export type BaseSessionState =
  | "unloaded"
  | "attaching"
  | "idle"
  | "working"
  | "waitingForInput"
  | "error"
  | "exited";

export interface SessionOverlays {
  streaming: boolean;
  toolRunning: boolean;
  compacting: boolean;
  retrying: boolean;
  localQueuedStartCount: number;
  piQueuedSteeringCount: number;
  piQueuedFollowUpCount: number;
  needsUserInput: boolean;
}

export interface SidebarSessionState {
  baseState: BaseSessionState;
  overlays: SessionOverlays;
}

export interface RuntimeEventLike {
  type: string;
  [key: string]: unknown;
}

export type ToolExecutionStatus = "running" | "completed" | "error";

export interface ToolExecutionCardState {
  id: string;
  name: string;
  status: ToolExecutionStatus;
  output?: string;
  isError?: boolean;
}

export interface PendingExtensionUiRequestState {
  requestId: string;
  method: string;
  timeout?: number;
}

export interface ReducedSessionState extends SidebarSessionState {
  activeTools: string[];
  pendingExtensionUiQueue: PendingExtensionUiRequestState[];
  toolCards: Record<string, ToolExecutionCardState>;
  diagnostics: string[];
  /** A provider error was observed and has not been superseded by a retry. */
  terminalProviderErrorObserved: boolean;
}

export type SidebarIndicatorKind =
  | "needsInput"
  | "error"
  | "attaching"
  | "compacting"
  | "retrying"
  | "toolRunning"
  | "working"
  | "queued"
  | "idle"
  | "muted";

export interface SidebarIndicator {
  kind: SidebarIndicatorKind;
  label: string;
  queuedCount?: number;
}

export const emptyOverlays: SessionOverlays = Object.freeze({
  streaming: false,
  toolRunning: false,
  compacting: false,
  retrying: false,
  localQueuedStartCount: 0,
  piQueuedSteeringCount: 0,
  piQueuedFollowUpCount: 0,
  needsUserInput: false,
});

export function createInitialReducedSessionState(
  patch: Partial<ReducedSessionState> = {},
): ReducedSessionState {
  return {
    baseState: patch.baseState ?? "idle",
    overlays: { ...emptyOverlays, ...patch.overlays },
    activeTools: patch.activeTools ?? [],
    pendingExtensionUiQueue: patch.pendingExtensionUiQueue ?? [],
    toolCards: patch.toolCards ?? {},
    diagnostics: patch.diagnostics ?? [],
    terminalProviderErrorObserved: patch.terminalProviderErrorObserved ?? false,
  };
}

export function getQueuedCount(overlays: SessionOverlays): number {
  return (
    overlays.localQueuedStartCount +
    overlays.piQueuedSteeringCount +
    overlays.piQueuedFollowUpCount
  );
}

export function reduceSessionRuntimeEvent(
  state: ReducedSessionState,
  event: RuntimeEventLike,
): ReducedSessionState {
  // Pending extension dialogs are the source of truth for actionable input.
  // Project every event through this priority so tool/retry/end events can
  // update their own overlays without hiding the request.
  return prioritizePendingExtensionUi(
    reduceSessionRuntimeEventUnprioritized(state, event),
  );
}

