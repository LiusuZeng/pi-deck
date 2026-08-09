import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveLaunchEnvironment,
  resolveLaunchPlan,
} from "./start-pi-deck.mjs";

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

function fakeNpmLaunch(...args) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-fake-npm-"));
  const npm = path.join(bin, "npm");
  fs.writeFileSync(
    npm,
    '#!/bin/sh\nprintf "FAKE_NPM_ARGS:%s\\n" "$*"\nprintf "FAKE_HOME:%s\\n" "$PI_DECK_HOME"\nprintf "FAKE_USER_DATA:%s\\n" "$PI_DECK_USER_DATA_DIR"\n',
    { mode: 0o755 },
  );
  try {
    return spawnSync(process.execPath, [launcher, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

describe("Pi Deck launcher planning", () => {
  it("isolates fake metadata under the checkout-local ignored state directory", () => {
    const checkoutRoot = "/tmp/pi-deck-checkout-a";
    const plan = resolveLaunchPlan({
      backend: "fake",
      runMode: "launch",
      build: false,
      env: {},
      root: checkoutRoot,
    });

    expect(plan.env.PI_DECK_HOME).toBe(
      path.join(checkoutRoot, ".pi", "local", "pi-deck-home"),
    );
    expect(plan.env.PI_DECK_USER_DATA_DIR).toBe(
      path.join(checkoutRoot, ".pi", "local", "electron-user-data"),
    );
    expect(plan.metadataPaths).toEqual({
      piDeckHome: plan.env.PI_DECK_HOME,
      userDataDir: plan.env.PI_DECK_USER_DATA_DIR,
    });
  });

  it("treats blank fake metadata overrides as unsafe and isolates them", () => {
    const plan = resolveLaunchPlan({
      backend: "fake",
      runMode: "launch",
      build: false,
      env: { PI_DECK_HOME: " ", PI_DECK_USER_DATA_DIR: "" },
      root: "/tmp/pi-deck-checkout-a",
    });

    expect(plan.env.PI_DECK_HOME).toContain("/.pi/local/pi-deck-home");
    expect(plan.env.PI_DECK_USER_DATA_DIR).toContain(
      "/.pi/local/electron-user-data",
    );
  });

  it("keeps explicit fake metadata overrides", () => {
    const plan = resolveLaunchPlan({
      backend: "fake",
      runMode: "launch",
      build: false,
      env: {
        PI_DECK_HOME: "/tmp/caller-home",
        PI_DECK_USER_DATA_DIR: "/tmp/caller-user-data",
      },
      root: "/tmp/pi-deck-checkout-a",
    });

    expect(plan.env.PI_DECK_HOME).toBe("/tmp/caller-home");
    expect(plan.env.PI_DECK_USER_DATA_DIR).toBe("/tmp/caller-user-data");
  });

  it("does not redirect real backend metadata", () => {
    const env = {
      PI_DECK_HOME: "/Users/example/.pideck",
      PI_DECK_USER_DATA_DIR:
        "/Users/example/Library/Application Support/Pi Deck",
    };
    const resolved = resolveLaunchEnvironment({
      backend: "real",
      env,
      root: "/tmp/pi-deck-checkout-a",
    });

    expect(resolved.metadataPaths).toBeUndefined();
    expect(resolved.env.PI_DECK_HOME).toBe(env.PI_DECK_HOME);
    expect(resolved.env.PI_DECK_USER_DATA_DIR).toBe(env.PI_DECK_USER_DATA_DIR);
  });

  it("routes raw fake development through the isolated internal app script", () => {
    const plan = resolveLaunchPlan({
      backend: "fake",
      runMode: "dev",
      build: false,
      env: {},
      root: "/tmp/pi-deck-checkout-a",
    });

    expect(plan.npmScript).toBe("dev:app");
    expect(plan.env.PI_DECK_HOME).toContain("/.pi/local/");
    expect(plan.env.PI_DECK_USER_DATA_DIR).toContain("/.pi/local/");
  });

  it("plans an existing-dist launch without a build", () => {
    const result = dryRun("--fake", "--dry-run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Fake backend Pi Deck production-ish launch",
    );
    expect(result.stdout).toContain("run launch");
    expect(result.stdout).not.toContain("launch:build");
  });

  it("executes a non-dry fake launch with the resolved script and isolated state", () => {
    const result = fakeNpmLaunch("--fake");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FAKE_NPM_ARGS:--prefix");
    expect(result.stdout).toContain("run launch");
    expect(result.stdout).toContain("FAKE_HOME:");
    expect(result.stdout).toContain("/.pi/local/pi-deck-home");
    expect(result.stdout).toContain("FAKE_USER_DATA:");
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
