import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  claimUnassignedChatResumeWorkspace,
  resolveChatCreationWorkspaceId,
  resolveChatResumeWorkspace,
  resolveChatResumeWorkspaceId,
} from "./chatWorkspaceOwnership.js";
import { WorkspaceStore } from "./workspaces/workspaceStore.js";

const temporaryRoots: string[] = [];

async function createWorkspaceFixture(): Promise<{
  root: string;
  store: WorkspaceStore;
  namedId: string;
  defaultId: string;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-default-workspace-fallback-"),
  );
  temporaryRoots.push(root);
  const store = new WorkspaceStore(path.join(root, "home"));
  const named = await store.create({ name: "Named workspace" });
  const defaultWorkspace = await store.ensureDefaultWorkspace();
  return {
    root,
    store,
    namedId: named.id,
    defaultId: defaultWorkspace.id,
  };
}

test("compatibility chat creation resolves the stable default without activation", async () => {
  const { root, store, namedId, defaultId } = await createWorkspaceFixture();

  assert.equal(resolveChatCreationWorkspaceId(undefined, defaultId), defaultId);
  assert.equal(resolveChatCreationWorkspaceId(namedId, defaultId), namedId);
  assert.equal((await store.getActiveWorkspace())?.id, namedId);

  const sessionFile = path.join(root, "session.jsonl");
  await fs.writeFile(sessionFile, "session\n");
  await store.upsertSessionRefFromSnapshot({
    workspaceId: resolveChatCreationWorkspaceId(undefined, defaultId),
    sessionFile,
    sessionId: "pi-session",
    title: "Compatibility session",
    messageCount: 0,
  });

  const owner = await store.getSessionOwner(sessionFile);
  assert.equal(owner?.workspaceId, defaultId);
  assert.equal(
    (await store.getSessionRefs(namedId)).some(
      (ref) => ref.sessionFile === owner?.sessionFile,
    ),
    false,
  );
  assert.equal(
    (await store.getSessionRefs(defaultId)).filter(
      (ref) => ref.sessionFile === owner?.sessionFile,
    ).length,
    1,
  );

  const reloadedStore = new WorkspaceStore(path.join(root, "home"));
  const reloadedDefault = await reloadedStore.ensureDefaultWorkspace();
  assert.equal(reloadedDefault.id, defaultId);
  assert.equal((await reloadedStore.getActiveWorkspace())?.id, namedId);
});

test("resume ownership keeps a canonical existing owner instead of using the default", async () => {
  const { root, store, namedId, defaultId } = await createWorkspaceFixture();
  const sessionFile = path.join(root, "owned.jsonl");
  const alias = path.join(root, "owned-alias.jsonl");
  await fs.writeFile(sessionFile, "session\n");
  await fs.symlink(sessionFile, alias);
  await store.upsertSessionRefFromSnapshot({
    workspaceId: namedId,
    sessionFile,
    title: "Owned session",
  });

  const ownership = await resolveChatResumeWorkspace(store, alias);
  assert.deepEqual(ownership, { workspaceId: namedId, source: "existing" });
  assert.equal(
    await store.getSessionOwner(alias).then((owner) => owner?.workspaceId),
    namedId,
  );
  assert.equal((await store.getSessionRefs(defaultId)).length, 0);
  assert.equal((await store.getActiveWorkspace())?.id, namedId);
});

test("unassigned resume claims the stable default without activating it", async () => {
  const { root, store, namedId, defaultId } = await createWorkspaceFixture();
  const sessionFile = path.join(root, "unassigned.jsonl");
  await fs.writeFile(sessionFile, "session\n");

  const ownership = await resolveChatResumeWorkspace(store, sessionFile);
  assert.deepEqual(ownership, { workspaceId: defaultId, source: "default" });
  await claimUnassignedChatResumeWorkspace(
    store,
    ownership.workspaceId,
    sessionFile,
  );

  assert.equal(
    (await store.getSessionOwner(sessionFile))?.workspaceId,
    defaultId,
  );
  await assert.rejects(
    claimUnassignedChatResumeWorkspace(store, namedId, sessionFile),
    /ownership changed/i,
  );
  assert.equal(
    (await store.getSessionOwner(sessionFile))?.workspaceId,
    defaultId,
  );
  assert.equal((await store.getActiveWorkspace())?.id, namedId);
});

test("workspace ownership resolvers prefer ownership and reject unresolved fallbacks", () => {
  assert.equal(resolveChatResumeWorkspaceId("owned", "default"), "owned");
  assert.equal(resolveChatResumeWorkspaceId(undefined, "default"), "default");
  assert.throws(
    () => resolveChatCreationWorkspaceId(undefined, undefined),
    /requires a workspace/i,
  );
  assert.throws(
    () => resolveChatResumeWorkspaceId(undefined, undefined),
    /requires a workspace/i,
  );
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});