function reduceSessionRuntimeEventUnprioritized(
  state: ReducedSessionState,
  event: RuntimeEventLike,
): ReducedSessionState {
  switch (event.type) {
    case "agent_start":
      return {
        ...state,
        baseState: "working",
        terminalProviderErrorObserved: false,
        overlays: { ...state.overlays, streaming: false },
      };
    case "message_update":
      return reduceMessageUpdateEvent(state, event);
    case "tool_execution_start":
      return reduceToolStartEvent(state, event);
    case "tool_execution_update":
      return reduceToolUpdateEvent(state, event);
    case "tool_execution_end":
      return reduceToolEndEvent(state, event);
    case "queue_update":
      return {
        ...state,
        overlays: {
          ...state.overlays,
          // Pi RPC emits complete queues, rather than count fields.
          piQueuedSteeringCount:
            getArray(event, "steering")?.length ??
            getNumber(event, "steeringCount") ??
            0,
          piQueuedFollowUpCount:
            getArray(event, "followUp")?.length ??
            getNumber(event, "followUpCount") ??
            0,
        },
      };
    case "compaction_start":
      return { ...state, overlays: { ...state.overlays, compacting: true } };
    case "compaction_end":
      return { ...state, overlays: { ...state.overlays, compacting: false } };
    case "auto_retry_start":
      return {
        ...state,
        baseState: "working",
        terminalProviderErrorObserved: false,
        overlays: { ...state.overlays, streaming: false, retrying: true },
      };
    case "auto_retry_end": {
      // Pi sends { success, finalError }; status remains a compatibility
      // fallback for older fixtures and recorded event logs.
      const retryFailed =
        getBoolean(event, "success") === false ||
        getString(event, "status") === "failed" ||
        getString(event, "status") === "error";
      const retryError = getRuntimeEventErrorMessage(event);
      return {
        ...state,
        baseState: retryFailed ? "error" : "working",
        terminalProviderErrorObserved: retryFailed,
        overlays: { ...state.overlays, streaming: false, retrying: false },
        diagnostics: retryFailed
          ? appendDiagnostic(
              state.diagnostics,
              retryError ?? "Pi automatic retry failed.",
            )
          : state.diagnostics,
      };
    }
    case "extension_ui_request":
      return reduceExtensionUiRequestEvent(state, event);
    case "extension_ui_response_sent":
    case "extension_ui_request_timeout":
      return clearPendingExtensionUiRequest(
        state,
        getExtensionUiRequestId(event),
      );
    case "extension_ui_response_failed":
      return reduceExtensionUiResponseFailedEvent(state, event);
    case "agent_end":
      return reduceAgentEndEvent(state, event);
    case "diagnostic": {
      const message = getString(event, "message");
      return message
        ? { ...state, diagnostics: [...state.diagnostics, message] }
        : state;
    }
    case "worker_exit":
      // An unplanned exit detaches the runtime in main, which clears its
      // response map. Do not leave the renderer advertising an unanswerable
      // extension dialog after the pending-input priority projection runs.
      return getBoolean(event, "intentional") === true
        ? { ...state, baseState: "error" }
        : {
            ...state,
            baseState: "error",
            pendingExtensionUiQueue: [],
            overlays: { ...state.overlays, needsUserInput: false },
          };
    default:
      return state;
  }
}

function prioritizePendingExtensionUi(
  state: ReducedSessionState,
): ReducedSessionState {
  if (state.pendingExtensionUiQueue.length === 0) {
    return state;
  }

  return {
    ...state,
    baseState: "waitingForInput",
    overlays: { ...state.overlays, needsUserInput: true },
  };
}

function reduceMessageUpdateEvent(
  state: ReducedSessionState,
  event: RuntimeEventLike,
): ReducedSessionState {
  const assistantEventType = getString(
    getRecord(event, "assistantMessageEvent"),
    "type",
  );
  const done = getBoolean(event, "done") ?? assistantEventType === "done";
  const providerErrorObserved = hasRuntimeEventError(event);
  // An extension dialog stays actionable until its response is acknowledged.
  // Its queue is therefore the source of truth even when Pi reports the
  // provider error that will subsequently end the agent turn.
  const stillWaitingForInput = state.pendingExtensionUiQueue.length > 0;

  return {
    ...state,
    baseState: stillWaitingForInput
      ? "waitingForInput"
      : providerErrorObserved
        ? "error"
        : done
          ? state.baseState
          : "working",
    terminalProviderErrorObserved:
      providerErrorObserved || state.terminalProviderErrorObserved,
    overlays: {
      ...state.overlays,
      streaming: !done && !providerErrorObserved,
      needsUserInput: stillWaitingForInput,
    },
    diagnostics: providerErrorObserved
      ? appendDiagnostic(
          state.diagnostics,
          getRuntimeEventErrorMessage(event) ?? "Pi message update failed.",
        )
      : state.diagnostics,
  };
}

function reduceToolStartEvent(
  state: ReducedSessionState,
  event: RuntimeEventLike,
): ReducedSessionState {
  const toolCallId = getToolCallId(event);
  if (toolCallId === undefined) {
    return state;
  }

  const activeTools = state.activeTools.includes(toolCallId)
    ? state.activeTools
    : [...state.activeTools, toolCallId];

  return {
    ...state,
    baseState: "working",
    activeTools,
    overlays: { ...state.overlays, toolRunning: true },
    toolCards: {
      ...state.toolCards,
      [toolCallId]: createToolCard({
        id: toolCallId,
        name:
          getString(event, "name") ?? getString(event, "toolName") ?? "Tool",
        status: "running",
        output: getString(event, "output"),
        isError: getBoolean(event, "isError"),
      }),
    },
  };
}

