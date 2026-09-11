import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  findMacOSAppBundle,
  piDeckBundleName,
  preparePiDeckElectronExecutable,
} from "./electron-runtime.mjs";

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

  it("launches macOS from a Pi Deck-named bundle and reuses the clone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-electron-"));
    try {
      const { bundle, executable } = await writeFakeElectronBundle(root);
      const copyBundle = vi.fn(async (source, destination) => {
        await cp(source, destination, {
          recursive: true,
          preserveTimestamps: true,
        });
      });

      const first = await preparePiDeckElectronExecutable({
        platform: "darwin",
        electronExecutable: executable,
        copyBundle,
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

      const second = await preparePiDeckElectronExecutable({
        platform: "darwin",
        electronExecutable: executable,
        copyBundle,
      });
      expect(second).toBe(expected);
      expect(copyBundle).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
