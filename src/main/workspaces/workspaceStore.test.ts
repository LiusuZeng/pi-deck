import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { WorkspaceStore } from "./workspaceStore.js";
import type { ChatSessionSummary } from "../../shared/types.js";

async function temporaryHome(): Promise<{ root: string; home: string }> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-workspace-store-"),
  );
  return { root, home: path.join(root, "home") };
}

function summary(
  sessionFile: string,
  title = "Cached session",
): ChatSessionSummary {
  return {
    id: sessionFile,
    sessionFile,
    title,
    updatedAtMs: 123,
    createdAtMs: 100,
    messageCount: 2,
    preview: "Cached preview",
  };
}

test("WorkspaceStore creates UUID workspaces, normalizes names, and archives the active workspace", async () => {
  const { home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const first = await store.create({ name: "  Product   planning  " });
  const second = await store.create({ name: "Product planning" });

  assert.match(
    first.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(first.name, "Product planning");
  assert.equal((await store.list()).workspaces.length, 2);
  assert.equal((await store.getActiveWorkspace())?.id, second.id);

  await store.archive(second.id);
  const listed = await store.list();
  assert.equal(listed.workspaces.length, 1);
  assert.equal(listed.activeWorkspaceId, first.id);
  await assert.rejects(store.select(second.id), /archived/i);
});

test("WorkspaceStore provides a stable, folderless default workspace", async () => {
  const { home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const first = await store.ensureDefaultWorkspace({ activate: true });
  const second = await store.ensureDefaultWorkspace();

  assert.equal(first.id, second.id);
  assert.equal(first.name, "Default workspace");
  assert.equal(first.isDefault, true);
  assert.equal(first.defaultProjectId, undefined);
  assert.equal((await store.list()).activeWorkspaceId, first.id);
  await assert.rejects(
    store.update({ workspaceId: first.id, name: "Renamed" }),
    /default workspace/i,
  );
  await assert.rejects(store.archive(first.id), /default workspace/i);
});

test("WorkspaceStore archives session membership without touching the Pi file", async () => {
  const { root, home } = await temporaryHome();
  const sessionFile = path.join(root, "session.jsonl");
  await fs.writeFile(sessionFile, "pi jsonl remains here\n");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Archive me" });
  await store.upsertSessionRef(workspace.id, summary(sessionFile));

  await store.archiveSession(workspace.id, sessionFile);
  assert.deepEqual(await store.getCachedSessionSummaries(workspace.id), []);
  const archived = await store.getCachedSessionSummaries(workspace.id, {
    includeArchived: true,
  });
  assert.equal(archived[0]?.archivedAtMs !== undefined, true);
  assert.equal(
    await fs.readFile(sessionFile, "utf8"),
    "pi jsonl remains here\n",
  );

  await store.restoreSession(workspace.id, sessionFile);
  assert.equal((await store.getCachedSessionSummaries(workspace.id)).length, 1);
});

test("WorkspaceStore cascades archive and restores only cascade-owned sessions", async () => {
  const { root, home } = await temporaryHome();
  const firstFile = path.join(root, "first.jsonl");
  const secondFile = path.join(root, "second.jsonl");
  await fs.writeFile(firstFile, "first\n");
  await fs.writeFile(secondFile, "second\n");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Cascade" });
  await store.upsertSessionRef(workspace.id, summary(firstFile, "First"));
  await store.upsertSessionRef(workspace.id, summary(secondFile, "Second"));
  await store.archiveSession(workspace.id, firstFile);

  await store.archive(workspace.id);
  assert.equal((await store.list()).workspaces.length, 0);
  assert.equal((await store.list()).archivedWorkspaces?.length, 1);
  assert.equal(
    (
      await store.getCachedSessionSummaries(workspace.id, {
        includeArchived: true,
      })
    ).every((session) => session.archivedAtMs !== undefined),
    true,
  );

  await store.restore(workspace.id);
  const restored = await store.getCachedSessionSummaries(workspace.id);
  assert.deepEqual(
    restored.map((session) => session.title),
    ["Second"],
  );
  const all = await store.getCachedSessionSummaries(workspace.id, {
    includeArchived: true,
  });
  assert.equal(
    all.find((session) => session.title === "First")?.archivedAtMs !==
      undefined,
    true,
  );
});

test("WorkspaceStore refreshes archived session metadata without reopening the workspace", async () => {
  const { root, home } = await temporaryHome();
  const sessionFile = path.join(root, "archived.jsonl");
  await fs.writeFile(sessionFile, "session\n");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Archived metadata" });
  await store.upsertSessionRef(workspace.id, summary(sessionFile, "Old title"));
  await store.archive(workspace.id);

  await store.upsertSessionRefs(
    workspace.id,
    [summary(sessionFile, "Prompt-derived title")],
    { allowArchived: true },
  );

  const archived = await store.getCachedSessionSummaries(workspace.id, {
    includeArchived: true,
  });
  assert.equal(archived[0]?.title, "Prompt-derived title");
  assert.equal(archived[0]?.archivedAtMs !== undefined, true);
});

test("WorkspaceStore removes, rather than serializes, a cleared default project", async () => {
  const { home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const workspace = await store.create({
    name: "With a folder",
    defaultProjectId: "project-a",
  });

  await store.update({ workspaceId: workspace.id, defaultProjectId: null });
  assert.equal(
    (await store.getWorkspace(workspace.id))?.defaultProjectId,
    undefined,
  );
  const persisted = JSON.parse(
    await fs.readFile(path.join(home, "workspaces.json"), "utf8"),
  ) as { workspaces: Array<Record<string, unknown>> };
  assert.equal("defaultProjectId" in persisted.workspaces[0]!, false);
});

test("WorkspaceStore persists membership once by canonical file and projects cached summaries without I/O", async () => {
  const { root, home } = await temporaryHome();
  const sessions = path.join(root, "sessions");
  await fs.mkdir(sessions);
  const sessionFile = path.join(sessions, "one.jsonl");
  await fs.writeFile(sessionFile, "");
  const store = new WorkspaceStore(home);
  const left = await store.create({ name: "Left" });
  const right = await store.create({ name: "Right" });

  await store.upsertSessionRef(left.id, summary(sessionFile));
  await store.upsertSessionRef(right.id, summary(sessionFile, "Moved"));
  assert.equal((await store.getSessionRefs(left.id)).length, 0);
  assert.equal((await store.getSessionRefs(right.id)).length, 1);

  const readFile = vi.spyOn(fs, "readFile");
  assert.deepEqual(await store.getCachedSessionSummaries(right.id), [
    { ...summary(await fs.realpath(sessionFile), "Moved") },
  ]);
  assert.equal(readFile.mock.calls.length, 0);
  readFile.mockRestore();

  assert.equal(await store.removeSession(right.id, sessionFile), true);
  assert.equal(await store.removeSession(right.id, sessionFile), false);
  assert.equal((await store.getSessionRefs(right.id)).length, 0);
});

test("WorkspaceStore preserves a durable title across title-less model and thinking snapshots", async () => {
  const { root, home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Snapshots" });
  const sessionFile = path.join(root, "parent.jsonl");

  await store.upsertSessionRefFromSnapshot({
    workspaceId: workspace.id,
    sessionFile,
    sessionId: "parent-id",
    title: "Durable parent title",
    messageCount: 3,
  });
  // Model and thinking updates are state-only snapshots and have no title.
  await store.upsertSessionRefFromSnapshot({
    workspaceId: workspace.id,
    sessionFile,
    sessionId: "parent-id",
  });
  const preserved = await store.getSessionRefs(workspace.id);
  assert.equal(preserved[0]?.title, "Durable parent title");

  const newFile = path.join(root, "new-parent.jsonl");
  await store.upsertSessionRefFromSnapshot({
    workspaceId: workspace.id,
    sessionFile: newFile,
  });
  assert.equal(
    (await store.getSessionRefs(workspace.id)).find(
      (ref) => ref.sessionFile === path.resolve(newFile),
    )?.title,
    "new-parent",
  );
});

test("WorkspaceStore validates an entire refresh batch before changing membership", async () => {
  const { root, home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Batch" });
  const validFile = path.join(root, "valid.jsonl");
  const invalid = {
    ...summary(path.join(root, "invalid.jsonl")),
    messageCount: -1,
  } as ChatSessionSummary;

  await assert.rejects(
    store.upsertSessionRefs(workspace.id, [summary(validFile), invalid]),
  );
  assert.deepEqual(await store.getSessionRefs(workspace.id), []);
});

test("WorkspaceStore retries a failed equivalent persistence mutation", async () => {
  const { root, home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Retry" });
  const sessionFile = path.join(root, "retry.jsonl");
  const writeFile = vi.spyOn(fs, "writeFile");
  writeFile.mockRejectedValueOnce(new Error("injected write failure"));

  await assert.rejects(
    store.upsertSessionRef(workspace.id, summary(sessionFile)),
    /injected write failure/,
  );
  await store.upsertSessionRef(workspace.id, summary(sessionFile));
  writeFile.mockRestore();

  const reloaded = new WorkspaceStore(home);
  assert.equal(
    (await reloaded.getSessionRefs(workspace.id))[0]?.title,
    "Cached session",
  );
});

test("WorkspaceStore backs up corrupt metadata and recovers an empty store", async () => {
  const { home } = await temporaryHome();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "workspaces.json"), "{ broken\n");

  const store = new WorkspaceStore(home);
  assert.deepEqual(await store.list(), { workspaces: [] });
  assert.ok(
    (await fs.readdir(home)).some((file) =>
      file.startsWith("workspaces.json.corrupt-"),
    ),
  );
});

test("WorkspaceStore migrates legacy projects deterministically and is idempotent", async () => {
  const { root, home } = await temporaryHome();
  const sessionFile = path.join(root, "duplicate.jsonl");
  const diagnostics = { recordError: vi.fn() };
  const store = new WorkspaceStore(home, diagnostics as never);
  const now = 1_000;

  const result = await store.migrateLegacyProjects({
    activeProjectId: "active",
    projects: [
      {
        id: "older",
        displayName: "Older",
        createdAtMs: now,
        updatedAtMs: now,
        lastOpenedAtMs: 20,
      },
      {
        id: "active",
        displayName: "Active",
        createdAtMs: now,
        updatedAtMs: now,
        lastOpenedAtMs: 10,
      },
      {
        id: "archived",
        displayName: "Archived",
        createdAtMs: now,
        updatedAtMs: now,
        lastOpenedAtMs: 100,
        archivedAtMs: now,
      },
    ],
    sessionRefs: [
      {
        projectId: "older",
        sessionFile,
        addedAtMs: now,
        lastSeenAtMs: now,
        title: "Older copy",
      },
      {
        projectId: "active",
        sessionFile,
        addedAtMs: now,
        lastSeenAtMs: now,
        title: "Active copy",
      },
      {
        projectId: "archived",
        sessionFile: `${sessionFile}-ignored`,
        addedAtMs: now,
        lastSeenAtMs: now,
      },
    ],
  });

  assert.equal(result.workspaces.length, 2);
  assert.equal(result.activeWorkspace?.legacyProjectId, "active");
  const active = result.workspaces.find(
    (workspace) => workspace.legacyProjectId === "active",
  )!;
  assert.equal(
    (await store.getSessionRefs(active.id))[0]?.title,
    "Active copy",
  );
  assert.equal(diagnostics.recordError.mock.calls.length, 1);

  const replay = await store.migrateLegacyProjects({
    projects: [
      {
        id: "new",
        displayName: "Must not appear",
        createdAtMs: now,
        updatedAtMs: now,
        lastOpenedAtMs: now,
      },
    ],
    sessionRefs: [],
  });
  assert.equal(replay.workspaces.length, 2);
  assert.equal(await store.getWorkspaceByLegacyProjectId("new"), undefined);
});

test("WorkspaceStore creates an initial folderless migration workspace when no projects exist", async () => {
  const { home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const result = await store.migrateLegacyProjects({
    projects: [],
    sessionRefs: [],
    bootstrapWorkspace: { name: "  My    workspace " },
  });
  assert.equal(result.activeWorkspace?.name, "My workspace");
  assert.equal(result.activeWorkspace?.defaultProjectId, undefined);
});

async function createLegacyWorkspaceWithSession(): Promise<{
  root: string;
  home: string;
  store: WorkspaceStore;
  workspaceId: string;
  sessionFile: string;
}> {
  const { root, home } = await temporaryHome();
  const sessionFile = path.join(root, "legacy.jsonl");
  await fs.writeFile(sessionFile, "");
  const store = new WorkspaceStore(home);
  const migrated = await store.migrateLegacyProjects({
    activeProjectId: "legacy-project",
    projects: [
      {
        id: "legacy-project",
        displayName: "Legacy",
        createdAtMs: 1,
        updatedAtMs: 1,
        lastOpenedAtMs: 1,
      },
    ],
    sessionRefs: [
      {
        projectId: "legacy-project",
        sessionFile,
        addedAtMs: 1,
        lastSeenAtMs: 1,
      },
    ],
  });
  return {
    root,
    home,
    store,
    workspaceId: migrated.activeWorkspace!.id,
    sessionFile: await fs.realpath(sessionFile),
  };
}

test("WorkspaceStore persists a legacy removal exclusion and explicit re-add clears it", async () => {
  const { home, store, workspaceId, sessionFile } =
    await createLegacyWorkspaceWithSession();

  assert.equal(await store.removeSession(workspaceId, sessionFile), true);
  assert.equal(
    await store.isLegacySessionExcluded(workspaceId, sessionFile),
    true,
  );

  await store.upsertSessionRefs(workspaceId, [summary(sessionFile)]);
  assert.equal(await store.getSessionOwner(sessionFile), undefined);
  assert.equal(
    await store.isLegacySessionExcluded(workspaceId, sessionFile),
    true,
  );

  const reloaded = new WorkspaceStore(home);
  assert.equal(
    await reloaded.isLegacySessionExcluded(workspaceId, sessionFile),
    true,
  );
  await reloaded.upsertSessionRef(workspaceId, summary(sessionFile));
  assert.equal(
    await reloaded.isLegacySessionExcluded(workspaceId, sessionFile),
    false,
  );
  assert.equal(
    (await reloaded.getSessionOwner(sessionFile))?.workspaceId,
    workspaceId,
  );
});

test("WorkspaceStore tombstones legacy move sources and clears a move-back target", async () => {
  const { store, workspaceId, sessionFile } =
    await createLegacyWorkspaceWithSession();
  const other = await store.create({ name: "Other" });

  await store.moveSession(sessionFile, other.id);
  assert.equal(
    await store.isLegacySessionExcluded(workspaceId, sessionFile),
    true,
  );
  assert.equal(
    (await store.getSessionOwner(sessionFile))?.workspaceId,
    other.id,
  );

  await store.upsertSessionRefs(workspaceId, [summary(sessionFile)]);
  assert.equal(
    (await store.getSessionOwner(sessionFile))?.workspaceId,
    other.id,
  );

  await store.moveSession(sessionFile, workspaceId);
  assert.equal(
    await store.isLegacySessionExcluded(workspaceId, sessionFile),
    false,
  );
  assert.equal(
    (await store.getSessionOwner(sessionFile))?.workspaceId,
    workspaceId,
  );
});

test("WorkspaceStore reports archived workspace refs as assigned", async () => {
  const { store, workspaceId, sessionFile } =
    await createLegacyWorkspaceWithSession();
  await store.archive(workspaceId);

  assert.equal(
    (await store.getSessionOwner(sessionFile))?.workspaceId,
    workspaceId,
  );
});
