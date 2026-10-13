import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function stateFile(root: string): string {
  return path.join(root, "task-session-state.json");
}

afterEach(async () => {
  vi.restoreAllMocks();
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
      stateFile(root),
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

  it.each([
    [
      "set",
      async (store: TaskSessionMainStateStore) =>
        store.set("/another-parent.jsonl", validState()),
      (resumed: TaskSessionMainStateStore) => {
        expect(resumed.get("/existing-parent.jsonl")).toEqual(validState());
        expect(resumed.get("/another-parent.jsonl")).toEqual(validState());
      },
    ],
    [
      "setSettings",
      async (store: TaskSessionMainStateStore) =>
        store.setSettings("/existing-parent.jsonl", {
          model: "provider:new-model",
          thinkingLevel: "low",
        }),
      (resumed: TaskSessionMainStateStore) => {
        expect(resumed.get("/existing-parent.jsonl")).toEqual(validState());
        expect(resumed.getSettings("/existing-parent.jsonl")).toEqual({
          model: "provider:new-model",
          thinkingLevel: "low",
        });
      },
    ],
    [
      "delete",
      async (store: TaskSessionMainStateStore) =>
        store.delete("/missing-parent.jsonl"),
      (resumed: TaskSessionMainStateStore) => {
        expect(resumed.get("/existing-parent.jsonl")).toEqual(validState());
      },
    ],
  ])(
    "does not overwrite valid recovery state after transient read failures before %s",
    async (_name, mutate, assertRecovered) => {
      const root = await temporaryRoot();
      const existing = new TaskSessionMainStateStore(root);
      await existing.set("/existing-parent.jsonl", validState());
      const original = await fs.readFile(stateFile(root), "utf8");

      const healthy = new TaskSessionMainStateStore(root);
      await healthy.loadIfNeeded();
      expect(healthy.get("/existing-parent.jsonl")).toEqual(validState());

      const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
      let failuresRemaining = 2;
      vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
        if (file === stateFile(root) && failuresRemaining > 0) {
          failuresRemaining -= 1;
          const error = new Error("injected EIO") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
        return await actualFs.readFile(file, options);
      });

      const recovering = new TaskSessionMainStateStore(root);
      await expect(recovering.loadIfNeeded()).resolves.toBeUndefined();
      expect(recovering.get("/existing-parent.jsonl")).toBeUndefined();
      expect(await actualFs.readFile(stateFile(root), "utf8")).toBe(original);

      await expect(mutate(recovering)).rejects.toThrow(
        "refusing to overwrite existing recovery data",
      );
      expect(await actualFs.readFile(stateFile(root), "utf8")).toBe(original);

      vi.restoreAllMocks();
      await expect(mutate(recovering)).resolves.toBeUndefined();
      const resumed = new TaskSessionMainStateStore(root);
      await resumed.loadIfNeeded();
      assertRecovered(resumed);
    },
  );

  it("shares a pending initial load with concurrent mutations", async () => {
    const root = await temporaryRoot();
    const seed = new TaskSessionMainStateStore(root);
    await seed.set("/existing-parent.jsonl", validState());
    const original = await fs.readFile(stateFile(root), "utf8");

    const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    let releaseRead!: (value: string) => void;
    const pendingRead = new Promise<string>((resolve) => {
      releaseRead = resolve;
    });
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (file, options) => {
        if (file === stateFile(root)) return await pendingRead;
        return await actualFs.readFile(file, options);
      });

    const store = new TaskSessionMainStateStore(root);
    const loading = store.loadIfNeeded();
    const setting = store.setSettings("/existing-parent.jsonl", {
      model: "provider:concurrent",
      thinkingLevel: "medium",
    });

    await Promise.resolve();
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(await actualFs.readFile(stateFile(root), "utf8")).toBe(original);

    releaseRead(original);
    await expect(Promise.all([loading, setting])).resolves.toBeDefined();
    expect(readSpy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();

    const resumed = new TaskSessionMainStateStore(root);
    await resumed.loadIfNeeded();
    expect(resumed.get("/existing-parent.jsonl")).toEqual(validState());
    expect(resumed.getSettings("/existing-parent.jsonl")).toEqual({
      model: "provider:concurrent",
      thinkingLevel: "medium",
    });
  });

  it("preserves malformed top-level files before allowing fallback writes", async () => {
    const root = await temporaryRoot();
    const invalid = "not-json";
    await fs.writeFile(stateFile(root), invalid, "utf8");
    const diagnostics = { recordError: vi.fn() };

    const store = new TaskSessionMainStateStore(root, diagnostics);
    await expect(store.loadIfNeeded()).resolves.toBeUndefined();
    expect(diagnostics.recordError.mock.calls.join("\n")).toContain(
      "preserved",
    );

    await store.set("/new-parent.jsonl", validState());
    const backups = (await fs.readdir(root)).filter((entry) =>
      entry.startsWith("task-session-state.json.invalid-"),
    );
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(root, backups[0]!), "utf8")).toBe(
      invalid,
    );

    const resumed = new TaskSessionMainStateStore(root);
    await resumed.loadIfNeeded();
    expect(resumed.get("/new-parent.jsonl")).toEqual(validState());
  });

  it("refuses to replace malformed top-level files when preservation fails", async () => {
    const root = await temporaryRoot();
    const invalid = "[]";
    await fs.writeFile(stateFile(root), invalid, "utf8");
    vi.spyOn(fs, "copyFile").mockRejectedValue(new Error("no backup"));

    const store = new TaskSessionMainStateStore(root);
    await expect(store.loadIfNeeded()).resolves.toBeUndefined();
    await expect(store.set("/new-parent.jsonl", validState())).rejects.toThrow(
      "refusing to overwrite existing recovery data",
    );
    expect(await fs.readFile(stateFile(root), "utf8")).toBe(invalid);
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
