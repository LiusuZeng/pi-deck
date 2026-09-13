import type { FailureKind } from "./openaiCodexAuth.js";
import type { BaseSessionState, SessionOverlays } from "./sessionState.js";

/** The compact runtime fields reconciliation needs; the full IPC payload stays App-owned. */
export interface RuntimeStatusForSessionReconciliation {
  runtimeId: string;
  state: {
    isAgentActive: boolean;
  };
}

export type ReconciliationSessionStatus =
  | "idle"
  | "starting"
  | "sending"
  | "working"
  | "aborting"
  | "reconnecting"
  | "waiting"
  | "error";

/**
 * The lifecycle projection reconciliation changes. Timeline construction and
 * other view-model fields deliberately remain owned by App.
 */
export interface SessionForRuntimeReconciliation {
  id: string;
  status: ReconciliationSessionStatus;
  baseState: BaseSessionState;
  overlays: SessionOverlays;
  subtitle: string;
  updatedAt: string;
  updatedAtMs: number;
  lastRuntimeEventLabel?: string | undefined;
  lastError?: string | undefined;
  awaitingAgentEnd?: boolean | undefined;
  providerErrorObserved?: boolean | undefined;
  failureKind?: FailureKind | undefined;
  workingStartedAtMs?: number | undefined;
}

/** App supplies presentation and timeline construction without widening this domain. */
export interface SessionRuntimeReconciliationDependencies<
  TSession extends SessionForRuntimeReconciliation,
> {
  backendLabel(session: TSession): string;
  appendInfoDiagnostic(session: TSession, content: string): TSession;
  now(): number;
}

export function reconcileSessionWithRuntimeStatus<
  TSession extends SessionForRuntimeReconciliation,
>(
  session: TSession,
  runtimeStatus: RuntimeStatusForSessionReconciliation,
  dependencies: SessionRuntimeReconciliationDependencies<TSession>,
): TSession {
  // A response for another runtime must never mutate the selected/session row.
  if (runtimeStatus.runtimeId !== session.id) {
    return session;
  }
  // Extension UI input remains pending until its response is delivered or the
  // request times out, regardless of the compact runtime's active flag.
  if (session.status === "waiting") {
    return session;
  }

  if (runtimeStatus.state.isAgentActive) {
    // Abort remains pending until Pi reports a terminal completion event or an
    // authoritative inactive status; a still-active status is not success.
    if (session.status === "aborting" || session.status === "working") {
      return session;
    }
    return {
      ...session,
      status: "working",
      baseState: "working",
      overlays: { ...session.overlays, streaming: true },
      subtitle: `Working · ${dependencies.backendLabel(session)} confirmed by Pi`,
      lastRuntimeEventLabel: "Pi reconciliation confirmed active work",
    };
  }

  const authStillPending = session.failureKind === "auth-required";
  return dependencies.appendInfoDiagnostic(
    {
      ...session,
      status: authStillPending ? "error" : "idle",
      baseState: authStillPending ? "error" : "idle",
      awaitingAgentEnd: false,
      providerErrorObserved: authStillPending
        ? session.providerErrorObserved === true
        : false,
      ...(authStillPending ? {} : { lastError: undefined }),
      overlays: {
        ...session.overlays,
        streaming: false,
        toolRunning: false,
        retrying: false,
      },
      workingStartedAtMs: undefined,
      subtitle: authStillPending
        ? "Error · OpenAI authentication verification pending"
        : `Idle · ${dependencies.backendLabel(session)} reconciled`,
      lastRuntimeEventLabel: "Pi reconciliation confirmed completion",
      updatedAt: "Now",
      updatedAtMs: dependencies.now(),
    },
    "Reconciled from Pi runtime status because the live completion event was not observed.",
  );
}
