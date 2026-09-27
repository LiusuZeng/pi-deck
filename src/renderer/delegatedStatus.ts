export type DelegatedParentState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type DelegatedStatusTone = "working" | "success" | "error";

export interface DelegatedChildCounts {
  total: number;
  queued?: number;
  running?: number;
  waiting?: number;
  succeeded?: number;
  failed?: number;
  cancelled?: number;
  /** Terminal children whose outcome was not provided by the backend. */
  finished?: number;
}

export interface DelegatedStatusProjection {
  label: string;
  detail?: string;
  tone: DelegatedStatusTone;
  parentState: DelegatedParentState;
  parentPhase?: string;
  children: Required<DelegatedChildCounts>;
}

export interface DelegatedStatusInput {
  parentState: DelegatedParentState;
  parentPhase?: string;
  children: DelegatedChildCounts;
}

/**
 * Separates the parent operation phase from child outcomes. In particular,
 * terminal children never imply that their still-running parent completed.
 */
export function projectDelegatedStatus(
  input: DelegatedStatusInput,
): DelegatedStatusProjection {
  const children = normalizeCounts(input.children);
  const phase = normalizePhase(input.parentPhase);
  const label = parentLabel(input.parentState, phase, children);
  const detail = childDetail(children);
  return {
    label,
    ...(detail === undefined ? {} : { detail }),
    tone:
      input.parentState === "failed" || input.parentState === "cancelled"
        ? "error"
        : input.parentState === "completed"
          ? "success"
          : "working",
    parentState: input.parentState,
    ...(phase === undefined ? {} : { parentPhase: phase }),
    children,
  };
}

/** Projects only delegated/subagent tool events; unrelated tools return undefined. */
export function projectDelegatedToolStatus(
  event: Record<string, unknown>,
): DelegatedStatusProjection | undefined {
  const toolName = stringValue(event.toolName) ?? stringValue(event.name);
  if (!isDelegatedToolName(toolName)) return undefined;

  const payload = eventPayload(event);
  const details = recordValue(payload?.details) ?? recordValue(event.details);
  const parentPhase = firstString(
    stringValue(payload?.parentPhase),
    stringValue(payload?.delegatedPhase),
    stringValue(payload?.phase),
    stringValue(details?.parentPhase),
    stringValue(details?.delegatedPhase),
    stringValue(details?.phase),
    stringValue(recordValue(details?.parent)?.phase),
    stringValue(recordValue(details?.operation)?.phase),
  );
  const parentState = parentStateFromEvent(event);
  const children = childCountsFromRecords(event, payload, details);

  return projectDelegatedStatus({
    parentState,
    ...(parentPhase === undefined ? {} : { parentPhase }),
    children,
  });
}

function parentLabel(
  parentState: DelegatedParentState,
  phase: string | undefined,
  children: Required<DelegatedChildCounts>,
): string {
  switch (parentState) {
    case "completed":
      return "Completed delegated work";
    case "failed":
      return "Delegated work failed";
    case "cancelled":
      return "Delegated work cancelled";
  }

  switch (phase) {
    case "planning":
      return "Planning delegated tasks";
    case "running":
    case "running-children":
    case "executing":
      return "Running delegated tasks";
    case "collecting":
      return "Collecting delegated results";
    case "synthesizing":
    case "synthesis":
      return "Synthesizing results";
    case "reviewing":
    case "review":
      return "Reviewing delegated results";
    case "validating":
    case "validation":
      return "Validating delegated results";
    case "retrying-synthesis":
    case "synthesis-retry":
    case "retrying-final-response":
      return "Retrying final response";
    case "retrying":
      return "Retrying delegated work";
    case "processing":
    case "post-processing":
    case "preparing-response":
    case "preparing-final-response":
    case "finalizing":
    case "completed":
      return "Processing delegated results";
    case "waiting":
    case "waiting-parent":
      return "Waiting to continue delegated work";
  }

  if (children.running > 0 || children.queued > 0) {
    return "Running delegated tasks";
  }
  if (children.waiting > 0) {
    return "Waiting to continue delegated work";
  }
  if (terminalCount(children) > 0) {
    // Honest fallback: all children being terminal proves only that the parent
    // is post-processing. It does not prove synthesis, validation, or success.
    return "Processing delegated results";
  }
  return "Delegated work in progress";
}

function childDetail(
  children: Required<DelegatedChildCounts>,
): string | undefined {
  if (children.total === 0) return undefined;
  const terminal = terminalCount(children);
  const outcomes = outcomeParts(children);

  if (terminal >= children.total) {
    return [
      `${children.total} delegated ${plural(children.total, "task")} finished`,
      ...outcomes,
    ].join(" · ");
  }

  const parts: string[] = [];
  if (children.running > 0) {
    parts.push(
      `${children.running} of ${children.total} delegated ${plural(children.total, "task")} active`,
    );
  } else {
    parts.push(
      `${terminal} of ${children.total} delegated ${plural(children.total, "task")} finished`,
    );
  }
  if (children.queued > 0) parts.push(`${children.queued} queued`);
  if (children.waiting > 0) parts.push(`${children.waiting} waiting`);
  parts.push(...outcomes);
  return parts.join(" · ");
}

