import {
  workOriginForPrimaryView,
  type PrimaryView,
  type WorkOrigin,
} from "./primaryView.js";

/**
 * Pure route/ownership policy for opening a session or activity item. Effects
 * (main-process selection, React commits, and compensation IPC) stay in App.
 */
export interface SessionWorkspaceNavigation {
  generation: number;
  origin: WorkOrigin;
  ownerWorkspaceId: string;
  requiresWorkspaceActivation: boolean;
}

export function planSessionWorkspaceNavigation(input: {
  generation: number;
  primaryView: PrimaryView;
  activeWorkspaceId: string;
  ownerWorkspaceId: string;
}): SessionWorkspaceNavigation {
  return {
    generation: input.generation,
    origin: workOriginForPrimaryView(
      input.primaryView,
      input.activeWorkspaceId,
    ),
    ownerWorkspaceId: input.ownerWorkspaceId,
    requiresWorkspaceActivation:
      input.activeWorkspaceId !== input.ownerWorkspaceId,
  };
}

/** Undefined means the stale main-process selection already matches intent. */
export function staleWorkspaceSelectionCompensation(input: {
  currentGeneration: number;
  requestedGeneration: number;
  requestedWorkspaceId: string;
  latestWorkspaceSelectionTarget: string;
}): string | undefined {
  return input.currentGeneration !== input.requestedGeneration &&
    input.latestWorkspaceSelectionTarget !== input.requestedWorkspaceId
    ? input.latestWorkspaceSelectionTarget
    : undefined;
}
