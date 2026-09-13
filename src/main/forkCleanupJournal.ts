import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DiagnosticsRecorder } from "./diagnostics/diagnostics.js";
import type { ProjectStore } from "./projects/projectStore.js";
import type { WorkspaceStore } from "./workspaces/workspaceStore.js";

const entrySchema = z
  .object({
    sessionFile: z.string().min(1),
    workspaceId: z.string().uuid(),
    projectId: z.string().min(1).optional(),
  })
  .strict();
const fileSchema = z
  .object({ version: z.literal(1), entries: z.array(entrySchema) })
  .strict();

type ForkCleanupEntry = z.infer<typeof entrySchema>;
type ForkCleanupFile = z.infer<typeof fileSchema>;

/**
 * Write-ahead compensation for a fork which has named a fresh target but has
 * not yet returned it to the renderer. A process crash or failed metadata
 * removal must therefore be retried before that target can be attached.
 */
export class ForkCleanupJournal {
  readonly storeFile: string;
  private state: ForkCleanupFile = { version: 1, entries: [] };
  private loaded = false;
  // A corrupt journal has unknowable outstanding targets. Fail closed for
  // attach/fork operations rather than silently making them available.
  private corrupt = false;
  private persistTail: Promise<void> = Promise.resolve();

  constructor(
    piDeckHome: string,
    private readonly diagnostics?: DiagnosticsRecorder,
  ) {
    this.storeFile = path.join(piDeckHome, "failed-fork-cleanup.json");
  }

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.storeFile), {
      recursive: true,
      mode: 0o700,
    });
    try {
      this.state = fileSchema.parse(
        JSON.parse(await fs.readFile(this.storeFile, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.corrupt = true;
        this.diagnostics?.recordError(
          `Failed fork cleanup journal is invalid; session attachment is blocked until it is repaired: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.state = { version: 1, entries: [] };
    }
    this.loaded = true;
  }

  async reserve(entry: ForkCleanupEntry): Promise<void> {
    await this.loadIfNeeded();
    if (this.corrupt) {
      throw new Error("Failed fork cleanup journal requires repair.");
    }
    const parsed = entrySchema.parse(entry);
    await this.transact(() => {
      if (
        this.state.entries.some(
          (item) => item.sessionFile === parsed.sessionFile,
        )
      ) {
        return this.state;
      }
      return { ...this.state, entries: [...this.state.entries, parsed] };
    });
  }

  async complete(sessionFile: string): Promise<void> {
    await this.loadIfNeeded();
    await this.transact(() => ({
      ...this.state,
      entries: this.state.entries.filter(
        (entry) => entry.sessionFile !== sessionFile,
      ),
    }));
  }

  async blocks(sessionFile: string): Promise<boolean> {
    await this.loadIfNeeded();
    return (
      this.corrupt ||
      this.state.entries.some((entry) => entry.sessionFile === sessionFile)
    );
  }

  async retry(
    workspaceStore: WorkspaceStore,
    projectStore: ProjectStore | undefined,
  ): Promise<void> {
    await this.loadIfNeeded();
    if (this.corrupt) return;
    for (const entry of [...this.state.entries]) {
      try {
        await workspaceStore.removeSession(
          entry.workspaceId,
          entry.sessionFile,
        );
        if (entry.projectId !== undefined) {
          await projectStore?.removeSessionRef(
            entry.projectId,
            entry.sessionFile,
          );
        }
        await this.complete(entry.sessionFile);
      } catch (error) {
        this.diagnostics?.recordError(
          `Failed to retry failed fork cleanup for ${entry.sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async transact(operation: () => ForkCleanupFile): Promise<void> {
    const transaction = this.persistTail
      .catch(() => undefined)
      .then(async () => {
        const next = fileSchema.parse(operation());
        if (JSON.stringify(next) === JSON.stringify(this.state)) return;
        await this.write(next);
        this.state = next;
      });
    this.persistTail = transaction.then(
      () => undefined,
      () => undefined,
    );
    return transaction;
  }

  private async write(candidate: ForkCleanupFile): Promise<void> {
    const temp = `${this.storeFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(candidate, null, 2)}\n`, {
        mode: 0o600,
      });
      await fs.rename(temp, this.storeFile);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
