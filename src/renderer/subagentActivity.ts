export type SubagentActivityMode = "single" | "parallel" | "chain";

export type SubagentActivityState =
  | "Waiting for activity"
  | "Activity observed"
  | "Completed"
  | "Failed"
  | "Interrupted"
  | "Not run"
  | "Unknown";

export type SubagentHistoryItem =
  | { kind: "tool"; label: string }
  | { kind: "text"; text: string }
  | { kind: "error"; text: string };

export interface SubagentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface SubagentActivityChild {
  /** Stable only within the parent runtime and tool call. */
  index: number;
  step?: number;
  agent: string;
  task: string;
  state: SubagentActivityState;
  history: SubagentHistoryItem[];
  latest?: string;
  model?: string;
  completedTurns?: number;
  usage?: SubagentUsage;
  /** Epoch time of the latest meaningful live progress observation. */
  lastObservedAtMs?: number;
}

export interface SubagentActivity {
  mode: SubagentActivityMode;
  children: SubagentActivityChild[];
}

export interface ProjectSubagentActivityOptions {
  toolName: unknown;
  args?: unknown;
  details?: unknown;
  phase: "running" | "terminal";
  parentInterrupted?: boolean;
  /** Supplied only for live events; restored snapshots must omit it. */
  observedAtMs?: number;
  previous?: SubagentActivity;
}

const MAX_CHILDREN = 32;
const MAX_MESSAGES = 100;
const MAX_PARTS_PER_MESSAGE = 100;
const MAX_HISTORY_ITEMS = 24;
const MAX_HISTORY_CHARACTERS = 8_000;
const MAX_TEXT_CHARACTERS = 1_200;
const MAX_TASK_CHARACTERS = 500;
const MAX_LABEL_CHARACTERS = 120;
// Bounded lookahead recognizes a credential beginning at a display boundary
// without running regular expressions over an untrusted, unbounded string.
const SECRET_BOUNDARY_GUARD_CHARACTERS = 256;

interface SeedChild {
  agent: string;
  task: string;
  step?: number;
}

interface SeedProjection {
  mode: SubagentActivityMode;
  children: SeedChild[];
}

interface ParsedDetails {
  mode: SubagentActivityMode;
  results: Array<Record<string, unknown> | undefined>;
}

/**
 * Convert extension-specific subagent arguments/details into a small, bounded,
 * public projection. Cumulative updates replace this projection; callers must
 * not append snapshots. This is deliberately not a general transcript viewer.
 */
export function projectSubagentActivity(
  options: ProjectSubagentActivityOptions,
): SubagentActivity | undefined {
  const previous = isSubagentActivity(options.previous)
    ? options.previous
    : undefined;
  if (normalizeToolName(options.toolName) !== "subagent" && !previous) {
    return undefined;
  }

  const args = parseArgs(options.args);
  const details = parseDetails(options.details);
  const mode = args?.mode ?? previous?.mode ?? details?.mode;
  if (mode === undefined) return undefined;

  const seeds =
    args?.children ??
    previous?.children.map((child) => ({
      agent: child.agent,
      task: child.task,
      ...(child.step === undefined ? {} : { step: child.step }),
    })) ??
    details?.results.map((result, index) =>
      seedFromResult(result, index, mode),
    );
  if (seeds === undefined || seeds.length === 0) return undefined;

  const children = seeds.slice(0, MAX_CHILDREN).map((seed, index) => {
    const result = resultForChild(details, mode, index, seed.step);
    const prior = previous?.children[index];
    return projectChild({
      index,
      seed,
      result,
      prior,
      phase: options.phase,
      parentInterrupted: options.parentInterrupted === true,
      observedAtMs: options.observedAtMs,
    });
  });

  if (options.phase === "terminal" && mode === "chain") {
    let chainStopped = false;
    for (const child of children) {
      if (
        chainStopped &&
        resultForChild(details, mode, child.index, child.step) === undefined &&
        child.history.length === 0 &&
        child.completedTurns === undefined &&
        (previous?.children[child.index]?.state === undefined ||
          previous.children[child.index]?.state === "Waiting for activity")
      ) {
        child.state = "Not run";
      }
      if (child.state === "Failed" || child.state === "Interrupted") {
        chainStopped = true;
      }
    }
  }

  return { mode, children };
}

