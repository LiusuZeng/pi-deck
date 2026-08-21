import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskSessionMainStateStore } from "./taskSessionMainStateStore.js";
import type { PersistedTaskSessionState } from "./taskSessionOrchestrator.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-task-state-"));
  roots.push(root);
  return root;
}

function validState(): PersistedTaskSessionState {
  return {
    version: 1,
    mode: "parallel",
    nextTaskNumber: 2,
    workerSettings: { model: "provider:model", thinkingLevel: "high" },
    plans: [
      {
        planId: 1,
        contextSummary: "Bounded context summary",
        originalPrompt: "Do independent work",
        tasks: [
          {
            taskNumber: 1,
            generatedName: "First task",
            brief: "Complete the first task",
            lifecycle: "interrupted",
            attempt: 1,
            transitions: [
              { lifecycle: "running", attempt: 1, at: 1 },
              { lifecycle: "interrupted", attempt: 1, at: 2 },
            ],
            handoffSummary: "Interrupted after restart.",
          },
        ],
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("TaskSessionMainStateStore", () => {
  it("round-trips validated state and settings atomically", async () => {
    const root = await temporaryRoot();
    const store = new TaskSessionMainStateStore(root);
    await store.loadIfNeeded();
    await store.set("/parent.jsonl", validState());
    await store.setSettings("/parent.jsonl", {
      model: "provider:model",
      thinkingLevel: "max",
    });

    const resumed = new TaskSessionMainStateStore(root);
    await resumed.loadIfNeeded();
    expect(resumed.get("/parent.jsonl")).toEqual(validState());
    expect(resumed.getSettings("/parent.jsonl")).toEqual({
      model: "provider:model",
      thinkingLevel: "max",
    });
  });

  it("drops malformed persisted plans instead of breaking parent resume", async () => {
    const root = await temporaryRoot();
    await fs.writeFile(
      path.join(root, "task-session-state.json"),
      JSON.stringify({
        "/bad.jsonl": {
          state: {
            version: 1,
            mode: "parallel",
            nextTaskNumber: 2,
            plans: [
              {
                planId: 1,
                contextSummary: "context",
                originalPrompt: "prompt",
                tasks: [
                  {
                    taskNumber: 1,
                    generatedName: "contains\na newline",
                    brief: "brief",
                    lifecycle: "running",
                    attempt: 1,
                    transitions: [],
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    const store = new TaskSessionMainStateStore(root);
    await expect(store.loadIfNeeded()).resolves.toBeUndefined();
    expect(store.get("/bad.jsonl")).toBeUndefined();
  });

  it("never persists runtime handles or raw output fields", async () => {
    const root = await temporaryRoot();
    const store = new TaskSessionMainStateStore(root);
    await store.loadIfNeeded();
    await store.set("/parent.jsonl", validState());
    const persisted = await fs.readFile(
      path.join(root, "task-session-state.json"),
      "utf8",
    );
    for (const forbidden of [
      "runtimeId",
      "sessionFile",
      "transcript",
      "rawOutput",
      "toolOutput",
    ])
      expect(persisted).not.toContain(forbidden);
  });
});
