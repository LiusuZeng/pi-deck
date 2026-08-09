import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowRun } from "./workflowEngine.js";
import {
  rehydrateCanonicalWorkflowRuns,
  rehydrateWorkflowRuns,
} from "./workflowRehydration.js";
import {
  createWorkflowRoleRun,
  startWorkflowOccurrence,
} from "./agentWorkflowRuntime.js";
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
  it("keeps queued canonical work resumable and schedules it after runtime readiness", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "queued",
      revision: 1,
      name: "Queued",
      inputs: [],
      entryNodeId: "work",
      nodes: [
        {
          id: "work",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "work" },
        },
      ],
      relationships: [{ id: "end", from: "work", to: { end: "completed" } }],
    };
    const initial = createWorkflowRoleRun(definition, "workspace");
    const queued = {
      ...initial,
      occurrences: initial.occurrences.map((item) => ({
        ...item,
        status: "queued" as const,
      })),
    };
    const updated: (typeof initial)[] = [];
    const scheduled: (typeof initial)[] = [];
    await rehydrateCanonicalWorkflowRuns([queued], {
      resolveWorkspace: async () => undefined,
      updateRun: async (run) => {
        updated.push(run);
        return run;
      },
      schedule: async (run) => {
        scheduled.push(run);
        return run;
      },
      emit: () => undefined,
      recordError: () => undefined,
    });
    expect(updated[0].status).toBe("waiting");
    expect(updated[0].occurrences[0].status).toBe("ready");
    expect(scheduled).toHaveLength(1);
  });

  it("marks genuinely lost canonical running ownership as attention without scheduling", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "running",
      revision: 1,
      name: "Running",
      inputs: [],
      entryNodeId: "work",
      nodes: [
        {
          id: "work",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "work" },
        },
      ],
      relationships: [{ id: "end", from: "work", to: { end: "completed" } }],
    };
    const initial = createWorkflowRoleRun(definition, "workspace");
    const running = startWorkflowOccurrence(
      initial,
      initial.occurrences[0].id,
      "runtime",
    );
    const withSavedFile = {
      ...running,
      occurrences: running.occurrences.map((item) => ({
        ...item,
        sessionFile: "/tmp/interrupted.jsonl",
      })),
    };
    const updated: (typeof initial)[] = [];
    const scheduled: (typeof initial)[] = [];
    await rehydrateCanonicalWorkflowRuns([withSavedFile], {
      resolveWorkspace: async () => undefined,
      updateRun: async (run) => {
        updated.push(run);
        return run;
      },
      schedule: async (run) => {
        scheduled.push(run);
        return run;
      },
      emit: () => undefined,
      recordError: () => undefined,
    });
    expect(scheduled).toHaveLength(0);
    expect(updated[0]?.occurrences[0]).toMatchObject({
      status: "failed",
      sessionFile: "/tmp/interrupted.jsonl",
    });
    expect(updated[0]?.occurrences[0]).not.toHaveProperty("runtimeId");
  });

  it("removes stale runtime IDs from completed records but keeps reopen files", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "completed",
      revision: 1,
      name: "Completed",
      inputs: [],
      entryNodeId: "work",
      nodes: [
        {
          id: "work",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "work" },
        },
      ],
      relationships: [{ id: "end", from: "work", to: { end: "completed" } }],
    };
    const initial = createWorkflowRoleRun(definition, "workspace");
    const completed = {
      ...initial,
      status: "completed" as const,
      occurrences: initial.occurrences.map((item) => ({
        ...item,
        status: "completed" as const,
        runtimeId: "stale-runtime",
        sessionFile: "/tmp/completed.jsonl",
      })),
    };
    const updated: (typeof initial)[] = [];
    const emitted: (typeof initial)[] = [];
    const scheduled: (typeof initial)[] = [];
    await rehydrateCanonicalWorkflowRuns([completed], {
      resolveWorkspace: async () => undefined,
      updateRun: async (run) => {
        updated.push(run);
        return run;
      },
      schedule: async (run) => {
        scheduled.push(run);
        return run;
      },
      emit: (run) => emitted.push(run),
      recordError: () => undefined,
    });
    expect(updated).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(scheduled).toHaveLength(0);
    expect(updated[0]).toMatchObject({ status: "completed" });
    expect(updated[0]?.occurrences[0]).toMatchObject({
      sessionFile: "/tmp/completed.jsonl",
    });
    expect(updated[0]?.occurrences[0]).not.toHaveProperty("runtimeId");
  });
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
