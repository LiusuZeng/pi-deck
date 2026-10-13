import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ownerDirectoryName = ".pi-deck-metadata-owner";
const recoveryDirectoryName = `${ownerDirectoryName}.recovery`;
const ownerFileName = "owner.json";
const ownerRecordVersion = 1;
const defaultIncompleteOwnerTimeoutMs = 30_000;

export interface MetadataOwnershipLease {
  readonly canonicalHome: string;
  readonly lockDirectory: string;
  release(): Promise<void>;
}

export interface MetadataOwnershipOptions {
  readonly now?: () => number;
  readonly pidIsRunning?: (pid: number, hostname: string) => boolean;
  readonly incompleteOwnerTimeoutMs?: number;
  readonly beforeRecoverStaleLockDirectory?: () => void | Promise<void>;
}

export interface MetadataOwnerRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAtMs: number;
  readonly canonicalHome: string;
}

export class MetadataOwnershipError extends Error {
  readonly code = "PI_DECK_METADATA_OWNED";
  readonly owner?: MetadataOwnerRecord;

  constructor(canonicalHome: string, owner?: MetadataOwnerRecord) {
    const ownerDescription = owner
      ? `PID ${owner.pid} on ${owner.hostname}`
      : "another process";
    super(
      `Pi Deck metadata at ${canonicalHome} is already owned by ${ownerDescription}. ` +
        "Quit the existing Pi Deck instance or launch with an isolated PI_DECK_HOME before continuing.",
    );
    this.name = "MetadataOwnershipError";
    if (owner !== undefined) {
      this.owner = owner;
    }
  }
}

export async function acquireMetadataOwnership(
  piDeckHome: string,
  options: MetadataOwnershipOptions = {},
): Promise<MetadataOwnershipLease> {
  const now = options.now ?? Date.now;
  const pidIsRunning = options.pidIsRunning ?? defaultPidIsRunning;
  const incompleteOwnerTimeoutMs =
    options.incompleteOwnerTimeoutMs ?? defaultIncompleteOwnerTimeoutMs;
  const resolvedHome = path.resolve(piDeckHome);

  await fs.mkdir(resolvedHome, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(resolvedHome);
  const lockDirectory = path.join(canonicalHome, ownerDirectoryName);
  const recoveryDirectory = path.join(canonicalHome, recoveryDirectoryName);
  const ownerFile = path.join(lockDirectory, ownerFileName);
  const token = randomUUID();
  const owner: MetadataOwnerRecord = {
    version: ownerRecordVersion,
    token,
    pid: process.pid,
    hostname: os.hostname(),
    startedAtMs: now(),
    canonicalHome,
  };

  for (;;) {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      try {
        await fs.writeFile(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await fs
          .rm(lockDirectory, { recursive: true, force: true })
          .catch(() => undefined);
        throw error;
      }
      return {
        canonicalHome,
        lockDirectory,
        release: () =>
          removeOwnedLockDirectory(lockDirectory, ownerFile, token),
      };
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }

      const existing = await readOwnerRecord(ownerFile);
      if (
        existing !== undefined &&
        ownerIsRunning(existing, pidIsRunning, os.hostname())
      ) {
        throw new MetadataOwnershipError(canonicalHome, existing);
      }
      if (existing === undefined) {
        const lockIsRecoverable = await isIncompleteOwnerRecoverable(
          lockDirectory,
          now(),
          incompleteOwnerTimeoutMs,
        ).catch((error: unknown) => {
          if (isErrorCode(error, "ENOENT")) return undefined;
          throw error;
        });
        if (lockIsRecoverable === undefined) continue;
        if (!lockIsRecoverable) {
          throw new MetadataOwnershipError(canonicalHome);
        }
      }
      await options.beforeRecoverStaleLockDirectory?.();
      await recoverStaleLockDirectory({
        canonicalHome,
        lockDirectory,
        recoveryDirectory,
        ownerFile,
        now,
        pidIsRunning,
        incompleteOwnerTimeoutMs,
      });
    }
  }
}

