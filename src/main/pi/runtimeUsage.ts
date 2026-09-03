import type { ChatRuntimeStatus } from "../../shared/types.js";
import type { PiState } from "./types.js";

export type RuntimeUsage = NonNullable<ChatRuntimeStatus["usage"]>;

export function runtimeUsageFromState(
  state: PiState,
): ChatRuntimeStatus["usage"] | undefined {
  const usage = (state as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  return runtimeUsageFromFlatRecord(usage as Record<string, unknown>);
}

export function runtimeUsageFromSessionStats(
  stats: unknown,
): ChatRuntimeStatus["usage"] | undefined {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
    return undefined;
  }
  const record = stats as Record<string, unknown>;
  const tokens = objectRecord(record.tokens);
  const contextUsage = objectRecord(
    record.contextUsage ?? record.context_usage,
  );

  const inputTokens = readNonnegativeNumber(tokens ?? record, [
    "input",
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const outputTokens = readNonnegativeNumber(tokens ?? record, [
    "output",
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const cacheReadTokens = readNonnegativeNumber(tokens ?? record, [
    "cacheRead",
    "cacheReadTokens",
    "cache_read",
    "cache_read_tokens",
  ]);
  const cacheWriteTokens = readNonnegativeNumber(tokens ?? record, [
    "cacheWrite",
    "cacheWriteTokens",
    "cache_write",
    "cache_write_tokens",
  ]);
  const totalTokens = readNonnegativeNumber(tokens ?? record, [
    "total",
    "totalTokens",
    "total_tokens",
  ]);
  const contextUsedTokens = readNonnegativeNumber(contextUsage ?? record, [
    "tokens",
    "contextUsedTokens",
    "contextUsed",
    "context_used_tokens",
  ]);
  const contextWindowTokens = readNonnegativeNumber(contextUsage ?? record, [
    "contextWindow",
    "contextWindowTokens",
    "context_window",
    "context_window_tokens",
  ]);
  const totalCostUsd = readCostUsd(record);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    totalTokens === undefined &&
    contextUsedTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return undefined;
  }

  const safeInputTokens = inputTokens ?? 0;
  const safeOutputTokens = outputTokens ?? 0;
  const safeCacheReadTokens = cacheReadTokens ?? 0;
  const safeCacheWriteTokens = cacheWriteTokens ?? 0;
  return {
    inputTokens: safeInputTokens,
    outputTokens: safeOutputTokens,
    cacheReadTokens: safeCacheReadTokens,
    cacheWriteTokens: safeCacheWriteTokens,
    totalTokens:
      totalTokens ??
      safeInputTokens +
        safeOutputTokens +
        safeCacheReadTokens +
        safeCacheWriteTokens,
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

function runtimeUsageFromFlatRecord(
  record: Record<string, unknown>,
): ChatRuntimeStatus["usage"] | undefined {
  const inputTokens = readNonnegativeNumber(record, ["inputTokens", "input"]);
  const outputTokens = readNonnegativeNumber(record, [
    "outputTokens",
    "output",
  ]);
  const cacheReadTokens =
    readNonnegativeNumber(record, ["cacheReadTokens", "cacheRead"]) ?? 0;
  const cacheWriteTokens =
    readNonnegativeNumber(record, ["cacheWriteTokens", "cacheWrite"]) ?? 0;
  const totalCostUsd = readCostUsd(record);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return undefined;
  }
  const safeInputTokens = inputTokens ?? 0;
  const safeOutputTokens = outputTokens ?? 0;
  return {
    inputTokens: safeInputTokens,
    outputTokens: safeOutputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens:
      readNonnegativeNumber(record, ["totalTokens", "total"]) ??
      safeInputTokens + safeOutputTokens + cacheReadTokens + cacheWriteTokens,
    ...(readNonnegativeNumber(record, ["contextUsedTokens", "contextUsed"]) !==
    undefined
      ? {
          contextUsedTokens: readNonnegativeNumber(record, [
            "contextUsedTokens",
            "contextUsed",
          ]),
        }
      : {}),
    ...(readNonnegativeNumber(record, [
      "contextWindowTokens",
      "contextWindow",
    ]) !== undefined
      ? {
          contextWindowTokens: readNonnegativeNumber(record, [
            "contextWindowTokens",
            "contextWindow",
          ]),
        }
      : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCostUsd(record: Record<string, unknown>): number | undefined {
  const direct = readNonnegativeNumber(record, [
    "costUsd",
    "totalCostUsd",
    "total_cost_usd",
    "cost",
  ]);
  if (direct !== undefined) {
    return direct;
  }
  const cost = objectRecord(record.cost);
  return cost === undefined
    ? undefined
    : readNonnegativeNumber(cost, ["total", "usd"]);
}

function readNonnegativeNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}
