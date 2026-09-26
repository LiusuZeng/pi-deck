import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
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
  const expected = path.join(await fs.realpath(root), "missing.jsonl");

  assert.equal(await canonicalFilesystemPath(missing), expected);
  assert.equal(await canonicalSessionFilePath(missing), expected);
  assert.equal(canonicalSessionFilePathSync(missing), expected);
});

test("canonical filesystem identity resolves a symlink ancestor for missing descendants", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-identity-"));
  const target = path.join(root, "project");
  const alias = path.join(root, "project-alias");
  await fs.mkdir(target);
  await fs.symlink(target, alias, "dir");

  const directMissing = path.join(target, "future", "session.jsonl");
  const aliasMissing = path.join(alias, "future", "session.jsonl");
  const expected = path.join(
    await fs.realpath(target),
    "future",
    "session.jsonl",
  );

  // Async project/session identity and synchronous reservation identity must
  // all collapse before the missing suffix is appended.
  assert.equal(await canonicalFilesystemPath(aliasMissing), expected);
  assert.equal(await canonicalProjectPath(aliasMissing), expected);
  assert.equal(await canonicalSessionFilePath(aliasMissing), expected);
  assert.equal(canonicalSessionFilePathSync(aliasMissing), expected);
  assert.equal(
    await canonicalFilesystemPath(aliasMissing),
    await canonicalFilesystemPath(directMissing),
  );
  assert.equal(
    canonicalSessionFilePathSync(aliasMissing),
    canonicalSessionFilePathSync(directMissing),
  );
});

test("canonical filesystem identity does not probe ancestors after a permission error", async () => {
  const denied = path.resolve("permission-denied", "session.jsonl");
  const error = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  const realpath = vi.spyOn(fs, "realpath").mockRejectedValue(error);
  try {
    assert.equal(await canonicalFilesystemPath(denied), denied);
    assert.equal(realpath.mock.calls.length, 1);
  } finally {
    realpath.mockRestore();
  }
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
