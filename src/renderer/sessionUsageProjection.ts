import { extractPiMessageText } from "../shared/piMessageNormalization.js";
import type {
  ChatMessage,
  ChatModelSummary,
  ChatRuntimeEvent,
  ChatRuntimeStatus,
  ChatSnapshot,
} from "../shared/types.js";

export interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  totalCostUsd?: number;
}

export interface MessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCostUsd?: number;
}

export interface SessionUsageProjection {
  id: string;
  usageStats?: UsageStats;
  usageByMessageId?: Record<string, MessageUsage>;
  modelLabel?: string;
  thinkingLevel?: string;
}

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export function modelLabelForChatModel(model: ChatModelSummary): string {
  return model.provider ? `${model.provider} / ${model.id}` : model.id;
}

export function modelLabelFromState(state: ChatSnapshot["state"]): string {
  const provider = typeof state.provider === "string" ? state.provider : "";
  const model = state.model;
  if (typeof model === "string") {
    return [provider, model].filter((part) => part.length > 0).join(" / ");
  }
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const modelId =
      typeof model.id === "string"
        ? model.id
        : typeof model.name === "string"
          ? model.name
          : "";
    const modelProvider =
      typeof model.provider === "string" ? model.provider : provider;
    return [modelProvider, modelId]
      .filter((part) => part.length > 0)
      .join(" / ");
  }
  return provider;
}

export function parseModelLabel(
  label: string | undefined,
): { provider: string; modelId: string } | undefined {
  if (!label) {
    return undefined;
  }
  const separator = label.indexOf("/");
  if (separator === -1) {
    return undefined;
  }
  const provider = label.slice(0, separator).trim();
  const modelId = label.slice(separator + 1).trim();
  return provider && modelId ? { provider, modelId } : undefined;
}

export function usageFromMessages(
  messages: readonly ChatMessage[],
  contextWindowTokens: number | undefined,
): {
  usageStats?: UsageStats;
  usageByMessageId?: Record<string, MessageUsage>;
} {
  const usageByMessageId: Record<string, MessageUsage> = {};
  messages.forEach((message, index) => {
    const usage = extractMessageUsage(message);
    if (usage !== undefined) {
      usageByMessageId[message.id ?? `message-${index}`] = usage;
    }
  });

  if (Object.keys(usageByMessageId).length === 0) {
    if (contextWindowTokens === undefined) {
      return {};
    }
    return { usageStats: { contextWindowTokens } };
  }

  return {
    usageByMessageId,
    usageStats: summarizeUsageByMessage(usageByMessageId, contextWindowTokens),
  };
}

