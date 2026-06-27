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

export function getQueuedCount(overlays: SessionOverlays): number {
  return (
    overlays.localQueuedStartCount +
    overlays.piQueuedSteeringCount +
    overlays.piQueuedFollowUpCount
  );
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
