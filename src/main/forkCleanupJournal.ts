import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DiagnosticsRecorder } from "./diagnostics/diagnostics.js";
import type { ProjectStore } from "./projects/projectStore.js";
import type { WorkspaceStore } from "./workspaces/workspaceStore.js";

const legacyTargetEntrySchema = z
  .object({
    sessionFile: z.string().min(1),
    sourceSessionFile: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    workspaceId: z.string().uuid(),
  })
  .strict();
const legacyFileSchema = z
  .object({ version: z.literal(1), entries: z.array(legacyTargetEntrySchema) })
  .strict();

const sourceReservationEntrySchema = z
  .object({
    kind: z.literal("source"),
    sourceSessionFile: z.string().min(1),
    transactionId: z.string().uuid(),
    createdAtMs: z.number().int().nonnegative(),
    // A pre-spawn reservation deliberately has no process identity. It must
    // never be guessed clear after a crash because the parent cannot prove
    // whether native process creation had begun.
    phase: z.enum(["pre-spawn", "spawned"]),
    childRuntimeId: z.string().min(1).optional(),
    childPid: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.phase === "spawned" && entry.childRuntimeId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Spawned source reservations require a child runtime ID.",
      });
    }
    if (
      entry.phase === "pre-spawn" &&
      (entry.childRuntimeId !== undefined || entry.childPid !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Pre-spawn source reservations cannot name a child.",
      });
    }
  });
const targetReservationEntrySchema = z
  .object({
    kind: z.literal("target"),
    sessionFile: z.string().min(1),
    // Omitted only by migrated v1 target records, which predate durable
    // source reservation. Every v2 promotion supplies this field.
    sourceSessionFile: z.string().min(1).optional(),
    transactionId: z.string().uuid(),
    createdAtMs: z.number().int().nonnegative(),
    childRuntimeId: z.string().min(1).optional(),
    childPid: z.number().int().positive().optional(),
    workspaceId: z.string().uuid(),
    projectId: z.string().min(1).optional(),
  })
  .strict();
const entrySchema = z.union([
  sourceReservationEntrySchema,
  targetReservationEntrySchema,
]);
const fileSchema = z
  .object({ version: z.literal(2), entries: z.array(entrySchema) })
  .strict();

type SourceReservationEntry = z.infer<typeof sourceReservationEntrySchema>;
type TargetReservationEntry = z.infer<typeof targetReservationEntrySchema>;
type ForkCleanupEntry = z.infer<typeof entrySchema>;
type ForkCleanupFile = z.infer<typeof fileSchema>;
type ForkTargetEntryInput = Omit<
  TargetReservationEntry,
  "kind" | "transactionId" | "createdAtMs" | "sourceSessionFile"
> & {
  sourceSessionFile: string;
  transactionId?: string;
  createdAtMs?: number;
};

function entryKey(entry: ForkCleanupEntry): string {
  return entry.kind === "source"
    ? `source:${entry.sourceSessionFile}`
    : `target:${entry.sessionFile}`;
}

/**
 * Durable write-ahead ownership for native Pi forks. Version 2 starts with a
 * source-only record before process creation, records the child identity as
 * soon as it exists, and atomically promotes that record to source+target
 * compensation once get_state has named the child session.
 */
