import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { ProjectStore } from "./projects/projectStore.js";
import { ForkCleanupJournal } from "./forkCleanupJournal.js";
import { WorkspaceStore } from "./workspaces/workspaceStore.js";

test("failed fork cleanup remains blocked through restart until both stores persist removal", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-fork-journal-"),
  );
  const home = path.join(root, "home");
  const projectPath = path.join(root, "project");
  const sessionFile = path.join(root, "fork-target.jsonl");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(sessionFile, "");
  const projectId = await fs.realpath(projectPath);
  const workspaces = new WorkspaceStore(home);
  const workspace = await workspaces.create({ name: "Forks" });
  const projects = new ProjectStore(home);
  await projects.upsertAndActivateProject(projectId);
  await workspaces.upsertSessionRefFromSnapshot({
    workspaceId: workspace.id,
    sessionFile,
  });
  await projects.upsertSessionRefFromSnapshot({ projectId, sessionFile });

  const journal = new ForkCleanupJournal(home);
  await journal.reserve({ sessionFile, workspaceId: workspace.id, projectId });
  const writeFile = vi.spyOn(fs, "writeFile");
  writeFile.mockRejectedValueOnce(
    new Error("injected workspace remove failure"),
  );
  await journal.retryAfterConfirmedExit(sessionFile, workspaces, projects);
  assert.equal(await journal.blocks(sessionFile), true);
  assert.equal((await workspaces.getSessionRefs(workspace.id)).length, 1);

  writeFile.mockRestore();
  const restarted = new ForkCleanupJournal(home);
  await restarted.retryAfterConfirmedExit(
    sessionFile,
    new WorkspaceStore(home),
    new ProjectStore(home),
  );
  assert.equal(await restarted.blocks(sessionFile), false);
  assert.equal(
    (await new WorkspaceStore(home).getSessionRefs(workspace.id)).length,
    0,
  );
  assert.equal(
    (await new ProjectStore(home).getSessionRefs(projectId)).length,
    0,
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("persistent reserve failure remains process-blocked until cleanup succeeds", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-fork-journal-ephemeral-"),
  );
  const sessionFile = path.join(root, "fork-target.jsonl");
  const entry = {
    sessionFile,
    workspaceId: "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e",
  };
  const journal = new ForkCleanupJournal(path.join(root, "home"));
  const writeFile = vi
    .spyOn(fs, "writeFile")
    .mockRejectedValue(new Error("persistent journal write failure"));
  try {
    await assert.rejects(
      journal.reserve(entry),
      /persistent journal write failure/,
    );
    assert.equal(await journal.blocks(sessionFile), true);

    let cleanupFails = true;
    const workspaces = {
      getSessionOwner: async () => undefined,
      removeSession: async () => {
        if (cleanupFails) throw new Error("cleanup still fails");
      },
    } as unknown as WorkspaceStore;
    await journal.retryAfterConfirmedExit(sessionFile, workspaces, undefined);
    assert.equal(await journal.blocks(sessionFile), true);

    cleanupFails = false;
    await journal.retryAfterConfirmedExit(sessionFile, workspaces, undefined);
    assert.equal(await journal.blocks(sessionFile), false);
  } finally {
    writeFile.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source reservations remain blocked through a journal restart", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-fork-journal-source-"),
  );
  try {
    const sessionFile = path.join(root, "fork-target.jsonl");
    const sourceSessionFile = path.join(root, "fork-source.jsonl");
    const journal = new ForkCleanupJournal(path.join(root, "home"));
    await journal.reserve({
      sessionFile,
      sourceSessionFile,
      workspaceId: "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e",
    });
    assert.equal(await journal.blocks(sourceSessionFile), true);
    assert.equal(
      await new ForkCleanupJournal(path.join(root, "home")).blocks(
        sourceSessionFile,
      ),
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source-only reservation survives crash/restart until a durable child exit proof", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-fork-journal-pre-spawn-"),
  );
  try {
    const sourceSessionFile = path.join(root, "fork-source.jsonl");
    const transactionId = "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e";
    const journal = new ForkCleanupJournal(path.join(root, "home"));
    await journal.reserveSource({ sourceSessionFile, transactionId });

    // This models a process crash before createWorker publishes a PID. A new
    // process has no safe evidence with which to release the source.
    const restarted = new ForkCleanupJournal(path.join(root, "home"));
    assert.equal(await restarted.blocks(sourceSessionFile), true);
    assert.equal(
      await restarted.completeSourceAfterConfirmedExit({
        sourceSessionFile,
        transactionId,
        childRuntimeId: "runtime-never-recorded",
      }),
      false,
    );
    assert.equal(await restarted.blocks(sourceSessionFile), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("spawn identity promotion atomically replaces source-only recovery with target cleanup", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-fork-journal-promote-"),
  );
  try {
    const home = path.join(root, "home");
    const sourceSessionFile = path.join(root, "fork-source.jsonl");
    const targetSessionFile = path.join(root, "fork-target.jsonl");
    const transactionId = "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e";
    const journal = new ForkCleanupJournal(home);
    await journal.reserveSource({ sourceSessionFile, transactionId });
    await journal.recordSpawnedSource({
      sourceSessionFile,
      transactionId,
      childRuntimeId: "runtime-child",
      childPid: 1234,
    });
    await journal.promoteSourceToTarget({
      sourceSessionFile,
      sessionFile: targetSessionFile,
      transactionId,
      workspaceId: "3f8a3c42-841c-4ef5-8a9b-9a229924ad1e",
    });

    const recovered = new ForkCleanupJournal(home);
    assert.equal(await recovered.blocks(sourceSessionFile), true);
    assert.equal(await recovered.blocks(targetSessionFile), true);
    const persisted = JSON.parse(
      await fs.readFile(path.join(home, "failed-fork-cleanup.json"), "utf8"),
    ) as {
      version: number;
      entries: Array<{ kind: string; sessionFile?: string }>;
    };
    assert.equal(persisted.version, 2);
    assert.equal(persisted.entries.length, 1);
    assert.equal(persisted.entries[0]?.kind, "target");
    assert.equal(persisted.entries[0]?.sessionFile, targetSessionFile);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("confirmed child exit releases a known source-only reservation", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-fork-journal-known-child-"),
  );
  try {
    const sourceSessionFile = path.join(root, "fork-source.jsonl");
    const transactionId = "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e";
    const journal = new ForkCleanupJournal(path.join(root, "home"));
    await journal.reserveSource({ sourceSessionFile, transactionId });
    await journal.recordSpawnedSource({
      sourceSessionFile,
      transactionId,
      childRuntimeId: "runtime-child",
    });
    assert.equal(
      await journal.completeSourceAfterConfirmedExit({
        sourceSessionFile,
        transactionId,
        childRuntimeId: "runtime-child",
      }),
      true,
    );
    assert.equal(await journal.blocks(sourceSessionFile), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("confirmed-exit retry retains a target moved outside its reserved workspace", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-fork-journal-moved-"),
  );
  try {
    const sessionFile = path.join(root, "fork-target.jsonl");
    const journal = new ForkCleanupJournal(path.join(root, "home"));
    await journal.reserve({
      sessionFile,
      workspaceId: "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e",
    });
    let removed = false;
    await journal.retryAfterConfirmedExit(
      sessionFile,
      {
        getSessionOwner: async () => ({
          workspaceId: "3f8a3c42-841c-4ef5-8a9b-9a229924ad1e",
        }),
        removeSession: async () => {
          removed = true;
          return true;
        },
      } as unknown as WorkspaceStore,
      undefined,
    );
    assert.equal(removed, false);
    assert.equal(await journal.blocks(sessionFile), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("confirmed-exit retry retains project compensation without its project store", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-fork-journal-project-"),
  );
  try {
    const sessionFile = path.join(root, "fork-target.jsonl");
    const journal = new ForkCleanupJournal(path.join(root, "home"));
    await journal.reserve({
      sessionFile,
      workspaceId: "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e",
      projectId: "/project",
    });
    let removed = false;
    await journal.retryAfterConfirmedExit(
      sessionFile,
      {
        getSessionOwner: async () => undefined,
        removeSession: async () => {
          removed = true;
          return true;
        },
      } as unknown as WorkspaceStore,
      undefined,
    );
    assert.equal(removed, true);
    assert.equal(await journal.blocks(sessionFile), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