function reduceToolUpdateEvent(
  state: ReducedSessionState,
  event: RuntimeEventLike,
): ReducedSessionState {
  const toolCallId = getToolCallId(event);
  if (toolCallId === undefined) {
    return state;
  }

  const existing = state.toolCards[toolCallId];
  return {
    ...state,
    activeTools: state.activeTools.includes(toolCallId)
      ? state.activeTools
      : [...state.activeTools, toolCallId],
    overlays: { ...state.overlays, toolRunning: true },
    toolCards: {
      ...state.toolCards,
      [toolCallId]: createToolCard({
        id: toolCallId,
        name:
          existing?.name ??
          getString(event, "name") ??
          getString(event, "toolName") ??
          "Tool",
        status: "running",
        output: getString(event, "output") ?? existing?.output,
        isError: getBoolean(event, "isError") ?? existing?.isError,
      }),
    },
  };
}

function reduceToolEndEvent(
  state: ReducedSessionState,
  event: RuntimeEventLike,
): ReducedSessionState {
  const toolCallId = getToolCallId(event);
  if (toolCallId === undefined) {
    return state;
  }

  const activeTools = state.activeTools.filter((id) => id !== toolCallId);
  const existing = state.toolCards[toolCallId];
  const isError = isToolExecutionFailure(event);

  return {
    ...state,
    activeTools,
    overlays: { ...state.overlays, toolRunning: activeTools.length > 0 },
    toolCards: {
      ...state.toolCards,
      [toolCallId]: createToolCard({
        id: toolCallId,
        name:
          existing?.name ??
          getString(event, "name") ??
          getString(event, "toolName") ??
          "Tool",
        status: isError ? "error" : "completed",
        output: getString(event, "output") ?? existing?.output,
        isError,
      }),
    },
  };
}

/**
 * A tool failure is a diagnostic on the tool card, not a request for user
 * input. Session attention is derived only from explicit pending input state.
 */
export function isToolExecutionFailure(event: RuntimeEventLike): boolean {
  if (event.type !== "tool_execution_end") {
    return false;
  }

  // Keep failure classification aligned with the locations rendered in the
  // tool detail card: Pi adapters may place command status, errors, and exit
  // codes directly on the event, in output, in result, or in result.output.
  const result = getRecord(event, "result");
  const partialResult = getRecord(event, "partialResult");
  const output = getRecord(event, "output");
  const resultOutput = getRecord(result, "output");
  const partialResultOutput = getRecord(partialResult, "output");
  return [
    event,
    output,
    result,
    partialResult,
    resultOutput,
    partialResultOutput,
  ].some(
    (record) => record !== undefined && isFailedToolExecutionRecord(record),
  );
}

function isFailedToolExecutionRecord(record: RuntimeEventLike): boolean {
  const status = getString(record, "status");
  return (
    getBoolean(record, "isError") === true ||
    status === "error" ||
    status === "failed" ||
    hasNonZeroToolExitCode(record) ||
    hasToolError(record)
  );
}

function hasNonZeroToolExitCode(record: RuntimeEventLike): boolean {
  return ["exitCode", "exit_code", "code"].some((key) => {
    const value = getNumber(record, key);
    return value !== undefined && value !== 0;
  });
}

function hasToolError(record: RuntimeEventLike): boolean {
  if (getString(record, "errorMessage")?.trim()) return true;
  const error = record.error;
  return (
    error !== undefined && error !== null && error !== false && error !== ""
  );
}

function createToolCard(input: {
  id: string;
  name: string;
  status: ToolExecutionStatus;
  output?: string | undefined;
  isError?: boolean | undefined;
}): ToolExecutionCardState {
  return {
    id: input.id,
    name: input.name,
    status: input.status,
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
  };
}

function reduceExtensionUiRequestEvent(
  state: ReducedSessionState,
  event: RuntimeEventLike,
): ReducedSessionState {
  const method = getString(event, "method") ?? "unknown";
  if (!["select", "confirm", "input", "editor"].includes(method)) {
    return state;
  }

  // Pi sends request ids as `id`; main-process acknowledgements use
  // `requestId`. Never invent an id, because that queue entry could not be
  // cleared by Pi's acknowledgement.
  const requestId = getExtensionUiRequestId(event);
  if (requestId === undefined) {
    return {
      ...state,
      diagnostics: appendDiagnostic(
        state.diagnostics,
        "Pi sent an extension UI dialog without an id, so Pi Deck cannot safely answer it.",
      ),
    };
  }
  const timeout = getNumber(event, "timeout");
  const pendingRequest: PendingExtensionUiRequestState = {
    requestId,
    method,
    ...(timeout !== undefined ? { timeout } : {}),
  };
  const pendingExtensionUiQueue = state.pendingExtensionUiQueue.some(
    (request) => request.requestId === requestId,
  )
    ? state.pendingExtensionUiQueue.map((request) =>
        request.requestId === requestId ? pendingRequest : request,
      )
    : [...state.pendingExtensionUiQueue, pendingRequest];

  return {
    ...state,
    baseState: "waitingForInput",
    pendingExtensionUiQueue,
    overlays: { ...state.overlays, needsUserInput: true },
  };
}