function projectChild(options: {
  index: number;
  seed: SeedChild;
  result: Record<string, unknown> | undefined;
  prior: SubagentActivityChild | undefined;
  phase: "running" | "terminal";
  parentInterrupted: boolean;
  observedAtMs: number | undefined;
}): SubagentActivityChild {
  const { result, prior } = options;
  const agent = boundedPublicString(
    stringValue(result?.agent) ?? options.seed.agent,
    MAX_LABEL_CHARACTERS,
    "Unknown agent",
  );
  const task = boundedPublicString(
    stringValue(result?.task) ?? options.seed.task,
    MAX_TASK_CHARACTERS,
    "Task unavailable",
  );
  const step = positiveInteger(result?.step) ?? options.seed.step;
  const projectedHistory = historyFromResult(result);
  const history =
    projectedHistory.history.length === 0
      ? (prior?.history ?? [])
      : projectedHistory.history;
  const observed =
    history.length > 0 ||
    positiveInteger(recordValue(result?.usage)?.turns) !== undefined;
  const stopReason = stringValue(result?.stopReason)?.toLowerCase();
  const exitCode = finiteInteger(result?.exitCode);
  const interrupted = isInterruptedReason(stopReason);
  const failed =
    (!interrupted &&
      exitCode !== undefined &&
      exitCode !== 0 &&
      exitCode !== -1) ||
    stopReason === "error" ||
    stopReason === "failed" ||
    stringValue(result?.errorMessage) !== undefined;

  let state: SubagentActivityState;
  if (interrupted) state = "Interrupted";
  else if (failed) state = "Failed";
  else if (
    result === undefined &&
    prior !== undefined &&
    prior.state !== "Waiting for activity" &&
    prior.state !== "Activity observed"
  ) {
    // Parent lifecycle finalization must not erase an outcome already known
    // from an authoritative child result.
    state = prior.state;
  } else if (options.phase === "running") {
    // The extension initializes a running single child with exitCode 0. It is
    // not completion evidence until tool_execution_end is received.
    state = observed ? "Activity observed" : "Waiting for activity";
  } else if (result === undefined) {
    state = options.parentInterrupted ? "Interrupted" : "Unknown";
  } else if (exitCode === 0 && hasValidResultIdentity(result)) {
    state = "Completed";
  } else state = options.parentInterrupted ? "Interrupted" : "Unknown";

  const usage = usageFromResult(result, options.phase) ?? prior?.usage;
  const completedTurns =
    completedTurnsFromResult(result, options.phase) ?? prior?.completedTurns;
  const modelValue = stringValue(result?.model);
  const model =
    modelValue === undefined
      ? prior?.model
      : boundedPublicString(modelValue, MAX_LABEL_CHARACTERS, "");
  const latest = historyItemLabel(history[history.length - 1]);
  const progressChanged =
    observed &&
    (prior === undefined ||
      !historiesEqual(history, prior.history) ||
      completedTurns !== prior.completedTurns ||
      !usageEqual(usage, prior.usage));
  const observedAtMs = finiteTimestamp(options.observedAtMs);
  const lastObservedAtMs =
    progressChanged && observedAtMs !== undefined
      ? observedAtMs
      : prior?.lastObservedAtMs;

  return {
    index: options.index,
    ...(step === undefined ? {} : { step }),
    agent,
    task,
    state,
    history,
    ...(latest === undefined ? {} : { latest }),
    ...(model ? { model } : {}),
    ...(completedTurns === undefined ? {} : { completedTurns }),
    ...(usage === undefined ? {} : { usage }),
    ...(lastObservedAtMs === undefined ? {} : { lastObservedAtMs }),
  };
}

