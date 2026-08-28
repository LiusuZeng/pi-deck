import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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

const usageStoreSchema = z
  .object({
    version: z.literal(1),
    contributions: z.array(usageContributionSchema),
  })
  .strict();

interface UsageStoreState {
  version: 1;
  contributions: UsageContribution[];
}

const emptyStore = (): UsageStoreState => ({ version: 1, contributions: [] });

export class WorkspaceUsageStore {
  readonly storeFile: string;
  private state: UsageStoreState = emptyStore();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private persistTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private persistedGeneration = 0;

  constructor(private readonly piDeckHome: string) {
    this.storeFile = path.join(piDeckHome, "workspace-usage.json");
  }

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  async upsertContribution(contribution: UsageContribution): Promise<void> {
    const parsed = await canonicalContribution(contribution);
    await this.loadIfNeeded();
    const index = this.state.contributions.findIndex(
      (item) => item.id === parsed.id,
    );
    if (
      index >= 0 &&
      sameContribution(this.state.contributions[index]!, parsed)
    ) {
      await this.persistIfDirty();
      return;
    }
    const contributions = [...this.state.contributions];
    if (index >= 0) contributions[index] = parsed;
    else contributions.push(parsed);
    await this.commit({ version: 1, contributions });
  }

  async upsertContributions(
    contributions: readonly UsageContribution[],
  ): Promise<void> {
    if (contributions.length === 0) return;
    const parsed = await Promise.all(contributions.map(canonicalContribution));
    await this.loadIfNeeded();
    let changed = false;
    const byId = new Map(
      this.state.contributions.map((contribution, index) => [
        contribution.id,
        index,
      ]),
    );
    const next = [...this.state.contributions];
    for (const contribution of parsed) {
      const index = byId.get(contribution.id);
      if (index === undefined) {
        byId.set(contribution.id, next.length);
        next.push(contribution);
        changed = true;
      } else if (!sameContribution(next[index]!, contribution)) {
        next[index] = contribution;
        changed = true;
      }
    }
    if (changed) await this.commit({ version: 1, contributions: next });
    else await this.persistIfDirty();
  }

  async freezeSessionUsage(options: {
    workspaceId: string;
    sessionFile: string;
  }): Promise<void> {
    await this.loadIfNeeded();
    const sessionFile = await canonicalOrResolved(options.sessionFile);
    const frozen = this.state.contributions
      .filter((contribution) => contribution.ownerSessionFile === sessionFile)
      .map(
        (contribution): UsageContribution => ({
          id: `deleted:${contribution.id}`,
          workspaceId: options.workspaceId,
          source: contribution.source,
          inputTokens: contribution.inputTokens,
          outputTokens: contribution.outputTokens,
          cacheReadTokens: contribution.cacheReadTokens,
          cacheWriteTokens: contribution.cacheWriteTokens,
          totalTokens: contribution.totalTokens,
          ...(contribution.totalCostUsd !== undefined
            ? { totalCostUsd: contribution.totalCostUsd }
            : {}),
          recordedAtMs: Date.now(),
        }),
      );
    await this.upsertContributions(frozen);
  }

  async getWorkspaceUsage(options: {
    workspaceId: string;
    sessionFiles: readonly string[];
  }): Promise<WorkspaceUsageTotals> {
    await this.loadIfNeeded();
    const sessionFiles = new Set(
      await Promise.all(options.sessionFiles.map(canonicalOrResolved)),
    );
    const contributions = this.state.contributions.filter((contribution) => {
      if (contribution.ownerSessionFile !== undefined) {
        return sessionFiles.has(contribution.ownerSessionFile);
      }
      return contribution.workspaceId === options.workspaceId;
    });
    return summarizeUsageContributions(contributions);
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    try {
      const parsed = usageStoreSchema.parse(
        JSON.parse(await fs.readFile(this.storeFile, "utf8")),
      );
      this.state = {
        version: 1,
        contributions: parsed.contributions.map(toUsageContribution),
      };
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
      version: 1,
      contributions: parsed.contributions.map(toUsageContribution),
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
  const diagnostics: string[] = [];
  const canonicalSessionFile = await canonicalOrResolved(options.sessionFile);
  const stableSessionKey = canonicalSessionFile;
  let text: string;
  try {
    text = await fs.readFile(canonicalSessionFile, "utf8");
  } catch (error) {
    diagnostics.push(
      `Could not read session usage ${options.sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { contributions: [], diagnostics };
  }
  const contributions: UsageContribution[] = [];
  const now = Date.now();
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim().length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    const object = record as Record<string, unknown>;
    if (object.type !== "message") return;
    const usage = extractUsage(object.message ?? object);
    if (usage === undefined) return;
    const message =
      object.message &&
      typeof object.message === "object" &&
      !Array.isArray(object.message)
        ? (object.message as Record<string, unknown>)
        : object;
    const messageId = firstString(
      message.id,
      object.id,
      message.responseId,
      object.responseId,
    );
    contributions.push({
      id:
        messageId !== undefined
          ? `${options.source ?? "session"}:${stableSessionKey}:${messageId}`
          : `${options.source ?? "session"}:${stableSessionKey}:line:${index + 1}`,
      workspaceId: options.workspaceId,
      ownerSessionFile: canonicalSessionFile,
      source: options.source ?? "session",
      ...usage,
      recordedAtMs: now,
    });
  });
  return { contributions, diagnostics };
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

function hashStable(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function canonicalContribution(
  contribution: UsageContribution,
): Promise<UsageContribution> {
  const parsed = usageContributionSchema.parse({
    ...contribution,
    ...(contribution.ownerSessionFile !== undefined
      ? {
          ownerSessionFile: await canonicalOrResolved(
            contribution.ownerSessionFile,
          ),
        }
      : {}),
  });
  return toUsageContribution(parsed);
}

async function canonicalOrResolved(filePath: string): Promise<string> {
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

function sameContribution(
  left: UsageContribution,
  right: UsageContribution,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
