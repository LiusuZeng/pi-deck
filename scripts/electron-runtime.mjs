import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export const piDeckApplicationName = "Pi Deck";
export const piDeckBundleName = `${piDeckApplicationName}.app`;
export const piDeckBundleIdentifier = "com.pi-deck.desktop";

const require = createRequire(import.meta.url);
const runtimeIdentitySchemaVersion = 1;

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

function runtimeIdentityMarkerPath(sourceBundle) {
  return path.join(path.dirname(sourceBundle), ".pi-deck-electron-runtime.json");
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
 * source-run launches use a sibling Pi Deck.app clone with Pi Deck plist
 * metadata. APFS clone-copy keeps the first preparation cheap and the marker
 * makes later launches constant-time until the installed Electron runtime
 * changes.
 */
export async function preparePiDeckElectronExecutable({
  platform = process.platform,
  electronExecutable = resolveInstalledElectronExecutable(),
  copyBundle = cloneElectronBundle,
  patchBundleIdentity = patchMacOSBundleIdentity,
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

  const brandedBundle = path.join(path.dirname(sourceBundle), piDeckBundleName);
  const brandedExecutable = path.join(brandedBundle, executableRelativePath);
  const markerPath = runtimeIdentityMarkerPath(sourceBundle);

  if (
    await preparedRuntimeLooksCurrent(
      electronExecutable,
      brandedExecutable,
      markerPath,
    )
  ) {
    return brandedExecutable;
  }

  await rm(markerPath, { force: true });
  try {
    await copyBundle(sourceBundle, brandedBundle);
    await patchBundleIdentity(brandedBundle);

    const sourceStats = await stat(electronExecutable);
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          schemaVersion: runtimeIdentitySchemaVersion,
          applicationName: piDeckApplicationName,
          bundleIdentifier: piDeckBundleIdentifier,
          sourceSize: sourceStats.size,
          sourceMtimeMs: sourceStats.mtimeMs,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    await Promise.all([
      rm(brandedBundle, { recursive: true, force: true }),
      rm(markerPath, { force: true }),
    ]);
    throw error;
  }

  if (
    !(await preparedRuntimeLooksCurrent(
      electronExecutable,
      brandedExecutable,
      markerPath,
    ))
  ) {
    throw new Error(
      `Pi Deck Electron runtime was prepared but its executable is missing or stale: ${brandedExecutable}`,
    );
  }
  return brandedExecutable;
}
