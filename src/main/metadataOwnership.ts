import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ownerDirectoryName = ".pi-deck-metadata-owner";
const legacyRecoveryDirectoryName = `${ownerDirectoryName}.recovery`;
const recoveryFencePrefix = "pi-deck-metadata-recovery-v2:";
const recoveryDirectoryName = `${ownerDirectoryName}.recovery-v2`;
const ownerFileName = "owner.json";
const ownerRecordVersion = 1;
const defaultIncompleteOwnerTimeoutMs = 30_000;
const recoveryQueues = new Map<string, Promise<void>>();

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
  readonly afterAcquireRecoveryFence?: () => void | Promise<void>;
  readonly beforeRemoveStaleLockDirectory?: () => void | Promise<void>;
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

  constructor(
    canonicalHome: string,
    owner?: MetadataOwnerRecord,
    guidance = "Quit the existing Pi Deck instance or launch with an isolated PI_DECK_HOME before continuing.",
  ) {
    const ownerDescription = owner
      ? `PID ${owner.pid} on ${owner.hostname}`
      : "another process";
    super(
      `Pi Deck metadata at ${canonicalHome} is already owned by ${ownerDescription}. ` +
        guidance,
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
  const legacyRecoveryDirectory = path.join(
    canonicalHome,
    legacyRecoveryDirectoryName,
  );
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
      await serializeRecovery(recoveryDirectory, () =>
        recoverStaleLockDirectory({
          canonicalHome,
          lockDirectory,
          legacyRecoveryDirectory,
          recoveryDirectory,
          ownerFile,
          now,
          pidIsRunning,
          incompleteOwnerTimeoutMs,
          afterAcquireRecoveryFence: options.afterAcquireRecoveryFence,
          beforeRemoveStaleLockDirectory:
            options.beforeRemoveStaleLockDirectory,
        }),
      );
    }
  }
}

