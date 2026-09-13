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

test("promotion write failures retain source and ephemeral target, then restart discovery blocks and safely cleans the unique child", async () => {
  for (const [method, failure] of [
    ["writeFile", "write"],
    ["rename", "rename"],
  ] as const) {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), `pi-deck-fork-journal-recover-${failure}-`),
    );
    try {
      const home = path.join(root, "home");
      const sessionDir = path.join(root, "sessions");
      const projectDir = path.join(root, "project");
      const sourceSessionFile = path.join(sessionDir, "source.jsonl");
      const targetSessionFile = path.join(sessionDir, "target.jsonl");
      const transactionId = "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e";
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        sourceSessionFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "source",
          timestamp: new Date().toISOString(),
          cwd: projectDir,
        })}\n`,
      );
      const canonicalSource = await fs.realpath(sourceSessionFile);
      const canonicalSessionDir = await fs.realpath(sessionDir);
      const workspaces = new WorkspaceStore(home);
      const workspace = await workspaces.create({ name: "Forks" });
      const journal = new ForkCleanupJournal(home);
      await journal.reserveSource({
        sourceSessionFile: canonicalSource,
        transactionId,
        sessionDir: canonicalSessionDir,
        workspaceId: workspace.id,
      });
      await journal.recordSpawnedSource({
        sourceSessionFile: canonicalSource,
        transactionId,
        childRuntimeId: "runtime-child",
        childPid: process.pid,
      });
      await journal.recordTargetDiscovery({
        sourceSessionFile: canonicalSource,
        transactionId,
      });
      await fs.writeFile(
        targetSessionFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "target",
          timestamp: new Date().toISOString(),
          cwd: projectDir,
          parentSession: canonicalSource,
        })}\n`,
      );
      const canonicalTarget = await fs.realpath(targetSessionFile);
      await journal.blockDiscoveredTarget({
        sessionFile: canonicalTarget,
        sourceSessionFile: canonicalSource,
        transactionId,
        discoveredSessionId: "target",
        workspaceId: workspace.id,
      });
      const failureSpy = vi.spyOn(fs, method);
      failureSpy.mockRejectedValueOnce(
        new Error(`injected ${failure} failure`),
      );
      await assert.rejects(
        journal.promoteSourceToTarget({
          sessionFile: canonicalTarget,
          sourceSessionFile: canonicalSource,
          transactionId,
          discoveredSessionId: "target",
          workspaceId: workspace.id,
        }),
        new RegExp(`injected ${failure} failure`),
      );
      failureSpy.mockRestore();
      assert.equal(await journal.blocks(canonicalSource), true);
      assert.equal(await journal.blocks(canonicalTarget), true);

      // The durable file remains source-only, but its fallback checkpoint
      // binds the exact validated Pi target ID for safe restart recovery.
      const blockedAfterRestart = new ForkCleanupJournal(home);
      await blockedAfterRestart.recoverSourceTargetsAfterRestart(
        new WorkspaceStore(home),
        undefined,
      );
      assert.equal(await blockedAfterRestart.blocks(canonicalSource), true);
      assert.equal(await blockedAfterRestart.blocks(canonicalTarget), true);

      // A later PID probe that proves the child absent may safely promote the
      // unique candidate, remove its unclaimed refs, and release both blocks.
      const journalFile = path.join(home, "failed-fork-cleanup.json");
      const persisted = JSON.parse(await fs.readFile(journalFile, "utf8")) as {
        version: number;
        entries: Array<Record<string, unknown>>;
      };
      persisted.entries[0]!.childPid = 999_999_999;
      delete persisted.entries[0]!.discoveredTargetSessionFile;
      delete persisted.entries[0]!.discoveredTargetSessionId;
      await fs.writeFile(journalFile, `${JSON.stringify(persisted)}\n`);
      await workspaces.upsertSessionRefFromSnapshot({
        workspaceId: workspace.id,
        sessionFile: canonicalTarget,
      });
      // A lone provenance match remains blocked, not claimed, without the
      // exact checkpoint written after target promotion first failed.
      const inferredOnlyAfterRestart = new ForkCleanupJournal(home);
      await inferredOnlyAfterRestart.recoverSourceTargetsAfterRestart(
        new WorkspaceStore(home),
        undefined,
      );
      assert.equal(
        await inferredOnlyAfterRestart.blocks(canonicalSource),
        true,
      );
      assert.equal(
        await inferredOnlyAfterRestart.blocks(canonicalTarget),
        true,
      );
      assert.equal(
        (await new WorkspaceStore(home).getSessionRefs(workspace.id)).length,
        1,
      );

      persisted.entries[0]!.discoveredTargetSessionFile = canonicalTarget;
      persisted.entries[0]!.discoveredTargetSessionId = "target";
      await fs.writeFile(journalFile, `${JSON.stringify(persisted)}\n`);
      const cleanedAfterRestart = new ForkCleanupJournal(home);
      await cleanedAfterRestart.recoverSourceTargetsAfterRestart(
        new WorkspaceStore(home),
        undefined,
      );
      assert.equal(await cleanedAfterRestart.blocks(canonicalSource), false);
      assert.equal(await cleanedAfterRestart.blocks(canonicalTarget), false);
      assert.equal(
        (await new WorkspaceStore(home).getSessionRefs(workspace.id)).length,
        0,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("restart recovery blocks every plausible child and never claims an ambiguous fork", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-fork-journal-ambiguous-"),
  );
  try {
    const home = path.join(root, "home");
    const sessionDir = path.join(root, "sessions");
    const projectDir = path.join(root, "project");
    const sourceSessionFile = path.join(sessionDir, "source.jsonl");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sourceSessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "source",
        timestamp: new Date().toISOString(),
        cwd: projectDir,
      })}\n`,
    );
    const source = await fs.realpath(sourceSessionFile);
    const workspaces = new WorkspaceStore(home);
    const workspace = await workspaces.create({ name: "Forks" });
    const journal = new ForkCleanupJournal(home);
    await journal.reserveSource({
      sourceSessionFile: source,
      transactionId: "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e",
      sessionDir: await fs.realpath(sessionDir),
      workspaceId: workspace.id,
    });
    await journal.recordSpawnedSource({
      sourceSessionFile: source,
      transactionId: "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e",
      childRuntimeId: "runtime-child",
      childPid: 999_999_999,
    });
    await journal.recordTargetDiscovery({
      sourceSessionFile: source,
      transactionId: "9f9b3c42-841c-4ef5-8a9b-9a229924ad1e",
    });
    const children = await Promise.all(
      ["first", "second"].map(async (name) => {
        const child = path.join(sessionDir, `${name}.jsonl`);
        await fs.writeFile(
          child,
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: name,
            timestamp: new Date().toISOString(),
            cwd: projectDir,
            parentSession: source,
          })}\n`,
        );
        return fs.realpath(child);
      }),
    );
    await Promise.all(
      children.map((sessionFile) =>
        workspaces.upsertSessionRefFromSnapshot({
          workspaceId: workspace.id,
          sessionFile,
        }),
      ),
    );
    await journal.recoverSourceTargetsAfterRestart(workspaces, undefined);
    assert.equal(await journal.blocks(source), true);
    for (const child of children) {
      assert.equal(await journal.blocks(child), true);
    }
    assert.equal((await workspaces.getSessionRefs(workspace.id)).length, 2);
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
