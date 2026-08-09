import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
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
    expect(persisted.occurrences[0]?.sessionFile).toBe("/tmp/session-1.jsonl");
  });
});
