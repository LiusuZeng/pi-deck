import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  ChatRuntimeUsage,
  WorkspaceUsageTotals,
} from "../../shared/types.js";
import type { PiMessage } from "../pi/types.js";

export type UsageContributionSource = "session" | "parallel" | "workflow";

export interface UsageContribution {
  id: string;
  workspaceId: string;
  ownerSessionFile?: string;
  source: UsageContributionSource;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd?: number;
  recordedAtMs: number;
}

export interface UsageSnapshot {
  id: string;
  workspaceId: string;
  ownerSessionFile?: string;
  source: UsageContributionSource;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd?: number;
  contributorsWithCost: number;
  contributorsWithoutCost: number;
  recordedAtMs: number;
  sessionFileSize?: number;
  sessionFileMtimeMs?: number;
  forkParentSession?: string;
  inheritedInputTokens?: number;
  inheritedOutputTokens?: number;
  inheritedCacheReadTokens?: number;
  inheritedCacheWriteTokens?: number;
  inheritedTotalTokens?: number;
  inheritedCostUsd?: number;
  inheritedContributorsWithCost?: number;
  inheritedContributorsWithoutCost?: number;
  inheritedUsageEntryCount?: number;
  inheritedMessageUsageEntryCount?: number;
  inheritedUsageFingerprint?: string;
}

export const emptyUsageTotals = (): WorkspaceUsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  knownCostUsd: 0,
  contributorsWithCost: 0,
  contributorsWithoutCost: 0,
});

export function addUsageContribution(
  totals: WorkspaceUsageTotals,
  contribution: Pick<
    UsageContribution,
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "totalTokens"
    | "totalCostUsd"
  >,
): WorkspaceUsageTotals {
  return {
    inputTokens: totals.inputTokens + contribution.inputTokens,
    outputTokens: totals.outputTokens + contribution.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + contribution.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens + contribution.cacheWriteTokens,
    totalTokens: totals.totalTokens + contribution.totalTokens,
    knownCostUsd: totals.knownCostUsd + (contribution.totalCostUsd ?? 0),
    contributorsWithCost:
      totals.contributorsWithCost +
      (contribution.totalCostUsd === undefined ? 0 : 1),
    contributorsWithoutCost:
      totals.contributorsWithoutCost +
      (contribution.totalCostUsd === undefined ? 1 : 0),
  };
}

export function summarizeUsageContributions(
  contributions: readonly UsageContribution[],
): WorkspaceUsageTotals {
  return contributions.reduce(addUsageContribution, emptyUsageTotals());
}

const usageContributionSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    ownerSessionFile: z.string().min(1).optional(),
    source: z.enum(["session", "parallel", "workflow"]),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    totalCostUsd: z.number().nonnegative().optional(),
    recordedAtMs: z.number().nonnegative(),
  })
  .strict();

const usageSnapshotSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    ownerSessionFile: z.string().min(1).optional(),
    source: z.enum(["session", "parallel", "workflow"]),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    totalCostUsd: z.number().nonnegative().optional(),
    contributorsWithCost: z.number().int().nonnegative(),
    contributorsWithoutCost: z.number().int().nonnegative(),
    recordedAtMs: z.number().nonnegative(),
    sessionFileSize: z.number().nonnegative().optional(),
    sessionFileMtimeMs: z.number().nonnegative().optional(),
    forkParentSession: z.string().min(1).optional(),
    inheritedInputTokens: z.number().nonnegative().optional(),
    inheritedOutputTokens: z.number().nonnegative().optional(),
    inheritedCacheReadTokens: z.number().nonnegative().optional(),
    inheritedCacheWriteTokens: z.number().nonnegative().optional(),
    inheritedTotalTokens: z.number().nonnegative().optional(),
    inheritedCostUsd: z.number().nonnegative().optional(),
    inheritedContributorsWithCost: z.number().int().nonnegative().optional(),
    inheritedContributorsWithoutCost: z.number().int().nonnegative().optional(),
    inheritedUsageEntryCount: z.number().int().nonnegative().optional(),
    inheritedMessageUsageEntryCount: z.number().int().nonnegative().optional(),
    inheritedUsageFingerprint: z.string().min(1).optional(),
  })
  .strict();

const legacyUsageStoreSchema = z
  .object({
    version: z.literal(1),
    contributions: z.array(usageContributionSchema),
  })
  .strict();

const usageStoreSchema = z
  .object({
    version: z.literal(2),
    snapshots: z.array(usageSnapshotSchema),
  })
  .strict();

interface UsageStoreState {
  version: 2;
  snapshots: UsageSnapshot[];
}

const emptyStore = (): UsageStoreState => ({ version: 2, snapshots: [] });

export class WorkspaceUsageStore {
  readonly storeFile: string;
  private state: UsageStoreState = emptyStore();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private persistTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private persistedGeneration = 0;
  private readonly sessionRefreshInFlight = new Map<
    string,
    Promise<{ diagnostics: string[]; refreshed: boolean }>
  >();

  constructor(private readonly piDeckHome: string) {
    this.storeFile = path.join(piDeckHome, "workspace-usage.json");
  }

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  /**
   * Compatibility entry point for callers/tests that still produce discrete
   * contributions. Production live accounting uses compact session snapshots.
   */
  async upsertContribution(contribution: UsageContribution): Promise<void> {
    await this.upsertSnapshot(snapshotFromContribution(contribution));
  }

  async upsertContributions(
    contributions: readonly UsageContribution[],
  ): Promise<void> {
    for (const contribution of contributions) {
      await this.upsertContribution(contribution);
    }
  }

