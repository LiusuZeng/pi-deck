import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { chatSessionSummarySchema } from "../../shared/ipcSchemas.js";
import type { ChatSessionSummary } from "../../shared/types.js";
import type { DiagnosticsRecorder } from "../diagnostics/diagnostics.js";

const workspaceRecordSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    defaultProjectId: z.string().min(1).optional(),
    legacyProjectId: z.string().min(1).optional(),
    createdAtMs: z.number(),
    updatedAtMs: z.number(),
    lastOpenedAtMs: z.number(),
    archivedAtMs: z.number().optional(),
  })
  .strict();

const workspaceSessionRefSchema = z
  .object({
    workspaceId: z.string().uuid(),
    sessionFile: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    preview: z.string().min(1).optional(),
    addedAtMs: z.number(),
    lastSeenAtMs: z.number(),
    lastKnownUpdatedAtMs: z.number().optional(),
    createdAtMs: z.number().optional(),
    messageCount: z.number().int().min(0).optional(),
    missingSinceMs: z.number().optional(),
  })
  .strict();

const workspaceStoreFileV1Schema = z
  .object({
    version: z.literal(1),
    activeWorkspaceId: z.string().uuid().optional(),
    projectsMigrationCompletedAtMs: z.number().optional(),
    workspaces: z.array(workspaceRecordSchema),
    sessionRefs: z.array(workspaceSessionRefSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const workspaceIds = new Set<string>();
    for (const [index, workspace] of value.workspaces.entries()) {
      if (workspaceIds.has(workspace.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate workspace id: ${workspace.id}`,
          path: ["workspaces", index, "id"],
        });
      }
      workspaceIds.add(workspace.id);
    }
    if (
      value.activeWorkspaceId !== undefined &&
      !workspaceIds.has(value.activeWorkspaceId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Active workspace does not exist.",
        path: ["activeWorkspaceId"],
      });
    }
    const sessionFiles = new Set<string>();
    for (const [index, ref] of value.sessionRefs.entries()) {
      if (!workspaceIds.has(ref.workspaceId)) {
        ctx.addIssue({
          code: "custom",
          message: "Session reference points to an unknown workspace.",
          path: ["sessionRefs", index, "workspaceId"],
        });
      }
      if (sessionFiles.has(ref.sessionFile)) {
        ctx.addIssue({
          code: "custom",
          message: `A session file may belong to only one workspace: ${ref.sessionFile}`,
          path: ["sessionRefs", index, "sessionFile"],
        });
      }
      sessionFiles.add(ref.sessionFile);
    }
  });

const createWorkspaceInputSchema = z
  .object({
    name: z.string(),
    defaultProjectId: z.string().min(1).optional(),
  })
  .strict();

const updateWorkspaceInputSchema = z
  .object({
    workspaceId: z.string().uuid(),
    name: z.string().optional(),
    defaultProjectId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.defaultProjectId !== undefined,
    "At least one workspace property must be updated.",
  );

const legacyProjectRecordSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    createdAtMs: z.number(),
    updatedAtMs: z.number(),
    lastOpenedAtMs: z.number(),
    archivedAtMs: z.number().optional(),
  })
  .strict();

const legacyProjectSessionRefSchema = z
  .object({
    projectId: z.string().min(1),
    sessionFile: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    preview: z.string().min(1).optional(),
    addedAtMs: z.number(),
    lastSeenAtMs: z.number(),
    lastKnownUpdatedAtMs: z.number().optional(),
    createdAtMs: z.number().optional(),
    messageCount: z.number().int().min(0).optional(),
    missingSinceMs: z.number().optional(),
  })
  .strict();

const legacyProjectMigrationInputSchema = z
  .object({
    activeProjectId: z.string().min(1).optional(),
    projects: z.array(legacyProjectRecordSchema),
    sessionRefs: z.array(legacyProjectSessionRefSchema),
    bootstrapWorkspace: z
      .object({
        name: z.string(),
        defaultProjectId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
export type WorkspaceSessionRef = z.infer<typeof workspaceSessionRefSchema>;
export type WorkspaceStoreFileV1 = z.infer<typeof workspaceStoreFileV1Schema>;
export type CreateWorkspaceInput = z.input<typeof createWorkspaceInputSchema>;
export type UpdateWorkspaceInput = z.input<typeof updateWorkspaceInputSchema>;
export type LegacyProjectRecord = z.infer<typeof legacyProjectRecordSchema>;
export type LegacyProjectSessionRef = z.infer<
  typeof legacyProjectSessionRefSchema
>;
export type LegacyProjectMigrationInput = z.input<
  typeof legacyProjectMigrationInputSchema
>;

/** Local store projection; the integration layer owns the public IPC DTO. */
export interface WorkspaceListResult {
  activeWorkspaceId?: string;
  activeWorkspace?: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
}

export interface WorkspaceSessionMutationResult {
  workspaceId: string;
  sessionFile: string;
  previousWorkspaceId?: string;
}

const emptyStore = (): WorkspaceStoreFileV1 => ({
  version: 1,
  workspaces: [],
  sessionRefs: [],
});

/**
 * Durable, app-owned workspace metadata. Session JSONL files are deliberately
 * never opened, moved, or deleted by this store; callers validate them before
 * adding a membership and refresh the cache with repository summaries.
 */
export class WorkspaceStore {
  readonly storeFile: string;
  private state: WorkspaceStoreFileV1 = emptyStore();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private persistQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private persistedGeneration = 0;

  constructor(
    private readonly piDeckHome: string,
    private readonly diagnostics?: DiagnosticsRecorder,
  ) {
    this.storeFile = path.join(piDeckHome, "workspaces.json");
  }

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  async list(): Promise<WorkspaceListResult> {
    await this.loadIfNeeded();
    return this.listSync();
  }

  async getActiveWorkspace(): Promise<WorkspaceRecord | undefined> {
    await this.loadIfNeeded();
    const workspace = this.getActiveWorkspaceSync();
    return workspace ? { ...workspace } : undefined;
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | undefined> {
    const id = z.string().uuid().parse(workspaceId);
    await this.loadIfNeeded();
    const workspace = this.state.workspaces.find((workspace) => workspace.id === id);
    return workspace ? { ...workspace } : undefined;
  }

  async getWorkspaceByLegacyProjectId(
    legacyProjectId: string,
  ): Promise<WorkspaceRecord | undefined> {
    const id = z.string().min(1).parse(legacyProjectId);
    await this.loadIfNeeded();
    const workspace = this.state.workspaces.find((workspace) => workspace.legacyProjectId === id);
    return workspace ? { ...workspace } : undefined;
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const parsed = createWorkspaceInputSchema.parse(input);
    const name = normalizeWorkspaceName(parsed.name);
    await this.loadIfNeeded();
    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      name,
      ...(parsed.defaultProjectId ? { defaultProjectId: parsed.defaultProjectId } : {}),
      createdAtMs: now,
      updatedAtMs: now,
      lastOpenedAtMs: now,
    };
    await this.commit({
      ...this.state,
      activeWorkspaceId: workspace.id,
      workspaces: [...this.state.workspaces, workspace],
    });
    return { ...workspace };
  }

  async update(input: UpdateWorkspaceInput): Promise<WorkspaceRecord> {
    const parsed = updateWorkspaceInputSchema.parse(input);
    const name = parsed.name === undefined ? undefined : normalizeWorkspaceName(parsed.name);
    await this.loadIfNeeded();
    const index = this.requireOpenWorkspaceIndex(parsed.workspaceId);
    const existing = this.state.workspaces[index]!;
    const { defaultProjectId: _defaultProjectId, ...withoutDefaultProjectId } =
      existing;
    const base =
      parsed.defaultProjectId === null ? withoutDefaultProjectId : existing;
    const next: WorkspaceRecord = {
      ...base,
      ...(name === undefined ? {} : { name }),
      ...(parsed.defaultProjectId === undefined
        ? {}
        : parsed.defaultProjectId === null
          ? {}
          : { defaultProjectId: parsed.defaultProjectId }),
      updatedAtMs: Date.now(),
    };
    await this.commit({
      ...this.state,
      workspaces: replaceAt(this.state.workspaces, index, next),
    });
    return { ...next };
  }

  async select(workspaceId: string): Promise<WorkspaceRecord> {
    const id = z.string().uuid().parse(workspaceId);
    await this.loadIfNeeded();
    const index = this.requireOpenWorkspaceIndex(id);
    const existing = this.state.workspaces[index]!;
    const now = Date.now();
    const next = {
      ...existing,
      updatedAtMs: now,
      lastOpenedAtMs: now,
    };
    await this.commit({
      ...this.state,
      activeWorkspaceId: id,
      workspaces: replaceAt(this.state.workspaces, index, next),
    });
    return { ...next };
  }

  async archive(workspaceId: string): Promise<WorkspaceRecord> {
    const id = z.string().uuid().parse(workspaceId);
    await this.loadIfNeeded();
    const index = this.requireOpenWorkspaceIndex(id);
    const now = Date.now();
    const archived = {
      ...this.state.workspaces[index]!,
      updatedAtMs: now,
      archivedAtMs: now,
    };
    const workspaces = replaceAt(this.state.workspaces, index, archived);
    const nextActiveWorkspaceId =
      this.state.activeWorkspaceId === id
        ? workspaces
            .filter((workspace) => workspace.archivedAtMs === undefined)
            .sort((left, right) => right.lastOpenedAtMs - left.lastOpenedAtMs)[0]?.id
        : this.state.activeWorkspaceId;
    await this.commit({
      ...this.state,
      ...(nextActiveWorkspaceId ? { activeWorkspaceId: nextActiveWorkspaceId } : { activeWorkspaceId: undefined }),
      workspaces,
    });
    return { ...archived };
  }

  async upsertSessionRef(
    workspaceId: string,
    summary: ChatSessionSummary,
  ): Promise<WorkspaceSessionMutationResult> {
    return this.upsertSessionRefs(workspaceId, [summary]).then((results) => results[0]!);
  }

  /**
   * Apply a repository refresh in one transaction. The final state is checked
   * against the strict schema before it replaces in-memory metadata.
   */
  async upsertSessionRefs(
    workspaceId: string,
    summaries: readonly ChatSessionSummary[],
    options: { missingSessionFiles?: readonly string[] } = {},
  ): Promise<WorkspaceSessionMutationResult[]> {
    const id = z.string().uuid().parse(workspaceId);
    const parsedSummaries = summaries.map((summary) => chatSessionSummarySchema.parse(summary));
    const missing = (options.missingSessionFiles ?? []).map((file) => z.string().min(1).parse(file));
    const [canonicalSummaries, canonicalMissing] = await Promise.all([
      Promise.all(parsedSummaries.map(async (summary) => ({ summary, sessionFile: await canonicalOrResolved(summary.sessionFile) }))),
      Promise.all(missing.map(canonicalOrResolved)),
    ]);
    ensureDistinct(canonicalSummaries.map((item) => item.sessionFile), "session summaries");
    await this.loadIfNeeded();
    this.requireOpenWorkspaceIndex(id);

    const now = Date.now();
    const refs = [...this.state.sessionRefs];
    const byFile = new Map(refs.map((ref, index) => [ref.sessionFile, index]));
    const results: WorkspaceSessionMutationResult[] = [];
    let changed = false;
    for (const { summary, sessionFile } of canonicalSummaries) {
      const existingIndex = byFile.get(sessionFile);
      const existing = existingIndex === undefined ? undefined : refs[existingIndex];
      const candidate = sessionRefFromSummary(id, sessionFile, summary, existing, now);
      if (existing && sameSessionRefData(existing, candidate)) {
        results.push({ workspaceId: id, sessionFile, ...(existing.workspaceId === id ? {} : { previousWorkspaceId: existing.workspaceId }) });
        continue;
      }
      if (existingIndex === undefined) {
        byFile.set(sessionFile, refs.length);
        refs.push(candidate);
      } else {
        refs[existingIndex] = candidate;
      }
      changed = true;
      results.push({ workspaceId: id, sessionFile, ...(existing && existing.workspaceId !== id ? { previousWorkspaceId: existing.workspaceId } : {}) });
    }
    for (const sessionFile of canonicalMissing) {
      const index = byFile.get(sessionFile);
      const existing = index === undefined ? undefined : refs[index];
      if (
        index !== undefined &&
        existing?.workspaceId === id &&
        existing.missingSinceMs === undefined
      ) {
        refs[index] = { ...existing, missingSinceMs: now };
        changed = true;
      }
    }
    if (changed) {
      await this.commit({ ...this.state, sessionRefs: refs });
    } else {
      await this.persistIfDirty();
    }
    return results;
  }

  async upsertSessionRefFromSnapshot(options: {
    workspaceId: string;
    sessionFile: string;
    sessionId?: string;
    cwd?: string;
    title?: string;
    updatedAtMs?: number;
    messageCount?: number;
    preview?: string;
  }): Promise<WorkspaceSessionMutationResult> {
    const workspaceId = z.string().uuid().parse(options.workspaceId);
    const sessionFile = await canonicalOrResolved(z.string().min(1).parse(options.sessionFile));
    const summary = chatSessionSummarySchema.parse({
      id: sessionFile,
      sessionFile,
      title: options.title ?? path.basename(sessionFile, ".jsonl"),
      updatedAtMs: options.updatedAtMs ?? Date.now(),
      messageCount: options.messageCount ?? 0,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.preview ? { preview: options.preview } : {}),
    });
    return this.upsertSessionRef(workspaceId, summary);
  }

  async moveSession(
    sessionFile: string,
    toWorkspaceId: string,
  ): Promise<WorkspaceSessionMutationResult> {
    const targetId = z.string().uuid().parse(toWorkspaceId);
    const canonical = await canonicalOrResolved(z.string().min(1).parse(sessionFile));
    await this.loadIfNeeded();
    this.requireOpenWorkspaceIndex(targetId);
    const index = this.state.sessionRefs.findIndex((ref) => ref.sessionFile === canonical);
    if (index < 0) throw new Error(`Session is not assigned to a workspace: ${canonical}`);
    const existing = this.state.sessionRefs[index]!;
    if (existing.workspaceId === targetId) {
      await this.persistIfDirty();
      return { workspaceId: targetId, sessionFile: canonical };
    }
    await this.commit({
      ...this.state,
      sessionRefs: replaceAt(this.state.sessionRefs, index, {
        ...existing,
        workspaceId: targetId,
        missingSinceMs: undefined,
      }),
    });
    return { workspaceId: targetId, sessionFile: canonical, previousWorkspaceId: existing.workspaceId };
  }

  async removeSession(
    workspaceId: string,
    sessionFile: string,
  ): Promise<boolean> {
    const id = z.string().uuid().parse(workspaceId);
    const canonical = await canonicalOrResolved(z.string().min(1).parse(sessionFile));
    await this.loadIfNeeded();
    const nextRefs = this.state.sessionRefs.filter(
      (ref) => !(ref.workspaceId === id && ref.sessionFile === canonical),
    );
    if (nextRefs.length === this.state.sessionRefs.length) {
      await this.persistIfDirty();
      return false;
    }
    await this.commit({ ...this.state, sessionRefs: nextRefs });
    return true;
  }

  async markSessionMissing(workspaceId: string, sessionFile: string): Promise<void> {
    const id = z.string().uuid().parse(workspaceId);
    const canonical = await canonicalOrResolved(z.string().min(1).parse(sessionFile));
    await this.loadIfNeeded();
    const index = this.state.sessionRefs.findIndex(
      (ref) => ref.workspaceId === id && ref.sessionFile === canonical,
    );
    const existing = index < 0 ? undefined : this.state.sessionRefs[index];
    if (!existing || existing.missingSinceMs !== undefined) {
      await this.persistIfDirty();
      return;
    }
    await this.commit({
      ...this.state,
      sessionRefs: replaceAt(this.state.sessionRefs, index, {
        ...existing,
        missingSinceMs: Date.now(),
      }),
    });
  }

  async getSessionRefs(workspaceId: string): Promise<WorkspaceSessionRef[]> {
    const id = z.string().uuid().parse(workspaceId);
    await this.loadIfNeeded();
    return this.state.sessionRefs
      .filter((ref) => ref.workspaceId === id)
      .map((ref) => ({ ...ref }));
  }

  /** Return cache only; this deliberately does not touch Pi session files. */
  async getCachedSessionSummaries(workspaceId: string): Promise<ChatSessionSummary[]> {
    const id = z.string().uuid().parse(workspaceId);
    await this.loadIfNeeded();
    return this.state.sessionRefs
      .filter((ref) => ref.workspaceId === id && ref.missingSinceMs === undefined)
      .map(toCachedSummary)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }

  /**
   * Import one immutable ProjectStore snapshot. Once marked complete this is a
   * no-op, making restarts and callers' defensive retries safe.
   */
  async migrateLegacyProjects(input: LegacyProjectMigrationInput): Promise<WorkspaceListResult> {
    const parsed = legacyProjectMigrationInputSchema.parse(input);
    const projects = parsed.projects.filter((project) => project.archivedAtMs === undefined);
    const projectIds = new Set(projects.map((project) => project.id));
    const sessionRefs = parsed.sessionRefs.filter((ref) => projectIds.has(ref.projectId));
    const canonicalRefs = await Promise.all(
      sessionRefs.map(async (ref) => ({ ...ref, sessionFile: await canonicalOrResolved(ref.sessionFile) })),
    );
    await this.loadIfNeeded();
    if (this.state.projectsMigrationCompletedAtMs !== undefined) return this.listSync();

    const now = Date.now();
    const workspaces: WorkspaceRecord[] = projects.map((project) => ({
      id: randomUUID(),
      name: normalizeWorkspaceName(project.displayName),
      defaultProjectId: project.id,
      legacyProjectId: project.id,
      createdAtMs: project.createdAtMs,
      updatedAtMs: project.updatedAtMs,
      lastOpenedAtMs: project.lastOpenedAtMs,
    }));
    if (workspaces.length === 0 && parsed.bootstrapWorkspace) {
      workspaces.push({
        id: randomUUID(),
        name: normalizeWorkspaceName(parsed.bootstrapWorkspace.name),
        ...(parsed.bootstrapWorkspace.defaultProjectId
          ? { defaultProjectId: parsed.bootstrapWorkspace.defaultProjectId }
          : {}),
        createdAtMs: now,
        updatedAtMs: now,
        lastOpenedAtMs: now,
      });
    }
    const workspaceByProjectId = new Map(
      workspaces.flatMap((workspace) =>
        workspace.legacyProjectId ? [[workspace.legacyProjectId, workspace] as const] : [],
      ),
    );
    const winners = new Map<string, LegacyProjectSessionRef>();
    for (const ref of canonicalRefs) {
      const previous = winners.get(ref.sessionFile);
      if (!previous) {
        winners.set(ref.sessionFile, ref);
        continue;
      }
      const winner = chooseLegacyRef(ref, previous, parsed.activeProjectId, projects);
      const discarded = winner === ref ? previous : ref;
      winners.set(ref.sessionFile, winner);
      this.diagnostics?.recordError(
        `Discarded duplicate legacy session membership for ${ref.sessionFile} from project ${discarded.projectId}.`,
      );
    }
    const refs: WorkspaceSessionRef[] = [...winners.values()].flatMap((ref) => {
      const workspace = workspaceByProjectId.get(ref.projectId);
      if (!workspace) return [];
      return [
        {
          workspaceId: workspace.id,
          sessionFile: ref.sessionFile,
          ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
          ...(ref.cwd ? { cwd: ref.cwd } : {}),
          ...(ref.title ? { title: ref.title } : {}),
          ...(ref.preview ? { preview: ref.preview } : {}),
          addedAtMs: ref.addedAtMs,
          lastSeenAtMs: ref.lastSeenAtMs,
          ...(ref.lastKnownUpdatedAtMs !== undefined
            ? { lastKnownUpdatedAtMs: ref.lastKnownUpdatedAtMs }
            : {}),
          ...(ref.createdAtMs !== undefined
            ? { createdAtMs: ref.createdAtMs }
            : {}),
          ...(ref.messageCount !== undefined
            ? { messageCount: ref.messageCount }
            : {}),
          ...(ref.missingSinceMs !== undefined
            ? { missingSinceMs: ref.missingSinceMs }
            : {}),
        },
      ];
    });
    const activeWorkspaceId = workspaceByProjectId.get(parsed.activeProjectId ?? "")?.id ?? workspaces[0]?.id;
    await this.commit({
      version: 1,
      ...(activeWorkspaceId ? { activeWorkspaceId } : {}),
      projectsMigrationCompletedAtMs: now,
      workspaces,
      sessionRefs: refs,
    });
    return this.listSync();
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(this.storeFile, "utf8");
      this.state = workspaceStoreFileV1Schema.parse(JSON.parse(raw));
    } catch (error) {
      if (!isMissingFile(error)) {
        const backup = `${this.storeFile}.corrupt-${Date.now()}`;
        this.diagnostics?.recordError(
          `Pi Deck workspace metadata was invalid and defaults were applied: ${errorToMessage(error)}`,
        );
        try {
          await fs.rename(this.storeFile, backup);
          this.diagnostics?.recordError(`Corrupt Pi Deck workspace metadata moved to ${backup}`);
        } catch {
          // A corrupt backup is best effort; recovery is still safe.
        }
      }
      this.state = emptyStore();
      this.generation += 1;
      await this.persist();
    }
    this.loaded = true;
  }

  private listSync(): WorkspaceListResult {
    const activeWorkspace = this.getActiveWorkspaceSync();
    return {
      ...(this.state.activeWorkspaceId ? { activeWorkspaceId: this.state.activeWorkspaceId } : {}),
      ...(activeWorkspace ? { activeWorkspace: { ...activeWorkspace } } : {}),
      workspaces: this.state.workspaces
        .filter((workspace) => workspace.archivedAtMs === undefined)
        .sort((left, right) => right.lastOpenedAtMs - left.lastOpenedAtMs)
        .map((workspace) => ({ ...workspace })),
    };
  }

  private getActiveWorkspaceSync(): WorkspaceRecord | undefined {
    const id = this.state.activeWorkspaceId;
    if (!id) return undefined;
    const workspace = this.state.workspaces.find((item) => item.id === id);
    return workspace?.archivedAtMs === undefined ? workspace : undefined;
  }

  private requireOpenWorkspaceIndex(workspaceId: string): number {
    const index = this.state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (index < 0) throw new Error(`Unknown workspace: ${workspaceId}`);
    if (this.state.workspaces[index]!.archivedAtMs !== undefined) {
      throw new Error(`Workspace is archived: ${workspaceId}`);
    }
    return index;
  }

  private async commit(next: WorkspaceStoreFileV1): Promise<void> {
    this.state = workspaceStoreFileV1Schema.parse(next);
    this.generation += 1;
    await this.persist();
  }

  private async persistIfDirty(): Promise<void> {
    if (this.persistedGeneration < this.generation) await this.persist();
  }

  private async persist(): Promise<void> {
    this.persistQueue = this.persistQueue.catch(() => undefined).then(async () => {
      const generation = this.generation;
      await this.writeStoreFile();
      this.persistedGeneration = Math.max(this.persistedGeneration, generation);
    });
    return this.persistQueue;
  }

  private async writeStoreFile(): Promise<void> {
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    const tempFile = `${this.storeFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempFile, this.storeFile);
  }
}

function normalizeWorkspaceName(raw: string): string {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Workspace name is required.");
  if (normalized.length > 120) throw new Error("Workspace name must be 120 characters or fewer.");
  return normalized;
}

function sessionRefFromSummary(
  workspaceId: string,
  sessionFile: string,
  summary: ChatSessionSummary,
  existing: WorkspaceSessionRef | undefined,
  now: number,
): WorkspaceSessionRef {
  return {
    workspaceId,
    sessionFile,
    ...(summary.sessionId ? { sessionId: summary.sessionId } : existing?.sessionId ? { sessionId: existing.sessionId } : {}),
    ...(summary.cwd ? { cwd: summary.cwd } : existing?.cwd ? { cwd: existing.cwd } : {}),
    title: summary.title || existing?.title || path.basename(sessionFile, ".jsonl"),
    ...(summary.preview ? { preview: summary.preview } : existing?.preview ? { preview: existing.preview } : {}),
    addedAtMs: existing?.addedAtMs ?? now,
    lastSeenAtMs: now,
    lastKnownUpdatedAtMs: summary.updatedAtMs,
    ...(summary.createdAtMs !== undefined ? { createdAtMs: summary.createdAtMs } : existing?.createdAtMs !== undefined ? { createdAtMs: existing.createdAtMs } : {}),
    messageCount: summary.messageCount,
  };
}

function toCachedSummary(ref: WorkspaceSessionRef): ChatSessionSummary {
  return {
    id: ref.sessionFile,
    sessionFile: ref.sessionFile,
    ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
    ...(ref.cwd ? { cwd: ref.cwd } : {}),
    title: ref.title ?? path.basename(ref.sessionFile, ".jsonl"),
    updatedAtMs: ref.lastKnownUpdatedAtMs ?? ref.lastSeenAtMs,
    ...(ref.createdAtMs !== undefined ? { createdAtMs: ref.createdAtMs } : {}),
    messageCount: ref.messageCount ?? 0,
    ...(ref.preview ? { preview: ref.preview } : {}),
  };
}

function sameSessionRefData(existing: WorkspaceSessionRef, candidate: WorkspaceSessionRef): boolean {
  return (
    existing.workspaceId === candidate.workspaceId &&
    existing.sessionFile === candidate.sessionFile &&
    existing.sessionId === candidate.sessionId &&
    existing.cwd === candidate.cwd &&
    existing.title === candidate.title &&
    existing.preview === candidate.preview &&
    existing.lastKnownUpdatedAtMs === candidate.lastKnownUpdatedAtMs &&
    existing.createdAtMs === candidate.createdAtMs &&
    existing.messageCount === candidate.messageCount &&
    existing.missingSinceMs === undefined
  );
}

function chooseLegacyRef(
  left: LegacyProjectSessionRef,
  right: LegacyProjectSessionRef,
  activeProjectId: string | undefined,
  projects: readonly LegacyProjectRecord[],
): LegacyProjectSessionRef {
  if (left.projectId === activeProjectId) return left;
  if (right.projectId === activeProjectId) return right;
  const opened = new Map(projects.map((project) => [project.id, project.lastOpenedAtMs]));
  const leftOpened = opened.get(left.projectId) ?? Number.NEGATIVE_INFINITY;
  const rightOpened = opened.get(right.projectId) ?? Number.NEGATIVE_INFINITY;
  if (leftOpened !== rightOpened) return leftOpened > rightOpened ? left : right;
  return left.projectId.localeCompare(right.projectId) <= 0 ? left : right;
}

function replaceAt<T>(items: readonly T[], index: number, replacement: T): T[] {
  return [...items.slice(0, index), replacement, ...items.slice(index + 1)];
}

function ensureDistinct(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} are not allowed in one batch.`);
}

async function canonicalOrResolved(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
