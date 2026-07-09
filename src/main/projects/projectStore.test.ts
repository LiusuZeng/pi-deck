import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ProjectStore } from "./projectStore.js";

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
