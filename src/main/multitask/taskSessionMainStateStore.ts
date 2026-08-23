import fs from "node:fs/promises";
import path from "node:path";
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
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly userDataPath: string) {}

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(this.filePath(), "utf8"),
      );
      if (!isRecord(parsed)) return;
      for (const [key, value] of Object.entries(parsed)) {
        // Accept the initial raw-state format as well as the settings envelope.
        if (isState(value)) this.states[key] = value;
        else if (isRecord(value) && isState(value.state)) {
          this.states[key] = value.state;
          if (isSettings(value.settings)) this.settings[key] = value.settings;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.states = {};
    }
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

  private filePath(): string {
    return path.join(this.userDataPath, "task-session-state.json");
  }
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
