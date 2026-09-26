import type { ChatRuntimeStatus } from "../../shared/types.js";
import type { PiState } from "./types.js";

export type RuntimeUsage = NonNullable<ChatRuntimeStatus["usage"]>;
export type RuntimeUsageField = NonNullable<
  RuntimeUsage["reportedFields"]
>[number];

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

export function runtimeUsageFromState(
  state: PiState,
): ChatRuntimeStatus["usage"] | undefined {
  const usage = objectRecord((state as Record<string, unknown>).usage);
  return usage === undefined ? undefined : runtimeUsageFromFlatRecord(usage);
}

/**
 * Merge current Pi's cumulative get_session_stats shape with older get_state
 * usage without allowing a partial source to erase fields the other reported.
 */
export function runtimeUsageFromSources(
  state: PiState,
  stats: unknown,
): ChatRuntimeStatus["usage"] | undefined {
  return mergeRuntimeUsage(
    runtimeUsageFromState(state),
    runtimeUsageFromSessionStats(stats),
  );
}

/**
 * Returns a total only when Pi's stats actually contains a token counter.
 * Context-window metadata alone is not evidence of zero consumed tokens.
 */
export function runtimeTotalTokensFromSessionStats(
  stats: unknown,
): number | undefined {
  const record = objectRecord(stats);
  if (record === undefined) return undefined;
  const source = objectRecord(record.tokens) ?? record;
  const totalTokens = readNonnegativeNumber(source, [
    "total",
    "totalTokens",
    "total_tokens",
  ]);
  if (totalTokens !== undefined) return totalTokens;
  const values = [
    readTokenNumber(source, "input"),
    readTokenNumber(source, "output"),
    readTokenNumber(source, "cacheRead"),
    readTokenNumber(source, "cacheWrite"),
  ];
  return values.some((value) => value !== undefined)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : undefined;
}

/**
 * Maps the cumulative shape returned by Pi 0.87 get_session_stats. Pi always
 * initializes aggregate counters (and cost) to zero, including before any
 * provider usage exists. Therefore an all-zero aggregate is unavailable, not
 * evidence of a zero-token model turn. This shape was verified against the
 * installed Pi source and a no-provider/offline RPC response; it is not claimed
 * to be a captured authenticated-provider payload.
 */