function outcomeParts(children: Required<DelegatedChildCounts>): string[] {
  const parts: string[] = [];
  if (children.succeeded > 0) parts.push(`${children.succeeded} succeeded`);
  if (children.failed > 0) parts.push(`${children.failed} failed`);
  if (children.cancelled > 0) parts.push(`${children.cancelled} cancelled`);
  if (children.finished > 0)
    parts.push(
      `${children.finished} outcome${children.finished === 1 ? "" : "s"} unavailable`,
    );
  return parts;
}

function childCountsFromRecords(
  event: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined,
): DelegatedChildCounts {
  const records = [
    recordValue(event.delegatedStatus),
    recordValue(payload?.delegatedStatus),
    recordValue(details?.children),
    details,
    payload,
  ].filter((record): record is Record<string, unknown> => record !== undefined);
  const results = firstArray(
    arrayValue(details?.results),
    arrayValue(details?.tasks),
    arrayValue(payload?.results),
    arrayValue(payload?.tasks),
  );
  const fromResults = results === undefined ? undefined : countResults(results);
  const direct = {
    total:
      firstNumberFrom(records, ["totalChildren", "totalTasks", "total"]) ??
      fromResults?.total ??
      taskCountFromArgs(event),
    queued: firstNumberFrom(records, [
      "queuedChildren",
      "queuedTasks",
      "queued",
    ]),
    running: firstNumberFrom(records, [
      "runningChildren",
      "runningTasks",
      "running",
    ]),
    waiting: firstNumberFrom(records, [
      "waitingChildren",
      "waitingTasks",
      "waiting",
    ]),
    succeeded: firstNumberFrom(records, [
      "succeededChildren",
      "successfulChildren",
      "succeededTasks",
      "succeeded",
      "completed",
    ]),
    failed: firstNumberFrom(records, [
      "failedChildren",
      "failedTasks",
      "failed",
    ]),
    cancelled: firstNumberFrom(records, [
      "cancelledChildren",
      "canceledChildren",
      "cancelledTasks",
      "cancelled",
      "canceled",
    ]),
    finished: firstNumberFrom(records, [
      "finishedChildren",
      "terminalChildren",
      "finishedTasks",
      "finished",
      "terminal",
    ]),
  };

  const legacy = legacyParallelCounts(payload);
  const succeeded = direct.succeeded ?? fromResults?.succeeded ?? 0;
  const failed = direct.failed ?? fromResults?.failed ?? 0;
  const cancelled = direct.cancelled ?? fromResults?.cancelled ?? 0;
  const reportedTerminal = direct.finished ?? legacy?.finished;
  return {
    total: direct.total || legacy?.total || 0,
    queued: direct.queued ?? fromResults?.queued ?? 0,
    // The extension's compact text is the authority for its own live counter.
    running: legacy?.running ?? direct.running ?? fromResults?.running ?? 0,
    waiting: direct.waiting ?? fromResults?.waiting ?? 0,
    succeeded,
    failed,
    cancelled,
    finished:
      reportedTerminal === undefined
        ? (fromResults?.finished ?? 0)
        : Math.max(0, reportedTerminal - succeeded - failed - cancelled),
  };
}

function countResults(results: unknown[]): Required<DelegatedChildCounts> {
  const counts: Required<DelegatedChildCounts> = emptyCounts(results.length);
  for (const value of results) {
    const result = recordValue(value);
    if (result === undefined) {
      counts.finished += 1;
      continue;
    }
    const state = firstString(
      stringValue(result.lifecycle),
      stringValue(result.status),
      stringValue(result.outcome),
    )?.toLowerCase();
    const stopReason = stringValue(result.stopReason)?.toLowerCase();
    const exitCode = numberValue(result.exitCode);
    if (["queued", "pending", "starting"].includes(state ?? "")) {
      counts.queued += 1;
    } else if (["running", "active", "retrying"].includes(state ?? "")) {
      counts.running += 1;
    } else if (["waiting", "waiting-parent"].includes(state ?? "")) {
      counts.waiting += 1;
    } else if (
      ["cancelled", "canceled", "aborted", "interrupted"].includes(
        state ?? "",
      ) ||
      ["cancelled", "canceled", "aborted", "interrupted"].includes(
        stopReason ?? "",
      )
    ) {
      counts.cancelled += 1;
    } else if (
      ["failed", "error"].includes(state ?? "") ||
      ["failed", "error"].includes(stopReason ?? "")
    ) {
      counts.failed += 1;
    } else if (["completed", "succeeded", "success"].includes(state ?? "")) {
      counts.succeeded += 1;
    } else if (exitCode === -1) {
      counts.running += 1;
    } else if (exitCode === 0) {
      counts.succeeded += 1;
    } else if (exitCode !== undefined) {
      counts.failed += 1;
    } else {
      counts.finished += 1;
    }
  }
  return counts;
}

