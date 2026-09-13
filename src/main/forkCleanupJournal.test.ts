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
  await journal.retry(workspaces, projects);
  assert.equal(await journal.blocks(sessionFile), true);
  assert.equal((await workspaces.getSessionRefs(workspace.id)).length, 1);

  writeFile.mockRestore();
  const restarted = new ForkCleanupJournal(home);
  await restarted.retry(new WorkspaceStore(home), new ProjectStore(home));
  assert.equal(await restarted.blocks(sessionFile), false);
  assert.equal(
    (await new WorkspaceStore(home).getSessionRefs(workspace.id)).length,
    0,
  );
  assert.equal(
    (await new ProjectStore(home).getSessionRefs(projectId)).length,
    0,
  );
});