export function runtimeUsageFromSessionStats(
  stats: unknown,
): ChatRuntimeStatus["usage"] | undefined {
  const record = objectRecord(stats);
  if (record === undefined) return undefined;
  const source = objectRecord(record.tokens) ?? record;
  const contextUsage = objectRecord(
    record.contextUsage ?? record.context_usage,
  );

  const inputTokens = readTokenNumber(source, "input");
  const outputTokens = readTokenNumber(source, "output");
  const cacheReadTokens = readTokenNumber(source, "cacheRead");
  const cacheWriteTokens = readTokenNumber(source, "cacheWrite");
  const explicitTotal = readNonnegativeNumber(source, [
    "total",
    "totalTokens",
    "total_tokens",
  ]);
  const computedTotal = [
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  ].some((value) => value !== undefined)
    ? (inputTokens ?? 0) +
      (outputTokens ?? 0) +
      (cacheReadTokens ?? 0) +
      (cacheWriteTokens ?? 0)
    : undefined;
  const totalTokens = explicitTotal ?? computedTotal;
  const contextUsedTokenKeys = [
    "tokens",
    "contextUsedTokens",
    "contextUsed",
    "context_used_tokens",
  ] as const;
  const contextUsedTokens = readNonnegativeNumber(
    contextUsage ?? record,
    contextUsedTokenKeys,
  );
  // Current Pi uses null when context occupancy is unavailable. Preserve that
  // authoritative answer as field provenance so the renderer can clear a
  // stale occupancy without treating an entirely absent field as evidence.
  const contextUsedTokensUnavailable =
    contextUsage !== undefined &&
    contextUsedTokenKeys.some(
      (key) =>
        Object.prototype.hasOwnProperty.call(contextUsage, key) &&
        contextUsage[key] === null,
    );
  const contextWindowTokens = readNonnegativeNumber(contextUsage ?? record, [
    "contextWindow",
    "contextWindowTokens",
    "context_window",
    "context_window_tokens",
  ]);
  const totalCostUsd = readCostUsd(record);

  // Pi's aggregate object is eagerly zero-filled. A model-backed completion
  // cannot consume exactly no tokens, so do not turn that placeholder into an
  // authoritative 0 in / 0 out / $0.0000 UI.
  const hasTokenEvidence = totalTokens !== undefined && totalTokens > 0;
  const hasContextEvidence =
    contextUsedTokens !== undefined && contextUsedTokens > 0;
  const hasCostEvidence = totalCostUsd !== undefined && totalCostUsd > 0;
  if (!hasTokenEvidence && !hasContextEvidence && !hasCostEvidence) {
    if (contextWindowTokens === undefined && !contextUsedTokensUnavailable) {
      return undefined;
    }
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      reportedFields: [
        ...(contextUsedTokensUnavailable
          ? (["contextUsedTokens"] as const)
          : []),
        ...(contextWindowTokens !== undefined
          ? (["contextWindowTokens"] as const)
          : []),
      ],
    };
  }

  const reportedFields: RuntimeUsageField[] = [];
  if (inputTokens !== undefined) reportedFields.push("inputTokens");
  if (outputTokens !== undefined) reportedFields.push("outputTokens");
  // Zero cache aggregates do not prove provider cache reporting. Once either
  // side is non-zero, both counters in Pi's aggregate are meaningful.
  if ((cacheReadTokens ?? 0) > 0 || (cacheWriteTokens ?? 0) > 0) {
    reportedFields.push("cacheReadTokens", "cacheWriteTokens");
  }
  if (explicitTotal !== undefined) reportedFields.push("totalTokens");
  if (contextUsedTokens !== undefined || contextUsedTokensUnavailable) {
    reportedFields.push("contextUsedTokens");
  }
  if (contextWindowTokens !== undefined)
    reportedFields.push("contextWindowTokens");
  // Pi computes an always-present zero cost accumulator. Only a positive
  // aggregate proves pricing was available from this source.
  if (hasCostEvidence) reportedFields.push("totalCostUsd");

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    reportedFields,
  };
}

function runtimeUsageFromFlatRecord(
  record: Record<string, unknown>,
): ChatRuntimeStatus["usage"] | undefined {
  const inputTokens = readTokenNumber(record, "input");
  const outputTokens = readTokenNumber(record, "output");
  const cacheReadTokens = readTokenNumber(record, "cacheRead");
  const cacheWriteTokens = readTokenNumber(record, "cacheWrite");
  const explicitTotal = readNonnegativeNumber(record, [
    "totalTokens",
    "total",
    "total_tokens",
  ]);
  const tokenValues = [
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  ];
  const totalTokens =
    explicitTotal ??
    (tokenValues.some((value) => value !== undefined)
      ? tokenValues.reduce<number>((total, value) => total + (value ?? 0), 0)
      : undefined);
  const contextUsedTokens = readNonnegativeNumber(record, [
    "contextUsedTokens",
    "contextUsed",
  ]);
  const contextWindowTokens = readNonnegativeNumber(record, [
    "contextWindowTokens",
    "contextWindow",
  ]);
  const totalCostUsd = readCostUsd(record);
  if (
    totalTokens === undefined &&
    contextUsedTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return undefined;
  }

  const reportedFields: RuntimeUsageField[] = [];
  if (inputTokens !== undefined) reportedFields.push("inputTokens");
  if (outputTokens !== undefined) reportedFields.push("outputTokens");
  if (cacheReadTokens !== undefined) reportedFields.push("cacheReadTokens");
  if (cacheWriteTokens !== undefined) reportedFields.push("cacheWriteTokens");
  if (explicitTotal !== undefined) reportedFields.push("totalTokens");
  if (contextUsedTokens !== undefined) reportedFields.push("contextUsedTokens");
  if (contextWindowTokens !== undefined)
    reportedFields.push("contextWindowTokens");
  if (totalCostUsd !== undefined) reportedFields.push("totalCostUsd");

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    reportedFields,
  };
}

