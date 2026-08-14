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
  completeWorkflowOccurrence,
  createWorkflowRoleRun,
  retryWorkflowOccurrence,
  startWorkflowOccurrence,
} from "./agentWorkflowRuntime.js";
import { renderWorkflowOccurrencePrompt } from "./workflowPromptRenderer.js";
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
      id: "00000000-0000-4000-8000-000000000101",
      revision: 1,
      name: "Queued",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000104",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000104",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "work" },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000105",
          from: "00000000-0000-4000-8000-000000000104",
          to: { end: "completed" },
        },
      ],
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
      id: "00000000-0000-4000-8000-000000000102",
      revision: 1,
      name: "Running",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000104",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000104",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "work" },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000105",
          from: "00000000-0000-4000-8000-000000000104",
          to: { end: "completed" },
        },
      ],
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

  it("recovers a bound attempt from persisted state and retries its immutable handoff", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000120",
      revision: 1,
      name: "Bound restart",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000121",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000121",
          name: "Source",
          role: "worker" as const,
          config: { instructions: "source" },
        },
        {
          id: "00000000-0000-4000-8000-000000000122",
          name: "Target",
          role: "worker" as const,
          inputBindings: [
            {
              sourceNodeId: "00000000-0000-4000-8000-000000000121",
              sourceValue: "finalOutput" as const,
              label: "Saved source",
            },
          ],
          config: { instructions: "target" },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000123",
          from: "00000000-0000-4000-8000-000000000121",
          to: { nodeId: "00000000-0000-4000-8000-000000000122" },
        },
      ],
    };
    let persisted = createWorkflowRoleRun(definition, "workspace", {}, 1);
    persisted = startWorkflowOccurrence(
      persisted,
      persisted.occurrences[0]!.id,
      "source-runtime",
      undefined,
      2,
    );
    persisted = completeWorkflowOccurrence(
      persisted,
      persisted.occurrences[0]!.id,
      "persisted output",
      3,
    );
    const source = persisted.occurrences[0]!;
    const target = persisted.occurrences.at(-1)!;
    persisted = startWorkflowOccurrence(
      persisted,
      target.id,
      "target-runtime",
      undefined,
      4,
    );
    let recovered: typeof persisted | undefined;
    await rehydrateCanonicalWorkflowRuns(
      [persisted],
      {
        resolveWorkspace: async () => undefined,
        updateRun: async (run) => {
          recovered = run;
          return run;
        },
        schedule: async (run) => run,
        emit: () => undefined,
        recordError: () => undefined,
      },
      5,
    );
    expect(recovered?.occurrences.at(-1)).toMatchObject({
      status: "failed",
      resolvedInputBindings: [
        {
          label: "Saved source",
          value: "persisted output",
          sourceOccurrenceId: source.id,
        },
      ],
    });
    const retried = retryWorkflowOccurrence(recovered!, target.id, 6);
    const retry = retried.occurrences.at(-1)!;
    expect(retry.resolvedInputBindings?.[0]?.sourceOccurrenceId).toBe(
      source.id,
    );
    expect(renderWorkflowOccurrencePrompt(retried, retry)).toContain(
      "Saved source:\npersisted output",
    );
  });

  it("removes stale runtime IDs from completed records but keeps reopen files", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000103",
      revision: 1,
      name: "Completed",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000104",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000104",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "work" },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000105",
          from: "00000000-0000-4000-8000-000000000104",
          to: { end: "completed" },
        },
      ],
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
