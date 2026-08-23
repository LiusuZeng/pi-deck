import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, test, vi } from "vitest";
import { WorkspaceStore } from "./workspaces/workspaceStore.js";

const electronMock = vi.hoisted(() => ({
  app: {
    on: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => {})),
    setPath: vi.fn(),
    quit: vi.fn(),
  },
}));
const temporaryRoots: string[] = [];

vi.mock("electron", () => ({
  app: electronMock.app,
  BrowserWindow: class {},
  dialog: {},
  nativeTheme: { on: vi.fn() },
  shell: {},
  session: {},
  nativeImage: {},
  webContents: {},
}));

test("compatibility chat creation resolves the stable default without activation", async () => {
  const { resolveChatCreationWorkspaceId } = await import("./main.js");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-default-workspace-fallback-"),
  );
  temporaryRoots.push(root);
  const home = path.join(root, "home");
  const store = new WorkspaceStore(home);
  const named = await store.create({ name: "Named workspace" });
  const defaultWorkspace = await store.ensureDefaultWorkspace();

  assert.equal(
    resolveChatCreationWorkspaceId(undefined, defaultWorkspace.id),
    defaultWorkspace.id,
  );
  assert.equal(
    resolveChatCreationWorkspaceId(named.id, defaultWorkspace.id),
    named.id,
  );
  assert.equal((await store.getActiveWorkspace())?.id, named.id);

  const sessionFile = path.join(root, "session.jsonl");
  await fs.writeFile(sessionFile, "session\n");
  await store.upsertSessionRefFromSnapshot({
    workspaceId: resolveChatCreationWorkspaceId(undefined, defaultWorkspace.id),
    sessionFile,
    sessionId: "pi-session",
    title: "Compatibility session",
    messageCount: 0,
  });

  const owner = await store.getSessionOwner(sessionFile);
  assert.equal(owner?.workspaceId, defaultWorkspace.id);
  assert.equal(
    (await store.getSessionRefs(named.id)).some(
      (ref) => ref.sessionFile === owner?.sessionFile,
    ),
    false,
  );
  assert.equal(
    (await store.getSessionRefs(defaultWorkspace.id)).filter(
      (ref) => ref.sessionFile === owner?.sessionFile,
    ).length,
    1,
  );

  const reloadedStore = new WorkspaceStore(home);
  const reloadedDefault = await reloadedStore.ensureDefaultWorkspace();
  assert.equal(reloadedDefault.id, defaultWorkspace.id);
  assert.equal((await reloadedStore.getActiveWorkspace())?.id, named.id);
});

test("chat creation rejects an unresolved workspace instead of creating an unowned runtime", async () => {
  const { resolveChatCreationWorkspaceId } = await import("./main.js");
  assert.throws(
    () => resolveChatCreationWorkspaceId(undefined, undefined),
    /requires a workspace/i,
  );
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});

beforeAll(async () => {
  await import("./main.js");
});
