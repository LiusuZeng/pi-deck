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
  failWorkflowOccurrence,
  retryWorkflowOccurrence,
  startWorkflowOccurrence,
  startWorkflowOrchestrator,
} from "./agentWorkflowRuntime.js";
import { renderWorkflowOccurrencePrompt } from "./workflowPromptRenderer.js";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { WorkflowStore } from "./workflowStore.js";
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

  it("keeps an archived canonical queue durable until restore", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000130",
      revision: 1,
      name: "Archived queue",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000131",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000131",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "work" },
        },
      ],
      relationships: [],
    };
    const initial = createWorkflowRoleRun(definition, "archived-workspace");
    const queued = {
      ...initial,
      occurrences: initial.occurrences.map((item) => ({
        ...item,
        status: "queued" as const,
      })),
    };
    const errors: string[] = [];
    const updated: (typeof initial)[] = [];
    const scheduled: (typeof initial)[] = [];

    await rehydrateCanonicalWorkflowRuns([queued], {
      resolveWorkspace: async () => {
        throw new Error("Workspace is archived: archived-workspace");
      },
      updateRun: async (run) => {
        updated.push(run);
        return run;
      },
      schedule: async (run) => {
        scheduled.push(run);
        return run;
      },
      emit: () => undefined,
      recordError: (message) => errors.push(message),
    });

    expect(updated).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
    expect(queued.occurrences[0]?.status).toBe("queued");
    expect(errors).toHaveLength(1);

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

    expect(updated.at(-1)?.occurrences[0]?.status).toBe("ready");
    expect(scheduled).toHaveLength(1);

    const ready = createWorkflowRoleRun(definition, "archived-workspace");
    await rehydrateCanonicalWorkflowRuns([ready], {
      resolveWorkspace: async () => {
        throw new Error("Workspace is archived: archived-workspace");
      },
      updateRun: async (run) => run,
      schedule: async (run) => {
        scheduled.push(run);
        return run;
      },
      emit: () => undefined,
      recordError: () => undefined,
    });
    expect(scheduled).toHaveLength(1);
    expect(ready.occurrences[0]?.status).toBe("ready");
  });

  it("preserves fan-out queue ownership across restart so concurrency remains bounded", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000106",
      revision: 1,
      name: "Fan-out restart",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000107",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000107",
          name: "Fan",
          role: "orchestrator" as const,
          config: {
            mode: "fanout" as const,
            agents: [
              "00000000-0000-4000-8000-000000000108",
              "00000000-0000-4000-8000-000000000109",
            ],
            maxConcurrency: 1,
            completion: "all" as const,
          },
        },
        ...[
          "00000000-0000-4000-8000-000000000108",
          "00000000-0000-4000-8000-000000000109",
        ].map((id) => ({
          id,
          name: id.slice(-1),
          role: "worker" as const,
          managedBy: "00000000-0000-4000-8000-000000000107",
          config: { instructions: "work" },
        })),
      ],
      relationships: [],
    };
    const initial = createWorkflowRoleRun(definition, "workspace", {}, 1);
    const queued = startWorkflowOrchestrator(
      initial,
      initial.occurrences[0]!.id,
      2,
    );
    const updated: (typeof initial)[] = [];
    await rehydrateCanonicalWorkflowRuns([queued], {
      resolveWorkspace: async () => undefined,
      updateRun: async (run) => {
        updated.push(run);
        return run;
      },
      schedule: async (run) => run,
      emit: () => undefined,
      recordError: () => undefined,
    });
    expect(updated[0]?.occurrences.map((item) => item.status)).toEqual([
      "running",
      "ready",
      "queued",
    ]);

    // A scheduler-capacity error can leave every managed child queued. Recovery
    // must refill one slot rather than waiting forever for a child completion.
    const stalled = {
      ...queued,
      occurrences: queued.occurrences.map((item) =>
        item.parentOrchestratorRunId
          ? { ...item, status: "queued" as const }
          : item,
      ),
    };
    const resumed: (typeof initial)[] = [];
    await rehydrateCanonicalWorkflowRuns([stalled], {
      resolveWorkspace: async () => undefined,
      updateRun: async (run) => {
        resumed.push(run);
        return run;
      },
      schedule: async (run) => run,
      emit: () => undefined,
      recordError: () => undefined,
    });
    expect(
      resumed[0]?.occurrences.filter((item) => item.status === "ready"),
    ).toHaveLength(1);
    expect(
      resumed[0]?.occurrences.filter((item) => item.status === "queued"),
    ).toHaveLength(1);
  });

  it("rehydrates a skipped fan-out predecessor and successful retry without exceeding concurrency", async () => {
    const fanout = "00000000-0000-4000-8000-000000000141";
    const firstWorker = "00000000-0000-4000-8000-000000000142";
    const secondWorker = "00000000-0000-4000-8000-000000000143";
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000140",
      revision: 1,
      name: "Retry fan-out restart",
      inputs: [],
      entryNodeId: fanout,
      nodes: [
        {
          id: fanout,
          name: "Fan",
          role: "orchestrator" as const,
          config: {
            mode: "fanout" as const,
            agents: [firstWorker, secondWorker],
            maxConcurrency: 1,
            completion: "all" as const,
          },
        },
        {
          id: firstWorker,
          name: "First",
          role: "worker" as const,
          managedBy: fanout,
          config: { instructions: "first" },
        },
        {
          id: secondWorker,
          name: "Second",
          role: "worker" as const,
          managedBy: fanout,
          config: { instructions: "second" },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000144",
          from: fanout,
          to: { end: "done" },
        },
      ],
    };
    let persisted = createWorkflowRoleRun(definition, "workspace", {}, 1);
    const owner = persisted.occurrences[0]!;
    persisted = startWorkflowOrchestrator(persisted, owner.id, 2);
    const first = persisted.occurrences.find(
      (item) => item.nodeId === firstWorker,
    )!;
    const second = persisted.occurrences.find(
      (item) => item.nodeId === secondWorker,
    )!;
    persisted = startWorkflowOccurrence(
      persisted,
      first.id,
      "first",
      undefined,
      3,
    );
    persisted = failWorkflowOccurrence(persisted, first.id, "first failed", 4);
    persisted = retryWorkflowOccurrence(persisted, first.id, 5);
    const retry = persisted.occurrences.at(-1)!;

    // A scheduler-capacity failure can leave every child queued. Persisted
    // occurrence order, not random IDs assigned in the same millisecond, must
    // decide which logical child gets the recovered slot.
    const olderSiblingId = "00000000-0000-4000-8000-000000000149";
    const retryId = "00000000-0000-4000-8000-000000000148";
    const stalledQueue = {
      ...persisted,
      occurrences: persisted.occurrences.map((item) =>
        item.id === second.id
          ? {
              ...item,
              id: olderSiblingId,
              status: "queued" as const,
              createdAtMs: 2,
            }
          : item.id === retry.id
            ? {
                ...item,
                id: retryId,
                status: "queued" as const,
                createdAtMs: 2,
              }
            : item,
      ),
    };
    let fifoRecovered: typeof persisted | undefined;
    await rehydrateCanonicalWorkflowRuns(
      [JSON.parse(JSON.stringify(stalledQueue))],
      {
        resolveWorkspace: async () => undefined,
        updateRun: async (run) => {
          fifoRecovered = run;
          return run;
        },
        schedule: async (run) => run,
        emit: () => undefined,
        recordError: () => undefined,
      },
      6,
    );
    expect(
      fifoRecovered?.occurrences.find((item) => item.id === olderSiblingId),
    ).toMatchObject({ status: "ready" });
    expect(
      fifoRecovered?.occurrences.find((item) => item.id === retryId),
    ).toMatchObject({ status: "queued" });

    let recovered: typeof persisted | undefined;
    const scheduled: (typeof persisted)[] = [];
    await rehydrateCanonicalWorkflowRuns(
      [JSON.parse(JSON.stringify(persisted))],
      {
        resolveWorkspace: async () => undefined,
        updateRun: async (run) => {
          recovered = run;
          return run;
        },
        schedule: async (run) => {
          scheduled.push(run);
          return run;
        },
        emit: () => undefined,
        recordError: () => undefined,
      },
      6,
    );

    expect(scheduled).toHaveLength(1);
    expect(recovered?.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          attempt: 1,
          status: "skipped",
          error: "first failed",
          parentOrchestratorRunId: owner.id,
        }),
        expect.objectContaining({
          id: retry.id,
          attempt: 2,
          status: "queued",
          parentOrchestratorRunId: owner.id,
        }),
        expect.objectContaining({ id: second.id, status: "ready" }),
      ]),
    );
    expect(
      recovered?.occurrences.filter((item) => item.status === "ready"),
    ).toHaveLength(1);

    expect(() =>
      startWorkflowOccurrence(
        recovered!,
        retry.id,
        "retry-too-early",
        undefined,
        7,
      ),
    ).toThrow("Only ready Worker or Decider occurrences may own Pi sessions.");
    let completed = startWorkflowOccurrence(
      recovered!,
      second.id,
      "second",
      undefined,
      7,
    );
    completed = completeWorkflowOccurrence(completed, second.id, "B", 8);
    expect(
      completed.occurrences.find((item) => item.id === retry.id),
    ).toMatchObject({
      status: "ready",
    });
    completed = startWorkflowOccurrence(
      completed,
      retry.id,
      "retry",
      undefined,
      9,
    );
    completed = completeWorkflowOccurrence(completed, retry.id, "A retry", 10);

    expect(
      completed.occurrences.find((item) => item.id === owner.id),
    ).toMatchObject({
      status: "completed",
      output: ["B", "A retry"],
    });
    expect(completed).toMatchObject({
      status: "completed",
      terminalOutcome: "done",
    });
    expect(
      completed.occurrences
        .filter((item) => item.parentOrchestratorRunId === owner.id)
        .map((item) => [item.attempt, item.status, item.output, item.error]),
    ).toEqual([
      [1, "skipped", undefined, "first failed"],
      [1, "completed", "B", undefined],
      [2, "completed", "A retry", undefined],
    ]);
  });

  it("keeps a constrained fan-out any retry queued across restart", async () => {
    const fanout = "00000000-0000-4000-8000-000000000151";
    const firstWorker = "00000000-0000-4000-8000-000000000152";
    const secondWorker = "00000000-0000-4000-8000-000000000153";
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000150",
      revision: 1,
      name: "Constrained retry fan-out restart",
      inputs: [],
      entryNodeId: fanout,
      nodes: [
        {
          id: fanout,
          name: "Fan",
          role: "orchestrator" as const,
          config: {
            mode: "fanout" as const,
            agents: [firstWorker, secondWorker],
            maxConcurrency: 1,
            completion: "any" as const,
          },
        },
        {
          id: firstWorker,
          name: "First",
          role: "worker" as const,
          managedBy: fanout,
          config: { instructions: "first" },
        },
        {
          id: secondWorker,
          name: "Second",
          role: "worker" as const,
          managedBy: fanout,
          config: { instructions: "second" },
        },
      ],
      relationships: [],
    };
    let persisted = createWorkflowRoleRun(definition, "workspace", {}, 1);
    const owner = persisted.occurrences[0]!;
    persisted = startWorkflowOrchestrator(persisted, owner.id, 2);
    const first = persisted.occurrences.find(
      (item) => item.nodeId === firstWorker,
    )!;
    const second = persisted.occurrences.find(
      (item) => item.nodeId === secondWorker,
    )!;
    persisted = startWorkflowOccurrence(
      persisted,
      first.id,
      "first",
      undefined,
      3,
    );
    persisted = failWorkflowOccurrence(persisted, first.id, "first failed", 4);
    persisted = startWorkflowOccurrence(
      persisted,
      second.id,
      "second",
      undefined,
      5,
    );
    persisted = retryWorkflowOccurrence(persisted, first.id, 6);
    const retry = persisted.occurrences.at(-1)!;
    expect(retry.status).toBe("queued");

    let recovered: typeof persisted | undefined;
    const scheduled: (typeof persisted)[] = [];
    await rehydrateCanonicalWorkflowRuns(
      [JSON.parse(JSON.stringify(persisted))],
      {
        resolveWorkspace: async () => undefined,
        updateRun: async (run) => {
          recovered = run;
          return run;
        },
        schedule: async (run) => {
          scheduled.push(run);
          return run;
        },
        emit: () => undefined,
        recordError: () => undefined,
      },
      7,
    );

    // The running sibling lost its session and needs attention, but recovery
    // must not promote the retry merely because that conversion frees a slot.
    expect(recovered).toMatchObject({ status: "needsAttention" });
    expect(recovered?.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "skipped" }),
        expect.objectContaining({ id: second.id, status: "failed" }),
        expect.objectContaining({ id: retry.id, status: "queued", attempt: 2 }),
      ]),
    );
    expect(
      recovered?.occurrences.filter(
        (item) =>
          item.parentOrchestratorRunId === owner.id &&
          ["ready", "running"].includes(item.status),
      ),
    ).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it.each(["all", "any"] as const)(
    "retries a recovered bounded %s fan-out in FIFO order without exceeding capacity",
    async (completion) => {
      const fanout = "00000000-0000-4000-8000-000000000161";
      const firstWorker = "00000000-0000-4000-8000-000000000162";
      const secondWorker = "00000000-0000-4000-8000-000000000163";
      const definition = {
        format: "pi-deck.agent-workflow" as const,
        schemaVersion: 2 as const,
        id: "00000000-0000-4000-8000-000000000160",
        revision: 1,
        name: `Recovered ${completion} fan-out`,
        inputs: [],
        entryNodeId: fanout,
        nodes: [
          {
            id: fanout,
            name: "Fan",
            role: "orchestrator" as const,
            config: {
              mode: "fanout" as const,
              agents: [firstWorker, secondWorker],
              maxConcurrency: 1,
              completion,
            },
          },
          ...[
            [firstWorker, "First"],
            [secondWorker, "Second"],
          ].map(([id, name]) => ({
            id,
            name,
            role: "worker" as const,
            managedBy: fanout,
            config: { instructions: name },
          })),
        ],
        relationships: [
          {
            id: "00000000-0000-4000-8000-000000000164",
            from: fanout,
            to: { end: "done" },
          },
        ],
      };
      let persisted = createWorkflowRoleRun(definition, "workspace", {}, 1);
      const owner = persisted.occurrences[0]!;
      persisted = startWorkflowOrchestrator(persisted, owner.id, 2);
      const first = persisted.occurrences.find(
        (item) => item.nodeId === firstWorker,
      )!;
      const second = persisted.occurrences.find(
        (item) => item.nodeId === secondWorker,
      )!;
      persisted = startWorkflowOccurrence(
        persisted,
        first.id,
        "first",
        undefined,
        3,
      );

      let recovered: typeof persisted | undefined;
      const scheduled: (typeof persisted)[] = [];
      await rehydrateCanonicalWorkflowRuns(
        [JSON.parse(JSON.stringify(persisted))],
        {
          resolveWorkspace: async () => undefined,
          updateRun: async (run) => {
            recovered = run;
            return run;
          },
          schedule: async (run) => {
            scheduled.push(run);
            return run;
          },
          emit: () => undefined,
          recordError: () => undefined,
        },
        4,
      );

      expect(recovered).toMatchObject({ status: "needsAttention" });
      expect(recovered?.occurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: owner.id, status: "running" }),
          expect.objectContaining({ id: first.id, status: "failed" }),
          expect.objectContaining({ id: second.id, status: "queued" }),
        ]),
      );
      expect(scheduled).toHaveLength(0);

      let run = retryWorkflowOccurrence(recovered!, first.id, 5);
      const retry = run.occurrences.at(-1)!;
      const activeChildren = () =>
        run.occurrences.filter(
          (item) =>
            item.parentOrchestratorRunId === owner.id &&
            ["ready", "running"].includes(item.status),
        );
      expect(
        run.occurrences.find((item) => item.id === owner.id),
      ).toMatchObject({ status: "running" });
      expect(
        run.occurrences.find((item) => item.id === second.id),
      ).toMatchObject({ status: "ready" });
      expect(retry).toMatchObject({ attempt: 2, status: "queued" });
      expect(activeChildren()).toEqual([
        expect.objectContaining({ id: second.id, status: "ready" }),
      ]);

      run = startWorkflowOccurrence(run, second.id, "second", undefined, 6);
      expect(activeChildren()).toEqual([
        expect.objectContaining({ id: second.id, status: "running" }),
      ]);
      run = completeWorkflowOccurrence(run, second.id, "B", 7);

      if (completion === "all") {
        expect(
          run.occurrences.find((item) => item.id === retry.id),
        ).toMatchObject({ status: "ready" });
        expect(activeChildren()).toEqual([
          expect.objectContaining({ id: retry.id, status: "ready" }),
        ]);
        run = startWorkflowOccurrence(run, retry.id, "retry", undefined, 8);
        expect(activeChildren()).toEqual([
          expect.objectContaining({ id: retry.id, status: "running" }),
        ]);
        run = completeWorkflowOccurrence(run, retry.id, "A retry", 9);
        expect(
          run.occurrences.find((item) => item.id === owner.id),
        ).toMatchObject({ status: "completed", output: ["B", "A retry"] });
        expect(
          run.occurrences
            .filter((item) => item.parentOrchestratorRunId === owner.id)
            .map((item) => [
              item.attempt,
              item.status,
              item.output,
              item.error,
            ]),
        ).toEqual([
          [
            1,
            "skipped",
            undefined,
            "Pi session was interrupted by restart; retry this occurrence.",
          ],
          [1, "completed", "B", undefined],
          [2, "completed", "A retry", undefined],
        ]);
      } else {
        expect(
          run.occurrences.find((item) => item.id === retry.id),
        ).toMatchObject({ status: "skipped" });
        expect(activeChildren()).toHaveLength(0);
        expect(
          run.occurrences.find((item) => item.id === owner.id),
        ).toMatchObject({ status: "completed", output: ["B"] });
        expect(
          run.occurrences
            .filter((item) => item.parentOrchestratorRunId === owner.id)
            .map((item) => [
              item.attempt,
              item.status,
              item.output,
              item.error,
            ]),
        ).toEqual([
          [
            1,
            "skipped",
            undefined,
            "Pi session was interrupted by restart; retry this occurrence.",
          ],
          [1, "completed", "B", undefined],
          [2, "skipped", undefined, undefined],
        ]);
      }
      expect(run).toMatchObject({
        status: "completed",
        terminalOutcome: "done",
      });
    },
  );

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

  it("repairs legacy stopped ready and queued retries before workspace gating", async () => {
    for (const workspaceCase of ["resolved", "archived"] as const) {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "pi-deck-rehydrate-"),
      );
      tempDirs.push(root);
      const definition = {
        format: "pi-deck.agent-workflow" as const,
        schemaVersion: 2 as const,
        id: "00000000-0000-4000-8000-000000000110",
        revision: 1,
        name: `Stopped legacy retry ${workspaceCase}`,
        inputs: [],
        entryNodeId: "00000000-0000-4000-8000-000000000111",
        nodes: [
          {
            id: "00000000-0000-4000-8000-000000000111",
            name: "Work",
            role: "worker" as const,
            config: { instructions: "work" },
          },
        ],
        relationships: [],
      };
      const store = new WorkflowStore(root);
      const initial = createWorkflowRoleRun(
        definition,
        `${workspaceCase}-workspace`,
        {},
        1,
      );
      const original = {
        ...initial.occurrences[0]!,
        status: "cancelled" as const,
        error: "Stopped by user",
        updatedAtMs: 2,
      };
      const dormantReplacement = {
        ...original,
        id: "00000000-0000-4000-8000-000000000112",
        status: "ready" as const,
        attempt: 2,
        error: undefined,
        createdAtMs: 2,
        updatedAtMs: 2,
      };
      const secondDormantReplacement = {
        ...dormantReplacement,
        id: "00000000-0000-4000-8000-000000000113",
        attempt: 3,
      };
      const queuedReplacement = {
        ...dormantReplacement,
        id: "00000000-0000-4000-8000-000000000114",
        status: "queued" as const,
        attempt: 4,
      };
      const legacy = await store.createWorkflowRun({
        ...initial,
        status: "stopped",
        occurrences: [
          original,
          dormantReplacement,
          secondDormantReplacement,
          queuedReplacement,
        ],
        updatedAtMs: 2,
        completedAtMs: 2,
      });
      const emitted: string[] = [];
      const scheduled: string[] = [];
      const errors: string[] = [];
      let resolveCalls = 0;

      await rehydrateCanonicalWorkflowRuns(
        await store.listWorkflowRuns(),
        {
          resolveWorkspace: async () => {
            resolveCalls += 1;
            if (workspaceCase === "archived") {
              throw new Error("Workspace is archived");
            }
          },
          updateRun: (run) => store.updateWorkflowRun(run),
          schedule: async (run) => {
            scheduled.push(run.id);
            return run;
          },
          emit: (run) => emitted.push(run.id),
          recordError: (message) => errors.push(message),
        },
        3,
      );

      const repaired = await store.getWorkflowRun(legacy.id);
      expect(repaired).toMatchObject({
        status: "stopped",
        revision: legacy.revision + 1,
      });
      expect(repaired.occurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: original.id, status: "skipped" }),
          expect.objectContaining({
            id: dormantReplacement.id,
            status: "skipped",
          }),
          expect.objectContaining({
            id: secondDormantReplacement.id,
            status: "skipped",
          }),
          expect.objectContaining({
            id: queuedReplacement.id,
            status: "cancelled",
          }),
        ]),
      );
      expect(resolveCalls).toBe(0);
      expect(scheduled).toEqual([]);
      expect(errors).toEqual([]);
      expect(emitted).toEqual([legacy.id]);

      // The repaired envelope survives a process restart and remains manually
      // resumable through its cancelled replacement rather than a dormant ready
      // or queued attempt that a new scheduler could launch automatically.
      const restarted = new WorkflowStore(root);
      const afterRestart = await restarted.getWorkflowRun(legacy.id);
      expect(afterRestart).toEqual(repaired);
      const resumed = retryWorkflowOccurrence(
        afterRestart,
        queuedReplacement.id,
        4,
      );
      expect(resumed).toMatchObject({ status: "waiting" });
      expect(resumed.occurrences.at(-1)).toMatchObject({
        status: "ready",
        attempt: 5,
      });
      expect(
        resumed.occurrences.filter((item) => item.status === "queued"),
      ).toEqual([]);
    }
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
