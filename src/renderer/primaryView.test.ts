import { describe, expect, it } from "vitest";
import {
  allWorkView,
  backToWorkView,
  replaceSessionRouteId,
  sessionView,
  workflowSidebarView,
  workflowView,
  workOriginForPrimaryView,
  workScopeForNewSession,
  workspaceWorkView,
} from "./primaryView.js";

describe("primary renderer view transitions", () => {
  it("models global and workspace Work as distinct primary views", () => {
    expect(allWorkView()).toEqual({ kind: "work", scope: { type: "all" } });
    expect(workspaceWorkView("workspace-a")).toEqual({
      kind: "work",
      scope: { type: "workspace", workspaceId: "workspace-a" },
    });
  });

  it("supports All Work -> A -> B -> All Work without using active workspace state", () => {
    const all = allWorkView();
    const workspaceA = workspaceWorkView("workspace-a");
    const workspaceB = workspaceWorkView("workspace-b");

    expect(
      [all, workspaceA, workspaceB, all].map((view) => view.scope),
    ).toEqual([
      { type: "all" },
      { type: "workspace", workspaceId: "workspace-a" },
      { type: "workspace", workspaceId: "workspace-b" },
      { type: "all" },
    ]);
  });

  it("keeps a concrete Work origin through session drill-in and Back", () => {
    const origin = workspaceWorkView("workspace-a");
    const session = sessionView("runtime-a", origin);

    expect(session).toEqual({
      kind: "session",
      sessionId: "runtime-a",
      origin,
    });
    expect(backToWorkView(session)).toBe(origin);
    expect(
      replaceSessionRouteId(session, "runtime-a", "runtime-a-resumed"),
    ).toEqual({
      ...session,
      sessionId: "runtime-a-resumed",
    });
  });

  it("preserves Work origin while navigating workflow surfaces", () => {
    const origin = allWorkView();
    const workflow = workflowView("agentHome", origin);

    expect(workOriginForPrimaryView(workflow, "workspace-a")).toBe(origin);
    expect(workflowSidebarView(workflow)).toBe("agentHome");
    expect(workflowSidebarView(workflowView("occurrenceRun", origin))).toBe(
      "runs",
    );
  });

  it("resolves New Session scope from the active primary view", () => {
    const workspace = workspaceWorkView("workspace-a");
    expect(workScopeForNewSession(allWorkView(), "workspace-b")).toEqual({
      type: "all",
    });
    expect(workScopeForNewSession(workspace, "workspace-b")).toEqual({
      type: "workspace",
      workspaceId: "workspace-a",
    });
    expect(
      workScopeForNewSession(
        sessionView("runtime-a", workspace),
        "workspace-b",
      ),
    ).toEqual({ type: "workspace", workspaceId: "workspace-a" });
  });
});
