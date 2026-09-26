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
  withChatResumeOwnershipTransaction,
} from "./chatWorkspaceOwnership.js";
import { SessionAttachmentGate } from "./sessionDiscoveryGate.js";
import { WorkspaceStore } from "./workspaces/workspaceStore.js";

const temporaryRoots: string[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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

test("resume and discovery queue order deterministically chooses ownership", async () => {
  const discoveryFirst = await createWorkspaceFixture();
  const discoveredFile = path.join(
    discoveryFirst.root,
    "discovered-first.jsonl",
  );
  await fs.writeFile(discoveredFile, "session\n");
  const discoveryFirstGate = new SessionAttachmentGate();
  const discoveryLease = await discoveryFirstGate.enter(0);
  const queuedResume = withChatResumeOwnershipTransaction({
    gate: discoveryFirstGate,
    generation: 0,
    assertActive: () => undefined,
    operation: async () =>
      resolveChatResumeWorkspace(discoveryFirst.store, discoveredFile),
  });

  await discoveryFirst.store.upsertSessionRefs(discoveryFirst.namedId, [
    {
      id: discoveredFile,
      sessionFile: discoveredFile,
      title: "Discovered session",
      updatedAtMs: 1,
      messageCount: 0,
    },
  ]);
  discoveryLease.release();

  assert.deepEqual(await queuedResume, {
    workspaceId: discoveryFirst.namedId,
    source: "existing",
  });
  assert.equal(
    (await discoveryFirst.store.getSessionOwner(discoveredFile))?.workspaceId,
    discoveryFirst.namedId,
  );

  const resumeFirst = await createWorkspaceFixture();
  const resumedFile = path.join(resumeFirst.root, "resume-first.jsonl");
  await fs.writeFile(resumedFile, "session\n");
  const resumeFirstGate = new SessionAttachmentGate();
  const resumeEntered = deferred();
  const allowValidatedClaim = deferred();
  let fallbackResolution:
    | Awaited<ReturnType<typeof resolveChatResumeWorkspace>>
    | undefined;
  const resume = withChatResumeOwnershipTransaction({
    gate: resumeFirstGate,
    generation: 0,
    assertActive: () => undefined,
    operation: async () => {
      const ownership = await resolveChatResumeWorkspace(
        resumeFirst.store,
        resumedFile,
      );
      fallbackResolution = ownership;
      resumeEntered.resolve();
      await allowValidatedClaim.promise;
      await claimUnassignedChatResumeWorkspace(
        resumeFirst.store,
        ownership.workspaceId,
        resumedFile,
      );
    },
  });
  await resumeEntered.promise;
  assert.deepEqual(fallbackResolution, {
    workspaceId: resumeFirst.defaultId,
    source: "default",
  });

  const discovery = (async () => {
    const lease = await resumeFirstGate.enter(0);
    try {
      await resumeFirst.store.upsertSessionRefs(resumeFirst.namedId, [
        {
          id: resumedFile,
          sessionFile: resumedFile,
          title: "Later discovery",
          updatedAtMs: 2,
          messageCount: 0,
        },
      ]);
    } finally {
      lease.release();
    }
  })();
  allowValidatedClaim.resolve();
  await resume;
  await discovery;

  assert.equal(
    (await resumeFirst.store.getSessionOwner(resumedFile))?.workspaceId,
    resumeFirst.defaultId,
  );
  assert.equal(
    (await resumeFirst.store.getSessionRefs(resumeFirst.namedId)).some(
      (ref) => ref.sessionFile === path.resolve(resumedFile),
    ),
    false,
  );
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
