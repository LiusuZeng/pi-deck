export type SessionTerminalOutcome = "completed" | "failed" | "aborted";

/**
 * Canonical turn lifecycle. Waiting for Extension UI is deliberately not a
 * phase: it is an actionable overlay that may outlive the terminal event for
 * the turn that created it.
 */
export type SessionLifecycle =
  | { phase: "inactive" }
  | { phase: "active" }
  | { phase: "aborting" }
  | {
      phase: "terminal";
      outcome: SessionTerminalOutcome;
      settledAtMs: number;
    };

export type SessionLifecycleTransition =
  | { type: "turnStarted" }
  | { type: "abortRequested" }
  | { type: "retryStarted" }
  | {
      type: "turnSettled";
      outcome: SessionTerminalOutcome;
      settledAtMs: number;
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

export function activeSessionLifecycle(): SessionLifecycle {
  return { phase: "active" };
}

export function terminalSessionLifecycle(
  outcome: SessionTerminalOutcome,
  settledAtMs: number,
): SessionLifecycle {
  return { phase: "terminal", outcome, settledAtMs };
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
    case "retryStarted":
      return activeSessionLifecycle();
    case "abortRequested":
      return current.phase === "terminal" ? current : { phase: "aborting" };
    case "turnSettled":
      return settleLifecycle(
        current,
        transition.outcome,
        transition.settledAtMs,
      );
    case "runtimeInactive":
      if (current.phase === "terminal") return current;
      return terminalSessionLifecycle(
        current.phase === "aborting" ? "aborted" : "completed",
        transition.settledAtMs,
      );
  }
}

export function settleLifecycle(
  current: SessionLifecycle,
  outcome: SessionTerminalOutcome,
  settledAtMs: number,
): SessionLifecycle {
  if (current.phase === "terminal" && current.outcome === outcome) {
    return current;
  }
  return terminalSessionLifecycle(outcome, settledAtMs);
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
