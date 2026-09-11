import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
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

  it.runIf(process.platform === "darwin")(
    "rebrands the installed Electron bundle with OS-visible Pi Deck identity",
    async () => {
      const electronExecutable = resolveInstalledElectronExecutable();
      const sourceBundle = findMacOSAppBundle(electronExecutable);
      const brandedBundle = path.join(path.dirname(sourceBundle), piDeckBundleName);
      const markerPath = path.join(
        path.dirname(sourceBundle),
        ".pi-deck-electron-runtime.json",
      );

      await Promise.all([
        rm(brandedBundle, { recursive: true, force: true }),
        rm(markerPath, { force: true }),
      ]);
      try {
        const brandedExecutable = await preparePiDeckElectronExecutable({
          electronExecutable,
        });
        expect(findMacOSAppBundle(brandedExecutable)).toBe(brandedBundle);

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

        const { stdout } = await execFileAsync(brandedExecutable, ["--version"]);
        expect(stdout.trim()).toMatch(/^v?\d+\.\d+\.\d+/);
      } finally {
        await Promise.all([
          rm(brandedBundle, { recursive: true, force: true }),
          rm(markerPath, { force: true }),
        ]);
      }
    },
    30_000,
  );
});
