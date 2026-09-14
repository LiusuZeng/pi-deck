import { describe, expect, it } from "vitest";
import { allWorkView, sessionView, workspaceWorkView } from "./primaryView.js";
import {
  planSessionWorkspaceNavigation,
  staleWorkspaceSelectionCompensation,
} from "./sessionWorkspaceNavigation.js";

describe("session workspace navigation", () => {
  it("preserves an all-work origin while activating a cross-workspace session owner", () => {
    expect(
      planSessionWorkspaceNavigation({
        generation: 4,
        primaryView: allWorkView(),
        activeWorkspaceId: "workspace-a",
        ownerWorkspaceId: "workspace-b",
      }),
    ).toEqual({
      generation: 4,
      origin: allWorkView(),
      ownerWorkspaceId: "workspace-b",
      requiresWorkspaceActivation: true,
    });
  });

  it("keeps a scoped route origin for cross-workspace session and activity routing", () => {
    const scopedWork = workspaceWorkView("workspace-a");
    const priorSession = sessionView("session-a", scopedWork);

    expect(
      planSessionWorkspaceNavigation({
        generation: 7,
        primaryView: priorSession,
        activeWorkspaceId: "workspace-a",
        ownerWorkspaceId: "workspace-b",
      }),
    ).toMatchObject({
      origin: scopedWork,
      ownerWorkspaceId: "workspace-b",
      requiresWorkspaceActivation: true,
    });
  });

  it("does not activate the workspace for a same-owner session", () => {
    expect(
      planSessionWorkspaceNavigation({
        generation: 2,
        primaryView: workspaceWorkView("workspace-b"),
        activeWorkspaceId: "workspace-b",
        ownerWorkspaceId: "workspace-b",
      }).requiresWorkspaceActivation,
    ).toBe(false);
  });

  it("compensates a stale main-process selection only when newer intent differs", () => {
    expect(
      staleWorkspaceSelectionCompensation({
        currentGeneration: 9,
        requestedGeneration: 8,
        requestedWorkspaceId: "workspace-a",
        latestWorkspaceSelectionTarget: "workspace-b",
      }),
    ).toBe("workspace-b");
    expect(
      staleWorkspaceSelectionCompensation({
        currentGeneration: 8,
        requestedGeneration: 8,
        requestedWorkspaceId: "workspace-a",
        latestWorkspaceSelectionTarget: "workspace-b",
      }),
    ).toBeUndefined();
    expect(
      staleWorkspaceSelectionCompensation({
        currentGeneration: 9,
        requestedGeneration: 8,
        requestedWorkspaceId: "workspace-a",
        latestWorkspaceSelectionTarget: "workspace-a",
      }),
    ).toBeUndefined();
  });
});