function legacyParallelCounts(
  payload: Record<string, unknown> | undefined,
): { total: number; finished: number; running: number } | undefined {
  const text = textContent(payload?.content);
  const match = text?.match(
    /Parallel:\s*(\d+)\s*\/\s*(\d+)\s*(?:done|finished),\s*(\d+)\s*running/i,
  );
  if (match === undefined || match === null) return undefined;
  return {
    finished: Number(match[1]),
    total: Number(match[2]),
    running: Number(match[3]),
  };
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => stringValue(recordValue(part)?.text))
    .filter((part): part is string => part !== undefined)
    .join("\n");
  return text || undefined;
}

function parentStateFromEvent(
  event: Record<string, unknown>,
): DelegatedParentState {
  if (event.type !== "tool_execution_end") return "running";
  const payload = eventPayload(event);
  const records = [
    event,
    payload,
    recordValue(event.output),
    recordValue(payload?.output),
  ].filter((record): record is Record<string, unknown> => record !== undefined);
  const statuses = [
    ...records.flatMap((record) => [
      stringValue(record.status)?.toLowerCase(),
      stringValue(record.stopReason)?.toLowerCase(),
    ]),
    stringValue(recordValue(payload?.details)?.parentStatus)?.toLowerCase(),
  ];
  if (
    statuses.some((status) =>
      ["cancelled", "canceled", "aborted", "interrupted"].includes(
        status ?? "",
      ),
    )
  )
    return "cancelled";
  if (
    statuses.some((status) => ["failed", "error"].includes(status ?? "")) ||
    records.some(
      (record) =>
        record.isError === true ||
        nonZeroExitCode(record) ||
        stringValue(record.error) !== undefined ||
        stringValue(record.errorMessage) !== undefined,
    )
  )
    return "failed";
  return "completed";
}

function nonZeroExitCode(record: Record<string, unknown>): boolean {
  return [record.exitCode, record.exit_code, record.code].some(
    (value) => numberValue(value) !== undefined && numberValue(value) !== 0,
  );
}

function eventPayload(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return event.type === "tool_execution_update"
    ? (recordValue(event.partialResult) ?? recordValue(event.result))
    : (recordValue(event.result) ?? recordValue(event.partialResult));
}

function taskCountFromArgs(event: Record<string, unknown>): number {
  const args = recordValue(event.args) ?? recordValue(event.arguments);
  const tasks = arrayValue(args?.tasks) ?? arrayValue(args?.chain);
  return tasks?.length ?? (stringValue(args?.agent) ? 1 : 0);
}

function normalizeCounts(
  input: DelegatedChildCounts,
): Required<DelegatedChildCounts> {
  const counts = {
    total: safeCount(input.total),
    queued: safeCount(input.queued),
    running: safeCount(input.running),
    waiting: safeCount(input.waiting),
    succeeded: safeCount(input.succeeded),
    failed: safeCount(input.failed),
    cancelled: safeCount(input.cancelled),
    finished: safeCount(input.finished),
  };
  const observed =
    counts.queued +
    counts.running +
    counts.waiting +
    counts.succeeded +
    counts.failed +
    counts.cancelled +
    counts.finished;
  counts.total = Math.max(counts.total, observed);
  return counts;
}

function emptyCounts(total: number): Required<DelegatedChildCounts> {
  return {
    total,
    queued: 0,
    running: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    finished: 0,
  };
}

function terminalCount(children: Required<DelegatedChildCounts>): number {
  return (
    children.succeeded +
    children.failed +
    children.cancelled +
    children.finished
  );
}

function normalizePhase(value: string | undefined): string | undefined {
  const phase = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return phase || undefined;
}

function isDelegatedToolName(value: string | undefined): boolean {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[_.-]+/g, " ");
  return (
    normalized === "subagent" ||
    normalized === "delegate" ||
    normalized === "deck delegate"
  );
}

function firstNumberFrom(
  records: Record<string, unknown>[],
  keys: string[],
): number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = numberValue(record[key]);
      if (value !== undefined) return safeCount(value);
    }
  }
  return undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function firstArray(
  ...values: Array<unknown[] | undefined>
): unknown[] | undefined {
  return values.find((value) => value !== undefined);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeCount(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.floor(value));
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
