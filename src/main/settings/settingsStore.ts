import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
} from "../../shared/ipcSchemas.js";
import type { AppSettings } from "../../shared/types.js";
import type { DiagnosticsRecorder } from "../diagnostics/diagnostics.js";

export const defaultAppSettings: AppSettings = Object.freeze({
  maxRunningSessions: 4,
  warmWorkerLimit: 1,
  enableLoginShellEnvCapture: true,
});

export class SettingsStore {
  readonly settingsFile: string;
  private settings: AppSettings = { ...defaultAppSettings };
  private loaded = false;

  constructor(
    private readonly userDataPath: string,
    private readonly diagnostics?: DiagnosticsRecorder,
  ) {
    this.settingsFile = path.join(userDataPath, "settings.json");
  }

  async get(): Promise<AppSettings> {
    await this.loadIfNeeded();
    return { ...this.settings };
  }

  async update(patch: unknown): Promise<AppSettings> {
    await this.loadIfNeeded();
    const parsedPatch = appSettingsPatchSchema.parse(patch);
    const next = appSettingsSchema.parse({ ...this.settings, ...parsedPatch });
    this.settings = next;
    await this.persist();
    return { ...this.settings };
  }

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await mkdir(this.userDataPath, { recursive: true });

    try {
      const raw = await readFile(this.settingsFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.settings = appSettingsSchema.parse({
        ...defaultAppSettings,
        ...(parsed as object),
      });
    } catch (error) {
      if (isMissingFile(error)) {
        this.settings = { ...defaultAppSettings };
        await this.persist();
      } else {
        const message = `Settings file was invalid and defaults were applied: ${errorToMessage(error)}`;
        this.diagnostics?.recordError(message);
        await this.backupCorruptSettings();
        this.settings = { ...defaultAppSettings };
        await this.persist();
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(this.userDataPath, { recursive: true });
    await writeFile(
      this.settingsFile,
      `${JSON.stringify(this.settings, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async backupCorruptSettings(): Promise<void> {
    const backupFile = `${this.settingsFile}.corrupt-${Date.now()}`;
    try {
      await rename(this.settingsFile, backupFile);
      this.diagnostics?.recordError(
        `Corrupt settings file moved to ${backupFile}`,
      );
    } catch (error) {
      this.diagnostics?.recordError(
        `Could not move corrupt settings file: ${errorToMessage(error)}`,
      );
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
