import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { WorkspaceStore } from "./workspaceStore.js";
import type { ChatSessionSummary } from "../../shared/types.js";

async function temporaryHome(): Promise<{ root: string; home: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-workspace-store-"));
  return { root, home: path.join(root, "home") };
}

function summary(sessionFile: string, title = "Cached session"): ChatSessionSummary {
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

  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(first.name, "Product planning");
  assert.equal((await store.list()).workspaces.length, 2);
  assert.equal((await store.getActiveWorkspace())?.id, second.id);

  await store.archive(second.id);
  const listed = await store.list();
  assert.equal(listed.workspaces.length, 1);
  assert.equal(listed.activeWorkspaceId, first.id);
  await assert.rejects(store.select(second.id), /archived/i);
});

test("WorkspaceStore removes, rather than serializes, a cleared default project", async () => {
  const { home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const workspace = await store.create({
    name: "With a folder",
    defaultProjectId: "project-a",
  });

  await store.update({ workspaceId: workspace.id, defaultProjectId: null });
  assert.equal((await store.getWorkspace(workspace.id))?.defaultProjectId, undefined);
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

test("WorkspaceStore validates an entire refresh batch before changing membership", async () => {
  const { root, home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Batch" });
  const validFile = path.join(root, "valid.jsonl");
  const invalid = { ...summary(path.join(root, "invalid.jsonl")), messageCount: -1 } as ChatSessionSummary;

  await assert.rejects(store.upsertSessionRefs(workspace.id, [summary(validFile), invalid]));
  assert.deepEqual(await store.getSessionRefs(workspace.id), []);
});

test("WorkspaceStore retries a failed equivalent persistence mutation", async () => {
  const { root, home } = await temporaryHome();
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Retry" });
  const sessionFile = path.join(root, "retry.jsonl");
  const writeFile = vi.spyOn(fs, "writeFile");
  writeFile.mockRejectedValueOnce(new Error("injected write failure"));

  await assert.rejects(store.upsertSessionRef(workspace.id, summary(sessionFile)), /injected write failure/);
  await store.upsertSessionRef(workspace.id, summary(sessionFile));
  writeFile.mockRestore();

  const reloaded = new WorkspaceStore(home);
  assert.equal((await reloaded.getSessionRefs(workspace.id))[0]?.title, "Cached session");
});

test("WorkspaceStore backs up corrupt metadata and recovers an empty store", async () => {
  const { home } = await temporaryHome();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "workspaces.json"), "{ broken\n");

  const store = new WorkspaceStore(home);
  assert.deepEqual(await store.list(), { workspaces: [] });
  assert.ok((await fs.readdir(home)).some((file) => file.startsWith("workspaces.json.corrupt-")));
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
      { id: "older", displayName: "Older", createdAtMs: now, updatedAtMs: now, lastOpenedAtMs: 20 },
      { id: "active", displayName: "Active", createdAtMs: now, updatedAtMs: now, lastOpenedAtMs: 10 },
      { id: "archived", displayName: "Archived", createdAtMs: now, updatedAtMs: now, lastOpenedAtMs: 100, archivedAtMs: now },
    ],
    sessionRefs: [
      { projectId: "older", sessionFile, addedAtMs: now, lastSeenAtMs: now, title: "Older copy" },
      { projectId: "active", sessionFile, addedAtMs: now, lastSeenAtMs: now, title: "Active copy" },
      { projectId: "archived", sessionFile: `${sessionFile}-ignored`, addedAtMs: now, lastSeenAtMs: now },
    ],
  });

  assert.equal(result.workspaces.length, 2);
  assert.equal(result.activeWorkspace?.legacyProjectId, "active");
  const active = result.workspaces.find((workspace) => workspace.legacyProjectId === "active")!;
  assert.equal((await store.getSessionRefs(active.id))[0]?.title, "Active copy");
  assert.equal(diagnostics.recordError.mock.calls.length, 1);

  const replay = await store.migrateLegacyProjects({
    projects: [{ id: "new", displayName: "Must not appear", createdAtMs: now, updatedAtMs: now, lastOpenedAtMs: now }],
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