export function summarizeUsageByMessage(
  usageByMessageId: Record<string, MessageUsage>,
  contextWindowTokens: number | undefined,
): UsageStats {
  const values = Object.values(usageByMessageId);
  const inputTokens = sumUsage(values, "inputTokens");
  const outputTokens = sumUsage(values, "outputTokens");
  const cacheReadTokens = sumUsage(values, "cacheReadTokens");
  const cacheWriteTokens = sumUsage(values, "cacheWriteTokens");
  const contextValues = values.flatMap((usage) => {
    const promptValues = [
      usage.inputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
    ];
    return promptValues.some((value) => value !== undefined)
      ? [promptValues.reduce<number>((total, value) => total + (value ?? 0), 0)]
      : [];
  });
  const contextUsedTokens =
    contextValues.length > 0 ? Math.max(...contextValues) : undefined;
  const costValues = values
    .map((usage) => usage.totalCostUsd)
    .filter((value): value is number => value !== undefined);
  const totalCostUsd =
    costValues.length > 0
      ? costValues.reduce((total, value) => total + value, 0)
      : undefined;

  const tokenValues = [
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  ];
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(tokenValues.some((value) => value !== undefined)
      ? {
          totalTokens: tokenValues.reduce<number>(
            (total, value) => total + (value ?? 0),
            0,
          ),
        }
      : {}),
    ...(contextUsedTokens !== undefined && contextUsedTokens > 0
      ? { contextUsedTokens }
      : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

function sumUsage(
  values: MessageUsage[],
  key: keyof Pick<
    MessageUsage,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): number | undefined {
  const reported = values.flatMap((usage) =>
    usage[key] === undefined ? [] : [usage[key]],
  );
  return reported.length > 0
    ? reported.reduce((total, value) => total + value, 0)
    : undefined;
}

export function getMessageUsageFromEvent(
  event: ChatRuntimeEvent,
): MessageUsage | undefined {
  const record = asRecord(event);
  const direct = extractMessageUsage(asRecord(record?.message) ?? event);
  if (direct !== undefined) {
    return direct;
  }
  const messages = Array.isArray(record?.messages)
    ? record.messages
    : undefined;
  if (messages === undefined) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = extractMessageUsage(messages[index]);
    if (usage !== undefined) {
      return usage;
    }
  }
  return undefined;
}

export function eventHasUsageMetadata(event: ChatRuntimeEvent): boolean {
  return getMessageUsageFromEvent(event) !== undefined;
}

export function extractMessageUsage(value: unknown): MessageUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const usageRecord = asRecord(record.usage) ?? record;
  const inputTokens = readNumber(usageRecord, [
    "input",
    "inputTokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const outputTokens = readNumber(usageRecord, [
    "output",
    "outputTokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const cacheReadTokens = readNumber(usageRecord, [
    "cacheRead",
    "cacheReadTokens",
    "cache_read",
    "cache_read_tokens",
  ]);
  const cacheWriteTokens = readNumber(usageRecord, [
    "cacheWrite",
    "cacheWriteTokens",
    "cache_write",
    "cache_write_tokens",
  ]);
  const totalCostUsd = readCostUsd(usageRecord);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

export function getContextWindowTokens(
  state: ChatSnapshot["state"],
): number | undefined {
  const direct = readNumber(state as Record<string, unknown>, [
    "contextWindow",
    "contextWindowTokens",
    "context_window",
  ]);
  if (direct !== undefined) {
    return direct;
  }
  return readNumber(asRecord(state.model) ?? {}, [
    "contextWindow",
    "contextWindowTokens",
    "context_window",
  ]);
}

function readCostUsd(record: Record<string, unknown>): number | undefined {
  const explicitlyReported = readNumber(record, [
    "costUsd",
    "totalCostUsd",
    "total_cost_usd",
  ]);
  if (explicitlyReported !== undefined) return explicitlyReported;

  // Pi's generic cost aggregate is initialized to zero even when provider
  // pricing is unavailable. A positive value proves a report; a generic zero
  // does not. Explicit *CostUsd fields above may still authoritatively be zero.
  if (typeof record.cost === "number" && Number.isFinite(record.cost)) {
    return record.cost > 0 ? record.cost : undefined;
  }
  const aggregate = readNumber(asRecord(record.cost) ?? {}, ["total", "usd"]);
  return aggregate !== undefined && aggregate > 0 ? aggregate : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function mergeSessionUsageFromSnapshot<
  TSession extends SessionUsageProjection,
>(session: TSession, snapshotSession: SessionUsageProjection): TSession {
  const usageByMessageId =
    snapshotSession.usageByMessageId === undefined
      ? session.usageByMessageId
      : {
          ...(session.usageByMessageId ?? {}),
          ...snapshotSession.usageByMessageId,
        };
  const summarizedSnapshotUsage =
    usageByMessageId === undefined
      ? snapshotSession.usageStats
      : summarizeUsageByMessage(
          usageByMessageId,
          snapshotSession.usageStats?.contextWindowTokens ??
            session.usageStats?.contextWindowTokens,
        );
  const usageStats = mergeKnownUsageStats(
    session.usageStats,
    mergeKnownUsageStats(snapshotSession.usageStats, summarizedSnapshotUsage),
  );
  return {
    ...session,
    ...(usageStats !== undefined ? { usageStats } : {}),
    ...(usageByMessageId !== undefined ? { usageByMessageId } : {}),
    ...(snapshotSession.modelLabel !== undefined
      ? { modelLabel: snapshotSession.modelLabel }
      : {}),
    ...(snapshotSession.thinkingLevel !== undefined
      ? { thinkingLevel: snapshotSession.thinkingLevel }
      : {}),
  };
}

export function mergeSessionUsageFromRuntimeStatus<
  TSession extends SessionUsageProjection,
>(session: TSession, status: ChatRuntimeStatus): TSession {
  if (status.runtimeId !== session.id || status.usage === undefined) {
    return session;
  }
  const modelLabel = modelLabelFromState(status.state);
  const reported = status.usage.reportedFields;
  const isReported = (field: keyof UsageStats): boolean =>
    reported === undefined || reported.includes(field);
  // For optional fields, presence in reportedFields with no numeric value is
  // an authoritative "unavailable" result. An omitted reported field is only
  // a sparse update and must not erase previously known data.
  const contextUsedTokensUnavailable =
    reported?.includes("contextUsedTokens") === true &&
    status.usage.contextUsedTokens === undefined;
  const projected: UsageStats = {
    ...(isReported("inputTokens")
      ? { inputTokens: status.usage.inputTokens }
      : {}),
    ...(isReported("outputTokens")
      ? { outputTokens: status.usage.outputTokens }
      : {}),
    ...(isReported("cacheReadTokens")
      ? { cacheReadTokens: status.usage.cacheReadTokens }
      : {}),
    ...(isReported("cacheWriteTokens")
      ? { cacheWriteTokens: status.usage.cacheWriteTokens }
      : {}),
    ...(isReported("totalTokens")
      ? { totalTokens: status.usage.totalTokens }
      : {}),
    ...(isReported("contextUsedTokens") &&
    status.usage.contextUsedTokens !== undefined
      ? { contextUsedTokens: status.usage.contextUsedTokens }
      : {}),
    ...(isReported("contextWindowTokens") &&
    status.usage.contextWindowTokens !== undefined
      ? { contextWindowTokens: status.usage.contextWindowTokens }
      : {}),
    ...(isReported("totalCostUsd") && status.usage.totalCostUsd !== undefined
      ? { totalCostUsd: status.usage.totalCostUsd }
      : {}),
  };
  const mergedUsageStats = mergeKnownUsageStats(session.usageStats, projected);
  if (contextUsedTokensUnavailable && mergedUsageStats !== undefined) {
    delete mergedUsageStats.contextUsedTokens;
  }
  return {
    ...session,
    usageStats: mergedUsageStats,
    ...(modelLabel.length > 0 ? { modelLabel } : {}),
    ...(status.state.thinkingLevel !== undefined
      ? { thinkingLevel: status.state.thinkingLevel }
      : {}),
  };
}

export function mergeKnownUsageStats(
  current: UsageStats | undefined,
  incoming: UsageStats | undefined,
): UsageStats | undefined {
  if (current === undefined) return incoming;
  if (incoming === undefined) return current;
  const cumulative = (
    key: Exclude<keyof UsageStats, "contextWindowTokens">,
  ): number | undefined => {
    const previous = current[key];
    const next = incoming[key];
    if (previous === undefined) return next;
    if (next === undefined) return previous;
    return Math.max(previous, next);
  };
  const inputTokens = cumulative("inputTokens");
  const outputTokens = cumulative("outputTokens");
  const cacheReadTokens = cumulative("cacheReadTokens");
  const cacheWriteTokens = cumulative("cacheWriteTokens");
  const totalTokens = cumulative("totalTokens");
  // Context usage is current occupancy, not a lifetime counter. A fresh
  // authoritative value may legitimately decrease after compaction. Omission
  // remains sparse/no-new-evidence and therefore preserves the known value.
  const contextUsedTokens =
    incoming.contextUsedTokens ?? current.contextUsedTokens;
  const totalCostUsd = cumulative("totalCostUsd");
  const contextWindowTokens =
    incoming.contextWindowTokens ?? current.contextWindowTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

export function thinkingLevelsForModel(
  model: ChatModelSummary | undefined,
  fallback: string[],
): string[] {
  if (model === undefined || model.reasoning === undefined) {
    return fallback.length > 0 ? fallback : ["off"];
  }
  if (!model.reasoning) {
    return ["off"];
  }
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    return level !== "xhigh" && level !== "max" ? true : mapped !== undefined;
  });
}

export function clampThinkingLevel(
  level: string,
  availableLevels: string[],
): string {
  if (availableLevels.includes(level)) {
    return level;
  }
  const requestedIndex = PI_THINKING_LEVELS.indexOf(
    level as (typeof PI_THINKING_LEVELS)[number],
  );
  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }
  for (
    let index = requestedIndex;
    index < PI_THINKING_LEVELS.length;
    index += 1
  ) {
    const candidate = PI_THINKING_LEVELS[index];
    if (candidate !== undefined && availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = PI_THINKING_LEVELS[index];
    if (candidate !== undefined && availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  return availableLevels[0] ?? "off";
}

export function extractTextContent(value: unknown): string | undefined {
  return extractPiMessageText(value);
}

export function extractThinkingContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((item): string[] => {
    const record = asRecord(item);
    if (typeof record?.thinking === "string") {
      return [record.thinking];
    }
    if (
      typeof record?.type === "string" &&
      record.type.includes("thinking") &&
      typeof record.text === "string"
    ) {
      return [record.text];
    }
    return [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
