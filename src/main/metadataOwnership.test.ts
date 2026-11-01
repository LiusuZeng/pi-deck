import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import {
  acquireMetadataOwnership,
  MetadataOwnershipError,
} from "./metadataOwnership.js";

const legacyRecoveryDirectoryName = ".pi-deck-metadata-owner.recovery";
const recoveryFencePrefix = "pi-deck-metadata-recovery-v2:";
const recoveryDirectoryName = ".pi-deck-metadata-owner.recovery-v2";

const childOwnerScript = String.raw`
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const [home, mode] = process.argv.slice(1);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(home);
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  const ownerFile = path.join(lockDirectory, "owner.json");
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(ownerFile, JSON.stringify({
    version: 1,
    token: "child-" + process.pid,
    pid: process.pid,
    hostname: os.hostname(),
    startedAtMs: Date.now(),
    canonicalHome,
  }, null, 2) + "\n");
  console.log("ready");
  if (mode === "exit") return;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    if (!String(chunk).includes("release")) return;
    await fs.rm(lockDirectory, { recursive: true, force: true });
    process.exit(0);
  });
  process.stdin.resume();
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;

const oldRecoveryAttemptScript = String.raw`
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const [home] = process.argv.slice(1);
  const canonicalHome = await fs.realpath(home);
  const legacyDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner.recovery");
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  try {
    await fs.mkdir(legacyDirectory, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      console.log("blocked");
      return;
    }
    throw error;
  }
  await fs.rm(lockDirectory, { recursive: true, force: true });
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({
    version: 1,
    token: "old-recovery-" + process.pid,
    pid: process.pid,
    hostname: os.hostname(),
    startedAtMs: Date.now(),
    canonicalHome,
  }) + "\n");
  await fs.rmdir(legacyDirectory);
  console.log("replaced");
  process.stdin.resume();
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;

const v2RecoveryAttemptScript = String.raw`
const [moduleUrl, home] = process.argv.slice(2);
const { acquireMetadataOwnership } = await import(moduleUrl);

function waitFor(command) {
  return new Promise((resolve) => {
    const onData = (chunk) => {
      if (!String(chunk).includes(command)) return;
      process.stdin.off("data", onData);
      resolve();
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

try {
  const lease = await acquireMetadataOwnership(home, {
    beforeRecoverStaleLockDirectory: async () => {
      console.log("observed");
      await waitFor("recover");
    },
    beforeRemoveStaleLockDirectory: async () => {
      console.log("ready");
      await waitFor("remove");
    },
  });
  console.log("acquired");
  await waitFor("release");
  await lease.release();
  console.log("released");
  process.exit(0);
} catch (error) {
  if (error && error.code === "PI_DECK_METADATA_OWNED") {
    console.log("owned");
    process.exit(0);
  } else {
    throw error;
  }
}
`;