export class ForkCleanupJournal {
  readonly storeFile: string;
  private state: ForkCleanupFile = { version: 2, entries: [] };
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  // A corrupt journal has unknowable outstanding targets. Fail closed for
  // attach/fork operations rather than silently making them available.
  private corrupt = false;
  // A reserve write can fail after Pi has created the target. Keep the exact
  // cleanup entry in this process even when it cannot be made durable.
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
      const parsed = JSON.parse(await fs.readFile(this.storeFile, "utf8"));
      const current = fileSchema.safeParse(parsed);
      if (current.success) {
        this.state = current.data;
      } else {
        // Version 1 only held target compensation. Preserve every entry while
        // upgrading it in memory; the next mutation writes version 2.
        const legacy = legacyFileSchema.parse(parsed);
        this.state = {
          version: 2,
          entries: legacy.entries.map((entry) => ({
            kind: "target" as const,
            ...entry,
            transactionId: randomUUID(),
            createdAtMs: 0,
          })),
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.corrupt = true;
        this.diagnostics?.recordError(
          `Failed fork cleanup journal is invalid; session attachment is blocked until it is repaired: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.state = { version: 2, entries: [] };
    }
    this.loaded = true;
    for (const entry of this.state.entries) {
      if (entry.kind !== "source") continue;
      this.diagnostics?.recordError(
        `Fork reservation ${entry.transactionId} for ${entry.sourceSessionFile} remains blocked after restart (${entry.phase}${entry.childPid !== undefined ? `, pid ${entry.childPid}` : ""}). Pi Deck will not clear it automatically; prove the child is absent/exited and perform explicit safe journal repair.`,
      );
    }
  }

  /** Persist the source lock before code is allowed to invoke native Pi. */
  async reserveSource(input: {
    sourceSessionFile: string;
    transactionId: string;
  }): Promise<void> {
    await this.loadIfNeeded();
    if (this.corrupt) {
      throw new Error("Failed fork cleanup journal requires repair.");
    }
    const parsed = sourceReservationEntrySchema.parse({
      kind: "source",
      ...input,
      createdAtMs: Date.now(),
      phase: "pre-spawn",
    });
    const operation = (): ForkCleanupFile => {
      const existing = this.state.entries.find(
        (entry) => entry.sourceSessionFile === parsed.sourceSessionFile,
      );
      if (existing !== undefined) {
        if (
          existing.kind === "source" &&
          existing.transactionId === parsed.transactionId
        ) {
          return this.state;
        }
        throw new Error("Source session already has a fork reservation.");
      }
      return { ...this.state, entries: [...this.state.entries, parsed] };
    };
    try {
      await this.transact(operation);
    } catch {
      try {
        await this.transact(operation);
      } catch (retryError) {
        this.ephemeralEntries.set(entryKey(parsed), parsed);
        throw retryError;
      }
    }
  }

  /**
   * The worker is now known, but its target is not. This is deliberately a
   * separate durable phase so restart diagnostics can identify the process
   * which owned an otherwise source-only reservation.
   */
  async recordSpawnedSource(input: {
    sourceSessionFile: string;
    transactionId: string;
    childRuntimeId: string;
    childPid?: number;
  }): Promise<void> {
    await this.loadIfNeeded();
    const operation = (): ForkCleanupFile => ({
      ...this.state,
      entries: this.state.entries.map((entry) => {
        if (
          entry.kind !== "source" ||
          entry.sourceSessionFile !== input.sourceSessionFile ||
          entry.transactionId !== input.transactionId
        ) {
          return entry;
        }
        return sourceReservationEntrySchema.parse({
          ...entry,
          phase: "spawned",
          childRuntimeId: input.childRuntimeId,
          ...(input.childPid !== undefined ? { childPid: input.childPid } : {}),
        });
      }),
    });
    const entry = this.findSource(input.sourceSessionFile, input.transactionId);
    if (entry === undefined) {
      throw new Error(
        "Fork source reservation was lost before child identity.",
      );
    }
    await this.transact(operation);
  }

  /** Atomically replace source-only ownership with source+target cleanup. */
  async promoteSourceToTarget(
    input: ForkTargetEntryInput & { transactionId: string },
  ): Promise<void> {
    await this.loadIfNeeded();
    const source = this.findSource(
      input.sourceSessionFile,
      input.transactionId,
    );
    if (source === undefined) {
      throw new Error(
        "Fork source reservation was lost before target discovery.",
      );
    }
    if (source.phase !== "spawned") {
      throw new Error("Fork target cannot be recorded before child identity.");
    }
    const target = targetReservationEntrySchema.parse({
      kind: "target",
      ...input,
      createdAtMs: input.createdAtMs ?? source.createdAtMs,
      childRuntimeId: source.childRuntimeId,
      ...(source.childPid !== undefined ? { childPid: source.childPid } : {}),
    });
    await this.transact(() => {
      const existingTarget = this.state.entries.find(
        (entry) =>
          entry.kind === "target" && entry.sessionFile === target.sessionFile,
      );
      if (existingTarget !== undefined) {
        if (existingTarget.transactionId === target.transactionId) {
          return this.state;
        }
        throw new Error("Fork target already has a cleanup reservation.");
      }
      let replaced = false;
      const entries = this.state.entries.map((entry) => {
        if (
          entry.kind === "source" &&
          entry.sourceSessionFile === target.sourceSessionFile &&
          entry.transactionId === target.transactionId
        ) {
          replaced = true;
          return target;
        }
        return entry;
      });
      if (!replaced) {
        throw new Error(
          "Fork source reservation was lost before target promotion.",
        );
      }
      return { ...this.state, entries };
    });
    this.ephemeralEntries.delete(entryKey(source));
  }

  /**
   * Safe only while this process has not attempted worker creation. A crashed
   * pre-spawn record intentionally has no caller for this method.
   */
  async releaseUnspawnedSource(
    sourceSessionFile: string,
    transactionId: string,
  ): Promise<void> {
    await this.loadIfNeeded();
    const source = this.findSource(sourceSessionFile, transactionId);
    if (source === undefined) return;
    if (source.phase !== "pre-spawn") {
      throw new Error("Fork source reservation has already started a child.");
    }
    await this.transact(() => ({
      ...this.state,
      entries: this.state.entries.filter(
        (entry) =>
          !(
            entry.kind === "source" &&
            entry.sourceSessionFile === sourceSessionFile &&
            entry.transactionId === transactionId
          ),
      ),
    }));
    this.ephemeralEntries.delete(entryKey(source));
  }

  /** Backward-compatible target reservation used by legacy compensation tests. */
  async reserve(
    entry: Omit<ForkTargetEntryInput, "transactionId" | "createdAtMs">,
  ): Promise<void> {
    await this.loadIfNeeded();
    if (this.corrupt) {
      throw new Error("Failed fork cleanup journal requires repair.");
    }
    const parsed = targetReservationEntrySchema.parse({
      kind: "target",
      ...entry,
      transactionId: randomUUID(),
      createdAtMs: Date.now(),
    });
    const operation = (): ForkCleanupFile => {
      if (
        this.state.entries.some(
          (item) =>
            item.kind === "target" && item.sessionFile === parsed.sessionFile,
        )
      ) {
        return this.state;
      }
      return { ...this.state, entries: [...this.state.entries, parsed] };
    };
    try {
      await this.transact(operation);
    } catch {
      try {
        await this.transact(operation);
      } catch (retryError) {
        this.ephemeralEntries.set(entryKey(parsed), parsed);
        throw retryError;
      }
    }
  }

  async complete(sessionFile: string): Promise<void> {
    await this.loadIfNeeded();
    await this.transact(() => ({
      ...this.state,
      entries: this.state.entries.filter(
        (entry) =>
          !(entry.kind === "target" && entry.sessionFile === sessionFile),
      ),
    }));
    this.ephemeralEntries.delete(`target:${sessionFile}`);
  }

  async blocks(sessionFile: string): Promise<boolean> {
    await this.loadIfNeeded();
    return (
      this.corrupt ||
      [...this.ephemeralEntries.values()].some(
        (entry) =>
          (entry.kind === "target" && entry.sessionFile === sessionFile) ||
          entry.sourceSessionFile === sessionFile,
      ) ||
      this.state.entries.some(
        (entry) =>
          (entry.kind === "target" && entry.sessionFile === sessionFile) ||
          entry.sourceSessionFile === sessionFile,
      )
    );
  }

  /**
   * A known spawned child has emitted worker_exit without naming a target. Its
   * source-only record can now be released. Unknown pre-spawn/spawn records
   * are intentionally left durable after restart; only the owning process may
   * use its observed worker_exit as an explicit exit proof.
   */
  async completeSourceAfterConfirmedExit(input: {
    sourceSessionFile: string;
    transactionId: string;
    childRuntimeId: string;
    // Only the owning process can supply this proof for a source record whose
    // child metadata failed to persist. Restart recovery must omit it.
    confirmedByOwningProcess?: boolean;
  }): Promise<boolean> {
    await this.loadIfNeeded();
    const source = this.findSource(
      input.sourceSessionFile,
      input.transactionId,
    );
    if (
      source === undefined ||
      (source.phase === "spawned" &&
        source.childRuntimeId !== input.childRuntimeId) ||
      (source.phase === "pre-spawn" && input.confirmedByOwningProcess !== true)
    ) {
      return false;
    }
    await this.transact(() => ({
      ...this.state,
      entries: this.state.entries.filter(
        (entry) =>
          !(
            entry.kind === "source" &&
            entry.sourceSessionFile === input.sourceSessionFile &&
            entry.transactionId === input.transactionId
          ),
      ),
    }));
    this.ephemeralEntries.delete(entryKey(source));
    return true;
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
    const entry = this.findTarget(sessionFile);
    if (entry === undefined) return;
    try {
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

  private findSource(
    sourceSessionFile: string,
    transactionId: string,
  ): SourceReservationEntry | undefined {
    const ephemeral = this.ephemeralEntries.get(`source:${sourceSessionFile}`);
    if (
      ephemeral?.kind === "source" &&
      ephemeral.transactionId === transactionId
    ) {
      return ephemeral;
    }
    const entry = this.state.entries.find(
      (item): item is SourceReservationEntry =>
        item.kind === "source" &&
        item.sourceSessionFile === sourceSessionFile &&
        item.transactionId === transactionId,
    );
    return entry;
  }

  private findTarget(sessionFile: string): TargetReservationEntry | undefined {
    const ephemeral = this.ephemeralEntries.get(`target:${sessionFile}`);
    if (ephemeral?.kind === "target") return ephemeral;
    return this.state.entries.find(
      (item): item is TargetReservationEntry =>
        item.kind === "target" && item.sessionFile === sessionFile,
    );
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
