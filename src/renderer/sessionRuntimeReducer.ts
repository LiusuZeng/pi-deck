import type { AttachmentDraft, ChatRuntimeEvent } from "../shared/types.js";
import {
  classifyOpenAiCodexAuthFailure,
  isSuccessfulOpenAiCodexTerminalCompletion,
  isSuccessfulTerminalAssistantCompletion,
  isSuccessfulTerminalStatus,
  type FailureKind,
} from "./openaiCodexAuth.js";
import {
  getAssistantMessageEventType,
  getMessageTextUpdate,
  getMessageUpdateId,
  getMessageUpdateRole,
  getThinkingUpdateContent,
} from "./runtimeMessageProjection.js";
import {
  isToolExecutionFailure,
  type BaseSessionState,
  type SessionOverlays,
} from "./sessionState.js";
import {
  extractTextContent,
  getMessageUsageFromEvent,
  summarizeUsageByMessage,
  type MessageUsage,
  type UsageStats,
} from "./sessionUsageProjection.js";

export type SessionStatus =
  | "idle"
  | "starting"
  | "sending"
  | "working"
  | "aborting"
  | "reconnecting"
  | "waiting"
  | "error";

export type ExtensionUiDialogMethod = "select" | "confirm" | "input" | "editor";
type ExtensionUiFireAndForgetMethod =
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "set_editor_text";

export interface PendingExtensionUiRequest {
  id: string;
  method: ExtensionUiDialogMethod;
  title: string;
  message?: string | undefined;
  options?: string[] | undefined;
  placeholder?: string | undefined;
  prefill?: string | undefined;
  timeout?: number | undefined;
}

export interface TimelineAttachment {
  id: string;
  fileName: string;
  kind: AttachmentDraft["kind"];
  sendMode: AttachmentDraft["sendMode"];
  mimeType?: string;
  previewDataUrl?: string;
}

export interface ToolDetailSection {
  title: string;
  content: string;
  tone?: "default" | "error";
}

export type TimelineItem =
  | {
      id: string;
      kind: "user";
      content: string;
      createdAt: string;
      attachments?: TimelineAttachment[];
    }
  | {
      id: string;
      kind: "assistant";
      content: string;
      createdAt: string;
      streaming?: boolean;
    }
  | {
      id: string;
      kind: "thinking";
      content: string;
      createdAt: string;
      streaming?: boolean;
    }
  | {
      id: string;
      kind: "diagnostic";
      tone: "info" | "error";
      content: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "tool";
      title: string;
      status: "running" | "success" | "error" | "collapsed";
      summary: string;
      details: string;
      detailSections?: ToolDetailSection[];
      createdAt: string;
    };

export interface SessionViewModel {
  id: string;
  workspaceId: string;
  workingDirectory?: string;
  title: string;
  titleOverride?: string;
  project: string;
  projectPath: string;
  subtitle: string;
  status: SessionStatus;
  updatedAt: string;
  updatedAtMs: number;
  timeline: TimelineItem[];
  baseState: BaseSessionState;
  overlays: SessionOverlays;
  usageStats?: UsageStats;
  usageByMessageId?: Record<string, MessageUsage>;
  workingStartedAtMs?: number | undefined;
  lastRuntimeEventLabel?: string | undefined;
  modelLabel?: string;
  thinkingLevel?: string;
  lastError?: string | undefined;
  runtimeBacked: boolean;
  backendMode?: "fake" | "real";
  sessionFile?: string;
  sessionId?: string;
  resumeBacked?: boolean;
  draftSession?: boolean;
  projectId?: string;
  isResuming?: boolean;
  pendingExtensionUiRequests?: PendingExtensionUiRequest[];
  retryPrompt?: { text: string; attachments: AttachmentDraft[] } | undefined;
  awaitingAgentEnd?: boolean;
  providerErrorObserved?: boolean;
  failureKind?: FailureKind | undefined;
  authVerified?: boolean | undefined;
  archivedAtMs?: number;
  completedAtMs?: number | undefined;
}

function timelineToolStatus(streaming: boolean): "running" | "success" {
  return streaming ? "running" : "success";
}

/** The durable synthesis receipt is transport metadata, not user-facing copy. */
function stripInternalSynthesisDeliveryMarker(value: string): string {
  return value.replace(/^<!-- pi-deck-synthesis-delivery:v1:[^\s]+ -->\n?/, "");
}

function toolTimelineItemFromContent(options: {
  id: string;
  content: string;
  createdAt: string;
  status: "running" | "success" | "error" | "collapsed";
  role?: string | undefined;
}): Extract<TimelineItem, { kind: "tool" }> | undefined {
  const toolPayload = parseToolPayload(options.content);
  const isToolRole =
    options.role === "tool" ||
    options.role === "toolResult" ||
    options.role === "tool_use" ||
    options.role === "tool_result";

  if (toolPayload === undefined && !isToolRole) {
    return undefined;
  }

  return {
    id: options.id,
    kind: "tool",
    title: toolPayload?.title ?? "Tool output",
    status: options.status,
    summary: toolPayload?.summary ?? summarizeToolDetails(options.content, 180),
    details: toolPayload?.details ?? options.content,
    ...(toolPayload?.detailSections !== undefined
      ? { detailSections: toolPayload.detailSections }
      : {}),
    createdAt: options.createdAt,
  };
}

function parseToolPayload(content: string):
  | {
      title: string;
      summary: string;
      details: string;
      detailSections?: ToolDetailSection[];
    }
  | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const details = JSON.stringify(record, null, 2);
  if (typeof record.command === "string") {
    const detailSections = toolDetailSectionsFromRuntimeEvent(
      {
        type: "tool_payload",
        runtimeId: "tool-payload",
        ...record,
      } as ChatRuntimeEvent,
      "Command",
      record,
    );
    return {
      title: "Command",
      summary: record.command,
      details,
      ...(detailSections.length > 0 ? { detailSections } : {}),
    };
  }
  if (typeof record.path === "string") {
    const limit =
      typeof record.limit === "number" ? ` · ${record.limit} lines` : "";
    return {
      title: "Read file",
      summary: `${record.path}${limit}`,
      details,
    };
  }
  if (Array.isArray(record.edits) || record.oldText !== undefined) {
    return {
      title: "Edit file",
      summary:
        typeof record.path === "string"
          ? record.path
          : "Patch details available when expanded",
      details,
    };
  }
  if (typeof record.tool === "string" || typeof record.name === "string") {
    const toolName = String(record.tool ?? record.name);
    return {
      title: toolName,
      summary: toolName,
      details,
    };
  }
  return undefined;
}