const childRecoveryOwnerScript = String.raw`
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const [home] = process.argv.slice(1);
  const canonicalHome = await fs.realpath(home);
  const legacyDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner.recovery");
  const recoveryDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner.recovery-v2");
  const token = "live-recovery-" + process.pid;
  await fs.symlink(
    "pi-deck-metadata-recovery-v2:" + JSON.stringify({
      version: 2,
      canonicalHome,
      token: "live-recovery-fence",
    }),
    legacyDirectory,
  );
  await fs.mkdir(recoveryDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(recoveryDirectory, token + ".json"), JSON.stringify({
    version: 1,
    token,
    pid: process.pid,
    hostname: os.hostname(),
    startedAtMs: Date.now(),
    canonicalHome,
  }) + "\n");
  console.log("ready");
  process.stdin.resume();
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;

async function temporaryHome(): Promise<{ root: string; home: string }> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-metadata-owner-"),
  );
  return { root, home: path.join(root, "home") };
}

async function seedStaleOwner(home: string): Promise<{
  canonicalHome: string;
  lockDirectory: string;
  ownerFile: string;
}> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(home);
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  const ownerFile = path.join(lockDirectory, "owner.json");
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(
    ownerFile,
    `${JSON.stringify({
      version: 1,
      token: "stale-owner",
      pid: 99_999_999,
      hostname: os.hostname(),
      startedAtMs: Date.now() - 60_000,
      canonicalHome,
    })}\n`,
  );
  return { canonicalHome, lockDirectory, ownerFile };
}

function spawnReadyChild(
  script: string,
  args: string[],
  readySignal = "ready",
): { child: ChildProcessWithoutNullStreams; ready: Promise<void> } {
  const child = spawn(process.execPath, ["-e", script, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let settled = false;
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out waiting for child owner. stderr: ${stderr}`));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || !chunk.includes(readySignal)) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Child owner exited before acquiring lock (${code ?? signal}). stderr: ${stderr}`,
        ),
      );
    });
  });
  return { child, ready };
}

function spawnProtocolOwner(
  home: string,
  mode: "hold" | "exit",
): { child: ChildProcessWithoutNullStreams; ready: Promise<void> } {
  return spawnReadyChild(childOwnerScript, [home, mode]);
}

interface ControlledChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: () => string;
  readonly errors: () => string;
}

function spawnControlledChild(
  command: string,
  args: string[],
): ControlledChild {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  return { child, output: () => output, errors: () => errors };
}

async function waitForChildOutput(
  controlled: ControlledChild,
  expected: string,
): Promise<void> {
  if (controlled.output().includes(expected)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for child output ${expected}. stdout: ${controlled.output()}. stderr: ${controlled.errors()}`,
        ),
      );
    }, 5_000);
    const onOutput = () => {
      if (!controlled.output().includes(expected)) return;
      cleanup();
      resolve();
    };
    const onExit = () => {
      if (controlled.output().includes(expected)) {
        cleanup();
        resolve();
        return;
      }
      cleanup();
      reject(
        new Error(
          `Child exited before output ${expected}. stdout: ${controlled.output()}. stderr: ${controlled.errors()}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      controlled.child.stdout.off("data", onOutput);
      controlled.child.off("exit", onExit);
    };
    controlled.child.stdout.on("data", onOutput);
    controlled.child.once("exit", onExit);
  });
}

async function createV2RecoveryAttemptRunner(root: string): Promise<string> {
  const runner = path.join(root, "v2-recovery-attempt.mjs");
  await fs.writeFile(runner, v2RecoveryAttemptScript, { mode: 0o600 });
  return runner;
}

function spawnV2RecoveryAttempt(runner: string, home: string): ControlledChild {
  return spawnControlledChild(process.execPath, [
    "--experimental-strip-types",
    runner,
    pathToFileURL(path.resolve("src/main/metadataOwnership.ts")).href,
    home,
  ]);
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) return;
  await once(child, "exit");
}

async function stopChildOwner(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) return;
  child.stdin.write("release\n");
  await waitForChildExit(child);
}

test("metadata ownership rejects a live owner through canonical path aliases", async () => {
  const { root, home } = await temporaryHome();
  const alias = path.join(root, "home-alias");
  await fs.mkdir(home, { recursive: true });
  await fs.symlink(home, alias, "dir");
  const { child, ready } = spawnProtocolOwner(alias, "hold");

  try {
    await ready;
    await assert.rejects(
      () => acquireMetadataOwnership(home),
      (error: unknown) =>
        error instanceof MetadataOwnershipError &&
        error.owner?.pid === child.pid &&
        /already owned/.test(error.message),
    );
  } finally {
    await stopChildOwner(child).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("metadata ownership recovers a lock left by a stopped owner process", async () => {
  const { root, home } = await temporaryHome();
  const { child, ready } = spawnProtocolOwner(home, "exit");

  try {
    await ready;
    await waitForChildExit(child);
    const lease = await acquireMetadataOwnership(home);
    try {
      assert.equal(lease.canonicalHome, await fs.realpath(home));
    } finally {
      await lease.release();
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("metadata ownership leaves an ambiguous legacy recovery sentinel for deliberate operator recovery", async () => {
  const { root, home } = await temporaryHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(home);
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  const legacyRecoveryDirectory = path.join(
    canonicalHome,
    ".pi-deck-metadata-owner.recovery",
  );
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(
    path.join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      version: 1,
      token: "stale-owner",
      pid: process.pid + 1,
      hostname: os.hostname(),
      startedAtMs: Date.now() - 60_000,
      canonicalHome,
    })}\n`,
  );
  // This ownerless directory could instead belong to a paused pre-upgrade
  // recoverer, so it cannot safely be treated as abandoned.
  await fs.mkdir(legacyRecoveryDirectory, { mode: 0o700 });

  try {
    await assert.rejects(
      () => acquireMetadataOwnership(home, { pidIsRunning: () => false }),
      (error: unknown) =>
        error instanceof MetadataOwnershipError &&
        /legacy recovery sentinel/.test(error.message),
    );
    assert.ok((await fs.lstat(legacyRecoveryDirectory)).isDirectory());
    assert.equal(
      JSON.parse(
        await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8"),
      ).token,
      "stale-owner",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("metadata ownership recovers after interruption immediately after atomic v2 fence publication", async () => {
  const { root, home } = await temporaryHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(home);
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  const legacyRecoveryDirectory = path.join(
    canonicalHome,
    legacyRecoveryDirectoryName,
  );
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(
    path.join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      version: 1,
      token: "stale-owner",
      pid: process.pid + 1,
      hostname: os.hostname(),
      startedAtMs: Date.now() - 60_000,
      canonicalHome,
    })}\n`,
  );

  try {
    await assert.rejects(
      () =>
        acquireMetadataOwnership(home, {
          pidIsRunning: () => false,
          afterAcquireRecoveryFence: () => {
            throw new Error("interrupted after fence publication");
          },
        }),
      /interrupted after fence publication/,
    );
    assert.ok((await fs.lstat(legacyRecoveryDirectory)).isSymbolicLink());

    const lease = await acquireMetadataOwnership(home, {
      pidIsRunning: () => false,
    });
    await lease.release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("metadata ownership recovers past an abandoned versioned recovery record", async () => {
  const { root, home } = await temporaryHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(home);
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  const recoveryDirectory = path.join(
    canonicalHome,
    ".pi-deck-metadata-owner.recovery-v2",
  );
  const staleRecoveryRecord = path.join(recoveryDirectory, "abandoned.json");
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(
    path.join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      version: 1,
      token: "stale-owner",
      pid: process.pid + 1,
      hostname: os.hostname(),
      startedAtMs: Date.now() - 60_000,
      canonicalHome,
    })}\n`,
  );
  await fs.mkdir(recoveryDirectory, { mode: 0o700 });
  await fs.writeFile(
    staleRecoveryRecord,
    `${JSON.stringify({
      version: 1,
      token: "abandoned-recovery",
      pid: process.pid + 1,
      hostname: os.hostname(),
      startedAtMs: Date.now() - 60_000,
      canonicalHome,
    })}\n`,
  );

  try {
    const lease = await acquireMetadataOwnership(home, {
      pidIsRunning: () => false,
    });
    try {
      assert.equal(
        JSON.parse(await fs.readFile(staleRecoveryRecord, "utf8")).token,
        "abandoned-recovery",
      );
    } finally {
      await lease.release();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("metadata ownership does not displace a live recovery owner while stale records remain", async () => {
  const { root, home } = await temporaryHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(home);
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  const ownerFile = path.join(lockDirectory, "owner.json");
  const recoveryDirectory = path.join(
    canonicalHome,
    ".pi-deck-metadata-owner.recovery-v2",
  );
  const recoveryFile = path.join(recoveryDirectory, "live-recovery-owner.json");
  const staleRecoveryFile = path.join(recoveryDirectory, "abandoned.json");
  const recoveryOwner = {
    version: 1 as const,
    token: "live-recovery-owner",
    pid: process.pid,
    hostname: os.hostname(),
    startedAtMs: Date.now(),
    canonicalHome,
  };
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(
    ownerFile,
    `${JSON.stringify({
      ...recoveryOwner,
      token: "stale-owner",
      pid: process.pid + 1,
    })}\n`,
  );
  await fs.mkdir(recoveryDirectory, { mode: 0o700 });
  await fs.writeFile(
    staleRecoveryFile,
    `${JSON.stringify({
      ...recoveryOwner,
      token: "abandoned-recovery",
      pid: process.pid + 1,
    })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(recoveryFile, `${JSON.stringify(recoveryOwner)}\n`, {
    mode: 0o600,
  });

  try {
    await assert.rejects(
      () =>
        acquireMetadataOwnership(home, {
          pidIsRunning: (pid) => pid === process.pid,
        }),
      (error: unknown) =>
        error instanceof MetadataOwnershipError &&
        error.owner?.token === recoveryOwner.token,
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(recoveryFile, "utf8")),
      recoveryOwner,
    );
    assert.equal(
      JSON.parse(await fs.readFile(staleRecoveryFile, "utf8")).token,
      "abandoned-recovery",
    );
    assert.equal(
      JSON.parse(await fs.readFile(ownerFile, "utf8")).token,
      "stale-owner",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("metadata ownership fences a delayed legacy recoverer before removing a stale lock", async () => {
  const { root, home } = await temporaryHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(home);
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  const ownerFile = path.join(lockDirectory, "owner.json");
  let oldRecoverer: ChildProcessWithoutNullStreams | undefined;
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(
    ownerFile,
    `${JSON.stringify({
      version: 1,
      token: "stale-owner",
      pid: process.pid + 1,
      hostname: os.hostname(),
      startedAtMs: Date.now() - 60_000,
      canonicalHome,
    })}\n`,
  );

  try {
    const lease = await acquireMetadataOwnership(home, {
      pidIsRunning: () => false,
      beforeRemoveStaleLockDirectory: async () => {
        const attempt = spawnReadyChild(
          oldRecoveryAttemptScript,
          [home],
          "blocked",
        );
        oldRecoverer = attempt.child;
        await attempt.ready;
        assert.equal(
          JSON.parse(await fs.readFile(ownerFile, "utf8")).token,
          "stale-owner",
        );
      },
    });
    await lease.release();
  } finally {
    if (oldRecoverer?.exitCode === null) oldRecoverer.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("metadata ownership preserves a live recovery record owned by another process", async () => {
  const { root, home } = await temporaryHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(home);
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  const recoveryDirectory = path.join(canonicalHome, recoveryDirectoryName);
  const ownerFile = path.join(lockDirectory, "owner.json");
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(
    ownerFile,
    `${JSON.stringify({
      version: 1,
      token: "stale-owner",
      pid: process.pid + 1,
      hostname: os.hostname(),
      startedAtMs: Date.now() - 60_000,
      canonicalHome,
    })}\n`,
  );
  const { child, ready } = spawnReadyChild(childRecoveryOwnerScript, [home]);

  try {
    await ready;
    const legacyFence = path.join(canonicalHome, legacyRecoveryDirectoryName);
    assert.ok((await fs.lstat(legacyFence)).isSymbolicLink());
    assert.match(
      await fs.readlink(legacyFence),
      new RegExp(`^${recoveryFencePrefix}`),
    );
    const recoveryFile = path.join(
      recoveryDirectory,
      `live-recovery-${child.pid}.json`,
    );
    await assert.rejects(
      () =>
        acquireMetadataOwnership(home, {
          pidIsRunning: (pid) => pid === child.pid,
        }),
      (error: unknown) =>
        error instanceof MetadataOwnershipError &&
        error.owner?.token === `live-recovery-${child.pid}`,
    );
    assert.equal(
      JSON.parse(await fs.readFile(recoveryFile, "utf8")).token,
      `live-recovery-${child.pid}`,
    );
    assert.equal(
      JSON.parse(await fs.readFile(ownerFile, "utf8")).token,
      "stale-owner",
    );
  } finally {
    if (child.exitCode === null) child.kill();
    await waitForChildExit(child).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("metadata ownership serializes concurrent stale lock recovery", async () => {
  const { root, home } = await temporaryHome();
  const { lockDirectory } = await seedStaleOwner(home);

  let waitingRecoveries = 0;
  let releaseRecoveries!: () => void;
  const bothObservedStaleLock = new Promise<void>((resolve) => {
    releaseRecoveries = resolve;
  });
  const beforeRecoverStaleLockDirectory = async (): Promise<void> => {
    waitingRecoveries += 1;
    if (waitingRecoveries === 2) releaseRecoveries();
    await bothObservedStaleLock;
  };

  try {
    const results = await Promise.allSettled([
      acquireMetadataOwnership(home, {
        beforeRecoverStaleLockDirectory,
        pidIsRunning: (pid) => pid === process.pid,
      }),
      acquireMetadataOwnership(home, {
        beforeRecoverStaleLockDirectory,
        pidIsRunning: (pid) => pid === process.pid,
      }),
    ]);

    const leases = results.filter((result) => result.status === "fulfilled");
    const rejections = results.filter((result) => result.status === "rejected");
    assert.equal(leases.length, 1);
    assert.equal(rejections.length, 1);
    assert.ok(rejections[0].reason instanceof MetadataOwnershipError);

    await leases[0].value.release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("separate processes allow exactly one simultaneous v2 stale-lock reclaimer", async () => {
  const { root, home } = await temporaryHome();
  const { lockDirectory, ownerFile } = await seedStaleOwner(home);
  const runner = await createV2RecoveryAttemptRunner(root);
  const first = spawnV2RecoveryAttempt(runner, home);
  const second = spawnV2RecoveryAttempt(runner, home);

  try {
    await Promise.all([
      waitForChildOutput(first, "observed"),
      waitForChildOutput(second, "observed"),
    ]);
    first.child.stdin.write("recover\n");
    second.child.stdin.write("recover\n");

    const winner = await Promise.race([
      waitForChildOutput(first, "ready").then(() => first),
      waitForChildOutput(second, "ready").then(() => second),
    ]);
    const blocked = winner === first ? second : first;
    await waitForChildOutput(blocked, "owned");
    assert.equal(
      JSON.parse(await fs.readFile(ownerFile, "utf8")).token,
      "stale-owner",
    );

    winner.child.stdin.write("remove\n");
    await waitForChildOutput(winner, "acquired");
    winner.child.stdin.write("release\n");
    await waitForChildExit(winner.child);
    await waitForChildExit(blocked.child);
    await assert.rejects(() => fs.lstat(lockDirectory), { code: "ENOENT" });
  } finally {
    if (first.child.exitCode === null) first.child.kill();
    if (second.child.exitCode === null) second.child.kill();
    await Promise.all([
      waitForChildExit(first.child).catch(() => undefined),
      waitForChildExit(second.child).catch(() => undefined),
    ]);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a delayed v2 reclaimer preserves and blocks on another process's live recovery record", async () => {
  const { root, home } = await temporaryHome();
  const { lockDirectory, ownerFile } = await seedStaleOwner(home);
  const runner = await createV2RecoveryAttemptRunner(root);
  const liveRecoverer = spawnV2RecoveryAttempt(runner, home);
  let delayedRecoverer: ControlledChild | undefined;

  try {
    await waitForChildOutput(liveRecoverer, "observed");
    liveRecoverer.child.stdin.write("recover\n");
    await waitForChildOutput(liveRecoverer, "ready");

    delayedRecoverer = spawnV2RecoveryAttempt(runner, home);
    await waitForChildOutput(delayedRecoverer, "observed");
    delayedRecoverer.child.stdin.write("recover\n");
    await waitForChildOutput(delayedRecoverer, "owned");
    assert.equal(
      JSON.parse(await fs.readFile(ownerFile, "utf8")).token,
      "stale-owner",
    );
    const recoveryRecords = (
      await fs.readdir(path.join(home, recoveryDirectoryName))
    ).filter((entry) => entry.endsWith(".json"));
    assert.equal(recoveryRecords.length, 1);

    liveRecoverer.child.stdin.write("remove\n");
    await waitForChildOutput(liveRecoverer, "acquired");
    liveRecoverer.child.stdin.write("release\n");
    await waitForChildExit(liveRecoverer.child);
    await waitForChildExit(delayedRecoverer.child);
    await assert.rejects(() => fs.lstat(lockDirectory), { code: "ENOENT" });
  } finally {
    if (liveRecoverer.child.exitCode === null) liveRecoverer.child.kill();
    if (delayedRecoverer?.child.exitCode === null)
      delayedRecoverer.child.kill();
    await Promise.all([
      waitForChildExit(liveRecoverer.child).catch(() => undefined),
      delayedRecoverer === undefined
        ? Promise.resolve()
        : waitForChildExit(delayedRecoverer.child).catch(() => undefined),
    ]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
