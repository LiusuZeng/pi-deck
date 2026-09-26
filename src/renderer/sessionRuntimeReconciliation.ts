import type { FailureKind } from "./openaiCodexAuth.js";
import type { BaseSessionState, SessionOverlays } from "./sessionState.js";
import {
  lifecycleBaseState,
  lifecycleCompletedAtMs,
  lifecycleSessionStatus,
  resolveSessionLifecycle,
  settleLifecycle,
  transitionSessionLifecycle,
  type SessionLifecycle,
} from "./sessionLifecycle.js";

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

/** The only session fields the status-polling eligibility decision needs. */
export interface SessionForRuntimeReconciliationEligibility {
  runtimeBacked: boolean;
  status: ReconciliationSessionStatus;
  overlays: Pick<
    SessionOverlays,
    "streaming" | "toolRunning" | "compacting" | "retrying"
  >;
}

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
  completedAtMs?: number | undefined;
  lifecycle?: SessionLifecycle | undefined;
}

/** App supplies presentation and timeline construction without widening this domain. */
export interface SessionRuntimeReconciliationDependencies<
  TSession extends SessionForRuntimeReconciliation,
> {
  backendLabel(session: TSession): string;
  appendInfoDiagnostic(session: TSession, content: string): TSession;
  now(): number;
}

/**
 * Runtime events remain authoritative, but a bounded status fallback must
 * include active and waiting turns so dropping lifecycle events cannot leave
 * the UI permanently out of sync with Pi.
 */
export function shouldReconcileSession(
  session: SessionForRuntimeReconciliationEligibility,
): boolean {
  return session.runtimeBacked && isReconciliationBusy(session);
}

function isReconciliationBusy(
  session: Pick<
    SessionForRuntimeReconciliationEligibility,
    "status" | "overlays"
  >,
): boolean {
  return (
    session.status === "starting" ||
    session.status === "sending" ||
    session.status === "aborting" ||
    session.status === "reconnecting" ||
    session.status === "working" ||
    session.status === "waiting" ||
    session.overlays.retrying
  );
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
    const lifecycle = transitionSessionLifecycle(
      resolveSessionLifecycle(session),
      { type: "turnStarted" },
    );
    return {
      ...session,
      lifecycle,
      completedAtMs: undefined,
      status: "working",
      baseState: "working",
      overlays: { ...session.overlays, streaming: true },
      subtitle: `Working · ${dependencies.backendLabel(session)} confirmed by Pi`,
      lastRuntimeEventLabel: "Pi reconciliation confirmed active work",
    };
  }

  const now = dependencies.now();
  const currentLifecycle = resolveSessionLifecycle(session);
  const knownFailure =
    currentLifecycle.phase === "terminal" &&
    currentLifecycle.outcome === "failed";
  const lifecycle = knownFailure
    ? settleLifecycle(currentLifecycle, "failed", now)
    : transitionSessionLifecycle(currentLifecycle, {
        type: "runtimeInactive",
        settledAtMs: now,
      });
  const failed =
    lifecycle.phase === "terminal" && lifecycle.outcome === "failed";
  const status = lifecycleSessionStatus(lifecycle, false);
  const baseState = lifecycleBaseState(lifecycle, false);
  return dependencies.appendInfoDiagnostic(
    {
      ...session,
      lifecycle,
      completedAtMs: lifecycleCompletedAtMs(lifecycle),
      status,
      baseState,
      awaitingAgentEnd: false,
      providerErrorObserved: failed
        ? session.providerErrorObserved === true
        : false,
      ...(failed ? {} : { lastError: undefined }),
      overlays: {
        ...session.overlays,
        streaming: false,
        toolRunning: false,
        compacting: false,
        retrying: false,
      },
      workingStartedAtMs: undefined,
      subtitle: failed
        ? session.failureKind === "auth-required"
          ? "Error · OpenAI authentication verification pending"
          : "Error · backend stream failed"
        : lifecycle.phase === "terminal" && lifecycle.outcome === "aborted"
          ? "Idle · backend stream aborted"
          : `Idle · ${dependencies.backendLabel(session)} reconciled`,
      lastRuntimeEventLabel: failed
        ? "Pi reconciliation preserved terminal failure"
        : "Pi reconciliation confirmed completion",
      updatedAt: "Now",
      updatedAtMs: now,
    },
    "Reconciled from Pi runtime status because the live completion event was not observed.",
  );
}
