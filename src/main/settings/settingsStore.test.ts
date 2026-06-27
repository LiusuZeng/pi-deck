import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DiagnosticsRecorder } from "../diagnostics/diagnostics.js";
import { defaultAppSettings, SettingsStore } from "./settingsStore.js";

const tempDirs: string[] = [];

class TestDiagnostics implements DiagnosticsRecorder {
  readonly errors: string[] = [];

  recordError(message: string): void {
    this.errors.push(message);
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("SettingsStore", () => {
  it("creates defaults when settings file is missing", async () => {
    const dir = await tempUserDataDir();
    const store = new SettingsStore(dir);

    await expect(store.get()).resolves.toEqual(defaultAppSettings);
    await expect(
      readFile(path.join(dir, "settings.json"), "utf8"),
    ).resolves.toContain("maxRunningSessions");
  });

  it("persists updates across store instances", async () => {
    const dir = await tempUserDataDir();
    const store = new SettingsStore(dir);
    await store.update({ maxRunningSessions: 8, warmWorkerLimit: 2 });

    const reloaded = new SettingsStore(dir);
    await expect(reloaded.get()).resolves.toMatchObject({
      maxRunningSessions: 8,
      warmWorkerLimit: 2,
    });
  });

  it("rejects invalid updates without corrupting current settings", async () => {
    const dir = await tempUserDataDir();
    const store = new SettingsStore(dir);
    await store.update({ maxRunningSessions: 6 });

    await expect(store.update({ maxRunningSessions: 21 })).rejects.toThrow();
    await expect(store.get()).resolves.toMatchObject({ maxRunningSessions: 6 });
  });

  it("backs up corrupt settings and applies defaults", async () => {
    const dir = await tempUserDataDir();
    await writeFile(path.join(dir, "settings.json"), "{not-json");
    const diagnostics = new TestDiagnostics();
    const store = new SettingsStore(dir, diagnostics);

    await expect(store.get()).resolves.toEqual(defaultAppSettings);
    expect(diagnostics.errors.join("\n")).toContain("invalid");
    const files = await readdir(dir);
    expect(
      files.some((file) => file.startsWith("settings.json.corrupt-")),
    ).toBe(true);
  });
});

async function tempUserDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-deck-settings-"));
  tempDirs.push(dir);
  return dir;
}