async function serializeRecovery<T>(
  recoveryDirectory: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = recoveryQueues.get(recoveryDirectory) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  recoveryQueues.set(recoveryDirectory, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (recoveryQueues.get(recoveryDirectory) === tail) {
      recoveryQueues.delete(recoveryDirectory);
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
  readonly legacyRecoveryDirectory: string;
  readonly recoveryDirectory: string;
  readonly ownerFile: string;
  readonly now: () => number;
  readonly pidIsRunning: (pid: number, hostname: string) => boolean;
  readonly incompleteOwnerTimeoutMs: number;
  readonly afterAcquireRecoveryFence: (() => void | Promise<void>) | undefined;
  readonly beforeRemoveStaleLockDirectory:
    | (() => void | Promise<void>)
    | undefined;
}

async function recoverStaleLockDirectory({
  canonicalHome,
  lockDirectory,
  legacyRecoveryDirectory,
  recoveryDirectory,
  ownerFile,
  now,
  pidIsRunning,
  incompleteOwnerTimeoutMs,
  afterAcquireRecoveryFence,
  beforeRemoveStaleLockDirectory,
}: RecoverStaleLockOptions): Promise<void> {
  await acquireLegacyRecoveryFence(canonicalHome, legacyRecoveryDirectory);
  await afterAcquireRecoveryFence?.();
  const recoveryOwner: MetadataOwnerRecord = {
    version: ownerRecordVersion,
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    startedAtMs: now(),
    canonicalHome,
  };
  const recoveryRecord = await acquireRecoveryOwnership({
    canonicalHome,
    recoveryDirectory,
    recoveryOwner,
    pidIsRunning,
  });

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
    await beforeRemoveStaleLockDirectory?.();
    await fs.rm(lockDirectory, { recursive: true, force: true });
  } finally {
    await removeOwnedRecoveryRecord(recoveryRecord, recoveryOwner.token);
  }
}

interface LegacyRecoveryProtocolMarker {
  readonly version: 2;
  readonly canonicalHome: string;
  readonly token: string;
}

async function acquireLegacyRecoveryFence(
  canonicalHome: string,
  legacyRecoveryDirectory: string,
): Promise<void> {
  // The legacy path itself is the compatibility fence: pre-upgrade recoverers
  // use mkdir and therefore block on this atomically-created symlink. Unlike
  // mkdir followed by a marker write, a crash cannot leave an unmarked v2
  // directory indistinguishable from a paused legacy recoverer.
  const marker: LegacyRecoveryProtocolMarker = {
    version: 2,
    canonicalHome,
    token: randomUUID(),
  };
  try {
    await fs.symlink(
      `${recoveryFencePrefix}${JSON.stringify(marker)}`,
      legacyRecoveryDirectory,
    );
    return;
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }

  const legacyStats = await fs.lstat(legacyRecoveryDirectory);
  if (
    legacyStats.isSymbolicLink() &&
    (await isLegacyRecoveryProtocolMarker(
      legacyRecoveryDirectory,
      canonicalHome,
    ))
  ) {
    return;
  }

  // A directory (or malformed link) at this path could belong to a paused
  // pre-upgrade recoverer. Do not remove or repurpose it based on PID, age, or
  // contents.
  throw new MetadataOwnershipError(
    canonicalHome,
    undefined,
    "A legacy recovery sentinel is present. Stop all Pi Deck writers using this metadata, " +
      "then perform deliberate operator recovery; Pi Deck will not remove this ambiguous legacy state automatically.",
  );
}

async function isLegacyRecoveryProtocolMarker(
  legacyRecoveryDirectory: string,
  canonicalHome: string,
): Promise<boolean> {
  let target: string;
  try {
    target = await fs.readlink(legacyRecoveryDirectory);
  } catch (error) {
    if (isErrorCode(error, "EINVAL") || isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  if (!target.startsWith(recoveryFencePrefix)) return false;
  try {
    const marker: unknown = JSON.parse(
      target.slice(recoveryFencePrefix.length),
    );
    return (
      typeof marker === "object" &&
      marker !== null &&
      (marker as Record<string, unknown>).version === 2 &&
      (marker as Record<string, unknown>).canonicalHome === canonicalHome &&
      typeof (marker as Record<string, unknown>).token === "string"
    );
  } catch {
    return false;
  }
}

interface AcquireRecoveryOwnershipOptions {
  readonly canonicalHome: string;
  readonly recoveryDirectory: string;
  readonly recoveryOwner: MetadataOwnerRecord;
  readonly pidIsRunning: (pid: number, hostname: string) => boolean;
}

async function acquireRecoveryOwnership({
  canonicalHome,
  recoveryDirectory,
  recoveryOwner,
  pidIsRunning,
}: AcquireRecoveryOwnershipOptions): Promise<string> {
  await fs
    .mkdir(recoveryDirectory, { recursive: true, mode: 0o700 })
    .catch((error: unknown) => {
      if (isErrorCode(error, "EEXIST")) {
        throw new MetadataOwnershipError(canonicalHome);
      }
      throw error;
    });
  const recoveryRecord = path.join(
    recoveryDirectory,
    `${recoveryOwner.token}.json`,
  );
  const temporaryRecoveryRecord = path.join(
    recoveryDirectory,
    `${recoveryOwner.token}.tmp`,
  );
  await fs.writeFile(
    temporaryRecoveryRecord,
    `${JSON.stringify(recoveryOwner, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  try {
    // A record is immutable and has a unique name. Consequently an observer of
    // a dead recoverer never needs to unlink a path that a later live recoverer
    // could publish to, and crash residue cannot permanently block recovery.
    await fs.link(temporaryRecoveryRecord, recoveryRecord);
    const entries = await fs.readdir(recoveryDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (
        entry.name === path.basename(recoveryRecord) ||
        entry.name.endsWith(".tmp")
      ) {
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new MetadataOwnershipError(canonicalHome);
      }
      const existing = await readOwnerRecord(
        path.join(recoveryDirectory, entry.name),
      );
      if (existing === undefined) {
        throw new MetadataOwnershipError(canonicalHome);
      }
      if (ownerIsRunning(existing, pidIsRunning, os.hostname())) {
        throw new MetadataOwnershipError(canonicalHome, existing);
      }
    }
    return recoveryRecord;
  } catch (error) {
    await removeOwnedRecoveryRecord(recoveryRecord, recoveryOwner.token);
    throw error;
  } finally {
    await fs
      .rm(temporaryRecoveryRecord, { force: true })
      .catch((error: unknown) => {
        if (!isErrorCode(error, "ENOENT")) throw error;
      });
  }
}

async function removeOwnedRecoveryRecord(
  recoveryRecord: string,
  token: string,
): Promise<void> {
  const existing = await readOwnerRecord(recoveryRecord).catch(() => undefined);
  if (existing?.token !== token) return;
  await fs.rm(recoveryRecord, { force: true });
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