function mergeRuntimeUsage(
  fallback: RuntimeUsage | undefined,
  preferred: RuntimeUsage | undefined,
): RuntimeUsage | undefined {
  if (fallback === undefined) return preferred;
  if (preferred === undefined) return fallback;
  const fallbackFields = new Set(reportedFields(fallback));
  const preferredFields = new Set(reportedFields(preferred));
  const fields = new Set([...fallbackFields, ...preferredFields]);
  const value = (field: RuntimeUsageField): number | undefined =>
    preferredFields.has(field)
      ? preferred[field]
      : fallbackFields.has(field)
        ? fallback[field]
        : undefined;
  return {
    inputTokens: value("inputTokens") ?? 0,
    outputTokens: value("outputTokens") ?? 0,
    cacheReadTokens: value("cacheReadTokens") ?? 0,
    cacheWriteTokens: value("cacheWriteTokens") ?? 0,
    totalTokens: value("totalTokens") ?? 0,
    ...(value("contextUsedTokens") !== undefined
      ? { contextUsedTokens: value("contextUsedTokens") }
      : {}),
    ...(value("contextWindowTokens") !== undefined
      ? { contextWindowTokens: value("contextWindowTokens") }
      : {}),
    ...(value("totalCostUsd") !== undefined
      ? { totalCostUsd: value("totalCostUsd") }
      : {}),
    reportedFields: [...fields],
  };
}

function reportedFields(usage: RuntimeUsage): RuntimeUsageField[] {
  if (usage.reportedFields !== undefined) return usage.reportedFields;
  const fields: RuntimeUsageField[] = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
  ];
  if (usage.contextUsedTokens !== undefined) fields.push("contextUsedTokens");
  if (usage.contextWindowTokens !== undefined)
    fields.push("contextWindowTokens");
  if (usage.totalCostUsd !== undefined) fields.push("totalCostUsd");
  return fields;
}

function readTokenNumber(
  record: Record<string, unknown>,
  kind: (typeof TOKEN_FIELDS)[number] extends `${infer Prefix}Tokens`
    ? Prefix
    : never,
): number | undefined {
  const keys = {
    input: [
      "input",
      "inputTokens",
      "input_tokens",
      "promptTokens",
      "prompt_tokens",
    ],
    output: [
      "output",
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
    ],
    cacheRead: [
      "cacheRead",
      "cacheReadTokens",
      "cache_read",
      "cache_read_tokens",
    ],
    cacheWrite: [
      "cacheWrite",
      "cacheWriteTokens",
      "cache_write",
      "cache_write_tokens",
    ],
  } as const;
  return readNonnegativeNumber(record, keys[kind]);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCostUsd(record: Record<string, unknown>): number | undefined {
  const explicitlyReported = readNonnegativeNumber(record, [
    "costUsd",
    "totalCostUsd",
    "total_cost_usd",
  ]);
  if (explicitlyReported !== undefined) return explicitlyReported;

  const aggregate = readNonnegativeNumber(record, ["cost"]);
  if (aggregate !== undefined) return aggregate > 0 ? aggregate : undefined;
  const nestedAggregate = readNonnegativeNumber(
    objectRecord(record.cost) ?? {},
    ["total", "usd"],
  );
  return nestedAggregate !== undefined && nestedAggregate > 0
    ? nestedAggregate
    : undefined;
}

function readNonnegativeNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}
