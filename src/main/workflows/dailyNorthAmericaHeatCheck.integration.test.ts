import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowRoleDefinition,
} from "../../shared/agentWorkflowSchemas.js";
import { createWorkflowRoleRun } from "./agentWorkflowRuntime.js";
import { WorkflowOccurrenceScheduler } from "./workflowScheduler.js";
import { WorkflowStore } from "./workflowStore.js";

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  ),
);

describe("Daily North America Heat Check canonical execution", () => {
  it("persists and reloads a sequential Worker chain with predecessor handoff", async () => {
    const fixture = workflowDefinitionSchema.parse(
      JSON.parse(
        await fs.readFile(
          new URL(
            "./fixtures/daily-north-america-heat-check.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    ) as WorkflowDefinition;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "daily-heat-"));
    dirs.push(home);
    const store = new WorkflowStore(home);
    await store.createWorkflow(fixture, "workspace");
    let sequence = 0;
    const messages = new Map<string, string>();
    const prompts: string[] = [];
    const scheduler = new WorkflowOccurrenceScheduler({
      createSession: async () => ({
        runtimeId: `runtime-${++sequence}`,
        state: {
          sessionId: `session-${sequence}`,
          sessionFile: `/tmp/session-${sequence}.jsonl`,
        },
        messages: [],
      }),
      prompt: async (runtimeId, text) => {
        prompts.push(text);
        messages.set(runtimeId, "");
      },
      getSnapshot: async (runtimeId) => ({
        runtimeId,
        state: {},
        messages: [{ role: "assistant", content: messages.get(runtimeId) }],
      }),
      closeSession: async () => undefined,
      getRun: (id) => store.getWorkflowRun(id),
      persist: (run) => store.updateWorkflowRun(run),
      emit: () => undefined,
    });
    let run = await store.createWorkflowRun(
      createWorkflowRoleRun(fixture, "workspace"),
    );
    run = await scheduler.schedule(run);
    expect(run.occurrences[0]).toMatchObject({
      runtimeId: "runtime-1",
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
    });
    const outputs = [
      "Canada 2026-08-09",
      "Canada 2026-08-09; United States",
      "Canada 2026-08-09; United States; Mexico",
      "United States is hottest",
    ];
    for (const [index, output] of outputs.entries()) {
      const occurrence = run.occurrences.find(
        (item) => item.status === "running",
      )!;
      messages.set(occurrence.runtimeId!, output);
      await scheduler.handleRuntimeEvent({
        type: "agent_end",
        runtimeId: occurrence.runtimeId!,
        status: "completed",
      });
      run = await store.getWorkflowRun(run.id);
      if (index < outputs.length - 1) expect(prompts.at(-1)).toContain(output);
    }
    const reloaded = new WorkflowStore(home);
    const persisted = await reloaded.getWorkflowRun(run.id);
    expect(persisted).toMatchObject({
      status: "completed",
      terminalOutcome: "completed",
    });
    expect(persisted.occurrences).toHaveLength(4);
    expect(persisted.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionFile: "/tmp/session-1.jsonl" }),
      ]),
    );
    for (const occurrence of persisted.occurrences) {
      expect(occurrence).not.toHaveProperty("runtimeId");
      expect(occurrence.sessionFile).toMatch(/^\/tmp\/session-\d+\.jsonl$/);
    }
  });

  it("serializes simultaneous bounded fan-out completions without losing a child", async () => {
    const ids = {
      workflow: "00000000-0000-4000-8000-000000000301",
      fanout: "00000000-0000-4000-8000-000000000302",
      a: "00000000-0000-4000-8000-000000000303",
      b: "00000000-0000-4000-8000-000000000304",
      c: "00000000-0000-4000-8000-000000000305",
      d: "00000000-0000-4000-8000-000000000306",
      end: "00000000-0000-4000-8000-000000000307",
    };
    const definition: WorkflowRoleDefinition = {
      format: "pi-deck.agent-workflow",
      schemaVersion: 2,
      id: ids.workflow,
      revision: 1,
      name: "Concurrent fan-out",
      inputs: [],
      entryNodeId: ids.fanout,
      nodes: [
        {
          id: ids.fanout,
          name: "Fan out",
          role: "orchestrator",
          config: {
            mode: "fanout",
            agents: [ids.a, ids.b, ids.c, ids.d],
            maxConcurrency: 2,
            completion: "all",
          },
        },
        ...[ids.a, ids.b, ids.c, ids.d].map((id) => ({
          id,
          name: `Worker ${id.slice(-1)}`,
          role: "worker" as const,
          managedBy: ids.fanout,
          config: { instructions: "Return an answer." },
        })),
      ],
      relationships: [{ id: ids.end, from: ids.fanout, to: { end: "done" } }],
    };
    let persisted = createWorkflowRoleRun(definition, "workspace", {}, 1);
    let created = 0;
    let synchronizeCompletionReads = false;
    let completionReads = 0;
    let releaseCompletionReads!: () => void;
    const completionReadBarrier = new Promise<void>((resolve) => {
      releaseCompletionReads = resolve;
    });
    const scheduler = new WorkflowOccurrenceScheduler({
      createSession: async () => ({
        runtimeId: `runtime-${++created}`,
        state: {
          sessionId: `session-${created}`,
          sessionFile: `/tmp/session-${created}.jsonl`,
        },
        messages: [],
      }),
      prompt: async () => undefined,
      getSnapshot: async (runtimeId) => ({
        runtimeId,
        state: {},
        messages: [{ role: "assistant", content: `answer ${runtimeId}` }],
      }),
      closeSession: async () => undefined,
      getRun: async () => {
        // The old unsynchronized scheduler lets both handlers load this same
        // snapshot. A serialized handler instead times out the first read,
        // persists it, then gives the second handler the current snapshot.
        if (synchronizeCompletionReads && ++completionReads <= 2) {
          if (completionReads === 2) releaseCompletionReads();
          await Promise.race([
            completionReadBarrier,
            new Promise<void>((resolve) => setTimeout(resolve, 25)),
          ]);
        }
        return persisted;
      },
      persist: async (run) => {
        persisted = run;
        return run;
      },
      emit: () => undefined,
    });

    await scheduler.schedule(persisted);
    synchronizeCompletionReads = true;
    await Promise.all(
      ["runtime-1", "runtime-2"].map((runtimeId) =>
        scheduler.handleRuntimeEvent({
          type: "agent_end",
          runtimeId,
          status: "completed",
        }),
      ),
    );
    await Promise.all(
      ["runtime-3", "runtime-4"].map((runtimeId) =>
        scheduler.handleRuntimeEvent({
          type: "agent_end",
          runtimeId,
          status: "completed",
        }),
      ),
    );

    expect(persisted.status).toBe("completed");
    expect(persisted.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: ids.fanout, status: "completed" }),
      ]),
    );
    expect(
      persisted.occurrences.filter((item) => item.role === "worker"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: ids.a, status: "completed" }),
        expect.objectContaining({ nodeId: ids.b, status: "completed" }),
        expect.objectContaining({ nodeId: ids.c, status: "completed" }),
        expect.objectContaining({ nodeId: ids.d, status: "completed" }),
      ]),
    );
  });

  it("fails a workflow-created session without a durable reopen file", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000201",
      revision: 1,
      name: "Missing session file",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000202",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000202",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "work" },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000203",
          from: "00000000-0000-4000-8000-000000000202",
          to: { end: "completed" },
        },
      ],
    };
    const closed: string[] = [];
    const scheduler = new WorkflowOccurrenceScheduler({
      createSession: async () => ({
        runtimeId: "runtime-without-file",
        state: { sessionId: "session" },
        messages: [],
      }),
      prompt: async () => undefined,
      getSnapshot: async () => ({
        runtimeId: "unused",
        state: {},
        messages: [],
      }),
      closeSession: async (runtimeId) => {
        closed.push(runtimeId);
      },
      persist: async (run) => run,
      emit: () => undefined,
    });
    const run = await scheduler.schedule(
      createWorkflowRoleRun(definition, "workspace"),
    );
    expect(run.occurrences[0]).toMatchObject({
      status: "failed",
      error: "Workflow Pi session has no saved session file for reopening.",
    });
    expect(run.occurrences[0]).not.toHaveProperty("runtimeId");
    expect(closed).toEqual(["runtime-without-file"]);
  });
});
