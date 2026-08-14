import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MultitaskStateStore } from "./multitaskStateStore.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("MultitaskStateStore", () => {
  it("persists state by session file, not a renderer task number", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-multitask-"),
    );
    directories.push(directory);
    const sessionFile = "/sessions/a.jsonl";
    const store = new MultitaskStateStore(directory);
    await store.loadIfNeeded();
    await store.set(sessionFile, { mode: "parallel", tasks: [] });

    const resumed = new MultitaskStateStore(directory);
    await resumed.loadIfNeeded();
    expect(resumed.get(sessionFile)).toEqual({ mode: "parallel", tasks: [] });
    expect(resumed.get("/sessions/b.jsonl")).toBeUndefined();
  });
});
