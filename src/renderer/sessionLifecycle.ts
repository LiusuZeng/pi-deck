export type SessionTerminalOutcome = "completed" | "failed" | "aborted";

/**
 * Canonical turn lifecycle. Waiting for Extension UI is deliberately not a
 * phase: it is an actionable overlay that may outlive the terminal event for
 * the turn that created it.
 */
export type SessionLifecycle =
  | { phase: "inactive" }
  | { phase: "active"; turnId?: string }
  | { phase: "aborting"; turnId?: string }
  | {
      phase: "terminal";
      outcome: SessionTerminalOutcome;
      settledAtMs: number;
      turnId?: string;
    };

export type SessionLifecycleTransition =
  | { type: "turnStarted"; turnId?: string }
  | { type: "abortRequested" }
  | { type: "retryStarted"; turnId?: string }
  | {
      type: "turnSettled";
      outcome: SessionTerminalOutcome;
      settledAtMs: number;
      turnId?: string;
    }
  | { type: "runtimeInactive"; settledAtMs: number };

export interface LegacyLifecycleProjection {
  lifecycle?: SessionLifecycle | undefined;
  status?: string | undefined;
  baseState?: string | undefined;
  completedAtMs?: number | undefined;
  providerErrorObserved?: boolean | undefined;
  failureKind?: string | undefined;
}

export const inactiveSessionLifecycle: SessionLifecycle = Object.freeze({
  phase: "inactive",
});

export function activeSessionLifecycle(turnId?: string): SessionLifecycle {
  return turnId === undefined
    ? { phase: "active" }
    : { phase: "active", turnId };
}

export function terminalSessionLifecycle(
  outcome: SessionTerminalOutcome,
  settledAtMs: number,
  turnId?: string,
): SessionLifecycle {
  return turnId === undefined
    ? { phase: "terminal", outcome, settledAtMs }
    : { phase: "terminal", outcome, settledAtMs, turnId };
}

/**
 * Compatibility is resolved once at domain boundaries. When lifecycle is
 * present it is authoritative, even if older presentation fields are stale.
 */
export function resolveSessionLifecycle(
  source: LegacyLifecycleProjection,
): SessionLifecycle {
  if (source.lifecycle !== undefined) return source.lifecycle;

  if (
    source.providerErrorObserved === true ||
    source.failureKind !== undefined ||
    source.baseState === "error" ||
    source.status === "error"
  ) {
    return terminalSessionLifecycle(
      "failed",
      validTimestamp(source.completedAtMs) ?? 0,
    );
  }
  if (source.status === "aborting") return { phase: "aborting" };
  if (
    source.status === "starting" ||
    source.status === "sending" ||
    source.status === "reconnecting" ||
    source.status === "working" ||
    source.baseState === "attaching" ||
    source.baseState === "working"
  ) {
    return activeSessionLifecycle();
  }
  const completedAtMs = validTimestamp(source.completedAtMs);
  return completedAtMs === undefined
    ? inactiveSessionLifecycle
    : terminalSessionLifecycle("completed", completedAtMs);
}

export function transitionSessionLifecycle(
  current: SessionLifecycle,
  transition: SessionLifecycleTransition,
): SessionLifecycle {
  switch (transition.type) {
    case "turnStarted":
      return activeSessionLifecycle(transition.turnId);
    case "retryStarted":
      return activeSessionLifecycle(
        transition.turnId ?? ("turnId" in current ? current.turnId : undefined),
      );
    case "abortRequested":
      return current.phase === "terminal"
        ? current
        : !("turnId" in current) || current.turnId === undefined
          ? { phase: "aborting" }
          : { phase: "aborting", turnId: current.turnId };
    case "turnSettled":
      return settleLifecycle(
        current,
        transition.outcome,
        transition.settledAtMs,
        transition.turnId,
      );
    case "runtimeInactive":
      if (current.phase === "terminal") return current;
      return terminalSessionLifecycle(
        current.phase === "aborting" ? "aborted" : "completed",
        transition.settledAtMs,
        "turnId" in current ? current.turnId : undefined,
      );
  }
}

export function settleLifecycle(
  current: SessionLifecycle,
  outcome: SessionTerminalOutcome,
  settledAtMs: number,
  turnId?: string,
): SessionLifecycle {
  // Terminal evidence belongs to one turn and is immutable. Only an explicit
  // turnStarted/retryStarted transition may create a lifecycle whose outcome
  // can later differ. This also prevents delayed errors from rewriting a
  // completion (and vice versa).
  if (current.phase === "terminal") return current;
  return terminalSessionLifecycle(
    outcome,
    settledAtMs,
    turnId ?? ("turnId" in current ? current.turnId : undefined),
  );
}

export function lifecycleCompletedAtMs(
  lifecycle: SessionLifecycle,
): number | undefined {
  return lifecycle.phase === "terminal" && lifecycle.outcome !== "failed"
    ? lifecycle.settledAtMs
    : undefined;
}

export function lifecycleBaseState(
  lifecycle: SessionLifecycle,
  waitingForInput: boolean,
): "idle" | "working" | "waitingForInput" | "error" {
  if (waitingForInput) return "waitingForInput";
  if (lifecycle.phase === "active" || lifecycle.phase === "aborting") {
    return "working";
  }
  if (lifecycle.phase === "terminal" && lifecycle.outcome === "failed") {
    return "error";
  }
  return "idle";
}

export function lifecycleSessionStatus(
  lifecycle: SessionLifecycle,
  waitingForInput: boolean,
): "idle" | "working" | "aborting" | "waiting" | "error" {
  if (waitingForInput) return "waiting";
  if (lifecycle.phase === "aborting") return "aborting";
  if (lifecycle.phase === "active") return "working";
  if (lifecycle.phase === "terminal" && lifecycle.outcome === "failed") {
    return "error";
  }
  return "idle";
}

export function isLifecycleActive(lifecycle: SessionLifecycle): boolean {
  return lifecycle.phase === "active" || lifecycle.phase === "aborting";
}

function validTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    !Number.isNaN(new Date(value).getTime())
    ? value
    : undefined;
}
