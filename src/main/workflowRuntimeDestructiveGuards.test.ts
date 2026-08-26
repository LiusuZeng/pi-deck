import { describe, expect, it } from "vitest";
import {
  assertNoWorkflowRuntimesForReset,
  assertRuntimeNotWorkflowOwned,
  assertSessionFileNotWorkflowOwned,
  assertWorkspaceNotWorkflowOwned,
  chatSessionIsBusyForMutation,
} from "./workflowRuntimeDestructiveGuards.js";
import { WorkflowRuntimeOwnershipRegistry } from "./workflowRuntimeOwnership.js";

function ownedRegistry() {
  const ownership = new WorkflowRuntimeOwnershipRegistry();
  ownership.claim("runtime-a", {
    scheduler: "legacy",
    runId: "run-a",
    itemId: "step-a",
    itemKind: "step",
    workspaceId: "workspace-a",
    sessionFile: "/tmp/workflow.jsonl",
  });
  return ownership;
}

describe("workflow runtime destructive guards", () => {
  it("blocks public close for workflow-owned runtimes", () => {
    const ownership = ownedRegistry();

    expect(() =>
      assertRuntimeNotWorkflowOwned(
        ownership,
        "runtime-a",
        "closing this session",
      ),
    ).toThrow(/before closing this session/);
    expect(() =>
      assertRuntimeNotWorkflowOwned(
        ownership,
        "ordinary-runtime",
        "closing this session",
      ),
    ).not.toThrow();
  });

  it("blocks single-session destructive operations for workflow-owned session files", () => {
    const ownership = ownedRegistry();

    for (const action of [
      "deleting this session",
      "moving this session",
      "removing this session",
      "archiving this session",
    ]) {
      expect(() =>
        assertSessionFileNotWorkflowOwned(
          ownership,
          "/tmp/workflow.jsonl",
          action,
        ),
      ).toThrow(new RegExp(action));
    }
    expect(() =>
      assertSessionFileNotWorkflowOwned(
        ownership,
        "/tmp/ordinary.jsonl",
        "deleting this session",
      ),
    ).not.toThrow();
  });

  it("blocks workspace archive and chat reset while workflow runtimes are owned", () => {
    const ownership = ownedRegistry();

    expect(() =>
      assertWorkspaceNotWorkflowOwned(
        ownership,
        "workspace-a",
        "archiving this workspace",
      ),
    ).toThrow(/before archiving this workspace/);
    expect(() => assertNoWorkflowRuntimesForReset(ownership)).toThrow(
      /before resetting chat/,
    );
  });

  it("blocks reset during allocation before a session file is known", () => {
    const ownership = new WorkflowRuntimeOwnershipRegistry();
    const claim = ownership.claim("runtime-allocating", {
      scheduler: "occurrence",
      runId: "run-a",
      itemId: "occurrence-a",
      itemKind: "occurrence",
      workspaceId: "workspace-a",
    });

    expect(() => assertNoWorkflowRuntimesForReset(ownership)).toThrow(
      /before resetting chat/,
    );
    expect(ownership.isSessionFileOwned("/tmp/later.jsonl")).toBe(false);

    claim.updateSessionFile("/tmp/later.jsonl");

    expect(ownership.isSessionFileOwned("/tmp/later.jsonl")).toBe(true);
  });

  it("marks workflow-owned session files busy so bulk delete skips them", () => {
    const ownership = ownedRegistry();

    expect(
      chatSessionIsBusyForMutation({
        canonicalSessionFile: "/tmp/workflow.jsonl",
        sessionFileLocks: new Map(),
        sessionResumePromises: new Map(),
        sessionMutationReservations: new Set(),
        workflowRuntimeOwnership: ownership,
      }),
    ).toBe(true);
    expect(
      chatSessionIsBusyForMutation({
        canonicalSessionFile: "/tmp/ordinary.jsonl",
        sessionFileLocks: new Map(),
        sessionResumePromises: new Map(),
        sessionMutationReservations: new Set(),
        workflowRuntimeOwnership: ownership,
      }),
    ).toBe(false);
  });
});
