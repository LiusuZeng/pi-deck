import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  acquireMetadataOwnership,
  MetadataOwnershipError,
} from "./metadataOwnership.js";

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

async function temporaryHome(): Promise<{ root: string; home: string }> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-metadata-owner-"),
  );
  return { root, home: path.join(root, "home") };
}

function spawnProtocolOwner(
  home: string,
  mode: "hold" | "exit",
): { child: ChildProcessWithoutNullStreams; ready: Promise<void> } {
  const child = spawn(process.execPath, ["-e", childOwnerScript, home, mode], {
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
      if (settled || !chunk.includes("ready")) return;
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

test("metadata ownership serializes concurrent stale lock recovery", async () => {
  const { root, home } = await temporaryHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(home);
  const lockDirectory = path.join(canonicalHome, ".pi-deck-metadata-owner");
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(
    path.join(lockDirectory, "owner.json"),
    `${JSON.stringify(
      {
        version: 1,
        token: "stale-owner",
        pid: process.pid + 1,
        hostname: os.hostname(),
        startedAtMs: Date.now() - 60_000,
        canonicalHome,
      },
      null,
      2,
    )}\n`,
  );

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