  async recordSessionMessagesUsage(options: {
    workspaceId: string;
    sessionFile?: string;
    sessionKey: string;
    source: UsageContributionSource;
    messages: readonly PiMessage[];
    recordedAtMs?: number;
  }): Promise<void> {
    const ownerSessionFile =
      options.sessionFile === undefined
        ? undefined
        : await canonicalOrResolved(options.sessionFile);
    const id =
      options.source === "session" && ownerSessionFile !== undefined
        ? sessionSnapshotId(ownerSessionFile)
        : `${options.source}:${options.sessionKey}`;
    await this.loadIfNeeded();
    const existing = this.state.snapshots.find(
      (snapshot) => snapshot.id === id,
    );
    // Re-read the copied raw prefix for live projections. Pi compaction can
    // remove arbitrary inherited messages from get_messages(), so a persisted
    // count cannot safely be used to slice the projected list positionally.
    const resolvedForkBaseline =
      options.source === "session" && ownerSessionFile !== undefined
        ? await resolveForkBaselineForMessageEntries(ownerSessionFile)
        : undefined;
    const existingForkBaseline = hasDurableForkBaseline(existing)
      ? inheritedTotalsFromSnapshot(existing)
      : undefined;
    const snapshot = await usageSnapshotFromMessages({
      id,
      workspaceId: options.workspaceId,
      ...(ownerSessionFile !== undefined ? { ownerSessionFile } : {}),
      source: options.source,
      messages: options.messages,
      ...(options.recordedAtMs !== undefined
        ? { recordedAtMs: options.recordedAtMs }
        : {}),
      ...(resolvedForkBaseline !== undefined
        ? { inheritedBaseline: resolvedForkBaseline }
        : existingForkBaseline !== undefined
          ? { inheritedBaseline: existingForkBaseline }
          : {}),
    });
    if (snapshot === undefined) return;

    if (options.source === "session" && ownerSessionFile !== undefined) {
      const signature = await sessionFileSignature(ownerSessionFile);
      if (signature !== undefined) {
        snapshot.sessionFileSize = signature.size;
        snapshot.sessionFileMtimeMs = signature.mtimeMs;
      }
    }
    await this.upsertSnapshot(snapshot);
  }

  /**
   * Replace one cumulative normal-session snapshot from Pi's compact
   * get_session_stats payload. Execution-count metadata is retained until an
   * agent-end transcript/message reconciliation can make it exact.
   */
  async recordRuntimeUsage(options: {
    workspaceId: string;
    sessionFile: string;
    usage: ChatRuntimeUsage;
    recordedAtMs?: number;
  }): Promise<void> {
    const ownerSessionFile = await canonicalOrResolved(options.sessionFile);
    await this.loadIfNeeded();
    const id = sessionSnapshotId(ownerSessionFile);
    const existing = this.state.snapshots.find(
      (snapshot) => snapshot.id === id,
    );
    const forkBaseline = hasDurableForkBaseline(existing)
      ? inheritedTotalsFromSnapshot(existing)
      : await resolveForkBaselineForSessionFile(ownerSessionFile);
    const adjustedUsage = subtractInheritedRuntimeUsage(
      options.usage,
      forkBaseline,
    );
    const hasReportedUsage =
      adjustedUsage.totalTokens > 0 || adjustedUsage.totalCostUsd !== undefined;
    const inheritedOnlyRuntime =
      forkBaseline !== undefined &&
      adjustedUsage.totalTokens === 0 &&
      adjustedUsage.totalCostUsd === undefined;
    const existingHasReportedUsage =
      existing !== undefined &&
      (existing.totalTokens > 0 ||
        existing.totalCostUsd !== undefined ||
        existing.contributorsWithCost > 0 ||
        existing.contributorsWithoutCost > 0);
    const deriveRuntimeContributors =
      inheritedOnlyRuntime ||
      existing === undefined ||
      (forkBaseline !== undefined && !existingHasReportedUsage);
    const contributorsWithCost = deriveRuntimeContributors
      ? hasReportedUsage && adjustedUsage.totalCostUsd !== undefined
        ? 1
        : 0
      : existing.contributorsWithCost;
    const contributorsWithoutCost = deriveRuntimeContributors
      ? hasReportedUsage && adjustedUsage.totalCostUsd === undefined
        ? 1
        : 0
      : existing.contributorsWithoutCost;
    const totalCostUsd =
      adjustedUsage.totalCostUsd ??
      (inheritedOnlyRuntime ? undefined : existing?.totalCostUsd);
    await this.upsertSnapshot({
      id,
      workspaceId: options.workspaceId,
      ownerSessionFile,
      source: "session",
      inputTokens: adjustedUsage.inputTokens,
      outputTokens: adjustedUsage.outputTokens,
      cacheReadTokens: adjustedUsage.cacheReadTokens,
      cacheWriteTokens: adjustedUsage.cacheWriteTokens,
      totalTokens: adjustedUsage.totalTokens,
      ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      contributorsWithCost,
      contributorsWithoutCost,
      recordedAtMs: options.recordedAtMs ?? Date.now(),
      ...(existing?.sessionFileSize !== undefined
        ? { sessionFileSize: existing.sessionFileSize }
        : {}),
      ...(existing?.sessionFileMtimeMs !== undefined
        ? { sessionFileMtimeMs: existing.sessionFileMtimeMs }
        : {}),
      ...forkBaselineSnapshotFields(forkBaseline),
    });
  }

  async refreshSessionFileUsage(options: {
    workspaceId: string;
    sessionFile: string;
    source?: UsageContributionSource;
  }): Promise<{ diagnostics: string[]; refreshed: boolean }> {
    const canonicalSessionFile = await canonicalOrResolved(options.sessionFile);
    const source = options.source ?? "session";
    const refreshKey = `${source}:${canonicalSessionFile}`;
    const existingRefresh = this.sessionRefreshInFlight.get(refreshKey);
    if (existingRefresh !== undefined) {
      return existingRefresh;
    }

    const refresh = (async () => {
      await this.loadIfNeeded();
      const signature = await sessionFileSignature(canonicalSessionFile);
      if (signature === undefined) {
        return {
          diagnostics: [
            `Could not stat session usage ${options.sessionFile}: file is missing or unreadable`,
          ],
          refreshed: false,
        };
      }

      const id =
        source === "session"
          ? sessionSnapshotId(canonicalSessionFile)
          : `${source}:recovery:${canonicalSessionFile}`;
      const existing = this.state.snapshots.find(
        (snapshot) => snapshot.id === id,
      );
      if (
        existing?.sessionFileSize === signature.size &&
        existing.sessionFileMtimeMs === signature.mtimeMs
      ) {
        const forkParentSession =
          source === "session"
            ? await sessionFileParentSession(canonicalSessionFile)
            : undefined;
        const needsForkRepair =
          forkParentSession !== undefined &&
          (existing.forkParentSession === undefined ||
            existing.inheritedUsageEntryCount === undefined ||
            existing.inheritedMessageUsageEntryCount === undefined ||
            existing.inheritedUsageFingerprint === undefined);
        if (!needsForkRepair) {
          return { diagnostics: [], refreshed: false };
        }
      }

      const existingForkBaseline = hasDurableForkBaseline(existing)
        ? inheritedTotalsFromSnapshot(existing)
        : undefined;
      const result = await usageSnapshotFromSessionFile({
        id,
        workspaceId: options.workspaceId,
        sessionFile: canonicalSessionFile,
        source,
        recordedAtMs: Date.now(),
        signature,
        ...(existingForkBaseline !== undefined
          ? { inheritedBaseline: existingForkBaseline }
          : {}),
      });
      if (result.snapshot !== undefined && result.diagnostics.length === 0) {
        await this.upsertSnapshot(result.snapshot);
      }
      return {
        diagnostics: result.diagnostics,
        refreshed:
          result.snapshot !== undefined && result.diagnostics.length === 0,
      };
    })();

    this.sessionRefreshInFlight.set(refreshKey, refresh);
    try {
      return await refresh;
    } finally {
      if (this.sessionRefreshInFlight.get(refreshKey) === refresh) {
        this.sessionRefreshInFlight.delete(refreshKey);
      }
    }
  }

