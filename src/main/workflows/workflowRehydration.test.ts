import { describe, expect, it } from "vitest";
import { createWorkflowRun } from "./workflowEngine.js";
import { rehydrateWorkflowRuns } from "./workflowRehydration.js";
import type { WorkflowTemplate } from "../../shared/workflowSchemas.js";

const template: WorkflowTemplate = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Rehydrate me",
  inputs: [],
  steps: [
    {
      id: "step",
      name: "Step",
      kind: "agent",
      promptParts: [{ type: "text", text: "Continue." }],
      inputPolicy: {
        includeWorkflowContext: true,
        includeParentFinalAnswer: true,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
      startPolicy: "auto",
    },
  ],
  transitions: [],
  createdAtMs: 1,
  updatedAtMs: 1,
};

describe("workflow rehydration", () => {
  it("rehydrates only the workspace released by a restore", async () => {
    const restoredRun = createWorkflowRun({
      template,
      workspaceId: "restored-workspace",
      inputs: {},
      now: 10,
    });
    const unrelatedRun = createWorkflowRun({
      template,
      workspaceId: "other-workspace",
      inputs: {},
      now: 10,
    });
    const scheduledIds: string[] = [];

    await rehydrateWorkflowRuns(
      [restoredRun, unrelatedRun],
      {
        resolveWorkspace: async () => undefined,
        updateRun: async (next) => next,
        schedule: async (next) => {
          scheduledIds.push(next.id);
          return next;
        },
        emit: () => undefined,
        recordError: () => undefined,
      },
      20,
      "restored-workspace",
    );

    expect(scheduledIds).toEqual([restoredRun.id]);
  });

  it("keeps an archived workspace run resumable without throwing", async () => {
    const run = createWorkflowRun({
      template,
      workspaceId: "archived-workspace",
      inputs: {},
      now: 10,
    });
    const otherRun = createWorkflowRun({
      template,
      workspaceId: "restored-workspace",
      inputs: {},
      now: 10,
    });
    const errors: string[] = [];
    const scheduledIds: string[] = [];

    await expect(
      rehydrateWorkflowRuns(
        [run, otherRun],
        {
          resolveWorkspace: async (workspaceId) => {
            if (workspaceId === "archived-workspace") {
              throw new Error("Workspace is archived: archived-workspace");
            }
          },
          updateRun: async (next) => next,
          schedule: async (next) => {
            scheduledIds.push(next.id);
            return next;
          },
          emit: () => undefined,
          recordError: (message) => errors.push(message),
        },
        20,
      ),
    ).resolves.toBeUndefined();

    expect(scheduledIds).toEqual([otherRun.id]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/archived-workspace/);
    expect(errors[0]).toMatch(/resumable/);
    expect(run.status).toBe("waiting");
    expect(run.stepRuns[0]?.status).toBe("ready");
  });
});