function historyFromResult(result: Record<string, unknown> | undefined): {
  history: SubagentHistoryItem[];
} {
  if (result === undefined) return { history: [] };
  const messages = Array.isArray(result.messages)
    ? result.messages.slice(-MAX_MESSAGES)
    : [];
  const history: SubagentHistoryItem[] = [];
  let characterCount = 0;

  function push(item: SubagentHistoryItem): void {
    const value = item.kind === "tool" ? item.label : item.text;
    if (value.length === 0) return;
    const previous = history[history.length - 1];
    const previousValue =
      previous?.kind === "tool" ? previous.label : previous?.text;
    if (previous?.kind === item.kind && previousValue === value) return;
    history.push(item);
    characterCount += value.length;
    while (
      history.length > MAX_HISTORY_ITEMS ||
      characterCount > MAX_HISTORY_CHARACTERS
    ) {
      const removed = history.shift();
      if (removed === undefined) break;
      characterCount -=
        removed.kind === "tool" ? removed.label.length : removed.text.length;
    }
  }

  for (const unknownMessage of messages) {
    const message = recordValue(unknownMessage);
    if (stringValue(message?.role) !== "assistant") continue;
    const content = message?.content;
    if (typeof content === "string") {
      push({
        kind: "text",
        text: boundedPublicString(content, MAX_TEXT_CHARACTERS, ""),
      });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const unknownPart of content.slice(0, MAX_PARTS_PER_MESSAGE)) {
      const part = recordValue(unknownPart);
      const type = stringValue(part?.type);
      if (type === "text") {
        const text = stringValue(part?.text);
        if (text !== undefined) {
          push({
            kind: "text",
            text: boundedPublicString(text, MAX_TEXT_CHARACTERS, ""),
          });
        }
      } else if (type === "toolCall" || type === "tool_use") {
        const name = stringValue(part?.name) ?? stringValue(part?.toolName);
        push({ kind: "tool", label: safeToolLabel(name) });
      }
      // thinking/reasoning, tool results and unknown content are intentionally
      // not projected. In particular, arbitrary arguments and outputs never
      // enter this public history.
    }
  }

  const error = stringValue(result.errorMessage);
  if (error !== undefined) {
    push({
      kind: "error",
      text: boundedPublicString(error, MAX_TEXT_CHARACTERS, "Error reported"),
    });
  }
  return { history };
}

function usageFromResult(
  result: Record<string, unknown> | undefined,
  _phase: "running" | "terminal",
): SubagentUsage | undefined {
  const raw = recordValue(result?.usage);
  if (raw === undefined) return undefined;
  const usage: SubagentUsage = {};
  assignPositiveUsage(usage, "inputTokens", raw.input);
  assignPositiveUsage(usage, "outputTokens", raw.output);
  assignPositiveUsage(usage, "cacheReadTokens", raw.cacheRead);
  assignPositiveUsage(usage, "cacheWriteTokens", raw.cacheWrite);
  const explicitTotal = nonnegativeNumber(raw.totalTokens);
  const computedTotal =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  const total =
    explicitTotal && explicitTotal > 0 ? explicitTotal : computedTotal;
  if (total > 0) usage.totalTokens = total;
  // Zero-initialized extension counters are not proof that token usage is
  // authoritatively zero, even after a failed spawn.
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function assignPositiveUsage(
  usage: SubagentUsage,
  key: keyof SubagentUsage,
  value: unknown,
): void {
  const parsed = nonnegativeNumber(value);
  if (parsed !== undefined && parsed > 0) usage[key] = parsed;
}

function completedTurnsFromResult(
  result: Record<string, unknown> | undefined,
  _phase: "running" | "terminal",
): number | undefined {
  const turns = positiveInteger(recordValue(result?.usage)?.turns);
  return turns === undefined ? undefined : Math.min(turns, 1_000_000);
}

function resultForChild(
  details: ParsedDetails | undefined,
  mode: SubagentActivityMode,
  index: number,
  step: number | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined || details.mode !== mode) return undefined;
  if (mode === "chain" && step !== undefined) {
    const byStep = details.results.find(
      (result) => positiveInteger(result?.step) === step,
    );
    if (byStep !== undefined) return byStep;
    const positional = details.results[index];
    // Explicit step identity wins over array position. A result for step 2
    // must never be borrowed by a missing step 1 child.
    return positiveInteger(positional?.step) === undefined
      ? positional
      : undefined;
  }
  return details.results[index];
}

function parseArgs(value: unknown): SeedProjection | undefined {
  const args = recordValue(value);
  if (args === undefined) return undefined;
  const single =
    nonemptyString(args.agent) !== undefined &&
    nonemptyString(args.task) !== undefined;
  const parallel = Array.isArray(args.tasks) && args.tasks.length > 0;
  const chain = Array.isArray(args.chain) && args.chain.length > 0;
  if (Number(single) + Number(parallel) + Number(chain) !== 1) return undefined;

  if (single) {
    return {
      mode: "single",
      children: [
        {
          agent: nonemptyString(args.agent)!,
          task: nonemptyString(args.task)!,
        },
      ],
    };
  }
  const mode = parallel ? "parallel" : "chain";
  const source = (parallel ? args.tasks : args.chain) as unknown[];
  if (source.length > MAX_CHILDREN) return undefined;
  const children = source.map((item, index) => {
    const record = recordValue(item);
    const agent = nonemptyString(record?.agent);
    const task = nonemptyString(record?.task);
    if (agent === undefined || task === undefined) return undefined;
    return {
      agent,
      task,
      ...(mode === "chain" ? { step: index + 1 } : {}),
    };
  });
  return children.every((child) => child !== undefined)
    ? { mode, children: children as SeedChild[] }
    : undefined;
}