function summarizeToolDetails(content: string, maxLength: number): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine || "Tool output";
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}

function safeToolDetails(content: string): string {
  const maxLength = 20_000;
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n\n… Tool output truncated in Pi Deck after ${formatInteger(maxLength)} characters.`;
}

function formatToolStatus(
  status: Extract<TimelineItem, { kind: "tool" }>["status"],
): string {
  switch (status) {
    case "running":
      return "running";
    case "success":
      return "success";
    case "error":
      return "error";
    default:
      return "collapsed";
  }
}

export function reduceRuntimeEvent(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  // A dialog remains actionable until Pi acknowledges its response or the
  // request times out. Apply this projection after every event reduction so
  // concurrent tool/retry/terminal events cannot mask pending input.
  return prioritizePendingExtensionUiRequest(
    reduceRuntimeEventUnprioritized(session, event),
  );
}

export function reduceRuntimeEventUnprioritized(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  switch (event.type) {
    case "agent_start":
      return {
        ...session,
        completedAtMs: undefined,
        awaitingAgentEnd: false,
        status: "working",
        baseState: "working",
        overlays: { ...session.overlays, streaming: true },
        subtitle: `Working · ${backendLabel(session)} stream`,
        workingStartedAtMs: session.workingStartedAtMs ?? Date.now(),
        lastRuntimeEventLabel: "Pi agent started",
        retryPrompt: undefined,
        // Starting/replacing a worker and get_state only prove transport
        // availability. Keep auth repair pending until a model turn ends.
        providerErrorObserved: false,
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    case "message_update":
      return reduceMessageUpdate(session, event);
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return reduceToolExecutionEvent(session, event);
    case "queue_update": {
      const steeringCount =
        getArray(event, "steering")?.length ??
        getNumber(event, "steeringCount") ??
        0;
      const followUpCount =
        getArray(event, "followUp")?.length ??
        getNumber(event, "followUpCount") ??
        0;
      return {
        ...session,
        overlays: {
          ...session.overlays,
          piQueuedSteeringCount: steeringCount,
          piQueuedFollowUpCount: followUpCount,
        },
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    }
    case "compaction_start":
      return {
        ...session,
        overlays: { ...session.overlays, compacting: true },
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    case "compaction_end":
      return {
        ...session,
        overlays: { ...session.overlays, compacting: false },
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    case "auto_retry_start":
      // Pi 0.81 emits this after agent_end({ willRetry: true }). Keep the
      // runtime busy through backoff rather than exposing idle/send controls.
      return {
        ...session,
        awaitingAgentEnd: false,
        status: session.status === "aborting" ? "aborting" : "working",
        baseState: "working",
        overlays: {
          ...session.overlays,
          streaming: false,
          retrying: true,
        },
        subtitle: `Retrying · ${backendLabel(session)} will retry this turn`,
        workingStartedAtMs: session.workingStartedAtMs ?? Date.now(),
        lastRuntimeEventLabel: "Pi scheduled an automatic retry",
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    case "auto_retry_end": {
      const retryStatus = getString(event, "status");
      // Real Pi reports success/finalError. Keep the status fallback solely
      // for older fake fixtures and manually recorded event logs.
      const retryFailed =
        getBoolean(event, "success") === false ||
        retryStatus === "failed" ||
        retryStatus === "error";

      // Pi 0.81 AgentSession.abort() cancels retry backoff and emits
      // auto_retry_end({ success: false, finalError: "Retry cancelled" }).
      // The renderer has already recorded the user's abort intent, and Pi
      // does not emit another successful agent_end to repair this state.
      // Handle that terminal cancellation before generic retry failures.
      if (session.status === "aborting" && retryFailed) {
        return {
          ...session,
          awaitingAgentEnd: false,
          providerErrorObserved:
            session.failureKind === "auth-required"
              ? session.providerErrorObserved === true
              : false,
          status: session.failureKind === "auth-required" ? "error" : "idle",
          baseState: session.failureKind === "auth-required" ? "error" : "idle",
          overlays: {
            ...session.overlays,
            streaming: false,
            toolRunning: false,
            retrying: false,
            needsUserInput: false,
          },
          subtitle: "Idle · backend stream aborted",
          workingStartedAtMs: undefined,
          retryPrompt: undefined,
          ...(session.failureKind === "auth-required"
            ? {}
            : { lastError: undefined }),
          lastRuntimeEventLabel: "Pi cancelled the automatic retry after abort",
          updatedAt: "Now",
          updatedAtMs: Date.now(),
        };
      }

      const retryError = getRuntimeEventErrorMessage(event);
      const nextSession: SessionViewModel = {
        ...session,
        awaitingAgentEnd: retryFailed
          ? false
          : (session.awaitingAgentEnd ?? false),
        // A successful retry_end is emitted before the authoritative final
        // agent_end, so it must not expose an idle session in that gap.
        status: retryFailed ? "error" : "working",
        baseState: retryFailed ? "error" : "working",
        overlays: {
          ...session.overlays,
          streaming: false,
          retrying: false,
        },
        subtitle: retryFailed
          ? "Error · automatic retry failed"
          : `Working · ${backendLabel(session)} retry complete`,
        workingStartedAtMs: retryFailed
          ? undefined
          : (session.workingStartedAtMs ?? Date.now()),
        lastRuntimeEventLabel: retryFailed
          ? "Pi reported a final retry error"
          : "Pi finished an automatic retry",
        providerErrorObserved:
          retryFailed || session.providerErrorObserved === true,
        ...(retryFailed
          ? {
              failureKind:
                classifyOpenAiCodexAuthFailure(event) ?? session.failureKind,
              authVerified: undefined,
            }
          : {}),
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
      return retryFailed
        ? appendRuntimeErrorDiagnostic(
            nextSession,
            retryError ?? "Pi automatic retry failed.",
          )
        : nextSession;
    }
    case "extension_ui_request":
      return session.runtimeBacked
        ? reduceExtensionUiRequestEvent(session, event)
        : session;
    case "extension_ui_response_sent":
    case "extension_ui_request_timeout":
      // Main has already detached this terminal runtime. A late write
      // acknowledgement is not permission to revive its prior working state.
      return session.runtimeBacked
        ? clearExtensionUiRequest(session, getString(event, "requestId"))
        : session;
    case "extension_ui_response_failed": {
      if (!session.runtimeBacked) {
        return session;
      }
      const stillWaitingForInput =
        (session.pendingExtensionUiRequests?.length ?? 0) > 0;
      // The response write failed, so its request remains actionable. Keep the
      // detail banner aligned with the sidebar and Work attention state.
      return appendRuntimeErrorDiagnostic(
        {
          ...session,
          status: stillWaitingForInput ? "waiting" : "error",
          baseState: stillWaitingForInput ? "waitingForInput" : "error",
          overlays: {
            ...session.overlays,
            needsUserInput: stillWaitingForInput,
          },
          subtitle: stillWaitingForInput
            ? "Waiting · extension input required"
            : "Error · extension UI response was not delivered",
        },
        getString(event, "message") ??
          "Pi Deck could not write the extension UI response to Pi.",
      );
    }
    case "agent_end": {
      const status = getString(event, "status");
      const willRetry = getBoolean(event, "willRetry") === true;
      const errorMessage = getRuntimeEventErrorMessage(event);
      // Production Pi sends agent_end({ messages, willRetry }) without the
      // fixture-only status/error fields. Carry only an error observed in a
      // Pi runtime event, never a previous UI/local error state, into this
      // terminal classification.
      const endedWithError =
        !willRetry &&
        (hasRuntimeEventError(event) || session.providerErrorObserved === true);
      const authenticatedCompletion =
        !endedWithError && isAuthenticatedModelCompletion(event);
      const successfulCompletion =
        !endedWithError && isSuccessfulModelCompletion(event);
      const authStillPending =
        session.failureKind === "auth-required" && !authenticatedCompletion;
      // A dialog is still actionable until Pi acknowledges its response or it
      // times out. Its queue, rather than a potentially stale overlay, is the
      // source of truth and takes precedence over a terminal error so every
      // surface continues to route the user to the required response.
      const stillWaitingForInput =
        (session.pendingExtensionUiRequests?.length ?? 0) > 0;
      const finalEventUsage = getMessageUsageFromEvent(event);
      const finalUsageMessageId =
        getMessageUpdateId(event) ??
        getMostRecentAssistantMessageId(session) ??
        getString(event, "runId") ??
        "agent-end";
      const usageByMessageId =
        finalEventUsage !== undefined
          ? {
              ...(session.usageByMessageId ?? {}),
              [finalUsageMessageId]: finalEventUsage,
            }
          : session.usageByMessageId;
      const completedTimeline = removeEmptyAssistantMessages(
        session.timeline.map((item) =>
          item.kind === "assistant" && item.streaming === true
            ? { ...item, streaming: false }
            : item,
        ),
      );

      if (willRetry) {
        return {
          ...session,
          awaitingAgentEnd: false,
          ...(usageByMessageId !== undefined ? { usageByMessageId } : {}),
          ...(usageByMessageId !== undefined
            ? {
                usageStats: summarizeUsageByMessage(
                  usageByMessageId,
                  session.usageStats?.contextWindowTokens,
                ),
              }
            : {}),
          status: "working",
          baseState: "working",
          providerErrorObserved: false,
          overlays: {
            ...session.overlays,
            streaming: false,
            toolRunning: false,
            retrying: true,
            needsUserInput: false,
          },
          subtitle: `Retrying · ${backendLabel(session)} will retry this turn`,
          workingStartedAtMs: session.workingStartedAtMs ?? Date.now(),
          lastRuntimeEventLabel: "Pi ended an attempt and scheduled a retry",
          updatedAt: "Now",
          updatedAtMs: Date.now(),
          timeline: completedTimeline,
        };
      }

      const nextSession: SessionViewModel = {
        ...session,
        // A live authoritative, non-error terminal event supersedes any
        // reconstructed durable completion timestamp for this session.
        completedAtMs:
          endedWithError || authStillPending ? undefined : Date.now(),
        awaitingAgentEnd: false,
        ...(usageByMessageId !== undefined ? { usageByMessageId } : {}),
        ...(usageByMessageId !== undefined
          ? {
              usageStats: summarizeUsageByMessage(
                usageByMessageId,
                session.usageStats?.contextWindowTokens,
              ),
            }
          : {}),
        status: stillWaitingForInput
          ? "waiting"
          : endedWithError || authStillPending
            ? "error"
            : "idle",
        baseState: stillWaitingForInput
          ? "waitingForInput"
          : endedWithError || authStillPending
            ? "error"
            : "idle",
        // Preserve a terminal provider failure behind an actionable dialog so
        // clearing the final request restores Failed rather than working/idle.
        providerErrorObserved: endedWithError || authStillPending,
        ...(endedWithError
          ? {
              failureKind:
                classifyOpenAiCodexAuthFailure(event) ?? session.failureKind,
              authVerified: undefined,
            }
          : authenticatedCompletion
            ? {
                failureKind: undefined,
                authVerified: true,
                lastError: undefined,
              }
            : successfulCompletion && !authStillPending
              ? { lastError: undefined }
              : {}),
        overlays: {
          ...session.overlays,
          streaming: false,
          toolRunning: false,
          retrying: false,
          needsUserInput: stillWaitingForInput,
        },
        subtitle: stillWaitingForInput
          ? "Waiting · extension input required"
          : endedWithError
            ? "Error · backend stream failed"
            : authStillPending
              ? "Error · OpenAI authentication verification pending"
              : status === "aborted"
                ? "Idle · backend stream aborted"
                : "Idle · backend stream complete",
        workingStartedAtMs: undefined,
        retryPrompt: endedWithError ? session.retryPrompt : undefined,
        lastRuntimeEventLabel: endedWithError
          ? "Pi reported an error"
          : status === "aborted"
            ? "Pi aborted the turn"
            : "Pi completed the turn",
        updatedAt: "Now",
        updatedAtMs: Date.now(),
        timeline: completedTimeline,
      };
      return endedWithError
        ? appendRuntimeErrorDiagnostic(
            nextSession,
            errorMessage ?? session.lastError ?? "Pi agent failed.",
          )
        : nextSession;
    }
    case "diagnostic":
      return appendDiagnostic(session, {
        tone: getString(event, "level") === "error" ? "error" : "info",
        content: getString(event, "message") ?? "Backend diagnostic event",
      });
    case "worker_exit": {
      const intentional = getUnknown(event, "intentional") === true;
      // SIGTERM is expected when Pi Deck detaches a completed session. Shell
      // launchers may expose it as code 143; preserve its durable file as a
      // resumable row rather than presenting a backend failure.
      const detachedSession = clearPendingExtensionUiRequests(session);
      if (intentional && session.sessionFile !== undefined) {
        return {
          ...detachedSession,
          status:
            detachedSession.failureKind === "auth-required" ? "error" : "idle",
          baseState:
            detachedSession.failureKind === "auth-required" ? "error" : "idle",
          awaitingAgentEnd: false,
          runtimeBacked: false,
          resumeBacked: true,
          subtitle:
            detachedSession.failureKind === "auth-required"
              ? "Authentication verification pending · reopen saved session"
              : "Saved · click to resume",
        };
      }
      // An intentional close already detached this runtime and preserved the
      // saved-session row. Its late process-exit event must not turn that row
      // into an error, but it must still discard any unanswerable dialog.
      if (!session.runtimeBacked && session.resumeBacked === true) {
        return detachedSession;
      }
      return appendDiagnostic(
        {
          ...detachedSession,
          // Main detaches response ownership on every worker exit, so clear
          // queued dialogs before the pending-input priority projection runs.
          status: "error",
          baseState: "error",
          awaitingAgentEnd: false,
          runtimeBacked: false,
          resumeBacked: session.sessionFile !== undefined,
          overlays: detachedSession.overlays,
          subtitle: session.sessionFile
            ? "Error · worker exited; click to resume saved session"
            : "Error · backend worker exited",
        },
        {
          tone: "error",
          content: `${backendLabel(session)} worker exited (code=${String(getUnknown(event, "code") ?? "null")}).`,
        },
      );
    }
    default:
      return session;
  }
}

function clearPendingExtensionUiRequests(
  session: SessionViewModel,
): SessionViewModel {
  return {
    ...session,
    pendingExtensionUiRequests: [],
    overlays: { ...session.overlays, needsUserInput: false },
  };
}

function prioritizePendingExtensionUiRequest(
  session: SessionViewModel,
): SessionViewModel {
  if ((session.pendingExtensionUiRequests?.length ?? 0) === 0) {
    return session;
  }

  return {
    ...session,
    status: "waiting",
    baseState: "waitingForInput",
    overlays: { ...session.overlays, needsUserInput: true },
    subtitle: "Waiting · extension input required",
  };
}

function reduceExtensionUiRequestEvent(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  const method = getString(event, "method");
  if (!isExtensionUiDialogMethod(method)) {
    if (isExtensionUiFireAndForgetMethod(method)) {
      return session;
    }
    return appendDiagnostic(session, {
      tone: "info",
      content: `Extension UI method “${method ?? "unknown"}” is not supported by Pi Deck. Only select, confirm, input, and editor requests can be answered.`,
    });
  }

  // Pi puts dialog fields at the top level. params supports old fixture events.
  const params = getRecord(event, "params");
  const requestId = getString(event, "id") ?? getString(event, "requestId");
  if (requestId === undefined) {
    return appendDiagnostic(session, {
      tone: "error",
      content:
        "Pi sent an extension UI dialog without an id, so Pi Deck cannot safely answer it.",
    });
  }
  const options = getStringArray(event, "options");
  const request: PendingExtensionUiRequest = {
    id: requestId,
    method,
    title:
      getString(event, "title") ??
      getStringFromRecord(params, "title") ??
      method,
    ...((getString(event, "message") ?? getStringFromRecord(params, "message"))
      ? {
          message:
            getString(event, "message") ??
            getStringFromRecord(params, "message"),
        }
      : {}),
    ...(options !== undefined ? { options } : {}),
    ...(getString(event, "placeholder") !== undefined
      ? { placeholder: getString(event, "placeholder") }
      : {}),
    ...(getString(event, "prefill") !== undefined
      ? { prefill: getString(event, "prefill") }
      : {}),
    ...(getNumber(event, "timeout") !== undefined
      ? { timeout: getNumber(event, "timeout") }
      : {}),
  };
  const pending = session.pendingExtensionUiRequests ?? [];
  const pendingExtensionUiRequests = pending.some(
    (item) => item.id === request.id,
  )
    ? pending.map((item) => (item.id === request.id ? request : item))
    : [...pending, request];

  return {
    ...session,
    status: "waiting",
    baseState: "waitingForInput",
    overlays: { ...session.overlays, needsUserInput: true },
    pendingExtensionUiRequests,
    subtitle: "Waiting · extension input required",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
  };
}

function clearExtensionUiRequest(
  session: SessionViewModel,
  requestId: string | undefined,
): SessionViewModel {
  const pending = session.pendingExtensionUiRequests ?? [];
  const pendingExtensionUiRequests =
    requestId === undefined
      ? pending.slice(1)
      : pending.filter((request) => request.id !== requestId);
  const stillWaiting = pendingExtensionUiRequests.length > 0;
  const terminalProviderFailure = session.providerErrorObserved === true;
  return {
    ...session,
    status: stillWaiting
      ? "waiting"
      : terminalProviderFailure
        ? "error"
        : "working",
    baseState: stillWaiting
      ? "waitingForInput"
      : terminalProviderFailure
        ? "error"
        : "working",
    pendingExtensionUiRequests,
    overlays: { ...session.overlays, needsUserInput: stillWaiting },
    subtitle: stillWaiting
      ? "Waiting · extension input required"
      : terminalProviderFailure
        ? "Error · backend stream failed"
        : `Working · ${backendLabel(session)} stream`,
    updatedAt: "Now",
    updatedAtMs: Date.now(),
  };
}

function isExtensionUiDialogMethod(
  method: string | undefined,
): method is ExtensionUiDialogMethod {
  return (
    method === "select" ||
    method === "confirm" ||
    method === "input" ||
    method === "editor"
  );
}

function isExtensionUiFireAndForgetMethod(
  method: string | undefined,
): method is ExtensionUiFireAndForgetMethod {
  return (
    method === "notify" ||
    method === "setStatus" ||
    method === "setWidget" ||
    method === "setTitle" ||
    method === "set_editor_text"
  );
}

function getStringArray(
  event: ChatRuntimeEvent,
  key: string,
): string[] | undefined {
  const value = getArray(event, key);
  return value?.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

function reduceToolExecutionEvent(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  const status =
    event.type === "tool_execution_end"
      ? isToolExecutionFailure(event)
        ? "error"
        : "success"
      : "running";
  const existingTool = existingToolTimelineItem(session.timeline, event);
  const eventToolItem = toolTimelineItemFromRuntimeEvent(event, status);
  const toolItem = eventToolItem
    ? mergeToolTimelineItemDetails(eventToolItem, existingTool)
    : undefined;
  const timeline = toolItem
    ? upsertToolMessage(session.timeline, toolItem)
    : session.timeline;
  const toolRunning = timeline.some(
    (item) => item.kind === "tool" && item.status === "running",
  );

  const isAborting = session.status === "aborting";
  return {
    ...session,
    status: isAborting ? "aborting" : "working",
    baseState: "working",
    overlays: { ...session.overlays, toolRunning },
    subtitle: isAborting
      ? "Aborting · waiting for Pi confirmation"
      : `Working · ${backendLabel(session)} stream`,
    workingStartedAtMs: session.workingStartedAtMs ?? Date.now(),
    lastRuntimeEventLabel:
      event.type === "tool_execution_end"
        ? "Tool finished"
        : event.type === "tool_execution_update"
          ? "Tool output updated"
          : "Tool started",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline,
  };
}

function existingToolTimelineItem(
  timeline: readonly TimelineItem[],
  event: ChatRuntimeEvent,
): Extract<TimelineItem, { kind: "tool" }> | undefined {
  const id = getString(event, "toolCallId") ?? getString(event, "id");
  return id === undefined
    ? undefined
    : timeline.find(
        (item): item is Extract<TimelineItem, { kind: "tool" }> =>
          item.kind === "tool" && item.id === id,
      );
}

export function toolTimelineItemFromRuntimeEvent(
  event: ChatRuntimeEvent,
  status: "running" | "success" | "error" | "collapsed",
): Extract<TimelineItem, { kind: "tool" }> | undefined {
  const id = getString(event, "toolCallId") ?? getString(event, "id");
  if (id === undefined) {
    return undefined;
  }
  const title =
    getString(event, "toolName") ?? getString(event, "name") ?? "Tool";
  const args = getToolEventArgs(event);
  const command = getCommandFromToolArgs(args) ?? getString(event, "command");
  const path = getStringFromRecord(args, "path");
  const summary = command ?? path ?? title;
  const detailSections = toolDetailSectionsFromRuntimeEvent(event, title, args);
  const details = safeToolDetails(
    detailSections.length > 0
      ? detailSectionsToText(detailSections)
      : rawToolEventDetails(event, title, args),
  );

  return {
    id,
    kind: "tool",
    title,
    status,
    summary,
    details,
    ...(detailSections.length > 0 ? { detailSections } : {}),
    createdAt: formatTime(),
  };
}

function mergeToolTimelineItemDetails(
  next: Extract<TimelineItem, { kind: "tool" }>,
  existing: Extract<TimelineItem, { kind: "tool" }> | undefined,
): Extract<TimelineItem, { kind: "tool" }> {
  if (existing === undefined) {
    return next;
  }

  const nextSections = next.detailSections;
  const existingInputSection =
    existing.detailSections?.find(isToolInputSection);
  const nextHasInputSection = nextSections?.some(isToolInputSection);
  const nextHasOutputSection = nextSections?.some(isToolOutputSection);
  const preservedOutputSections =
    nextHasOutputSection === true
      ? []
      : (existing.detailSections?.filter(isToolOutputSection) ?? []);
  const nextStatusSections = nextSections?.filter(isToolStatusSection) ?? [];
  const nextNonStatusSections =
    nextSections?.filter((section) => !isToolStatusSection(section)) ?? [];
  const detailSections = [
    ...(existingInputSection !== undefined && nextHasInputSection !== true
      ? [existingInputSection]
      : []),
    ...nextNonStatusSections,
    ...preservedOutputSections,
    ...nextStatusSections,
  ];

  const summary =
    next.summary === next.title && existing.summary.trim().length > 0
      ? existing.summary
      : next.summary;

  return {
    ...next,
    summary,
    createdAt: existing.createdAt,
    ...(detailSections.length > 0
      ? {
          detailSections,
          details: safeToolDetails(detailSectionsToText(detailSections)),
        }
      : {}),
  };
}

function isToolInputSection(section: ToolDetailSection): boolean {
  return section.title === "Command" || section.title === "Input";
}

function isToolOutputSection(section: ToolDetailSection): boolean {
  return ["stdout", "stderr", "Output", "Error"].includes(section.title);
}

function isToolStatusSection(section: ToolDetailSection): boolean {
  return section.title === "Exit status";
}

function getToolEventArgs(
  event: ChatRuntimeEvent,
): Record<string, unknown> | undefined {
  return (
    getRecord(event, "args") ??
    getRecord(event, "arguments") ??
    getRecord(event, "input") ??
    getRecord(event, "toolInput")
  );
}

function getCommandFromToolArgs(
  args: Record<string, unknown> | undefined,
): string | undefined {
  return (
    getStringFromRecord(args, "command") ??
    getStringFromRecord(args, "cmd") ??
    getStringFromRecord(args, "script")
  );
}

export function toolDetailSectionsFromRuntimeEvent(
  event: ChatRuntimeEvent,
  toolName: string,
  args: Record<string, unknown> | undefined,
): ToolDetailSection[] {
  const sections: ToolDetailSection[] = [];
  const result = getToolEventResult(event);
  const outputRecord = recordFromUnknown(getUnknown(event, "output"));
  const resultOutputRecord = recordFromUnknown(result?.output);

  const command = getCommandFromToolArgs(args) ?? getString(event, "command");
  if (command !== undefined) {
    sections.push({ title: "Command", content: command });
  } else if (args !== undefined) {
    sections.push({ title: "Input", content: JSON.stringify(args, null, 2) });
  }

  const stdout = firstString(
    getString(event, "stdout"),
    getStringFromRecord(outputRecord, "stdout"),
    getStringFromRecord(result, "stdout"),
    getStringFromRecord(resultOutputRecord, "stdout"),
  );
  const stderr = firstString(
    getString(event, "stderr"),
    getStringFromRecord(outputRecord, "stderr"),
    getStringFromRecord(result, "stderr"),
    getStringFromRecord(resultOutputRecord, "stderr"),
  );
  const combinedOutput = firstString(
    getString(event, "output"),
    stringFromUnknown(getUnknown(event, "result")),
    stringFromUnknown(getUnknown(event, "partialResult")),
    getStringFromRecord(outputRecord, "output"),
    getStringFromRecord(outputRecord, "result"),
    extractTextContent(outputRecord?.content),
    getStringFromRecord(outputRecord, "text"),
    getStringFromRecord(result, "output"),
    getStringFromRecord(result, "result"),
    extractTextContent(result?.content),
    getStringFromRecord(result, "content"),
    getStringFromRecord(result, "text"),
    getStringFromRecord(resultOutputRecord, "output"),
    extractTextContent(resultOutputRecord?.content),
  );

  if (stdout !== undefined) {
    sections.push({ title: "stdout", content: stdout });
  }
  if (stderr !== undefined) {
    sections.push({ title: "stderr", content: stderr, tone: "error" });
  }
  if (
    combinedOutput !== undefined &&
    combinedOutput !== stdout &&
    combinedOutput !== stderr
  ) {
    sections.push({ title: "Output", content: combinedOutput });
  }

  const error = firstString(
    getString(event, "errorMessage"),
    stringFromUnknown(getUnknown(event, "error")),
    getErrorMessageFromRecord(recordFromUnknown(getUnknown(event, "error"))),
    getStringFromRecord(outputRecord, "error"),
    getStringFromRecord(outputRecord, "message"),
    getStringFromRecord(result, "errorMessage"),
    getStringFromRecord(result, "error"),
    getStringFromRecord(result, "message"),
    getErrorMessageFromRecord(getRecordFromRecord(result, "error")),
  );
  if (
    error !== undefined &&
    error !== stderr &&
    error !== combinedOutput &&
    error !== stdout
  ) {
    sections.push({ title: "Error", content: error, tone: "error" });
  }

  const exitStatus = commandExitStatusFromRuntimeEvent(
    event,
    result,
    outputRecord,
    resultOutputRecord,
  );
  if (exitStatus !== undefined) {
    sections.push({ title: "Exit status", content: exitStatus });
  }

  if (sections.length === 0 && toolName.trim().length > 0) {
    sections.push({ title: "Tool", content: toolName });
  }
  return sections.map((section) => ({
    ...section,
    content: safeToolDetails(section.content),
  }));
}

function getToolEventResult(
  event: ChatRuntimeEvent,
): Record<string, unknown> | undefined {
  return getRecord(event, "result") ?? getRecord(event, "partialResult");
}

function commandExitStatusFromRuntimeEvent(
  event: ChatRuntimeEvent,
  result: Record<string, unknown> | undefined,
  outputRecord: Record<string, unknown> | undefined,
  resultOutputRecord: Record<string, unknown> | undefined,
): string | undefined {
  const exitCode = firstNumber(
    getNumber(event, "exitCode"),
    getNumber(event, "exit_code"),
    getNumber(event, "code"),
    getNumberFromRecord(outputRecord, "exitCode"),
    getNumberFromRecord(outputRecord, "exit_code"),
    getNumberFromRecord(outputRecord, "code"),
    getNumberFromRecord(result, "exitCode"),
    getNumberFromRecord(result, "exit_code"),
    getNumberFromRecord(result, "code"),
    getNumberFromRecord(resultOutputRecord, "exitCode"),
    getNumberFromRecord(resultOutputRecord, "exit_code"),
    getNumberFromRecord(resultOutputRecord, "code"),
  );
  const status = firstString(
    getString(event, "status"),
    getStringFromRecord(outputRecord, "status"),
    getStringFromRecord(result, "status"),
    getStringFromRecord(resultOutputRecord, "status"),
  );
  const isError = getBoolean(event, "isError");
  const parts: string[] = [];
  if (exitCode !== undefined) {
    parts.push(`code: ${exitCode}`);
  }
  if (status !== undefined) {
    parts.push(`status: ${status}`);
  }
  if (isError !== undefined) {
    parts.push(`isError: ${String(isError)}`);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function rawToolEventDetails(
  event: ChatRuntimeEvent,
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  const result = getToolEventResult(event);
  return JSON.stringify(
    {
      type: event.type,
      toolName,
      ...(args !== undefined ? { args } : {}),
      ...(getUnknown(event, "output") !== undefined
        ? { output: getUnknown(event, "output") }
        : {}),
      ...(result !== undefined ? { result } : {}),
      status: getString(event, "status"),
      isError: getBoolean(event, "isError"),
    },
    null,
    2,
  );
}

function detailSectionsToText(sections: readonly ToolDetailSection[]): string {
  return sections
    .map((section) => `${section.title}\n${section.content}`)
    .join("\n\n");
}

function reduceMessageUpdate(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  const messageId =
    getMessageUpdateId(event) ??
    getActiveAssistantMessageId(session) ??
    createId("assistant");
  const assistantEventType = getAssistantMessageEventType(event);
  const done =
    getBoolean(event, "done") ??
    (assistantEventType === "done" || assistantEventType === "error");
  const textUpdate = getMessageTextUpdate(event);
  const content = textUpdate?.content ?? "";
  const thinking = getThinkingUpdateContent(event);
  const role = getMessageUpdateRole(event);
  const existingAssistantContent = getAssistantContent(
    session.timeline,
    messageId,
  );
  const nextAssistantContent =
    textUpdate?.mode === "append" ||
    shouldAppendShortStreamingReplacement(
      existingAssistantContent,
      content,
      done,
    )
      ? `${existingAssistantContent ?? ""}${content}`
      : content;
  const toolItem = toolTimelineItemFromContent({
    id: messageId,
    content: nextAssistantContent,
    createdAt: formatTime(),
    status: timelineToolStatus(!done),
    role,
  });
  const hasReplyContent = nextAssistantContent.trim().length > 0;
  const hasThinkingContent =
    thinking !== undefined && thinking.trim().length > 0;

  let timeline = session.timeline;
  if (toolItem !== undefined) {
    timeline = upsertToolMessage(timeline, toolItem);
  } else if (hasReplyContent) {
    timeline = upsertAssistantMessage(
      timeline,
      messageId,
      nextAssistantContent,
      !done,
    );
  } else if (hasThinkingContent) {
    timeline = upsertThinkingMessage(
      timeline,
      `thinking-${messageId}`,
      thinking,
      !done,
    );
  }

  const eventUsage = getMessageUsageFromEvent(event);
  const usageByMessageId =
    eventUsage !== undefined
      ? { ...(session.usageByMessageId ?? {}), [messageId]: eventUsage }
      : session.usageByMessageId;
  const usageStats =
    usageByMessageId !== undefined
      ? summarizeUsageByMessage(
          usageByMessageId,
          session.usageStats?.contextWindowTokens,
        )
      : undefined;

  const errorMessage = getRuntimeEventErrorMessage(event);
  const isErrorUpdate = hasRuntimeEventError(event);
  // An actionable dialog takes precedence over all stream updates, including
  // the provider error update that precedes a production agent_end.
  const stillWaitingForInput =
    (session.pendingExtensionUiRequests?.length ?? 0) > 0;
  const nextSession: SessionViewModel = {
    ...session,
    ...(usageByMessageId !== undefined ? { usageByMessageId } : {}),
    ...(usageStats !== undefined ? { usageStats } : {}),
    providerErrorObserved:
      isErrorUpdate || session.providerErrorObserved === true,
    ...(isErrorUpdate
      ? {
          failureKind:
            classifyOpenAiCodexAuthFailure(event) ?? session.failureKind,
        }
      : {}),
    // An assistant message's `done` only completes that message. The agent
    // may still be running tools or emit an authoritative agent_end next.
    status: stillWaitingForInput
      ? "waiting"
      : isErrorUpdate
        ? "error"
        : session.status === "aborting"
          ? "aborting"
          : "working",
    baseState: stillWaitingForInput
      ? "waitingForInput"
      : isErrorUpdate
        ? "error"
        : "working",
    overlays: {
      ...session.overlays,
      streaming: !done && !isErrorUpdate,
      needsUserInput: stillWaitingForInput,
    },
    subtitle: stillWaitingForInput
      ? "Waiting · extension input required"
      : isErrorUpdate
        ? "Error · backend stream failed"
        : session.status === "aborting"
          ? "Aborting · waiting for Pi confirmation"
          : done
            ? "Working · waiting for Pi completion"
            : `Working · ${backendLabel(session)} stream`,
    ...(isErrorUpdate ? { workingStartedAtMs: undefined } : {}),
    awaitingAgentEnd: done && !isErrorUpdate,
    lastRuntimeEventLabel: isErrorUpdate
      ? "Pi reported an error"
      : done
        ? "Assistant message complete; awaiting Pi turn completion"
        : hasReplyContent
          ? "Receiving assistant text"
          : hasThinkingContent
            ? "Receiving thinking update"
            : "Pi sent a runtime update",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline,
  };

  return isErrorUpdate
    ? appendRuntimeErrorDiagnostic(
        nextSession,
        errorMessage ?? "Pi message update failed.",
      )
    : nextSession;
}

function removeEmptyAssistantMessages(items: TimelineItem[]): TimelineItem[] {
  return items.filter(
    (item) => item.kind !== "assistant" || item.content.trim().length > 0,
  );
}

function getActiveAssistantMessageId(
  session: SessionViewModel,
): string | undefined {
  const activeAssistant = [...session.timeline]
    .reverse()
    .find((item) => item.kind === "assistant" && item.streaming === true);
  return activeAssistant?.id;
}

function getMostRecentAssistantMessageId(
  session: SessionViewModel,
): string | undefined {
  return [...session.timeline]
    .reverse()
    .find((item) => item.kind === "assistant")?.id;
}

function getAssistantContent(
  items: TimelineItem[],
  id: string,
): string | undefined {
  const existing = items.find(
    (item) => item.kind === "assistant" && item.id === id,
  );
  return existing?.kind === "assistant" ? existing.content : undefined;
}

function shouldAppendShortStreamingReplacement(
  existingContent: string | undefined,
  nextContent: string,
  done: boolean,
): boolean {
  return (
    existingContent !== undefined &&
    !done &&
    nextContent.length > 0 &&
    nextContent.length < existingContent.length &&
    nextContent !== existingContent
  );
}

function upsertToolMessage(
  items: TimelineItem[],
  toolItem: Extract<TimelineItem, { kind: "tool" }>,
): TimelineItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.id !== toolItem.id) {
      return item;
    }
    found = true;
    return toolItem;
  });
  return found ? next : [...next, toolItem];
}

function upsertAssistantMessage(
  items: TimelineItem[],
  id: string,
  content: string,
  streaming: boolean,
): TimelineItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.kind !== "assistant" || item.id !== id) {
      return item;
    }
    found = true;
    return { ...item, content, streaming };
  });
  if (found) {
    return next;
  }
  return [
    ...next,
    { id, kind: "assistant", content, createdAt: formatTime(), streaming },
  ];
}

function upsertThinkingMessage(
  items: TimelineItem[],
  id: string,
  content: string,
  streaming: boolean,
): TimelineItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.kind !== "thinking" || item.id !== id) {
      return item;
    }
    found = true;
    return { ...item, content, streaming };
  });
  if (found) {
    return next;
  }
  return [
    ...next,
    { id, kind: "thinking", content, createdAt: formatTime(), streaming },
  ];
}

function backendLabel(session: SessionViewModel): string {
  return backendLabelFromMode(session.backendMode ?? "fake");
}

function backendLabelFromMode(mode: "fake" | "real"): string {
  return mode === "real" ? "Pi RPC backend" : "local demo backend";
}

function appendDiagnostic(
  session: SessionViewModel,
  diagnostic: { tone: "info" | "error"; content: string },
): SessionViewModel {
  return {
    ...session,
    status: diagnostic.tone === "error" ? "error" : session.status,
    baseState: diagnostic.tone === "error" ? "error" : session.baseState,
    ...(diagnostic.tone === "error" ? { lastError: diagnostic.content } : {}),
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline: [
      ...session.timeline,
      {
        id: createId("diagnostic"),
        kind: "diagnostic",
        tone: diagnostic.tone,
        content: diagnostic.content,
        createdAt: formatTime(),
      },
    ],
  };
}

function appendRuntimeErrorDiagnostic(
  session: SessionViewModel,
  content: string,
): SessionViewModel {
  const mostRecentTimelineItem = session.timeline[session.timeline.length - 1];
  if (
    mostRecentTimelineItem?.kind === "diagnostic" &&
    mostRecentTimelineItem.tone === "error" &&
    mostRecentTimelineItem.content === content
  ) {
    return { ...session, lastError: content };
  }

  // Callers have already reduced the runtime event's state. Unlike a local UI
  // failure, recording its diagnostic must not reclassify a still-actionable
  // extension request from waiting back to error.
  return {
    ...session,
    lastError: content,
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline: [
      ...session.timeline,
      {
        id: createId("diagnostic"),
        kind: "diagnostic",
        tone: "error",
        content,
        createdAt: formatTime(),
      },
    ],
  };
}

function getRuntimeEventErrorMessage(
  event: ChatRuntimeEvent,
): string | undefined {
  const directError =
    getString(event, "error") ??
    getString(event, "errorMessage") ??
    getString(event, "finalError") ??
    getString(event, "message");
  if (directError !== undefined) {
    return directError;
  }

  const assistantEvent = getRecord(event, "assistantMessageEvent");
  return (
    getErrorMessageFromRecord(getRecord(event, "error")) ??
    getAssistantMessageEventErrorMessage(assistantEvent) ??
    getAssistantMessageErrorMessage(getRecord(event, "message")) ??
    getAssistantMessageErrorMessage(getFinalAssistantMessage(event))
  );
}

function isAuthenticatedModelCompletion(event: ChatRuntimeEvent): boolean {
  const status = getString(event, "status");
  if (status === "aborted" || status === "error" || status === "failed") {
    return false;
  }
  return isSuccessfulOpenAiCodexTerminalCompletion(
    getFinalAssistantMessage(event),
  );
}

function isSuccessfulModelCompletion(event: ChatRuntimeEvent): boolean {
  const assistant = getFinalAssistantMessage(event);
  return assistant !== undefined
    ? isSuccessfulTerminalAssistantCompletion(assistant)
    : isSuccessfulTerminalStatus(getString(event, "status"));
}

function hasRuntimeEventError(event: ChatRuntimeEvent): boolean {
  const status = getString(event, "status");
  const assistantEvent = getRecord(event, "assistantMessageEvent");
  return (
    status === "error" ||
    status === "failed" ||
    hasDirectRuntimeEventError(event) ||
    isAssistantMessageEventFailure(assistantEvent) ||
    isErrorAssistantMessage(getRecord(event, "message")) ||
    isErrorAssistantMessage(getRecordFromRecord(assistantEvent, "error")) ||
    isErrorAssistantMessage(getFinalAssistantMessage(event))
  );
}

function hasDirectRuntimeEventError(event: ChatRuntimeEvent): boolean {
  return (
    getString(event, "error") !== undefined ||
    getString(event, "errorMessage") !== undefined ||
    getString(event, "finalError") !== undefined ||
    getString(event, "message") !== undefined ||
    getErrorMessageFromRecord(getRecord(event, "error")) !== undefined
  );
}

function isAssistantMessageEventFailure(
  assistantEvent: Record<string, unknown> | undefined,
): boolean {
  if (getStringFromRecord(assistantEvent, "type") !== "error") {
    return false;
  }
  return (
    getStringFromRecord(assistantEvent, "reason") !== "aborted" &&
    getStringFromRecord(
      getRecordFromRecord(assistantEvent, "error"),
      "stopReason",
    ) !== "aborted"
  );
}

function isErrorAssistantMessage(
  message: Record<string, unknown> | undefined,
): boolean {
  const stopReason = getStringFromRecord(message, "stopReason");
  return (
    stopReason !== "aborted" &&
    (stopReason === "error" ||
      getAssistantMessageErrorMessage(message) !== undefined)
  );
}

function getAssistantMessageEventErrorMessage(
  assistantEvent: Record<string, unknown> | undefined,
): string | undefined {
  return (
    getErrorMessageFromRecord(getRecordFromRecord(assistantEvent, "error")) ??
    getAssistantMessageErrorMessage(
      getRecordFromRecord(assistantEvent, "message"),
    ) ??
    getAssistantMessageErrorMessage(
      getRecordFromRecord(assistantEvent, "partial"),
    ) ??
    getStringFromRecord(assistantEvent, "errorMessage")
  );
}

function getAssistantMessageErrorMessage(
  message: Record<string, unknown> | undefined,
): string | undefined {
  return (
    getStringFromRecord(message, "errorMessage") ??
    getStringFromRecord(message, "error") ??
    getErrorMessageFromRecord(getRecordFromRecord(message, "error"))
  );
}

function getErrorMessageFromRecord(
  error: Record<string, unknown> | undefined,
): string | undefined {
  return (
    getStringFromRecord(error, "errorMessage") ??
    getStringFromRecord(error, "message") ??
    getStringFromRecord(error, "error")
  );
}

function getFinalAssistantMessage(
  event: ChatRuntimeEvent,
): Record<string, unknown> | undefined {
  const messages = getArray(event, "messages");
  if (messages === undefined) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (getStringFromRecord(record, "role") === "assistant") {
      return record;
    }
  }

  return undefined;
}

function getString(event: ChatRuntimeEvent, key: string): string | undefined {
  const value = getUnknown(event, key);
  return typeof value === "string" ? value : undefined;
}

function getRecord(
  event: ChatRuntimeEvent,
  key: string,
): Record<string, unknown> | undefined {
  const value = getUnknown(event, key);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getStringFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function getRecordFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return recordFromUnknown(record?.[key]);
}

function getNumberFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function recordFromUnknown(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return undefined;
  }
  return value === undefined || value === null ? undefined : String(value);
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => value !== undefined);
}

function getArray(event: ChatRuntimeEvent, key: string): unknown[] | undefined {
  const value = getUnknown(event, key);
  return Array.isArray(value) ? value : undefined;
}

function getNumber(event: ChatRuntimeEvent, key: string): number | undefined {
  const value = getUnknown(event, key);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getBoolean(event: ChatRuntimeEvent, key: string): boolean | undefined {
  const value = getUnknown(event, key);
  return typeof value === "boolean" ? value : undefined;
}

function getUnknown(event: ChatRuntimeEvent, key: string): unknown {
  return (event as Record<string, unknown>)[key];
}

function formatMessageTime(timestamp: number | undefined): string {
  if (timestamp === undefined) {
    return formatTime();
  }
  const date = new Date(
    timestamp > 10_000_000_000 ? timestamp : timestamp * 1000,
  );
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatTime(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
