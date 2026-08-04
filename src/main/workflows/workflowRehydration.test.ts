import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowRun } from "./workflowEngine.js";
import { rehydrateWorkflowRuns } from "./workflowRehydration.js";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import type { WorkflowTemplate } from "../../shared/workflowSchemas.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

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

  it("rehydrates waiting runs immediately after their workspace is restored", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-rehydrate-"));
    tempDirs.push(root);
    const workspaces = new WorkspaceStore(root);
    const workspace = await workspaces.create({ name: "Restored workspace" });
    const archived = await workspaces.archive(workspace.id);
    expect(archived.archivedAtMs).toBeDefined();
    await workspaces.restore(workspace.id);

    const run = createWorkflowRun({
      template,
      workspaceId: workspace.id,
      inputs: {},
      now: 10,
    });
    const scheduled: string[] = [];
    await rehydrateWorkflowRuns(
      [run],
      {
        resolveWorkspace: async (workspaceId) => {
          const restored = await workspaces.getWorkspace(workspaceId);
          if (restored === undefined || restored.archivedAtMs !== undefined) {
            throw new Error(`Workspace is archived: ${workspaceId}`);
          }
        },
        updateRun: async (next) => next,
        schedule: async (next) => {
          scheduled.push(next.id);
          return next;
        },
        emit: () => undefined,
        recordError: () => undefined,
      },
      20,
    );

    expect(scheduled).toEqual([run.id]);
    expect(run.status).toBe("waiting");
    expect(run.stepRuns[0]?.status).toBe("ready");
  });
});
