import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  chatSnapshotPersistenceFields,
  deriveChatSnapshotMetadata,
  type ChatSnapshotMetadata,
} from "./chatSnapshotMetadata.js";
import { ProjectStore } from "./projects/projectStore.js";
import { WorkspaceStore } from "./workspaces/workspaceStore.js";

const sparseSnapshots: ReadonlyArray<{
  name: string;
  metadata: ChatSnapshotMetadata;
  kind: "empty" | "skipped";
  title?: string;
}> = [
  {
    name: "fetched empty transcript",
    metadata: deriveChatSnapshotMetadata({ state: {}, messages: [] }),
    kind: "empty",
  },
  {
    name: "skipped transcript",
    metadata: deriveChatSnapshotMetadata({
      state: {},
      messages: [{ id: "ignored", role: "user", content: "Ignored" }],
      skipMessages: true,
    }),
    kind: "skipped",
  },
  {
    name: "state-only transcript",
    metadata: deriveChatSnapshotMetadata({
      state: { sessionName: "  Renamed\nby Pi  " },
      messages: [],
      skipMessages: true,
    }),
    kind: "skipped",
    title: "Renamed by Pi",
  },
];

function assertCachedTranscriptFields(
  ref: {
    title?: string;
    messageCount?: number;
    preview?: string;
    completedAtMs?: number;
    lastKnownUpdatedAtMs?: number;
  },
  title: string,
): void {
  assert.equal(ref.title, title);
  assert.equal(ref.messageCount, 2);
  assert.equal(ref.preview, "Cached preview");
  assert.equal(ref.completedAtMs, 456);
  assert.equal(ref.lastKnownUpdatedAtMs, 123);
}

test("WorkspaceStore keeps fetched-empty, skipped, and state-only snapshots sparse", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-snapshot-workspace-"),
  );
  const sessionFile = path.join(root, "session.jsonl");
  await fs.writeFile(sessionFile, "");
  const home = path.join(root, "home");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Snapshots" });
  await store.upsertSessionRefFromSnapshot({
    workspaceId: workspace.id,
    sessionFile,
    title: "Cached title",
    updatedAtMs: 123,
    completedAtMs: 456,
    messageCount: 2,
    preview: "Cached preview",
  });

  for (const snapshot of sparseSnapshots) {
    assert.equal(snapshot.metadata.kind, snapshot.kind, snapshot.name);
    const fields = chatSnapshotPersistenceFields(snapshot.metadata);
    assert.deepEqual(
      fields,
      snapshot.title === undefined ? {} : { title: snapshot.title },
      snapshot.name,
    );
    await store.upsertSessionRefFromSnapshot({
      workspaceId: workspace.id,
      sessionFile,
      ...fields,
    });
    const [ref] = await new WorkspaceStore(home).getSessionRefs(workspace.id);
    assertCachedTranscriptFields(ref!, snapshot.title ?? "Cached title");
  }
});

test("ProjectStore keeps fetched-empty, skipped, and state-only snapshots sparse", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-snapshot-project-"),
  );
  const home = path.join(root, "home");
  const projectDir = path.join(root, "project");
  const sessionFile = path.join(root, "session.jsonl");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(sessionFile, "");
  const project = await fs.realpath(projectDir);
  const store = new ProjectStore(home);
  await store.upsertAndActivateProject(project);
  await store.upsertSessionRefFromSnapshot({
    projectId: project,
    sessionFile,
    title: "Cached title",
    updatedAtMs: 123,
    completedAtMs: 456,
    messageCount: 2,
    preview: "Cached preview",
  });

  for (const snapshot of sparseSnapshots) {
    assert.equal(snapshot.metadata.kind, snapshot.kind, snapshot.name);
    const fields = chatSnapshotPersistenceFields(snapshot.metadata);
    assert.deepEqual(
      fields,
      snapshot.title === undefined ? {} : { title: snapshot.title },
      snapshot.name,
    );
    await store.upsertSessionRefFromSnapshot({
      projectId: project,
      sessionFile,
      ...fields,
    });
    const [ref] = await new ProjectStore(home).getSessionRefs(project);
    assertCachedTranscriptFields(ref!, snapshot.title ?? "Cached title");
  }
});
