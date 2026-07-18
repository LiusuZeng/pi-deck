import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { ProjectStore } from "./projectStore.js";
import type { ChatSessionSummary } from "../../shared/types.js";

test("ProjectStore serializes concurrent persists without temp-file rename races", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-project-store-"),
  );
  const rawProjectA = path.join(root, "project-a");
  const rawProjectB = path.join(root, "project-b");
  await fs.mkdir(rawProjectA, { recursive: true });
  await fs.mkdir(rawProjectB, { recursive: true });
  const projectA = await fs.realpath(rawProjectA);
  const projectB = await fs.realpath(rawProjectB);

  const store = new ProjectStore(path.join(root, "home"));
  await Promise.all([
    store.upsertAndActivateProject(projectA),
    store.upsertAndActivateProject(projectB),
  ]);

  const listed = await store.list();
  assert.equal(listed.projects.length, 2);
  assert.deepEqual(
    new Set(listed.projects.map((project) => project.id)),
    new Set([projectA, projectB]),
  );
});

test("ProjectStore persists active canonical project and avoids duplicate upserts", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-project-store-"),
  );
  const home = path.join(root, "home");
  const rawProject = path.join(root, "project");
  await fs.mkdir(rawProject, { recursive: true });
  const canonicalProject = await fs.realpath(rawProject);

  const store = new ProjectStore(home);
  const first = await store.upsertAndActivateProject(rawProject);
  const second = await store.upsertAndActivateProject(canonicalProject);

  assert.equal(first.id, canonicalProject);
  assert.equal(second.id, canonicalProject);
  assert.equal((await store.list()).projects.length, 1);

  const reloaded = new ProjectStore(home);
  const listed = await reloaded.list();
  assert.equal(listed.activeProjectId, canonicalProject);
  assert.equal(listed.activeProject?.id, canonicalProject);
  assert.equal(listed.projects.length, 1);
});

test("ProjectStore backs up corrupt metadata and recovers to defaults", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-project-store-"),
  );
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "projects.json"), "{ not json\n");

  const store = new ProjectStore(home);
  const listed = await store.list();

  assert.equal(listed.projects.length, 0);
  const files = await fs.readdir(home);
  assert.ok(files.some((file) => file.startsWith("projects.json.corrupt-")));
});

test("ProjectStore bulk session refresh persists once and skips an unchanged normalized refresh", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-project-store-"),
  );
  const home = path.join(root, "home");
  const projectDir = path.join(root, "project");
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  const project = await fs.realpath(projectDir);
  const sessionFiles = await Promise.all(
    ["one.jsonl", "two.jsonl", "three.jsonl"].map(async (name) => {
      const sessionFile = path.join(sessionsDir, name);
      await fs.writeFile(sessionFile, "");
      return sessionFile;
    }),
  );
  const summaries: ChatSessionSummary[] = sessionFiles.map(
    (sessionFile, index) => ({
      id: sessionFile,
      sessionFile,
      sessionId: `session-${index}`,
      cwd: project,
      title: `Session ${index}`,
      updatedAtMs: 100 + index,
      createdAtMs: 50 + index,
      messageCount: index,
      preview: `preview ${index}`,
    }),
  );

  const store = new ProjectStore(home);
  await store.upsertAndActivateProject(project);
  const writeFile = vi.spyOn(fs, "writeFile");

  await store.upsertSessionRefs(project, summaries);
  assert.equal(writeFile.mock.calls.length, 1);
  assert.equal((await store.getSessionRefs(project)).length, summaries.length);

  writeFile.mockClear();
  await store.upsertSessionRefs(project, summaries);
  assert.equal(writeFile.mock.calls.length, 0);

  writeFile.mockClear();
  await store.upsertSessionRefs(project, [], {
    missingSessionFiles: sessionFiles.slice(0, 2),
  });
  assert.equal(writeFile.mock.calls.length, 1);

  writeFile.mockClear();
  await store.upsertSessionRefs(project, [], {
    missingSessionFiles: sessionFiles.slice(0, 2),
  });
  assert.equal(writeFile.mock.calls.length, 0);
  writeFile.mockRestore();
});

test("ProjectStore retries a failed bulk persist on an unchanged refresh", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-project-store-retry-"),
  );
  const home = path.join(root, "home");
  const projectDir = path.join(root, "project");
  const sessionFile = path.join(root, "session.jsonl");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(sessionFile, "");
  const project = await fs.realpath(projectDir);
  const summary: ChatSessionSummary = {
    id: sessionFile,
    sessionFile,
    title: "Retry session",
    updatedAtMs: 100,
    messageCount: 1,
  };

  const store = new ProjectStore(home);
  await store.upsertAndActivateProject(project);
  const writeFile = vi.spyOn(fs, "writeFile");
  writeFile.mockRejectedValueOnce(new Error("injected write failure"));

  await assert.rejects(
    store.upsertSessionRefs(project, [summary]),
    /injected write failure/,
  );
  await store.upsertSessionRefs(project, [summary]);
  writeFile.mockRestore();

  const reloaded = new ProjectStore(home);
  const refs = await reloaded.getSessionRefs(project);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.title, "Retry session");
});

test("ProjectStore bulk session upserts validate the entire batch before changing state", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-project-store-"),
  );
  const home = path.join(root, "home");
  const projectDir = path.join(root, "project");
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  const project = await fs.realpath(projectDir);
  const sessionFile = path.join(sessionsDir, "session.jsonl");
  await fs.writeFile(sessionFile, "");

  const store = new ProjectStore(home);
  await store.upsertAndActivateProject(project);
  const writeFile = vi.spyOn(fs, "writeFile");
  const valid: ChatSessionSummary = {
    id: sessionFile,
    sessionFile,
    title: "Valid session",
    updatedAtMs: 100,
    messageCount: 1,
  };
  const invalid = { ...valid, sessionFile: "" } as ChatSessionSummary;

  await assert.rejects(store.upsertSessionRefs(project, [valid, invalid]));
  assert.equal((await store.getSessionRefs(project)).length, 0);
  assert.equal(writeFile.mock.calls.length, 0);
  writeFile.mockRestore();
});

test("ProjectStore upserts and marks project session refs by canonical file", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-project-store-"),
  );
  const home = path.join(root, "home");
  const projectDir = path.join(root, "project");
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  const project = await fs.realpath(projectDir);
  const sessionFile = path.join(sessionsDir, "session.jsonl");
  await fs.writeFile(sessionFile, "");
  const canonicalSessionFile = await fs.realpath(sessionFile);

  const store = new ProjectStore(home);
  await store.upsertAndActivateProject(project);
  const summary: ChatSessionSummary = {
    id: canonicalSessionFile,
    sessionFile,
    sessionId: "session-1",
    cwd: project,
    title: "First title",
    updatedAtMs: 100,
    createdAtMs: 50,
    messageCount: 2,
    preview: "hello",
  };

  await store.upsertSessionRef(project, summary);
  await store.upsertSessionRef(project, { ...summary, title: "Updated" });
  let refs = await store.getSessionRefs(project);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.sessionFile, canonicalSessionFile);
  assert.equal(refs[0]?.title, "Updated");
  assert.equal(refs[0]?.missingSinceMs, undefined);

  await store.markSessionMissing(project, sessionFile);
  refs = await store.getSessionRefs(project);
  assert.equal(typeof refs[0]?.missingSinceMs, "number");

  await store.removeSessionRef(project, sessionFile);
  refs = await store.getSessionRefs(project);
  assert.equal(refs.length, 0);
});