function clearPendingExtensionUiRequest(
  state: ReducedSessionState,
  requestId?: string,
): ReducedSessionState {
  const pendingExtensionUiQueue = requestId
    ? state.pendingExtensionUiQueue.filter(
        (request) => request.requestId !== requestId,
      )
    : state.pendingExtensionUiQueue.slice(1);

  const stillWaitingForInput = pendingExtensionUiQueue.length > 0;
  return {
    ...state,
    baseState: stillWaitingForInput
      ? "waitingForInput"
      : state.terminalProviderErrorObserved
        ? "error"
        : "working",
    pendingExtensionUiQueue,
    overlays: {
      ...state.overlays,
      needsUserInput: stillWaitingForInput,
    },
  };
}

function reduceExtensionUiResponseFailedEvent(
  state: ReducedSessionState,
  event: RuntimeEventLike,
): ReducedSessionState {
  const hasPendingExtensionUi = state.pendingExtensionUiQueue.length > 0;
  const message =
    getString(event, "message") ??
    "Pi Deck could not write the extension UI response to Pi.";
  return {
    ...state,
    baseState: hasPendingExtensionUi ? "waitingForInput" : "error",
    overlays: {
      ...state.overlays,
      needsUserInput: hasPendingExtensionUi,
    },
    diagnostics: [...state.diagnostics, message],
  };
}

function reduceAgentEndEvent(
  state: ReducedSessionState,
  event: RuntimeEventLike,
): ReducedSessionState {
  // Pi emits this between retry attempts. It is not a terminal provider
  // failure, even when the preceding message_update reported the retryable
  // error. Keep this aligned with the production reducer's busy/retrying
  // state and clear the transient terminal-error marker.
  if (getBoolean(event, "willRetry") === true) {
    return {
      ...state,
      baseState: "working",
      terminalProviderErrorObserved: false,
      activeTools: [],
      overlays: {
        ...state.overlays,
        streaming: false,
        toolRunning: false,
        retrying: true,
        needsUserInput: false,
      },
    };
  }

  const hasPendingExtensionUi = state.pendingExtensionUiQueue.length > 0;
  const reportedProviderError = hasRuntimeEventError(event);
  const terminalProviderErrorObserved =
    reportedProviderError || state.terminalProviderErrorObserved;
  let diagnostics = state.diagnostics;
  if (reportedProviderError) {
    diagnostics = appendDiagnostic(
      diagnostics,
      getRuntimeEventErrorMessage(event) ?? "Pi agent failed.",
    );
  }
  if (hasPendingExtensionUi) {
    diagnostics = appendDiagnostic(
      diagnostics,
      "agent_end while extension UI request is pending",
    );
  }

  return {
    ...state,
    baseState: hasPendingExtensionUi
      ? "waitingForInput"
      : terminalProviderErrorObserved
        ? "error"
        : "idle",
    terminalProviderErrorObserved,
    activeTools: [],
    overlays: {
      ...state.overlays,
      streaming: false,
      toolRunning: false,
      retrying: false,
      needsUserInput: hasPendingExtensionUi,
    },
    diagnostics,
  };
}

/** Keeps lightweight reducer error classification aligned with App's Pi events. */
function hasRuntimeEventError(event: RuntimeEventLike): boolean {
  const status = getString(event, "status");
  const assistantEvent = getRecord(event, "assistantMessageEvent");
  return (
    status === "error" ||
    status === "failed" ||
    hasDirectRuntimeEventError(event) ||
    isAssistantMessageEventFailure(assistantEvent) ||
    isErrorAssistantMessage(getRecord(event, "message")) ||
    isErrorAssistantMessage(getRecord(assistantEvent, "error")) ||
    isErrorAssistantMessage(getFinalAssistantMessage(event))
  );
}