function ownerIsRunning(
  owner: MetadataOwnerRecord,
  pidIsRunning: (pid: number, hostname: string) => boolean,
  currentHostname: string,
): boolean {
  if (owner.hostname !== currentHostname) {
    // A shared metadata directory on another host cannot be safely stolen; treat
    // it as owned until a user removes or moves the lock explicitly.
    return true;
  }
  return pidIsRunning(owner.pid, owner.hostname);
}

function defaultPidIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ESRCH")) return false;
    if (isErrorCode(error, "EPERM")) return true;
    return true;
  }
}

async function readOwnerRecord(
  ownerFile: string,
): Promise<MetadataOwnerRecord | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(ownerFile, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isOwnerRecord(parsed)) return undefined;
  return parsed;
}

function isOwnerRecord(value: unknown): value is MetadataOwnerRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === ownerRecordVersion &&
    typeof candidate.token === "string" &&
    Number.isInteger(candidate.pid) &&
    typeof candidate.hostname === "string" &&
    Number.isFinite(candidate.startedAtMs) &&
    typeof candidate.canonicalHome === "string"
  );
}

async function isIncompleteOwnerRecoverable(
  lockDirectory: string,
  nowMs: number,
  incompleteOwnerTimeoutMs: number,
): Promise<boolean> {
  const stats = await fs.lstat(lockDirectory);
  if (!stats.isDirectory()) return false;
  return nowMs - stats.mtimeMs >= incompleteOwnerTimeoutMs;
}

interface RecoverStaleLockOptions {
  readonly canonicalHome: string;
  readonly lockDirectory: string;
  readonly recoveryDirectory: string;
  readonly ownerFile: string;
  readonly now: () => number;
  readonly pidIsRunning: (pid: number, hostname: string) => boolean;
  readonly incompleteOwnerTimeoutMs: number;
}

async function recoverStaleLockDirectory({
  canonicalHome,
  lockDirectory,
  recoveryDirectory,
  ownerFile,
  now,
  pidIsRunning,
  incompleteOwnerTimeoutMs,
}: RecoverStaleLockOptions): Promise<void> {
  let ownsRecovery = false;
  try {
    await fs.mkdir(recoveryDirectory, { mode: 0o700 });
    ownsRecovery = true;
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      throw new MetadataOwnershipError(canonicalHome);
    }
    throw error;
  }

  try {
    const existing = await readOwnerRecord(ownerFile);
    if (existing !== undefined) {
      if (ownerIsRunning(existing, pidIsRunning, os.hostname())) {
        throw new MetadataOwnershipError(canonicalHome, existing);
      }
    } else {
      const lockIsRecoverable = await isIncompleteOwnerRecoverable(
        lockDirectory,
        now(),
        incompleteOwnerTimeoutMs,
      ).catch((error: unknown) => {
        if (isErrorCode(error, "ENOENT")) return false;
        throw error;
      });
      if (!lockIsRecoverable) {
        if (await pathExists(lockDirectory)) {
          throw new MetadataOwnershipError(canonicalHome);
        }
        return;
      }
    }

    const stats = await fs.lstat(lockDirectory).catch((error: unknown) => {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (stats === undefined) return;
    if (!stats.isDirectory()) {
      throw new MetadataOwnershipError(canonicalHome);
    }
    await fs.rm(lockDirectory, { recursive: true, force: true });
  } finally {
    if (ownsRecovery) {
      await fs.rmdir(recoveryDirectory).catch((error: unknown) => {
        if (!isErrorCode(error, "ENOENT")) throw error;
      });
    }
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function removeOwnedLockDirectory(
  lockDirectory: string,
  ownerFile: string,
  token: string,
): Promise<void> {
  const existing = await readOwnerRecord(ownerFile).catch(() => undefined);
  if (existing?.token !== token) return;
  await fs.rm(ownerFile, { force: true });
  await fs.rmdir(lockDirectory).catch((error: unknown) => {
    if (!isErrorCode(error, "ENOENT")) throw error;
  });
}

function isErrorCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
