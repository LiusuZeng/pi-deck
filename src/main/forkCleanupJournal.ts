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
    // Older journals predate source reservation persistence. Keep them
    // readable, while every new fork records both sides fail-closed.
    sourceSessionFile: z.string().min(1).optional(),
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
  private loadPromise: Promise<void> | undefined;
  // A corrupt journal has unknowable outstanding targets. Fail closed for
  // attach/fork operations rather than silently making them available.
  private corrupt = false;
  // A reserve write can fail after Pi has created the target. Keep the exact
  // cleanup entry in this process even when it cannot be made durable: callers
  // must not attach it until compensation has actually succeeded.
  private readonly ephemeralEntries = new Map<string, ForkCleanupEntry>();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(
    piDeckHome: string,
    private readonly diagnostics?: DiagnosticsRecorder,
  ) {
    this.storeFile = path.join(piDeckHome, "failed-fork-cleanup.json");
  }

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) return;
    // IPC registration precedes backend initialization. Publish this promise
    // synchronously so an early reserve cannot be overwritten by a second,
    // stale initial read that races startup.
    this.loadPromise ??= this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
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
    const operation = (): ForkCleanupFile => {
      if (
        this.state.entries.some(
          (item) => item.sessionFile === parsed.sessionFile,
        )
      ) {
        return this.state;
      }
      return { ...this.state, entries: [...this.state.entries, parsed] };
    };
    try {
      // A transient filesystem error must not turn a fresh target into an
      // attachable session. Retry once before retaining the process-only entry.
      await this.transact(operation);
    } catch {
      try {
        await this.transact(operation);
      } catch (retryError) {
        this.ephemeralEntries.set(parsed.sessionFile, parsed);
        throw retryError;
      }
    }
  }

  async complete(sessionFile: string): Promise<void> {
    await this.loadIfNeeded();
    // Do not release a process-only reservation until the durable entry (if
    // any) is also gone. For an entry whose reserve never persisted, reaching
    // this method is the caller's proof that cleanup completed.
    await this.transact(() => ({
      ...this.state,
      entries: this.state.entries.filter(
        (entry) => entry.sessionFile !== sessionFile,
      ),
    }));
    this.ephemeralEntries.delete(sessionFile);
  }

  async blocks(sessionFile: string): Promise<boolean> {
    await this.loadIfNeeded();
    return (
      this.corrupt ||
      this.ephemeralEntries.has(sessionFile) ||
      [...this.ephemeralEntries.values()].some(
        (entry) => entry.sourceSessionFile === sessionFile,
      ) ||
      this.state.entries.some(
        (entry) =>
          entry.sessionFile === sessionFile ||
          entry.sourceSessionFile === sessionFile,
      )
    );
  }

  /**
   * Compensate one target only after its owning child has emitted worker_exit.
   * A journal recovered at startup has no such proof: its old child may have
   * survived a crashed parent, so callers must leave it blocked rather than
   * treating restart as confirmation.
   */
  async retryAfterConfirmedExit(
    sessionFile: string,
    workspaceStore: WorkspaceStore,
    projectStore: ProjectStore | undefined,
  ): Promise<void> {
    await this.loadIfNeeded();
    if (this.corrupt) return;
    const entry =
      this.ephemeralEntries.get(sessionFile) ??
      this.state.entries.find((item) => item.sessionFile === sessionFile);
    if (entry === undefined) return;
    try {
      // A renderer mutation must not move a blocked target, but retain the
      // block even if legacy/corrupt metadata already did: removing only the
      // recorded source reference would otherwise release a live reference.
      const owner = await workspaceStore.getSessionOwner(entry.sessionFile);
      if (owner !== undefined && owner.workspaceId !== entry.workspaceId) {
        throw new Error(
          `Failed fork cleanup target moved from its reserved workspace ${entry.workspaceId}.`,
        );
      }
      await workspaceStore.removeSession(entry.workspaceId, entry.sessionFile);
      if (entry.projectId !== undefined) {
        if (projectStore === undefined) {
          throw new Error("Failed fork cleanup project store is unavailable.");
        }
        await projectStore.removeSessionRef(entry.projectId, entry.sessionFile);
      }
      await this.complete(entry.sessionFile);
    } catch (error) {
      this.diagnostics?.recordError(
        `Failed to retry failed fork cleanup for ${entry.sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
