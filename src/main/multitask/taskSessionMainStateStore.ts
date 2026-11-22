import fs from "node:fs/promises";
import path from "node:path";
import type { DiagnosticsRecorder } from "../diagnostics/diagnostics.js";
import {
  isPersistedTaskSessionState,
  type PersistedTaskSessionState,
  type TaskSessionWorkerSettings,
} from "./taskSessionOrchestrator.js";

/** Durable private task-session state, deliberately separate from legacy bridge state. */
export class TaskSessionMainStateStore {
  private states: Record<string, PersistedTaskSessionState> = {};
  private settings: Record<string, TaskSessionWorkerSettings> = {};
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly userDataPath: string,
    private readonly diagnostics?: DiagnosticsRecorder,
  ) {}

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    this.loadPromise = this.loadFromDisk();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = undefined;
    }
  }

  private async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath(), "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        this.states = {};
        this.settings = {};
        this.loaded = true;
      } else {
        this.recordDiagnostic(
          `Task session state could not be read; writes are disabled until it can be recovered: ${errorToMessage(error)}`,
        );
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      await this.handleInvalidTopLevel(
        `Task session state JSON was invalid: ${errorToMessage(error)}`,
      );
      return;
    }

    if (!isRecord(parsed)) {
      await this.handleInvalidTopLevel(
        "Task session state JSON must contain an object at the top level.",
      );
      return;
    }

    const nextStates: Record<string, PersistedTaskSessionState> = {};
    const nextSettings: Record<string, TaskSessionWorkerSettings> = {};
    for (const [key, value] of Object.entries(parsed)) {
      // Accept the initial raw-state format as well as the settings envelope.
      if (isState(value)) nextStates[key] = value;
      else if (isRecord(value) && isState(value.state)) {
        nextStates[key] = value.state;
        if (isSettings(value.settings)) nextSettings[key] = value.settings;
      }
    }
    this.states = nextStates;
    this.settings = nextSettings;
    this.loaded = true;
  }

  get(sessionFile: string): PersistedTaskSessionState | undefined {
    const state = this.states[sessionFile];
    return state ? structuredClone(state) : undefined;
  }

  getSettings(sessionFile: string): TaskSessionWorkerSettings | undefined {
    const settings = this.settings[sessionFile];
    return settings ? structuredClone(settings) : undefined;
  }

  async set(
    sessionFile: string,
    state: PersistedTaskSessionState,
  ): Promise<void> {
    await this.mutate(() => {
      this.states[sessionFile] = structuredClone(state);
    });
  }

  async setSettings(
    sessionFile: string,
    settings: TaskSessionWorkerSettings,
  ): Promise<void> {
    await this.mutate(() => {
      this.settings[sessionFile] = structuredClone(settings);
    });
  }

  async delete(sessionFile: string): Promise<void> {
    await this.mutate(() => {
      delete this.states[sessionFile];
      delete this.settings[sessionFile];
    });
  }

  private async mutate(change: () => void): Promise<void> {
    const write = this.writeTail.then(async () => {
      await this.loadIfNeeded();
      if (!this.loaded) {
        throw new Error(
          "Task session state could not be loaded; refusing to overwrite existing recovery data.",
        );
      }
      change();
      await fs.mkdir(path.dirname(this.filePath()), { recursive: true });
      const temporary = `${this.filePath()}.${process.pid}.${Date.now()}.tmp`;
      const persisted = Object.fromEntries(
        Object.keys(this.states).map((key) => [
          key,
          {
            state: this.states[key],
            ...(this.settings[key] ? { settings: this.settings[key] } : {}),
          },
        ]),
      );
      await fs.writeFile(temporary, JSON.stringify(persisted), "utf8");
      await fs.rename(temporary, this.filePath());
    });
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  private async handleInvalidTopLevel(message: string): Promise<void> {
    this.recordDiagnostic(
      `${message} Existing recovery data will be preserved.`,
    );
    const backup = `${this.filePath()}.invalid-${Date.now()}`;
    try {
      await fs.copyFile(this.filePath(), backup);
      this.recordDiagnostic(
        `Invalid task session state was preserved at ${backup}; starting with empty task-session recovery state.`,
      );
      this.states = {};
      this.settings = {};
      this.loaded = true;
    } catch (error) {
      this.recordDiagnostic(
        `Could not preserve invalid task session state; writes remain disabled: ${errorToMessage(error)}`,
      );
    }
  }

  private recordDiagnostic(message: string): void {
    this.diagnostics?.recordError(message);
  }

  private filePath(): string {
    return path.join(this.userDataPath, "task-session-state.json");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isSettings(value: unknown): value is TaskSessionWorkerSettings {
  return (
    isRecord(value) &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.thinkingLevel === undefined ||
      typeof value.thinkingLevel === "string")
  );
}
function isState(value: unknown): value is PersistedTaskSessionState {
  return isPersistedTaskSessionState(value);
}
