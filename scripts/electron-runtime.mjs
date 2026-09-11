import { constants as fsConstants } from "node:fs";
import { access, cp, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export const piDeckApplicationName = "Pi Deck";
export const piDeckBundleName = `${piDeckApplicationName}.app`;

const require = createRequire(import.meta.url);

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

async function executableLooksCurrent(sourceExecutable, brandedExecutable) {
  try {
    const [sourceStats, brandedStats] = await Promise.all([
      stat(sourceExecutable),
      stat(brandedExecutable),
    ]);
    await access(brandedExecutable, fsConstants.X_OK);
    return (
      sourceStats.isFile() &&
      brandedStats.isFile() &&
      sourceStats.size === brandedStats.size &&
      sourceStats.mtimeMs === brandedStats.mtimeMs
    );
  } catch {
    return false;
  }
}

async function runCloneCopy(sourceBundle, destinationBundle) {
  await new Promise((resolve, reject) => {
    const child = spawn("/bin/cp", ["-R", "-c", sourceBundle, destinationBundle], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`macOS clone copy exited via signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`macOS clone copy exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
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
 * macOS derives the Dock tooltip from the running .app bundle, not Electron's
 * internal app name. Keep Electron's signed contents unchanged and clone the
 * installed runtime to a sibling `Pi Deck.app` bundle, then launch the same
 * executable from that renamed outer bundle. APFS clone-copy keeps this cheap
 * and disk-efficient; a regular recursive copy is the compatibility fallback.
 */
export async function preparePiDeckElectronExecutable({
  platform = process.platform,
  electronExecutable = resolveInstalledElectronExecutable(),
  copyBundle = cloneElectronBundle,
} = {}) {
  if (platform !== "darwin") {
    return electronExecutable;
  }

  const sourceBundle = findMacOSAppBundle(electronExecutable);
  const executableRelativePath = path.relative(sourceBundle, electronExecutable);
  if (
    executableRelativePath.length === 0 ||
    executableRelativePath.startsWith("..") ||
    path.isAbsolute(executableRelativePath)
  ) {
    throw new Error(
      `Electron executable is not contained by its app bundle: ${electronExecutable}`,
    );
  }

  const brandedBundle = path.join(path.dirname(sourceBundle), piDeckBundleName);
  const brandedExecutable = path.join(brandedBundle, executableRelativePath);

  if (await executableLooksCurrent(electronExecutable, brandedExecutable)) {
    return brandedExecutable;
  }

  await copyBundle(sourceBundle, brandedBundle);
  if (!(await executableLooksCurrent(electronExecutable, brandedExecutable))) {
    throw new Error(
      `Pi Deck Electron runtime was prepared but its executable is missing or stale: ${brandedExecutable}`,
    );
  }
  return brandedExecutable;
}
