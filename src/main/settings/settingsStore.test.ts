import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as realRename,
  rm,
  unlink,
  writeFile as realWriteFile,
} from "node:fs/promises";
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

  it("loads settings written before the theme preference was added", async () => {
    const dir = await tempUserDataDir();
    await realWriteFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ maxRunningSessions: 8, warmWorkerLimit: 2 }),
    );

    await expect(new SettingsStore(dir).get()).resolves.toMatchObject({
      theme: "system",
      maxRunningSessions: 8,
      warmWorkerLimit: 2,
    });
  });

  it("persists a valid theme preference", async () => {
    const dir = await tempUserDataDir();
    const store = new SettingsStore(dir);

    await expect(store.update({ theme: "dark" })).resolves.toMatchObject({
      theme: "dark",
    });
    await expect(new SettingsStore(dir).get()).resolves.toMatchObject({
      theme: "dark",
    });
  });

  it("persists session sound preferences and preserves sibling toggles", async () => {
    const dir = await tempUserDataDir();
    const store = new SettingsStore(dir);

    await expect(
      store.update({ sessionSounds: { needsAttention: false } }),
    ).resolves.toMatchObject({
      sessionSounds: { needsAttention: false, completed: true },
    });
    await expect(
      store.update({ sessionSounds: { completed: false } }),
    ).resolves.toMatchObject({
      sessionSounds: { needsAttention: false, completed: false },
    });
    await expect(new SettingsStore(dir).get()).resolves.toMatchObject({
      sessionSounds: { needsAttention: false, completed: false },
    });
  });

  it("serializes concurrent updates so their settings both persist", async () => {
    const dir = await tempUserDataDir();
    const store = new SettingsStore(dir);

    await Promise.all([
      store.update({ theme: "dark" }),
      store.update({ sessionSounds: { completed: false } }),
    ]);

    await expect(new SettingsStore(dir).get()).resolves.toMatchObject({
      theme: "dark",
      sessionSounds: { needsAttention: true, completed: false },
    });
  });

  it("keeps its update queue usable after a rejected update", async () => {
    const dir = await tempUserDataDir();
    const store = new SettingsStore(dir);

    await expect(store.update({ maxRunningSessions: 21 })).rejects.toThrow();
    await expect(
      store.update({ maxRunningSessions: 6 }),
    ).resolves.toMatchObject({
      maxRunningSessions: 6,
    });
  });

  it("rejects failed writes without corrupting current settings", async () => {
    const dir = await tempUserDataDir();
    const settingsFile = path.join(dir, "settings.json");
    const store = new SettingsStore(dir);
    await store.update({ maxRunningSessions: 6 });

    await rm(settingsFile);
    await mkdir(settingsFile);

    await expect(store.update({ maxRunningSessions: 7 })).rejects.toThrow();
    await expect(store.get()).resolves.toMatchObject({
      maxRunningSessions: 6,
    });

    await rm(settingsFile, { recursive: true });
    await expect(store.update({ theme: "dark" })).resolves.toMatchObject({
      theme: "dark",
      maxRunningSessions: 6,
    });
    await expect(new SettingsStore(dir).get()).resolves.toMatchObject({
      theme: "dark",
      maxRunningSessions: 6,
    });
  });

  it("preserves last-good settings on disk when the temporary write fails", async () => {
    const dir = await tempUserDataDir();
    const store = new SettingsStore(dir);
    await store.update({ theme: "dark", maxRunningSessions: 6 });

    let tempFile: string | undefined;
    const faultingStore = new SettingsStore(dir, undefined, {
      mkdir,
      readFile,
      rename: realRename,
      unlink,
      writeFile: async (file, data, options) => {
        tempFile = String(file);
        await realWriteFile(file, String(data).slice(0, 2), options);
        throw new Error("injected partial temp write failure");
      },
    });

    await expect(faultingStore.update({ warmWorkerLimit: 2 })).rejects.toThrow(
      "injected partial temp write failure",
    );
    await expect(faultingStore.get()).resolves.toMatchObject({
      theme: "dark",
      maxRunningSessions: 6,
      warmWorkerLimit: 1,
    });
    await expect(new SettingsStore(dir).get()).resolves.toMatchObject({
      theme: "dark",
      maxRunningSessions: 6,
      warmWorkerLimit: 1,
    });
    expect(tempFile).toContain(path.join(dir, ".settings.json."));
    await expect(readdir(dir)).resolves.not.toContain(path.basename(tempFile!));
  });

  it("preserves last-good settings on disk when atomic rename fails", async () => {
    const dir = await tempUserDataDir();
    const store = new SettingsStore(dir);
    await store.update({ theme: "dark", maxRunningSessions: 6 });

    let tempFile: string | undefined;
    const faultingStore = new SettingsStore(dir, undefined, {
      mkdir,
      readFile,
      rename: async (source, destination) => {
        if (String(source).includes(`${path.sep}.settings.json.`)) {
          tempFile = String(source);
          expect(String(destination)).toBe(path.join(dir, "settings.json"));
          throw new Error("injected rename failure");
        }
        await realRename(source, destination);
      },
      unlink,
      writeFile: realWriteFile,
    });

    await expect(faultingStore.update({ warmWorkerLimit: 2 })).rejects.toThrow(
      "injected rename failure",
    );
    await expect(faultingStore.get()).resolves.toMatchObject({
      theme: "dark",
      maxRunningSessions: 6,
      warmWorkerLimit: 1,
    });
    await expect(new SettingsStore(dir).get()).resolves.toMatchObject({
      theme: "dark",
      maxRunningSessions: 6,
      warmWorkerLimit: 1,
    });
    expect(tempFile).toContain(path.join(dir, ".settings.json."));
    await expect(readdir(dir)).resolves.not.toContain(path.basename(tempFile!));
  });

  it("backs up corrupt settings and applies defaults", async () => {
    const dir = await tempUserDataDir();
    await realWriteFile(path.join(dir, "settings.json"), "{not-json");
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