  async freezeSessionUsage(options: {
    workspaceId: string;
    sessionFile: string;
  }): Promise<void> {
    await this.loadIfNeeded();
    const sessionFile = await canonicalOrResolved(options.sessionFile);
    const owned = this.state.snapshots.filter(
      (snapshot) => snapshot.ownerSessionFile === sessionFile,
    );
    if (owned.length === 0) return;

    const frozen = owned.map(
      (snapshot): UsageSnapshot => ({
        id: `deleted:${snapshot.id}`,
        workspaceId: options.workspaceId,
        source: snapshot.source,
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
        cacheReadTokens: snapshot.cacheReadTokens,
        cacheWriteTokens: snapshot.cacheWriteTokens,
        totalTokens: snapshot.totalTokens,
        ...(snapshot.totalCostUsd !== undefined
          ? { totalCostUsd: snapshot.totalCostUsd }
          : {}),
        contributorsWithCost: snapshot.contributorsWithCost,
        contributorsWithoutCost: snapshot.contributorsWithoutCost,
        recordedAtMs: Date.now(),
      }),
    );

    const snapshots = this.state.snapshots.filter(
      (snapshot) => snapshot.ownerSessionFile !== sessionFile,
    );
    const byId = new Map(
      snapshots.map((snapshot, index) => [snapshot.id, index]),
    );
    for (const snapshot of frozen) {
      const index = byId.get(snapshot.id);
      if (index === undefined) {
        byId.set(snapshot.id, snapshots.length);
        snapshots.push(snapshot);
      } else {
        snapshots[index] = snapshot;
      }
    }
    await this.commit({ version: 2, snapshots });
  }

  async getWorkspaceUsage(options: {
    workspaceId: string;
    sessionFiles: readonly string[];
  }): Promise<WorkspaceUsageTotals> {
    await this.loadIfNeeded();
    // Workspace refs are already canonicalized by WorkspaceStore. Avoid
    // realpath/stat here so this read path performs no session-file I/O.
    const sessionFiles = new Set(
      options.sessionFiles.map((file) => path.resolve(file)),
    );
    let totals = emptyUsageTotals();
    for (const snapshot of this.state.snapshots) {
      const included =
        snapshot.ownerSessionFile !== undefined
          ? sessionFiles.has(path.resolve(snapshot.ownerSessionFile))
          : snapshot.workspaceId === options.workspaceId;
      if (included) {
        totals = addUsageSnapshot(totals, snapshot);
      }
    }
    return totals;
  }

  private async upsertSnapshot(snapshot: UsageSnapshot): Promise<void> {
    const parsed = await canonicalSnapshot(snapshot);
    await this.loadIfNeeded();
    const index = this.state.snapshots.findIndex(
      (item) => item.id === parsed.id,
    );
    if (index >= 0 && sameSnapshot(this.state.snapshots[index]!, parsed)) {
      await this.persistIfDirty();
      return;
    }
    const snapshots = [...this.state.snapshots];
    if (index >= 0) snapshots[index] = parsed;
    else snapshots.push(parsed);
    await this.commit({ version: 2, snapshots });
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    try {
      const raw: unknown = JSON.parse(
        await fs.readFile(this.storeFile, "utf8"),
      );
      const current = usageStoreSchema.safeParse(raw);
      if (current.success) {
        this.state = {
          version: 2,
          snapshots: current.data.snapshots.map(toUsageSnapshot),
        };
      } else {
        const legacy = legacyUsageStoreSchema.parse(raw);
        this.state = {
          version: 2,
          snapshots: migrateLegacyContributions(legacy.contributions),
        };
        this.generation += 1;
        await this.persist();
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        await fs
          .rename(this.storeFile, `${this.storeFile}.corrupt-${Date.now()}`)
          .catch(() => undefined);
      }
      this.state = emptyStore();
      this.generation += 1;
      await this.persist();
    }
    this.loaded = true;
  }

  private async commit(next: UsageStoreState): Promise<void> {
    const parsed = usageStoreSchema.parse(next);
    this.state = {
      version: 2,
      snapshots: parsed.snapshots.map(toUsageSnapshot),
    };
    this.generation += 1;
    await this.persist();
  }

  private async persistIfDirty(): Promise<void> {
    if (this.persistedGeneration < this.generation) await this.persist();
  }

