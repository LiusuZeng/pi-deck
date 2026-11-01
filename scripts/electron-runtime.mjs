import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export const piDeckApplicationName = "Pi Deck";
export const piDeckBundleName = `${piDeckApplicationName}.app`;
export const piDeckBundleIdentifier = "com.pi-deck.desktop";

const require = createRequire(import.meta.url);
const runtimeIdentitySchemaVersion = 2;
const runtimeCacheDirectoryEnvVar = "PI_DECK_ELECTRON_RUNTIME_CACHE_DIR";

export function resolveInstalledElectronExecutable() {
  return require("electron");
}

export function findMacOSAppBundle(executablePath) {
  let current = path.resolve(executablePath);
  while (true) {
    const parent = path.dirname(current);
    if (current.endsWith(".app")) {
      return current;
    }
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(
    `Could not locate a macOS .app bundle for Electron executable: ${executablePath}`,
  );
}

export function resolvePiDeckElectronRuntimeCacheRoot({
  env = process.env,
  homedir = os.homedir,
} = {}) {
  const explicitCacheRoot = env[runtimeCacheDirectoryEnvVar]?.trim();
  if (explicitCacheRoot) {
    return path.resolve(explicitCacheRoot);
  }
  return path.join(
    homedir(),
    "Library",
    "Caches",
    "Pi Deck",
    "electron-runtime",
  );
}

function sourceRuntimeCacheKey(sourceBundle, executableRelativePath) {
  return createHash("sha256")
    .update(path.resolve(sourceBundle))
    .update("\0")
    .update(executableRelativePath)
    .digest("hex")
    .slice(0, 16);
}

function runtimeIdentityMarkerPath(runtimeDirectory) {
  return path.join(runtimeDirectory, ".pi-deck-electron-runtime.json");
}

function cachePreparationError(cacheRoot, runtimeDirectory, error) {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return new Error(
    `Unable to prepare the Pi Deck Electron runtime in cache directory ${runtimeDirectory}${detail}. Ensure ${cacheRoot} is writable or set ${runtimeCacheDirectoryEnvVar} to a writable directory.`,
    { cause: error },
  );
}

const runtimePreparationTurns = new Map();

function waitForRuntimePreparationLock() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

async function readRuntimePreparationLockOwner(lockPath) {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      typeof owner.token !== "string" ||
      typeof owner.hostname !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    ) {
      return undefined;
    }
    return owner;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function reclaimAbandonedRuntimePreparationLock(lockPath) {
  const abandonedLockPath = `${lockPath}.abandoned-${randomUUID()}`;
  try {
    await rename(lockPath, abandonedLockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await rm(abandonedLockPath, { recursive: true, force: true });
}

async function releaseRuntimePreparationLock(lockPath, token) {
  const owner = await readRuntimePreparationLockOwner(lockPath);
  if (owner?.token === token) {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireRuntimePreparationLock(
  lockPath,
  {
    beforePublish = async () => undefined,
    onWait = async () => undefined,
  } = {},
) {
  const owner = {
    hostname: os.hostname(),
    pid: process.pid,
    token: randomUUID(),
  };
  const candidatePath = `${lockPath}.candidate-${owner.token}`;
  let candidatePublicationAttempted = false;

  await writeFile(candidatePath, `${JSON.stringify(owner)}\n`, { flag: "wx" });
  try {
    while (true) {
      try {
        // link() publishes a fully written, owner-identified lock in one
        // filesystem operation. mkdir() followed by owner metadata creation
        // leaves a window where another process can mistake a new lock for an
        // abandoned one and prepare concurrently.
        if (!candidatePublicationAttempted) {
          candidatePublicationAttempted = true;
          await beforePublish();
        }
        await link(candidatePath, lockPath);
        return async () => releaseRuntimePreparationLock(lockPath, owner.token);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }

      const existingOwner = await readRuntimePreparationLockOwner(lockPath);
      if (
        existingOwner?.hostname === owner.hostname &&
        processIsRunning(existingOwner.pid)
      ) {
        await onWait();
        await waitForRuntimePreparationLock();
      } else if (!existingOwner || existingOwner.hostname === owner.hostname) {
        // A published lock always has complete owner metadata. Therefore an
        // invalid lock, or one whose local owner PID is gone, cannot be
        // actively publishing and can be atomically retired by one waiter.
        await reclaimAbandonedRuntimePreparationLock(lockPath);
      } else {
        await onWait();
        await waitForRuntimePreparationLock();
      }
    }
  } finally {
    await rm(candidatePath, { force: true });
  }
}

async function withRuntimePreparationLock(lockPath, prepare, lockOptions) {
  const previousTurn = runtimePreparationTurns.get(lockPath);
  let finishTurn;
  const turn = new Promise((resolve) => {
    finishTurn = resolve;
  });
  runtimePreparationTurns.set(lockPath, turn);

  if (previousTurn) {
    await previousTurn;
  }

  let releaseLock;
  try {
    releaseLock = await acquireRuntimePreparationLock(lockPath, lockOptions);
    return await prepare();
  } finally {
    try {
      await releaseLock?.();
    } finally {
      finishTurn();
      if (runtimePreparationTurns.get(lockPath) === turn) {
        runtimePreparationTurns.delete(lockPath);
      }
    }
  }
}

async function publishPreparedRuntime({
  brandedBundle,
  markerPath,
  stagedBundle,
  stagedMarkerPath,
}) {
  const previousBundle = `${brandedBundle}.previous-${randomUUID()}`;
  const previousMarkerPath = `${markerPath}.previous-${randomUUID()}`;
  let movedPreviousBundle = false;
  let movedPreviousMarker = false;
  let publishedBundle = false;
  let publishedMarker = false;

  async function restorePreviousRuntime() {
    if (publishedBundle) {
      await rm(brandedBundle, { recursive: true, force: true });
    }
    if (publishedMarker) {
      await rm(markerPath, { force: true });
    }
    if (movedPreviousBundle) {
      await rename(previousBundle, brandedBundle);
    }
    if (movedPreviousMarker) {
      await rename(previousMarkerPath, markerPath);
    }
  }

  try {
    try {
      await rename(brandedBundle, previousBundle);
      movedPreviousBundle = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    try {
      await rename(markerPath, previousMarkerPath);
      movedPreviousMarker = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await rename(stagedBundle, brandedBundle);
    publishedBundle = true;
    await rename(stagedMarkerPath, markerPath);
    publishedMarker = true;
  } catch (error) {
    await restorePreviousRuntime().catch(() => undefined);
    throw error;
  }

  return {
    async discardPreviousRuntime() {
      await rm(previousBundle, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await rm(previousMarkerPath, { force: true }).catch(() => undefined);
    },
    restorePreviousRuntime,
  };
}

async function assertRuntimeDirectoryWritable(runtimeDirectory) {
  let probePath;
  try {
    probePath = await mkdtemp(
      path.join(runtimeDirectory, ".pi-deck-write-probe-"),
    );
  } finally {
    if (probePath) {
      await rm(probePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

async function runCommand(command, args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawn(command, args, {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited via signal ${signal}`));
      } else if (code !== 0) {
        reject(
          new Error(
            `${command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function replacePlistString(plistPath, key, value) {
  await runCommand("/usr/bin/plutil", [
    "-replace",
    key,
    "-string",
    value,
    plistPath,
  ]);
}

export async function readMacOSPlistString(plistPath, key) {
  return runCommand(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", plistPath],
    { captureStdout: true },
  );
}

function helperBundleIdentity(entryName) {
  const baseName = entryName.replace(/\.app$/, "");
  const displayName = baseName.replace(/^Electron/, piDeckApplicationName);
  const suffix = baseName
    .replace(/^Electron\s+Helper/, "")
    .replace(/[^A-Za-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "")
    .toLowerCase();
  return {
    displayName,
    identifier: `${piDeckBundleIdentifier}.helper${suffix ? `.${suffix}` : ""}`,
  };
}

async function patchPlistIdentity(plistPath, displayName, identifier) {
  await replacePlistString(plistPath, "CFBundleDisplayName", displayName);
  await replacePlistString(plistPath, "CFBundleName", displayName);
  await replacePlistString(plistPath, "CFBundleIdentifier", identifier);
}

/**
 * Electron's macOS distribution guidance requires the outer app and helper
 * bundle identity fields to be renamed for OS-visible rebranding. The copied
 * runtime remains source-run only; no packaging framework is introduced.
 */
export async function patchMacOSBundleIdentity(
  bundlePath,
  { patchPlist = patchPlistIdentity, listFrameworks = readdir } = {},
) {
  await patchPlist(
    path.join(bundlePath, "Contents", "Info.plist"),
    piDeckApplicationName,
    piDeckBundleIdentifier,
  );

  const frameworksPath = path.join(bundlePath, "Contents", "Frameworks");
  let entries = [];
  try {
    entries = await listFrameworks(frameworksPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
      continue;
    }
    const identity = helperBundleIdentity(entry.name);
    await patchPlist(
      path.join(frameworksPath, entry.name, "Contents", "Info.plist"),
      identity.displayName,
      identity.identifier,
    );
  }
}

async function preparedRuntimeLooksCurrent(
  sourceExecutable,
  brandedExecutable,
  markerPath,
  { sourceBundle, executableRelativePath },
) {
  try {
    const [sourceStats, brandedStats, markerText] = await Promise.all([
      stat(sourceExecutable),
      stat(brandedExecutable),
      readFile(markerPath, "utf8"),
    ]);
    await access(brandedExecutable, fsConstants.X_OK);
    const marker = JSON.parse(markerText);
    return (
      sourceStats.isFile() &&
      brandedStats.isFile() &&
      sourceStats.size === brandedStats.size &&
      marker.schemaVersion === runtimeIdentitySchemaVersion &&
      marker.applicationName === piDeckApplicationName &&
      marker.bundleIdentifier === piDeckBundleIdentifier &&
      marker.sourceBundle === path.resolve(sourceBundle) &&
      marker.executableRelativePath === executableRelativePath &&
      marker.sourceSize === sourceStats.size &&
      marker.sourceMtimeMs === sourceStats.mtimeMs
    );
  } catch {
    return false;
  }
}

async function runCloneCopy(sourceBundle, destinationBundle) {
  await runCommand("/bin/cp", ["-R", "-c", sourceBundle, destinationBundle]);
}

export async function cloneElectronBundle(sourceBundle, destinationBundle) {
  const temporaryBundle = `${destinationBundle}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporaryBundle, { recursive: true, force: true });
  try {
    try {
      await runCloneCopy(sourceBundle, temporaryBundle);
    } catch {
      await rm(temporaryBundle, { recursive: true, force: true });
      await cp(sourceBundle, temporaryBundle, {
        recursive: true,
        preserveTimestamps: true,
      });
    }
    await rm(destinationBundle, { recursive: true, force: true });
    await rename(temporaryBundle, destinationBundle);
  } catch (error) {
    await rm(temporaryBundle, { recursive: true, force: true });
    throw error;
  }
}

/**
 * `app.setName()` only changes Electron's internal application name. macOS
 * takes the Dock/application identity from the running .app bundle, so normal
 * source-run launches use a cached Pi Deck.app clone with Pi Deck plist
 * metadata, avoiding writes to the installed Electron directory. APFS clone-copy
 * keeps the first preparation cheap and the marker makes later launches
 * constant-time until the installed Electron runtime changes.
 */
export async function preparePiDeckElectronExecutable({
  platform = process.platform,
  electronExecutable = resolveInstalledElectronExecutable(),
  copyBundle = cloneElectronBundle,
  patchBundleIdentity = patchMacOSBundleIdentity,
  runtimeCacheRoot = resolvePiDeckElectronRuntimeCacheRoot(),
  beforeRuntimePreparationLockPublish,
  onRuntimePreparationLockWait,
  afterRuntimePublication = async () => undefined,
} = {}) {
  if (platform !== "darwin") {
    return electronExecutable;
  }

  const sourceBundle = findMacOSAppBundle(electronExecutable);
  const executableRelativePath = path.relative(
    sourceBundle,
    electronExecutable,
  );
  if (
    executableRelativePath.length === 0 ||
    executableRelativePath.startsWith("..") ||
    path.isAbsolute(executableRelativePath)
  ) {
    throw new Error(
      `Electron executable is not contained by its app bundle: ${electronExecutable}`,
    );
  }

  const cacheRoot = path.resolve(runtimeCacheRoot);
  const runtimeDirectory = path.join(
    cacheRoot,
    `source-${sourceRuntimeCacheKey(sourceBundle, executableRelativePath)}`,
  );
  const brandedBundle = path.join(runtimeDirectory, piDeckBundleName);
  const brandedExecutable = path.join(brandedBundle, executableRelativePath);
  const markerPath = runtimeIdentityMarkerPath(runtimeDirectory);

  if (
    await preparedRuntimeLooksCurrent(
      electronExecutable,
      brandedExecutable,
      markerPath,
      { sourceBundle, executableRelativePath },
    )
  ) {
    return brandedExecutable;
  }

  try {
    await mkdir(runtimeDirectory, { recursive: true });
  } catch (error) {
    throw cachePreparationError(cacheRoot, runtimeDirectory, error);
  }

  try {
    await assertRuntimeDirectoryWritable(runtimeDirectory);
  } catch (error) {
    throw cachePreparationError(cacheRoot, runtimeDirectory, error);
  }

  const lockPath = path.join(runtimeDirectory, ".pi-deck-preparation-lock");
  return withRuntimePreparationLock(
    lockPath,
    async () => {
      if (
        await preparedRuntimeLooksCurrent(
          electronExecutable,
          brandedExecutable,
          markerPath,
          { sourceBundle, executableRelativePath },
        )
      ) {
        return brandedExecutable;
      }

      try {
        await assertRuntimeDirectoryWritable(runtimeDirectory);
      } catch (error) {
        throw cachePreparationError(cacheRoot, runtimeDirectory, error);
      }

      let attemptDirectory;
      try {
        attemptDirectory = await mkdtemp(
          path.join(runtimeDirectory, ".pi-deck-attempt-"),
        );
      } catch (error) {
        throw cachePreparationError(cacheRoot, runtimeDirectory, error);
      }
      const stagedBundle = path.join(attemptDirectory, piDeckBundleName);
      const stagedMarkerPath = path.join(
        attemptDirectory,
        ".pi-deck-electron-runtime.json",
      );

      try {
        await copyBundle(sourceBundle, stagedBundle);
        await patchBundleIdentity(stagedBundle);

        const sourceStats = await stat(electronExecutable);
        try {
          await writeFile(
            stagedMarkerPath,
            `${JSON.stringify(
              {
                schemaVersion: runtimeIdentitySchemaVersion,
                applicationName: piDeckApplicationName,
                bundleIdentifier: piDeckBundleIdentifier,
                sourceBundle: path.resolve(sourceBundle),
                executableRelativePath,
                sourceSize: sourceStats.size,
                sourceMtimeMs: sourceStats.mtimeMs,
              },
              null,
              2,
            )}\n`,
          );
          const publication = await publishPreparedRuntime({
            brandedBundle,
            markerPath,
            stagedBundle,
            stagedMarkerPath,
          });
          try {
            await afterRuntimePublication();
            if (
              !(await preparedRuntimeLooksCurrent(
                electronExecutable,
                brandedExecutable,
                markerPath,
                { sourceBundle, executableRelativePath },
              ))
            ) {
              throw new Error(
                `Pi Deck Electron runtime was prepared but its executable is missing or stale: ${brandedExecutable}`,
              );
            }
            await publication.discardPreviousRuntime();
          } catch (error) {
            await publication.restorePreviousRuntime().catch(() => undefined);
            throw error;
          }
        } catch (error) {
          throw cachePreparationError(cacheRoot, runtimeDirectory, error);
        }
      } finally {
        await rm(attemptDirectory, { recursive: true, force: true });
      }

      return brandedExecutable;
    },
    {
      beforePublish: beforeRuntimePreparationLockPublish,
      onWait: onRuntimePreparationLockWait,
    },
  );
}
