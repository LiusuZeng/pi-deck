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
  resolvePiDeckElectronRuntimeCacheRoot,
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
  const runtimeCacheRoot = path.join(root, "runtime-cache");

  try {
    await copySourceBundle(sourceBundle, isolatedSourceBundle);
    return {
      root,
      runtimeCacheRoot,
      isolatedSourceBundle,
      brandedExecutable: await preparePiDeckElectronExecutable({
        runtimeCacheRoot,
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

  it("resolves the default macOS runtime cache under the user cache directory", () => {
    expect(
      resolvePiDeckElectronRuntimeCacheRoot({
        env: {},
        homedir: () => "/Users/example",
      }),
    ).toBe("/Users/example/Library/Caches/Pi Deck/electron-runtime");
  });

  it("allows tests and callers to override the runtime cache directory", () => {
    expect(
      resolvePiDeckElectronRuntimeCacheRoot({
        env: { PI_DECK_ELECTRON_RUNTIME_CACHE_DIR: "relative-cache" },
        homedir: () => "/Users/example",
      }),
    ).toBe(path.resolve("relative-cache"));
  });

  it("launches macOS from a cached Pi Deck-named bundle and reuses the prepared runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-electron-"));
    try {
      const sourceRoot = path.join(root, "source");
      const cacheRoot = path.join(root, "cache");
      await mkdir(cacheRoot, { recursive: true });
      const { bundle, executable } = await writeFakeElectronBundle(sourceRoot);
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
        runtimeCacheRoot: cacheRoot,
      });
      const brandedBundle = findMacOSAppBundle(first);
      const relativeBrandedBundle = path.relative(cacheRoot, brandedBundle);
      expect(relativeBrandedBundle.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relativeBrandedBundle)).toBe(false);
      expect(path.basename(brandedBundle)).toBe(piDeckBundleName);
      expect(first).toBe(
        path.join(brandedBundle, "Contents", "MacOS", "Electron"),
      );
      expect(copyBundle).toHaveBeenCalledTimes(1);
      expect(copyBundle).toHaveBeenCalledWith(bundle, brandedBundle);
      expect(patchBundleIdentity).toHaveBeenCalledWith(brandedBundle);

      const second = await preparePiDeckElectronExecutable({
        platform: "darwin",
        electronExecutable: executable,
        copyBundle,
        patchBundleIdentity,
        runtimeCacheRoot: cacheRoot,
      });
      expect(second).toBe(first);
      expect(copyBundle).toHaveBeenCalledTimes(1);
      expect(patchBundleIdentity).toHaveBeenCalledTimes(1);

      await writeFile(executable, "fake-electron-updated");
      await chmod(executable, 0o755);
      const third = await preparePiDeckElectronExecutable({
        platform: "darwin",
        electronExecutable: executable,
        copyBundle,
        patchBundleIdentity,
        runtimeCacheRoot: cacheRoot,
      });
      expect(third).toBe(first);
      expect(copyBundle).toHaveBeenCalledTimes(2);
      expect(patchBundleIdentity).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepares the runtime from a read-only source installation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-electron-"));
    const sourceRoot = path.join(root, "readonly-source");
    try {
      const cacheRoot = path.join(root, "cache");
      await mkdir(cacheRoot, { recursive: true });
      const { bundle, executable } = await writeFakeElectronBundle(sourceRoot);
      await chmod(sourceRoot, 0o555);

      const brandedExecutable = await preparePiDeckElectronExecutable({
        platform: "darwin",
        electronExecutable: executable,
        runtimeCacheRoot: cacheRoot,
        patchBundleIdentity: async () => undefined,
      });
      const brandedBundle = findMacOSAppBundle(brandedExecutable);

      expect(path.relative(cacheRoot, brandedBundle).startsWith("..")).toBe(
        false,
      );
      await expect(
        access(path.join(path.dirname(bundle), piDeckBundleName)),
      ).rejects.toThrow();
      await expect(
        access(
          path.join(path.dirname(bundle), ".pi-deck-electron-runtime.json"),
        ),
      ).rejects.toThrow();
    } finally {
      await chmod(sourceRoot, 0o755).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an actionable error when the runtime cache is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-electron-"));
    try {
      const { executable } = await writeFakeElectronBundle(
        path.join(root, "source"),
      );
      const unavailableCacheRoot = path.join(root, "cache-file");
      await writeFile(unavailableCacheRoot, "not a directory");

      await expect(
        preparePiDeckElectronExecutable({
          platform: "darwin",
          electronExecutable: executable,
          runtimeCacheRoot: unavailableCacheRoot,
          patchBundleIdentity: async () => undefined,
        }),
      ).rejects.toThrow(
        /Unable to prepare the Pi Deck Electron runtime.*ENOTDIR.*PI_DECK_ELECTRON_RUNTIME_CACHE_DIR/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an actionable error for an existing unwritable runtime directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-electron-"));
    let runtimeDirectory;
    try {
      const { executable } = await writeFakeElectronBundle(
        path.join(root, "source"),
      );
      const cacheRoot = path.join(root, "cache");
      const preparedExecutable = await preparePiDeckElectronExecutable({
        platform: "darwin",
        electronExecutable: executable,
        runtimeCacheRoot: cacheRoot,
        patchBundleIdentity: async () => undefined,
      });
      const brandedBundle = findMacOSAppBundle(preparedExecutable);
      runtimeDirectory = path.dirname(brandedBundle);
      await rm(brandedBundle, { recursive: true, force: true });
      await rm(runtimeIdentityMarkerPath(brandedBundle), { force: true });
      await chmod(runtimeDirectory, 0o555);

      await expect(
        preparePiDeckElectronExecutable({
          platform: "darwin",
          electronExecutable: executable,
          runtimeCacheRoot: cacheRoot,
          patchBundleIdentity: async () => undefined,
        }),
      ).rejects.toThrow(
        /Unable to prepare the Pi Deck Electron runtime.*EACCES.*PI_DECK_ELECTRON_RUNTIME_CACHE_DIR/,
      );
    } finally {
      if (runtimeDirectory) {
        await chmod(runtimeDirectory, 0o755).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves source-copy failures instead of misreporting a cache error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-electron-"));
    try {
      const { executable } = await writeFakeElectronBundle(
        path.join(root, "source"),
      );

      await expect(
        preparePiDeckElectronExecutable({
          platform: "darwin",
          electronExecutable: executable,
          runtimeCacheRoot: path.join(root, "cache"),
          copyBundle: async () => {
            throw new Error("source copy failed");
          },
        }),
      ).rejects.toThrow("source copy failed");
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
        const brandedBundle = findMacOSAppBundle(fixture.brandedExecutable);
        expect(
          path
            .relative(fixture.runtimeCacheRoot, brandedBundle)
            .startsWith(".."),
        ).toBe(false);
        expect(path.basename(brandedBundle)).toBe(piDeckBundleName);
        expect(copySourceBundle).toHaveBeenCalledWith(
          bundle,
          fixture.isolatedSourceBundle,
        );
        expect(copyBundle).toHaveBeenCalledWith(
          fixture.isolatedSourceBundle,
          brandedBundle,
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
        expect(
          path
            .relative(fixture.runtimeCacheRoot, brandedBundle)
            .startsWith(".."),
        ).toBe(false);
        expect(path.basename(brandedBundle)).toBe(piDeckBundleName);

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