function parseDetails(value: unknown): ParsedDetails | undefined {
  const details = recordValue(value);
  if (details === undefined) return undefined;
  const mode = details.mode;
  if (!isMode(mode) || !Array.isArray(details.results)) return undefined;
  if (details.results.length === 0 || details.results.length > MAX_CHILDREN) {
    return undefined;
  }
  const results = details.results.map(recordValue);
  if (!results.some((result) => result !== undefined)) return undefined;
  return { mode, results };
}

function seedFromResult(
  result: Record<string, unknown> | undefined,
  index: number,
  mode: SubagentActivityMode,
): SeedChild {
  return {
    agent: stringValue(result?.agent) ?? "Unknown agent",
    task: stringValue(result?.task) ?? "Task unavailable",
    ...(mode === "chain"
      ? { step: positiveInteger(result?.step) ?? index + 1 }
      : {}),
  };
}

function isSubagentActivity(value: unknown): value is SubagentActivity {
  return (
    recordValue(value) !== undefined &&
    isMode((value as SubagentActivity).mode) &&
    Array.isArray((value as SubagentActivity).children)
  );
}

function isMode(value: unknown): value is SubagentActivityMode {
  return value === "single" || value === "parallel" || value === "chain";
}

function normalizeToolName(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[_.-]+/g, " ")
    : undefined;
}

function safeToolLabel(value: string | undefined): string {
  if (value === undefined) return "Tool";
  const safe = boundedPublicString(value, MAX_LABEL_CHARACTERS, "Tool");
  return /^[\p{L}\p{N}_.:/ -]+$/u.test(safe) && safe.length > 0 ? safe : "Tool";
}

function boundedPublicString(
  value: string,
  maximum: number,
  fallback: string,
): string {
  // Keep a small lookahead past the visible boundary so truncation cannot
  // expose the prefix of a common credential that starts near that boundary.
  const budgeted = value.slice(0, maximum + SECRET_BOUNDARY_GUARD_CHARACTERS);
  const normalized = redactCommonSecrets(
    budgeted.replace(/\u0000/g, ""),
  ).trim();
  if (normalized.length === 0) return fallback;
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1)}…`;
}

/** Best-effort defense in depth for common credentials; not universal DLP. */
export function redactCommonSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{12,}\b/g, "[REDACTED]")
    .replace(/\bglpat-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b((?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret(?:[_-]access[_-]key)?))\b(["']?\s*[=:]\s*)["']?[^\s,"';}]+["']?/gi,
      (_match, label: string, separator: string) =>
        `${label}${separator}[REDACTED]`,
    );
}

function historiesEqual(
  left: readonly SubagentHistoryItem[],
  right: readonly SubagentHistoryItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      if (item.kind !== other?.kind) return false;
      return item.kind === "tool"
        ? item.label === (other as { kind: "tool"; label: string }).label
        : item.text ===
            (other as { kind: "text" | "error"; text: string }).text;
    })
  );
}

function usageEqual(
  left: SubagentUsage | undefined,
  right: SubagentUsage | undefined,
): boolean {
  return (
    left?.inputTokens === right?.inputTokens &&
    left?.outputTokens === right?.outputTokens &&
    left?.cacheReadTokens === right?.cacheReadTokens &&
    left?.cacheWriteTokens === right?.cacheWriteTokens &&
    left?.totalTokens === right?.totalTokens
  );
}

function hasValidResultIdentity(
  result: Record<string, unknown> | undefined,
): boolean {
  return (
    nonemptyString(result?.agent) !== undefined &&
    nonemptyString(result?.task) !== undefined
  );
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function historyItemLabel(
  item: SubagentHistoryItem | undefined,
): string | undefined {
  if (item === undefined) return undefined;
  if (item.kind === "tool") return `Used ${item.label}`;
  if (item.kind === "error") return "Error reported";
  return item.text.replace(/\s+/g, " ").slice(0, 160);
}

function isInterruptedReason(value: string | undefined): boolean {
  return (
    value === "aborted" || value === "cancelled" || value === "interrupted"
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value)
    ? value
    : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