  private async persist(): Promise<void> {
    this.persistTail = this.persistTail
      .catch(() => undefined)
      .then(async () => {
        const generation = this.generation;
        await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
        const temp = `${this.storeFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await fs.writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, {
          mode: 0o600,
        });
        await fs.rename(temp, this.storeFile);
        this.persistedGeneration = Math.max(
          this.persistedGeneration,
          generation,
        );
      });
    return this.persistTail;
  }
}

function addUsageSnapshot(
  totals: WorkspaceUsageTotals,
  snapshot: UsageSnapshot,
): WorkspaceUsageTotals {
  return {
    inputTokens: totals.inputTokens + snapshot.inputTokens,
    outputTokens: totals.outputTokens + snapshot.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + snapshot.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens + snapshot.cacheWriteTokens,
    totalTokens: totals.totalTokens + snapshot.totalTokens,
    knownCostUsd: totals.knownCostUsd + (snapshot.totalCostUsd ?? 0),
    contributorsWithCost:
      totals.contributorsWithCost + snapshot.contributorsWithCost,
    contributorsWithoutCost:
      totals.contributorsWithoutCost + snapshot.contributorsWithoutCost,
  };
}

function sessionSnapshotId(sessionFile: string): string {
  return `session:${path.resolve(sessionFile)}`;
}

function snapshotFromContribution(
  contribution: UsageContribution,
): UsageSnapshot {
  return {
    id: `legacy-input:${contribution.id}`,
    workspaceId: contribution.workspaceId,
    ...(contribution.ownerSessionFile !== undefined
      ? { ownerSessionFile: contribution.ownerSessionFile }
      : {}),
    source: contribution.source,
    inputTokens: contribution.inputTokens,
    outputTokens: contribution.outputTokens,
    cacheReadTokens: contribution.cacheReadTokens,
    cacheWriteTokens: contribution.cacheWriteTokens,
    totalTokens: contribution.totalTokens,
    ...(contribution.totalCostUsd !== undefined
      ? { totalCostUsd: contribution.totalCostUsd }
      : {}),
    contributorsWithCost: contribution.totalCostUsd === undefined ? 0 : 1,
    contributorsWithoutCost: contribution.totalCostUsd === undefined ? 1 : 0,
    recordedAtMs: contribution.recordedAtMs,
  };
}

async function usageSnapshotFromMessages(options: {
  id: string;
  workspaceId: string;
  ownerSessionFile?: string;
  source: UsageContributionSource;
  messages: readonly PiMessage[];
  recordedAtMs?: number;
  inheritedBaseline?: ForkBaseline;
}): Promise<UsageSnapshot | undefined> {
  const entries: UsageEntry[] = [];
  for (const message of options.messages) {
    const entry = usageEntryFromMessage(message, entries.length);
    if (entry !== undefined) entries.push(entry);
  }
  const inherited =
    options.inheritedBaseline ??
    (options.source === "session" && options.ownerSessionFile !== undefined
      ? await resolveForkBaselineForMessageEntries(options.ownerSessionFile)
      : undefined);
  const adjustedEntries =
    inherited === undefined
      ? entries
      : entriesWithoutInheritedMessageUsage(entries, inherited);
  if (adjustedEntries.length === 0 && inherited === undefined) return undefined;
  return snapshotFromUsageEntries({
    id: options.id,
    workspaceId: options.workspaceId,
    ...(options.ownerSessionFile !== undefined
      ? { ownerSessionFile: options.ownerSessionFile }
      : {}),
    source: options.source,
    entries: adjustedEntries,
    recordedAtMs: options.recordedAtMs ?? Date.now(),
    ...(inherited !== undefined ? { inherited } : {}),
  });
}

async function usageSnapshotFromSessionFile(options: {
  id: string;
  workspaceId: string;
  sessionFile: string;
  source: UsageContributionSource;
  recordedAtMs: number;
  signature: { size: number; mtimeMs: number };
  inheritedBaseline?: ForkBaseline;
}): Promise<{ snapshot?: UsageSnapshot; diagnostics: string[] }> {
  const scanned = await scanSessionFileUsageDetails(options.sessionFile);
  if (scanned.diagnostics.length > 0) {
    return { diagnostics: scanned.diagnostics };
  }
  const inherited =
    options.inheritedBaseline ??
    (options.source === "session"
      ? await resolveForkBaselineForScannedEntries(scanned)
      : undefined);
  const entries = inherited
    ? scanned.entries.slice(forkBaselineEntryCount(inherited))
    : scanned.entries;
  return {
    snapshot: snapshotFromUsageEntries({
      id: options.id,
      workspaceId: options.workspaceId,
      ownerSessionFile: scanned.canonicalSessionFile,
      source: options.source,
      entries,
      recordedAtMs: options.recordedAtMs,
      sessionFileSize: options.signature.size,
      sessionFileMtimeMs: options.signature.mtimeMs,
      ...(inherited !== undefined ? { inherited } : {}),
    }),
    diagnostics: [],
  };
}

interface UsageEntry {
  usage: ExtractedUsage;
  signature: string;
  projectedSignature: string;
  entryType: string;
  messageId?: string;
  lineNumber?: number;
  timestampMs?: number;
}

interface ForkBaseline {
  parentSession: string;
  entries: UsageEntry[];
  totals: WorkspaceUsageTotals;
  entryCount?: number;
  messageEntryCount?: number;
  fingerprint?: string;
}

interface ScannedSessionUsage {
  canonicalSessionFile: string;
  parentSession?: string;
  forkStartedAtMs?: number;
  entries: UsageEntry[];
  diagnostics: string[];
}

function snapshotFromUsageEntries(options: {
  id: string;
  workspaceId: string;
  ownerSessionFile?: string;
  source: UsageContributionSource;
  entries: readonly UsageEntry[];
  recordedAtMs: number;
  sessionFileSize?: number;
  sessionFileMtimeMs?: number;
  inherited?: ForkBaseline;
}): UsageSnapshot {
  const totals = summarizeUsageEntries(options.entries);
  return {
    id: options.id,
    workspaceId: options.workspaceId,
    ...(options.ownerSessionFile !== undefined
      ? { ownerSessionFile: options.ownerSessionFile }
      : {}),
    source: options.source,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    totalTokens: totals.totalTokens,
    ...(totals.contributorsWithCost > 0
      ? { totalCostUsd: totals.knownCostUsd }
      : {}),
    contributorsWithCost: totals.contributorsWithCost,
    contributorsWithoutCost: totals.contributorsWithoutCost,
    recordedAtMs: options.recordedAtMs,
    ...(options.sessionFileSize !== undefined
      ? { sessionFileSize: options.sessionFileSize }
      : {}),
    ...(options.sessionFileMtimeMs !== undefined
      ? { sessionFileMtimeMs: options.sessionFileMtimeMs }
      : {}),
    ...forkBaselineSnapshotFields(options.inherited),
  };
}

function summarizeUsageEntries(
  entries: readonly UsageEntry[],
): WorkspaceUsageTotals {
  return entries.reduce(
    (totals, entry) => addUsageContribution(totals, entry.usage),
    emptyUsageTotals(),
  );
}

async function resolveForkBaselineForMessageEntries(
  sessionFile: string,
): Promise<ForkBaseline | undefined> {
  const scanned = await scanSessionFileUsageDetails(sessionFile);
  if (scanned.diagnostics.length > 0 || scanned.parentSession === undefined) {
    return undefined;
  }
  // The transcript includes Pi's non-message usage entries, which are omitted
  // from get_messages but included in cumulative runtime stats. Persist the
  // complete copied prefix; messageEntryCount keeps live message slicing aligned.
  return resolveForkBaseline(
    scanned.parentSession,
    scanned.entries,
    scanned.forkStartedAtMs,
  );
}

async function resolveForkBaselineForSessionFile(
  sessionFile: string,
): Promise<ForkBaseline | undefined> {
  const scanned = await scanSessionFileUsageDetails(sessionFile);
  if (scanned.diagnostics.length > 0) return undefined;
  return resolveForkBaselineForScannedEntries(scanned);
}

async function resolveForkBaselineForScannedEntries(
  scanned: ScannedSessionUsage,
): Promise<ForkBaseline | undefined> {
  if (scanned.parentSession === undefined) return undefined;
  return resolveForkBaseline(
    scanned.parentSession,
    scanned.entries,
    scanned.forkStartedAtMs,
  );
}

async function resolveForkBaseline(
  parentSession: string,
  childEntries: readonly UsageEntry[],
  forkStartedAtMs: number | undefined,
): Promise<ForkBaseline | undefined> {
  const canonicalParentSession = await canonicalOrResolved(parentSession);
  if (forkStartedAtMs === undefined) return undefined;

  const parent = await scanSessionFileUsageDetails(canonicalParentSession);
  // If the ancestor transcript was frozen/deleted before durable fork metadata
  // was repaired, recover the copied prefix from the child's own fork point
  // instead of subtracting the parent's current cumulative total.
  const inheritedCount =
    parent.diagnostics.length === 0
      ? commonUsagePrefixLength(parent.entries, childEntries, forkStartedAtMs)
      : forkPointInheritedPrefixLength(childEntries, forkStartedAtMs);
  const entries = childEntries.slice(0, inheritedCount);
  return {
    parentSession: canonicalParentSession,
    entries,
    totals: summarizeUsageEntries(entries),
    entryCount: entries.length,
    messageEntryCount: entries.filter((entry) => entry.entryType === "message")
      .length,
    fingerprint: usageEntriesFingerprint(entries),
  };
}

function forkPointInheritedPrefixLength(
  childEntries: readonly UsageEntry[],
  forkStartedAtMs: number,
): number {
  let count = 0;
  while (
    count < childEntries.length &&
    usageEntryCanBeInherited(childEntries[count]!, forkStartedAtMs)
  ) {
    count += 1;
  }
  return count;
}

function commonUsagePrefixLength(
  parentEntries: readonly UsageEntry[],
  childEntries: readonly UsageEntry[],
  forkStartedAtMs: number,
): number {
  const limit = Math.min(parentEntries.length, childEntries.length);
  let count = 0;
  while (
    count < limit &&
    usageEntryCanBeInherited(childEntries[count]!, forkStartedAtMs) &&
    usageEntryMatches(parentEntries[count]!, childEntries[count]!)
  ) {
    count += 1;
  }
  return count;
}

function usageEntryCanBeInherited(
  entry: UsageEntry,
  forkStartedAtMs: number,
): boolean {
  return (
    entry.timestampMs !== undefined && entry.timestampMs <= forkStartedAtMs
  );
}

function usageEntryMatches(left: UsageEntry, right: UsageEntry): boolean {
  if (
    left.messageId !== undefined &&
    right.messageId !== undefined &&
    left.messageId !== right.messageId
  ) {
    return false;
  }
  return left.signature === right.signature;
}

function entriesWithoutInheritedMessageUsage(
  entries: readonly UsageEntry[],
  baseline: ForkBaseline,
): UsageEntry[] {
  // get_messages() is a compaction-aware projection, unlike the raw JSONL
  // entries used to establish the fork point. Remove only provenance matches,
  // not a prefix count: a compacted projection may omit inherited turns before
  // a child-only turn.
  const unmatchedInherited = baseline.entries.filter(
    (entry) => entry.entryType === "message",
  );
  if (unmatchedInherited.length === 0) return [...entries];

  return entries.filter((entry) => {
    const inheritedIndex = unmatchedInherited.findIndex((candidate) =>
      usageEntryMatchesProjectedMessage(candidate, entry),
    );
    if (inheritedIndex < 0) return true;
    unmatchedInherited.splice(inheritedIndex, 1);
    return false;
  });
}

function usageEntryMatchesProjectedMessage(
  inherited: UsageEntry,
  projected: UsageEntry,
): boolean {
  if (inherited.entryType !== "message") return false;
  const sameMessageId =
    inherited.messageId !== undefined &&
    projected.messageId !== undefined &&
    inherited.messageId === projected.messageId;
  const sameTimestamp =
    inherited.timestampMs !== undefined &&
    projected.timestampMs !== undefined &&
    inherited.timestampMs === projected.timestampMs;
  // Do not de-duplicate merely identical text/usage. A copied record must
  // retain a stable Pi identity or timestamp in the projected transcript.
  if (!sameMessageId && !sameTimestamp) return false;
  return inherited.projectedSignature === projected.projectedSignature;
}

function forkBaselineSnapshotFields(
  baseline: ForkBaseline | undefined,
): Partial<UsageSnapshot> {
  if (baseline === undefined) return {};
  return {
    forkParentSession: baseline.parentSession,
    inheritedInputTokens: baseline.totals.inputTokens,
    inheritedOutputTokens: baseline.totals.outputTokens,
    inheritedCacheReadTokens: baseline.totals.cacheReadTokens,
    inheritedCacheWriteTokens: baseline.totals.cacheWriteTokens,
    inheritedTotalTokens: baseline.totals.totalTokens,
    ...(baseline.totals.contributorsWithCost > 0
      ? { inheritedCostUsd: baseline.totals.knownCostUsd }
      : {}),
    inheritedContributorsWithCost: baseline.totals.contributorsWithCost,
    inheritedContributorsWithoutCost: baseline.totals.contributorsWithoutCost,
    inheritedUsageEntryCount: forkBaselineEntryCount(baseline),
    inheritedMessageUsageEntryCount: forkBaselineMessageEntryCount(baseline),
    inheritedUsageFingerprint: forkBaselineFingerprint(baseline),
  };
}

function hasDurableForkBaseline(
  snapshot: UsageSnapshot | undefined,
): snapshot is UsageSnapshot {
  return (
    snapshot?.forkParentSession !== undefined &&
    snapshot.inheritedUsageEntryCount !== undefined &&
    snapshot.inheritedMessageUsageEntryCount !== undefined &&
    snapshot.inheritedUsageFingerprint !== undefined
  );
}

function inheritedTotalsFromSnapshot(
  snapshot: UsageSnapshot | undefined,
): ForkBaseline | undefined {
  if (snapshot?.forkParentSession === undefined) return undefined;
  return {
    parentSession: snapshot.forkParentSession,
    entries: [],
    totals: {
      inputTokens: snapshot.inheritedInputTokens ?? 0,
      outputTokens: snapshot.inheritedOutputTokens ?? 0,
      cacheReadTokens: snapshot.inheritedCacheReadTokens ?? 0,
      cacheWriteTokens: snapshot.inheritedCacheWriteTokens ?? 0,
      totalTokens: snapshot.inheritedTotalTokens ?? 0,
      knownCostUsd: snapshot.inheritedCostUsd ?? 0,
      contributorsWithCost: snapshot.inheritedContributorsWithCost ?? 0,
      contributorsWithoutCost: snapshot.inheritedContributorsWithoutCost ?? 0,
    },
    entryCount: snapshot.inheritedUsageEntryCount ?? 0,
    messageEntryCount: snapshot.inheritedMessageUsageEntryCount ?? 0,
    ...(snapshot.inheritedUsageFingerprint !== undefined
      ? { fingerprint: snapshot.inheritedUsageFingerprint }
      : {}),
  };
}

function forkBaselineEntryCount(baseline: ForkBaseline): number {
  return baseline.entryCount ?? baseline.entries.length;
}

function forkBaselineMessageEntryCount(baseline: ForkBaseline): number {
  return (
    baseline.messageEntryCount ??
    baseline.entries.filter((entry) => entry.entryType === "message").length
  );
}

function forkBaselineFingerprint(baseline: ForkBaseline): string {
  return baseline.fingerprint ?? usageEntriesFingerprint(baseline.entries);
}

function usageEntriesFingerprint(entries: readonly UsageEntry[]): string {
  return hashStable(
    JSON.stringify(
      entries.map((entry) => ({
        messageId: entry.messageId,
        signature: entry.signature,
      })),
    ),
  );
}

function subtractInheritedRuntimeUsage(
  usage: ChatRuntimeUsage,
  baseline: ForkBaseline | undefined,
): ChatRuntimeUsage {
  if (baseline === undefined) return usage;
  const totals = baseline.totals;
  const totalTokens = Math.max(0, usage.totalTokens - totals.totalTokens);
  const totalCostUsd =
    usage.totalCostUsd === undefined
      ? undefined
      : Math.max(
          0,
          usage.totalCostUsd -
            (totals.contributorsWithCost > 0 ? totals.knownCostUsd : 0),
        );
  const adjusted: ChatRuntimeUsage = {
    ...usage,
    inputTokens: Math.max(0, usage.inputTokens - totals.inputTokens),
    outputTokens: Math.max(0, usage.outputTokens - totals.outputTokens),
    cacheReadTokens: Math.max(
      0,
      usage.cacheReadTokens - totals.cacheReadTokens,
    ),
    cacheWriteTokens: Math.max(
      0,
      usage.cacheWriteTokens - totals.cacheWriteTokens,
    ),
    totalTokens,
  };
  // A runtime aggregate equal to a non-zero inherited cost cannot establish
  // whether a new turn was free or omitted cost. A directly reported zero,
  // however, is a known provider cost and must remain distinguishable from an
  // unavailable cost after baseline subtraction.
  if (
    totalCostUsd !== undefined &&
    (totalCostUsd > 0 || usage.totalCostUsd === 0)
  ) {
    adjusted.totalCostUsd = totalCostUsd;
  } else {
    delete adjusted.totalCostUsd;
  }
  return adjusted;
}

async function sessionFileSignature(
  sessionFile: string,
): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const stat = await fs.stat(sessionFile);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function migrateLegacyContributions(
  contributions: readonly z.infer<typeof usageContributionSchema>[],
): UsageSnapshot[] {
  const grouped = new Map<string, UsageSnapshot>();
  for (const parsed of contributions) {
    const contribution = toUsageContribution(parsed);
    const ownerSessionFile =
      contribution.ownerSessionFile === undefined
        ? undefined
        : path.resolve(contribution.ownerSessionFile);
    const id =
      ownerSessionFile !== undefined && contribution.source === "session"
        ? sessionSnapshotId(ownerSessionFile)
        : ownerSessionFile !== undefined
          ? `legacy:${contribution.source}:${ownerSessionFile}`
          : `legacy:${contribution.source}:${contribution.workspaceId}`;
    const current = grouped.get(id);
    const next = snapshotFromContribution({
      ...contribution,
      ...(ownerSessionFile !== undefined ? { ownerSessionFile } : {}),
    });
    if (current === undefined) {
      grouped.set(id, {
        ...next,
        id,
      });
      continue;
    }
    current.inputTokens += next.inputTokens;
    current.outputTokens += next.outputTokens;
    current.cacheReadTokens += next.cacheReadTokens;
    current.cacheWriteTokens += next.cacheWriteTokens;
    current.totalTokens += next.totalTokens;
    if (next.totalCostUsd !== undefined) {
      current.totalCostUsd = (current.totalCostUsd ?? 0) + next.totalCostUsd;
    }
    current.contributorsWithCost += next.contributorsWithCost;
    current.contributorsWithoutCost += next.contributorsWithoutCost;
    current.recordedAtMs = Math.max(current.recordedAtMs, next.recordedAtMs);
  }
  return [...grouped.values()];
}

async function canonicalSnapshot(
  snapshot: UsageSnapshot,
): Promise<UsageSnapshot> {
  const parsed = usageSnapshotSchema.parse({
    ...snapshot,
    ...(snapshot.ownerSessionFile !== undefined
      ? {
          ownerSessionFile: await canonicalOrResolved(
            snapshot.ownerSessionFile,
          ),
        }
      : {}),
    ...(snapshot.forkParentSession !== undefined
      ? {
          forkParentSession: await canonicalOrResolved(
            snapshot.forkParentSession,
          ),
        }
      : {}),
  });
  return toUsageSnapshot(parsed);
}

function toUsageSnapshot(
  parsed: z.infer<typeof usageSnapshotSchema>,
): UsageSnapshot {
  return {
    id: parsed.id,
    workspaceId: parsed.workspaceId,
    ...(parsed.ownerSessionFile !== undefined
      ? { ownerSessionFile: parsed.ownerSessionFile }
      : {}),
    source: parsed.source,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheWriteTokens: parsed.cacheWriteTokens,
    totalTokens: parsed.totalTokens,
    ...(parsed.totalCostUsd !== undefined
      ? { totalCostUsd: parsed.totalCostUsd }
      : {}),
    contributorsWithCost: parsed.contributorsWithCost,
    contributorsWithoutCost: parsed.contributorsWithoutCost,
    recordedAtMs: parsed.recordedAtMs,
    ...(parsed.sessionFileSize !== undefined
      ? { sessionFileSize: parsed.sessionFileSize }
      : {}),
    ...(parsed.sessionFileMtimeMs !== undefined
      ? { sessionFileMtimeMs: parsed.sessionFileMtimeMs }
      : {}),
    ...(parsed.forkParentSession !== undefined
      ? { forkParentSession: parsed.forkParentSession }
      : {}),
    ...(parsed.inheritedInputTokens !== undefined
      ? { inheritedInputTokens: parsed.inheritedInputTokens }
      : {}),
    ...(parsed.inheritedOutputTokens !== undefined
      ? { inheritedOutputTokens: parsed.inheritedOutputTokens }
      : {}),
    ...(parsed.inheritedCacheReadTokens !== undefined
      ? { inheritedCacheReadTokens: parsed.inheritedCacheReadTokens }
      : {}),
    ...(parsed.inheritedCacheWriteTokens !== undefined
      ? { inheritedCacheWriteTokens: parsed.inheritedCacheWriteTokens }
      : {}),
    ...(parsed.inheritedTotalTokens !== undefined
      ? { inheritedTotalTokens: parsed.inheritedTotalTokens }
      : {}),
    ...(parsed.inheritedCostUsd !== undefined
      ? { inheritedCostUsd: parsed.inheritedCostUsd }
      : {}),
    ...(parsed.inheritedContributorsWithCost !== undefined
      ? { inheritedContributorsWithCost: parsed.inheritedContributorsWithCost }
      : {}),
    ...(parsed.inheritedContributorsWithoutCost !== undefined
      ? {
          inheritedContributorsWithoutCost:
            parsed.inheritedContributorsWithoutCost,
        }
      : {}),
    ...(parsed.inheritedUsageEntryCount !== undefined
      ? { inheritedUsageEntryCount: parsed.inheritedUsageEntryCount }
      : {}),
    ...(parsed.inheritedMessageUsageEntryCount !== undefined
      ? {
          inheritedMessageUsageEntryCount:
            parsed.inheritedMessageUsageEntryCount,
        }
      : {}),
    ...(parsed.inheritedUsageFingerprint !== undefined
      ? { inheritedUsageFingerprint: parsed.inheritedUsageFingerprint }
      : {}),
  };
}

function sameSnapshot(left: UsageSnapshot, right: UsageSnapshot): boolean {
  return (
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.ownerSessionFile === right.ownerSessionFile &&
    left.source === right.source &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.totalTokens === right.totalTokens &&
    left.totalCostUsd === right.totalCostUsd &&
    left.contributorsWithCost === right.contributorsWithCost &&
    left.contributorsWithoutCost === right.contributorsWithoutCost &&
    left.sessionFileSize === right.sessionFileSize &&
    left.sessionFileMtimeMs === right.sessionFileMtimeMs &&
    left.forkParentSession === right.forkParentSession &&
    left.inheritedInputTokens === right.inheritedInputTokens &&
    left.inheritedOutputTokens === right.inheritedOutputTokens &&
    left.inheritedCacheReadTokens === right.inheritedCacheReadTokens &&
    left.inheritedCacheWriteTokens === right.inheritedCacheWriteTokens &&
    left.inheritedTotalTokens === right.inheritedTotalTokens &&
    left.inheritedCostUsd === right.inheritedCostUsd &&
    left.inheritedContributorsWithCost ===
      right.inheritedContributorsWithCost &&
    left.inheritedContributorsWithoutCost ===
      right.inheritedContributorsWithoutCost &&
    left.inheritedUsageEntryCount === right.inheritedUsageEntryCount &&
    left.inheritedMessageUsageEntryCount ===
      right.inheritedMessageUsageEntryCount &&
    left.inheritedUsageFingerprint === right.inheritedUsageFingerprint
  );
}

export function contributionsFromSessionMessages(options: {
  workspaceId: string;
  sessionFile?: string;
  sessionId?: string;
  source?: UsageContributionSource;
  messages: readonly PiMessage[];
  recordedAtMs?: number;
}): UsageContribution[] {
  const ownerSessionFile =
    options.sessionFile === undefined
      ? undefined
      : path.resolve(options.sessionFile);
  const stableSession =
    options.sessionId ?? ownerSessionFile ?? options.workspaceId;
  return options.messages.flatMap((message, index) => {
    const usage = extractUsage(message);
    if (usage === undefined) return [];
    const messageId =
      typeof message.id === "string" && message.id.length > 0
        ? message.id
        : `message-${index}-${hashStable(JSON.stringify(message).slice(0, 4096))}`;
    return [
      {
        id: `${options.source ?? "session"}:${stableSession}:${messageId}`,
        workspaceId: options.workspaceId,
        ...(ownerSessionFile !== undefined ? { ownerSessionFile } : {}),
        source: options.source ?? "session",
        ...usage,
        recordedAtMs: options.recordedAtMs ?? Date.now(),
      },
    ];
  });
}

export async function contributionsFromSessionFile(options: {
  workspaceId: string;
  sessionFile: string;
  source?: UsageContributionSource;
}): Promise<{ contributions: UsageContribution[]; diagnostics: string[] }> {
  const canonicalSessionFile = await canonicalRealpathOrResolved(
    options.sessionFile,
  );
  const contributions: UsageContribution[] = [];
  const now = Date.now();
  const source = options.source ?? "session";
  const scanned = await scanSessionFileUsage(
    canonicalSessionFile,
    (usage, messageId, lineNumber) => {
      contributions.push({
        id:
          messageId !== undefined
            ? `${source}:${canonicalSessionFile}:${messageId}`
            : `${source}:${canonicalSessionFile}:line:${lineNumber}`,
        workspaceId: options.workspaceId,
        ownerSessionFile: canonicalSessionFile,
        source,
        ...usage,
        recordedAtMs: now,
      });
    },
  );
  return scanned.diagnostics.length > 0
    ? { contributions: [], diagnostics: scanned.diagnostics }
    : { contributions, diagnostics: [] };
}

type ExtractedUsage = NonNullable<ReturnType<typeof extractUsage>>;

async function scanSessionFileUsage(
  sessionFile: string,
  visitor: (
    usage: ExtractedUsage,
    messageId: string | undefined,
    lineNumber: number,
  ) => void,
): Promise<{ canonicalSessionFile: string; diagnostics: string[] }> {
  const scanned = await scanSessionFileUsageDetails(sessionFile);
  if (scanned.diagnostics.length === 0) {
    for (const entry of scanned.entries) {
      visitor(entry.usage, entry.messageId, entry.lineNumber ?? 0);
    }
  }
  return {
    canonicalSessionFile: scanned.canonicalSessionFile,
    diagnostics: scanned.diagnostics,
  };
}

async function scanSessionFileUsageDetails(
  sessionFile: string,
): Promise<ScannedSessionUsage> {
  const canonicalSessionFile = await canonicalOrResolved(sessionFile);
  try {
    const input = createReadStream(canonicalSessionFile, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    let parentSession: string | undefined;
    let forkStartedAtMs: number | undefined;
    const entries: UsageEntry[] = [];
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        continue;
      }
      const object = record as Record<string, unknown>;
      if (object.type === "session" && parentSession === undefined) {
        const rawParent = firstString(object.parentSession);
        if (rawParent !== undefined) {
          parentSession = await canonicalOrResolved(rawParent);
        }
        forkStartedAtMs = firstTimestampMs(
          object.timestamp,
          object.createdAt,
          object.startedAt,
        );
        continue;
      }
      const isMessage = object.type === "message";
      const isUsageBearingEntry =
        object.type === "usage" ||
        object.type === "compaction" ||
        object.type === "branch_summary";
      if (!isMessage && !isUsageBearingEntry) continue;
      const message =
        isMessage &&
        object.message &&
        typeof object.message === "object" &&
        !Array.isArray(object.message)
          ? (object.message as Record<string, unknown>)
          : object;
      const entry = usageEntryFromMessage(message, entries.length, object);
      if (entry !== undefined) {
        entries.push({ ...entry, lineNumber });
      }
    }
    return {
      canonicalSessionFile,
      ...(parentSession !== undefined ? { parentSession } : {}),
      ...(forkStartedAtMs !== undefined ? { forkStartedAtMs } : {}),
      entries,
      diagnostics: [],
    };
  } catch (error) {
    return {
      canonicalSessionFile,
      entries: [],
      diagnostics: [
        `Could not read session usage ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

async function sessionFileParentSession(
  sessionFile: string,
): Promise<string | undefined> {
  const scanned = await scanSessionFileUsageDetails(sessionFile);
  return scanned.parentSession;
}

function usageEntryFromMessage(
  message: unknown,
  fallbackIndex: number,
  record?: Record<string, unknown>,
): UsageEntry | undefined {
  const usage = extractUsage(message);
  if (usage === undefined) return undefined;
  const messageRecord =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : {};
  const messageId = firstString(
    messageRecord.id,
    record?.id,
    messageRecord.responseId,
    record?.responseId,
  );
  const timestampMs = firstTimestampMs(
    messageRecord.timestamp,
    messageRecord.createdAt,
    record?.timestamp,
    record?.createdAt,
  );
  const entryType = firstString(record?.type) ?? "message";
  return {
    usage,
    entryType,
    projectedSignature: usageEntryProjectedSignature(messageRecord, usage),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(timestampMs !== undefined ? { timestampMs } : {}),
    signature: usageEntrySignature(
      messageRecord,
      usage,
      fallbackIndex,
      entryType,
    ),
  };
}

function usageEntryProjectedSignature(
  message: Record<string, unknown>,
  usage: ExtractedUsage,
): string {
  return hashStable(
    JSON.stringify({
      role: message.role,
      content: message.content,
      usage,
    }).slice(0, 8192),
  );
}

function usageEntrySignature(
  message: Record<string, unknown>,
  usage: ExtractedUsage,
  fallbackIndex: number,
  entryType: string,
): string {
  return hashStable(
    JSON.stringify({
      index: fallbackIndex,
      type: entryType,
      role: message.role,
      content: message.content,
      usage,
    }).slice(0, 8192),
  );
}

export function runtimeUsageContribution(options: {
  id: string;
  workspaceId: string;
  ownerSessionFile?: string;
  source: UsageContributionSource;
  usage: ChatRuntimeUsage;
  recordedAtMs?: number;
}): UsageContribution {
  return {
    id: options.id,
    workspaceId: options.workspaceId,
    ...(options.ownerSessionFile !== undefined
      ? { ownerSessionFile: options.ownerSessionFile }
      : {}),
    source: options.source,
    inputTokens: options.usage.inputTokens,
    outputTokens: options.usage.outputTokens,
    cacheReadTokens: options.usage.cacheReadTokens,
    cacheWriteTokens: options.usage.cacheWriteTokens,
    totalTokens: options.usage.totalTokens,
    ...(options.usage.totalCostUsd !== undefined
      ? { totalCostUsd: options.usage.totalCostUsd }
      : {}),
    recordedAtMs: options.recordedAtMs ?? Date.now(),
  };
}

function extractUsage(
  value: unknown,
):
  | Omit<
      UsageContribution,
      "id" | "workspaceId" | "ownerSessionFile" | "source" | "recordedAtMs"
    >
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  const usageRecord =
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)
      : record;
  const inputTokens = readNumber(usageRecord, [
    "input",
    "inputTokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const outputTokens = readNumber(usageRecord, [
    "output",
    "outputTokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const cacheReadTokens = readNumber(usageRecord, [
    "cacheRead",
    "cacheReadTokens",
    "cache_read",
    "cache_read_tokens",
  ]);
  const cacheWriteTokens = readNumber(usageRecord, [
    "cacheWrite",
    "cacheWriteTokens",
    "cache_write",
    "cache_write_tokens",
  ]);
  const totalTokens = readNumber(usageRecord, ["totalTokens", "total"]);
  const totalCostUsd = readCostUsd(usageRecord);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    totalTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return undefined;
  }
  const safeInput = inputTokens ?? 0;
  const safeOutput = outputTokens ?? 0;
  const safeCacheRead = cacheReadTokens ?? 0;
  const safeCacheWrite = cacheWriteTokens ?? 0;
  return {
    inputTokens: safeInput,
    outputTokens: safeOutput,
    cacheReadTokens: safeCacheRead,
    cacheWriteTokens: safeCacheWrite,
    totalTokens:
      totalTokens ?? safeInput + safeOutput + safeCacheRead + safeCacheWrite,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

function readCostUsd(record: Record<string, unknown>): number | undefined {
  const direct = readNumber(record, [
    "costUsd",
    "totalCostUsd",
    "total_cost_usd",
  ]);
  if (direct !== undefined) return direct;
  const cost = record.cost;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
    return cost;
  if (cost && typeof cost === "object" && !Array.isArray(cost)) {
    return readNumber(cost as Record<string, unknown>, ["total", "usd"]);
  }
  return undefined;
}

function readNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstTimestampMs(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value !== "string" || value.length === 0) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function hashStable(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function canonicalOrResolved(filePath: string): Promise<string> {
  // Workspace/session ownership is canonicalized before it reaches this store.
  // Keep usage identity lexical so maintained-state reads never depend on
  // filesystem alias resolution and tests/imports remain stable after deletion.
  return path.resolve(filePath);
}

async function canonicalRealpathOrResolved(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function toUsageContribution(
  parsed: z.infer<typeof usageContributionSchema>,
): UsageContribution {
  return {
    id: parsed.id,
    workspaceId: parsed.workspaceId,
    ...(parsed.ownerSessionFile !== undefined
      ? { ownerSessionFile: parsed.ownerSessionFile }
      : {}),
    source: parsed.source,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheWriteTokens: parsed.cacheWriteTokens,
    totalTokens: parsed.totalTokens,
    ...(parsed.totalCostUsd !== undefined
      ? { totalCostUsd: parsed.totalCostUsd }
      : {}),
    recordedAtMs: parsed.recordedAtMs,
  };
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
