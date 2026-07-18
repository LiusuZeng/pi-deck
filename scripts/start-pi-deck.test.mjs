import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const launcher = path.join(repoRoot, "scripts", "start-pi-deck.mjs");

function dryRun(...args) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("Pi Deck launcher planning", () => {
  it("plans an existing-dist launch without a build", () => {
    const result = dryRun("--fake", "--dry-run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Fake backend Pi Deck production-ish launch",
    );
    expect(result.stdout).toContain("run launch");
    expect(result.stdout).not.toContain("launch:build");
  });

  it("plans an explicit build-and-launch when requested", () => {
    const result = dryRun("--fake", "--build", "--dry-run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("run launch:build");
  });

  it("rejects build mode with the Vite development loop", () => {
    const result = dryRun("--fake", "--dev", "--build", "--dry-run");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--build is only valid with --launch");
  });

  it("keeps real-project path validation before planning", () => {
    const missingProject = path.join(repoRoot, "does-not-exist");
    const result = dryRun("--real", "--project", missingProject, "--dry-run");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Project directory does not exist");
  });
});
