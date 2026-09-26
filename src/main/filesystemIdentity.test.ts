import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  canonicalFilesystemPath,
  canonicalProjectPath,
  canonicalSessionFilePath,
  canonicalSessionFilePathSync,
} from "./filesystemIdentity.js";

test("canonical filesystem identity uses real paths for direct and symlink spellings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-identity-"));
  const target = path.join(root, "project");
  const alias = path.join(root, "project-alias");
  await fs.mkdir(target);
  await fs.symlink(target, alias, "dir");

  const expected = await fs.realpath(target);
  assert.equal(await canonicalFilesystemPath(target), expected);
  assert.equal(await canonicalProjectPath(alias), expected);
  assert.equal(canonicalSessionFilePathSync(alias), expected);
});

test("canonical filesystem identity has a resolved fallback for missing paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-identity-"));
  const missing = path.join(root, "gone", "..", "missing.jsonl");
  const expected = path.resolve(missing);

  assert.equal(await canonicalFilesystemPath(missing), expected);
  assert.equal(await canonicalSessionFilePath(missing), expected);
  assert.equal(canonicalSessionFilePathSync(missing), expected);
});

test.skipIf(process.platform !== "darwin")(
  "canonical filesystem identity collapses the macOS /tmp alias",
  async () => {
    const temporaryDirectory = os.tmpdir();
    const alias = temporaryDirectory.startsWith("/private/")
      ? temporaryDirectory.slice("/private".length)
      : `/private${temporaryDirectory}`;
    assert.equal(
      await canonicalFilesystemPath(temporaryDirectory),
      await canonicalFilesystemPath(alias),
    );
  },
);