function hasDirectRuntimeEventError(event: RuntimeEventLike): boolean {
  return (
    getString(event, "error") !== undefined ||
    getString(event, "errorMessage") !== undefined ||
    getString(event, "finalError") !== undefined ||
    getString(event, "message") !== undefined ||
    getErrorMessage(getRecord(event, "error")) !== undefined
  );
}

function isAssistantMessageEventFailure(
  assistantEvent: RuntimeEventLike | undefined,
): boolean {
  if (getString(assistantEvent, "type") !== "error") {
    return false;
  }
  return (
    getString(assistantEvent, "reason") !== "aborted" &&
    getString(getRecord(assistantEvent, "error"), "stopReason") !== "aborted"
  );
}

function isErrorAssistantMessage(
  message: RuntimeEventLike | undefined,
): boolean {
  const stopReason = getString(message, "stopReason");
  return (
    stopReason !== "aborted" &&
    (stopReason === "error" || getErrorMessage(message) !== undefined)
  );
}

function getRuntimeEventErrorMessage(
  event: RuntimeEventLike,
): string | undefined {
  return (
    getString(event, "error") ??
    getString(event, "errorMessage") ??
    getString(event, "finalError") ??
    getString(event, "message") ??
    getErrorMessage(getRecord(event, "error")) ??
    getErrorMessage(getRecord(event, "assistantMessageEvent")) ??
    getErrorMessage(getRecord(event, "message")) ??
    getErrorMessage(getFinalAssistantMessage(event))
  );
}

function getErrorMessage(
  record: RuntimeEventLike | undefined,
): string | undefined {
  return (
    getString(record, "errorMessage") ??
    getString(record, "error") ??
    getString(getRecord(record, "error"), "errorMessage") ??
    getString(getRecord(record, "error"), "message")
  );
}

function getFinalAssistantMessage(
  event: RuntimeEventLike,
): RuntimeEventLike | undefined {
  const messages = getArray(event, "messages");
  if (messages === undefined) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message)
    ) {
      continue;
    }
    const record = message as RuntimeEventLike;
    if (getString(record, "role") === "assistant") {
      return record;
    }
  }
  return undefined;
}

function appendDiagnostic(diagnostics: string[], message: string): string[] {
  return diagnostics.at(-1) === message
    ? diagnostics
    : [...diagnostics, message];
}

function getExtensionUiRequestId(event: RuntimeEventLike): string | undefined {
  return getString(event, "id") ?? getString(event, "requestId");
}

function getToolCallId(event: RuntimeEventLike): string | undefined {
  return getString(event, "toolCallId") ?? getString(event, "id");
}

function getRecord(
  event: RuntimeEventLike | undefined,
  key: string,
): RuntimeEventLike | undefined {
  const value = event?.[key];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as RuntimeEventLike;
  }
  return undefined;
}

function getString(
  event: RuntimeEventLike | undefined,
  key: string,
): string | undefined {
  const value = event?.[key];
  return typeof value === "string" ? value : undefined;
}

function getArray(event: RuntimeEventLike, key: string): unknown[] | undefined {
  const value = event[key];
  return Array.isArray(value) ? value : undefined;
}

function getNumber(event: RuntimeEventLike, key: string): number | undefined {
  const value = event[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getBoolean(event: RuntimeEventLike, key: string): boolean | undefined {
  const value = event[key];
  return typeof value === "boolean" ? value : undefined;
}

export function selectSidebarIndicator(
  session: SidebarSessionState,
): SidebarIndicator {
  const queuedCount = getQueuedCount(session.overlays);

  if (
    session.baseState === "waitingForInput" ||
    session.overlays.needsUserInput
  ) {
    return { kind: "needsInput", label: "Needs input" };
  }

  if (session.baseState === "error") {
    return { kind: "error", label: "Error" };
  }

  if (session.baseState === "attaching") {
    return { kind: "attaching", label: "Attaching" };
  }

  if (session.overlays.compacting) {
    return { kind: "compacting", label: "Compacting" };
  }

  if (session.overlays.retrying) {
    return { kind: "retrying", label: "Retrying" };
  }

  if (session.overlays.toolRunning) {
    return { kind: "toolRunning", label: "Tool running" };
  }

  if (session.overlays.streaming || session.baseState === "working") {
    return { kind: "working", label: "Working" };
  }

  if (queuedCount > 0) {
    return { kind: "queued", label: "Queued", queuedCount };
  }

  if (session.baseState === "idle") {
    return { kind: "idle", label: "Idle" };
  }

  return {
    kind: "muted",
    label: session.baseState === "exited" ? "Exited" : "Unloaded",
  };
}
