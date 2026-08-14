import fs from "node:fs/promises";
import path from "node:path";
import type { MultitaskState } from "./types.js";

/** Durable state is keyed by Pi's canonical session file, never a UI number. */
export class MultitaskStateStore {
  private states: Record<string, MultitaskState> = {};
  private loaded = false;

  constructor(private readonly userDataPath: string) {}

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(this.filePath(), "utf8"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      for (const [sessionFile, state] of Object.entries(parsed)) {
        if (typeof sessionFile === "string" && isState(state)) {
          this.states[sessionFile] = state;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A corrupt optional feature file must never prevent Pi Deck startup.
        this.states = {};
      }
    }
  }

  get(sessionFile: string): MultitaskState | undefined {
    const state = this.states[sessionFile];
    return state ? structuredClone(state) : undefined;
  }

  async set(sessionFile: string, state: MultitaskState): Promise<void> {
    this.states[sessionFile] = structuredClone(state);
    await fs.mkdir(path.dirname(this.filePath()), { recursive: true });
    const temporary = `${this.filePath()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.states), "utf8");
    await fs.rename(temporary, this.filePath());
  }

  private filePath(): string {
    return path.join(this.userDataPath, "multitask-state.json");
  }
}

function isState(value: unknown): value is MultitaskState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as MultitaskState;
  return (
    (state.mode === "parallel" || state.mode === "sequential") &&
    Array.isArray(state.tasks)
  );
}
