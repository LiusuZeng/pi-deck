import { execFile } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  cloneElectronBundle,
  findMacOSAppBundle,
  piDeckApplicationName,
  piDeckBundleIdentifier,
  piDeckBundleName,
  preparePiDeckElectronExecutable,
  readMacOSPlistString,
  resolveInstalledElectronExecutable,
} from "./electron-runtime.mjs";

const execFileAsync = promisify(execFile);

async function writeFakeElectronBundle(root) {
  const bundle = path.join(root, "Electron.app");
  const executable = path.join(bundle, "Contents", "MacOS", "Electron");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fake-electron");
  await chmod(executable, 0o755);
  return { bundle, executable };
}

function runtimeIdentityMarkerPath(sourceBundle) {
  return path.join(
    path.dirname(sourceBundle),
    ".pi-deck-electron-runtime.json",
  );
}

async function prepareIsolatedPiDeckElectronRuntime({
  electronExecutable = resolveInstalledElectronExecutable(),
  copySourceBundle = cloneElectronBundle,
  prepareOptions = {},
} = {}) {
  const sourceBundle = findMacOSAppBundle(electronExecutable);
  const executableRelativePath = path.relative(
    sourceBundle,
    electronExecutable,
  );
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pi-deck-electron-runtime-test-"),
  );
  const isolatedSourceBundle = path.join(root, path.basename(sourceBundle));

  try {
    await copySourceBundle(sourceBundle, isolatedSourceBundle);
    return {
      root,
      brandedExecutable: await preparePiDeckElectronExecutable({
        ...prepareOptions,
        electronExecutable: path.join(
          isolatedSourceBundle,
          executableRelativePath,
        ),
      }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

describe("Pi Deck Electron runtime", () => {
  it("locates the containing macOS app bundle", () => {
    expect(
      findMacOSAppBundle("/tmp/Electron.app/Contents/MacOS/Electron"),
    ).toBe("/tmp/Electron.app");
  });

  it("leaves non-macOS Electron launches unchanged", async () => {
    await expect(
      preparePiDeckElectronExecutable({
        platform: "linux",
        electronExecutable: "/tmp/electron",
      }),
    ).resolves.toBe("/tmp/electron");
  });

  it("launches macOS from a Pi Deck-named bundle and reuses the prepared runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-electron-"));
    try {
      const { bundle, executable } = await writeFakeElectronBundle(root);
      const copyBundle = vi.fn(async (source, destination) => {
        await cp(source, destination, {
          recursive: true,
          preserveTimestamps: true,
        });
      });
      const patchBundleIdentity = vi.fn(async () => undefined);

      const first = await preparePiDeckElectronExecutable({
        platform: "darwin",
        electronExecutable: executable,
        copyBundle,
        patchBundleIdentity,
      });
      const expected = path.join(
        root,
        piDeckBundleName,
        "Contents",
        "MacOS",
        "Electron",
      );
      expect(first).toBe(expected);
      expect(copyBundle).toHaveBeenCalledTimes(1);
      expect(copyBundle).toHaveBeenCalledWith(
        bundle,
        path.join(root, piDeckBundleName),
      );
      expect(patchBundleIdentity).toHaveBeenCalledWith(
        path.join(root, piDeckBundleName),
      );

      const second = await preparePiDeckElectronExecutable({
        platform: "darwin",
        electronExecutable: executable,
        copyBundle,
        patchBundleIdentity,
      });
      expect(second).toBe(expected);
      expect(copyBundle).toHaveBeenCalledTimes(1);
      expect(patchBundleIdentity).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepares integration runtimes from an isolated copy on success and failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-electron-"));
    try {
      const { bundle, executable } = await writeFakeElectronBundle(root);
      const sharedSentinelPath = path.join(
        root,
        piDeckBundleName,
        "sentinel.txt",
      );
      const sharedMarkerPath = runtimeIdentityMarkerPath(bundle);
      await mkdir(path.dirname(sharedSentinelPath), { recursive: true });
      await writeFile(sharedSentinelPath, "keep shared bundle");
      await writeFile(sharedMarkerPath, "keep shared marker");

      const copySourceBundle = vi.fn(async (source, destination) => {
        await cp(source, destination, {
          recursive: true,
          preserveTimestamps: true,
        });
      });
      const copyBundle = vi.fn(async (source, destination) => {
        await cp(source, destination, {
          recursive: true,
          preserveTimestamps: true,
        });
      });
      const patchBundleIdentity = vi.fn(async () => undefined);

      const fixture = await prepareIsolatedPiDeckElectronRuntime({
        electronExecutable: executable,
        copySourceBundle,
        prepareOptions: {
          platform: "darwin",
          copyBundle,
          patchBundleIdentity,
        },
      });
      try {
        const isolatedSourceBundle = path.join(fixture.root, "Electron.app");
        expect(findMacOSAppBundle(fixture.brandedExecutable)).toBe(
          path.join(fixture.root, piDeckBundleName),
        );
        expect(copySourceBundle).toHaveBeenCalledWith(
          bundle,
          isolatedSourceBundle,
        );
        expect(copyBundle).toHaveBeenCalledWith(
          isolatedSourceBundle,
          path.join(fixture.root, piDeckBundleName),
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
      await expect(readFile(sharedSentinelPath, "utf8")).resolves.toBe(
        "keep shared bundle",
      );
      await expect(readFile(sharedMarkerPath, "utf8")).resolves.toBe(
        "keep shared marker",
      );

      let failingFixtureRoot;
      await expect(
        prepareIsolatedPiDeckElectronRuntime({
          electronExecutable: executable,
          copySourceBundle: async (source, destination) => {
            failingFixtureRoot = path.dirname(destination);
            await cp(source, destination, {
              recursive: true,
              preserveTimestamps: true,
            });
          },
          prepareOptions: {
            platform: "darwin",
            copyBundle: async (source, destination) => {
              await cp(source, destination, {
                recursive: true,
                preserveTimestamps: true,
              });
            },
            patchBundleIdentity: async () => {
              throw new Error("patch failed");
            },
          },
        }),
      ).rejects.toThrow("patch failed");
      expect(failingFixtureRoot).toBeDefined();
      await expect(access(failingFixtureRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(sharedSentinelPath, "utf8")).resolves.toBe(
        "keep shared bundle",
      );
      await expect(readFile(sharedMarkerPath, "utf8")).resolves.toBe(
        "keep shared marker",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")(
    "rebrands an isolated Electron bundle with OS-visible Pi Deck identity",
    async () => {
      const fixture = await prepareIsolatedPiDeckElectronRuntime();
      try {
        const { brandedExecutable } = fixture;
        const brandedBundle = findMacOSAppBundle(brandedExecutable);
        expect(brandedBundle).toBe(path.join(fixture.root, piDeckBundleName));

        const infoPlist = path.join(brandedBundle, "Contents", "Info.plist");
        await expect(
          readMacOSPlistString(infoPlist, "CFBundleDisplayName"),
        ).resolves.toBe(piDeckApplicationName);
        await expect(
          readMacOSPlistString(infoPlist, "CFBundleName"),
        ).resolves.toBe(piDeckApplicationName);
        await expect(
          readMacOSPlistString(infoPlist, "CFBundleIdentifier"),
        ).resolves.toBe(piDeckBundleIdentifier);

        const { stdout } = await execFileAsync(brandedExecutable, [
          "--version",
        ]);
        expect(stdout.trim()).toMatch(/^v?\d+\.\d+\.\d+/);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
