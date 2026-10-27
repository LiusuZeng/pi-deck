import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { chatSessionSummarySchema } from "../../shared/ipcSchemas.js";
import type {
  ChatSessionSummary,
  ProjectListResult,
  ProjectRef,
} from "../../shared/types.js";
import type { DiagnosticsRecorder } from "../diagnostics/diagnostics.js";
import {
  canonicalProjectPath,
  canonicalSessionFilePath,
} from "../filesystemIdentity.js";

const projectRecordSchema = z
  .object({
    id: z.string().min(1),
    rootPath: z.string().min(1),
    displayName: z.string().min(1),
    createdAtMs: z.number(),
    updatedAtMs: z.number(),
    lastOpenedAtMs: z.number(),
    archivedAtMs: z.number().optional(),
    invalidReason: z.string().optional(),
  })
  .strict();

const projectSessionRefSchema = z
  .object({
    projectId: z.string().min(1),
    sessionFile: z.string().min(1),
    sessionId: z.string().optional(),
    title: z.string().optional(),
    cwd: z.string().optional(),
    canonicalCwd: z.string().optional(),
    preview: z.string().optional(),
    addedAtMs: z.number(),
    lastSeenAtMs: z.number(),
    lastKnownUpdatedAtMs: z.number().optional(),
    createdAtMs: z.number().optional(),
    completedAtMs: z.number().optional(),
    messageCount: z.number().int().min(0).optional(),
    missingSinceMs: z.number().optional(),
  })
  .strict();

const projectStoreFileSchema = z
  .object({
    version: z.literal(1),
    activeProjectId: z.string().optional(),
    projects: z.array(projectRecordSchema),
    sessionRefs: z.array(projectSessionRefSchema),
  })
  .strict();

type ProjectRecord = z.infer<typeof projectRecordSchema>;
type ProjectSessionRef = z.infer<typeof projectSessionRefSchema>;
type ProjectStoreFile = z.infer<typeof projectStoreFileSchema>;

const emptyStore = (): ProjectStoreFile => ({
  version: 1,
  projects: [],
  sessionRefs: [],
});

export function resolvePiDeckHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.PI_DECK_HOME;
  if (override !== undefined && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".pideck");
}

export class ProjectStore {
  readonly storeFile: string;
  private state: ProjectStoreFile = emptyStore();
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private sessionRefsGeneration = 0;
  private persistedSessionRefsGeneration = 0;

  constructor(
    private readonly piDeckHome: string,
    private readonly diagnostics?: DiagnosticsRecorder,
  ) {
    this.storeFile = path.join(piDeckHome, "projects.json");
  }

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    let raw: string;
    try {
      raw = await fs.readFile(this.storeFile, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) {
        this.diagnostics?.recordError(
          `Pi Deck project metadata could not be read; existing metadata was preserved: ${errorToMessage(error)}`,
        );
        throw error;
      }
      this.state = emptyStore();
      await this.persist();
      this.loaded = true;
      return;
    }

    let parsed: ProjectStoreFile;
    try {
      parsed = projectStoreFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      const backup = `${this.storeFile}.corrupt-${Date.now()}`;
      this.diagnostics?.recordError(
        `Pi Deck project metadata was invalid; preserving it before defaults are applied: ${errorToMessage(error)}`,
      );
      try {
        await fs.rename(this.storeFile, backup);
      } catch (backupError) {
        this.diagnostics?.recordError(
          `Could not preserve invalid Pi Deck project metadata; defaults were not applied: ${errorToMessage(backupError)}`,
        );
        throw backupError;
      }
      this.diagnostics?.recordError(
        `Corrupt Pi Deck project metadata moved to ${backup}`,
      );
      this.state = emptyStore();
      await this.persist();
      this.loaded = true;
      return;
    }

    this.state = await normalizeProjectStoreFilesystemIdentities(parsed);
    if (JSON.stringify(this.state) !== JSON.stringify(parsed)) {
      // Keep migrated identities dirty so the next normal store write makes
      // them durable without turning a migration write failure into a
      // corrupt-file recovery.
      this.sessionRefsGeneration += 1;
    }
    this.loaded = true;
  }

  async list(): Promise<ProjectListResult> {
    await this.loadIfNeeded();
    const invalidReasons = new Map<string, string | undefined>();
    for (const project of this.state.projects) {
      if (project.archivedAtMs !== undefined) {
        continue;
      }
      try {
        const stat = await fs.stat(project.rootPath);
        invalidReasons.set(
          project.id,
          stat.isDirectory() ? undefined : "Project path is not a folder.",
        );
      } catch {
        invalidReasons.set(
          project.id,
          "Project folder is missing or unreadable.",
        );
      }
    }
    if (
      [...invalidReasons].some(
        ([id, invalidReason]) =>
          this.state.projects.find((project) => project.id === id)
            ?.invalidReason !== invalidReason,
      )
    ) {
      await this.transact(() => {
        let changed = false;
        const projects = this.state.projects.map((project) => {
          if (!invalidReasons.has(project.id)) return project;
          const invalidReason = invalidReasons.get(project.id);
          if (project.invalidReason === invalidReason) return project;
          changed = true;
          return withInvalidReason(project, invalidReason);
        });
        return { next: { ...this.state, projects }, changed };
      });
    }

    const activeProject = this.getActiveProjectRecordSync();
    return {
      ...(this.state.activeProjectId
        ? { activeProjectId: this.state.activeProjectId }
        : {}),
      ...(activeProject ? { activeProject: toProjectRef(activeProject) } : {}),
      projects: this.state.projects
        .filter((project) => project.archivedAtMs === undefined)
        .sort((a, b) => b.lastOpenedAtMs - a.lastOpenedAtMs)
        .map(toProjectRef),
    };
  }

  async getActiveProject(): Promise<ProjectRecord | undefined> {
    await this.loadIfNeeded();
    return this.getActiveProjectRecordSync();
  }

  async getActiveProjectRef(): Promise<ProjectRef | undefined> {
    const project = await this.getActiveProject();
    return project ? toProjectRef(project) : undefined;
  }

  async upsertAndActivateProject(rootPath: string): Promise<ProjectRef> {
    await this.loadIfNeeded();
    const canonical = await canonicalProjectPath(rootPath);
    const now = Date.now();
    return this.transact(() => {
      const existingIndex = this.state.projects.findIndex(
        (project) => project.id === canonical,
      );
      const existing =
        existingIndex >= 0 ? this.state.projects[existingIndex] : undefined;
      const next: ProjectRecord = existing
        ? {
            ...existing,
            rootPath: canonical,
            displayName: existing.displayName ?? displayNameFromPath(canonical),
            updatedAtMs: now,
            lastOpenedAtMs: now,
          }
        : {
            id: canonical,
            rootPath: canonical,
            displayName: displayNameFromPath(canonical),
            createdAtMs: now,
            updatedAtMs: now,
            lastOpenedAtMs: now,
          };
      const projects =
        existingIndex >= 0
          ? replaceAt(this.state.projects, existingIndex, next)
          : [...this.state.projects, next];
      return {
        next: { ...this.state, activeProjectId: next.id, projects },
        result: toProjectRef(next),
        changed: true,
      };
    });
  }

  /**
   * Resolve a renderer-visible project id into the canonical root that main is
   * allowed to use. IDs are looked up exactly; they are never interpreted as
   * arbitrary filesystem paths.
   */
  async resolveAuthorizedProject(projectId: string): Promise<ProjectRef> {
    await this.loadIfNeeded();
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    if (project.archivedAtMs !== undefined) {
      throw new Error(`Project is archived: ${projectId}`);
    }

    let canonical: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      canonical = await fs.realpath(project.rootPath);
      stat = await fs.stat(canonical);
    } catch {
      await this.setProjectInvalidReason(
        project.id,
        "Project folder is missing or unreadable.",
      );
      throw new Error(`Project folder is missing or unreadable: ${project.id}`);
    }
    if (!stat.isDirectory()) {
      await this.setProjectInvalidReason(
        project.id,
        "Project path is not a folder.",
      );
      throw new Error(`Project path is not a folder: ${project.id}`);
    }
    // IDs are app-owned lookup keys. P0 currently creates them from the
    // canonical root, but authorization must not reinterpret an ID as a path
    // or require that implementation detail for future/migrated records.
    if (canonical !== project.rootPath) {
      await this.setProjectInvalidReason(
        project.id,
        "Project folder moved or its canonical path changed.",
      );
      throw new Error(
        `Project folder moved or is unavailable: ${project.rootPath}`,
      );
    }

    if (project.invalidReason !== undefined) {
      await this.setProjectInvalidReason(project.id, undefined);
    }
    return toProjectRef(withInvalidReason(project, undefined));
  }

  async selectProject(projectId: string): Promise<ProjectRef> {
    await this.resolveAuthorizedProject(projectId);
    return this.transact(() => {
      const projectIndex = this.state.projects.findIndex(
        (item) => item.id === projectId,
      );
      if (projectIndex < 0) {
        // resolveAuthorizedProject above makes this unreachable, but retain a
        // defensive error if future store mutations become concurrent.
        throw new Error(`Unknown project: ${projectId}`);
      }
      const project = this.state.projects[projectIndex]!;
      const now = Date.now();
      const next = withInvalidReason(
        {
          ...project,
          lastOpenedAtMs: now,
          updatedAtMs: now,
        },
        undefined,
      );
      return {
        next: {
          ...this.state,
          activeProjectId: next.id,
          projects: replaceAt(this.state.projects, projectIndex, next),
        },
        changed: true,
        result: toProjectRef(next),
      };
    });
  }

  async upsertSessionRef(
    projectId: string,
    summary: ChatSessionSummary,
  ): Promise<void> {
    await this.upsertSessionRefs(projectId, [summary]);
  }

  /**
   * Merge a scan's session summaries in one validated in-memory transaction.
   * Canonicalize and validate every input before changing state so a malformed
   * batch cannot leave partially persisted session metadata behind.
   */
  async upsertSessionRefs(
    projectId: string,
    summaries: readonly ChatSessionSummary[],
    options: { missingSessionFiles?: readonly string[] } = {},
  ): Promise<void> {
    const validProjectId = z.string().min(1).parse(projectId);
    const validSummaries = summaries.map((summary) => {
      const parsed = chatSessionSummarySchema.parse(summary);
      z.string().min(1).parse(parsed.sessionFile);
      return parsed;
    });
    const missingSessionFiles = (options.missingSessionFiles ?? []).map(
      (sessionFile) => z.string().min(1).parse(sessionFile),
    );
    const [canonicalSummaries, canonicalMissingSessionFiles] =
      await Promise.all([
        Promise.all(
          validSummaries.map(async (summary) => ({
            summary,
            sessionFile: await canonicalSessionFilePath(summary.sessionFile),
            canonicalCwd: summary.cwd
              ? await canonicalProjectPath(summary.cwd)
              : undefined,
          })),
        ),
        Promise.all(missingSessionFiles.map(canonicalSessionFilePath)),
      ]);

    await this.loadIfNeeded();
    const changed = await this.transact(() => {
      const now = Date.now();
      const nextRefs = [...this.state.sessionRefs];
      const indexes = new Map(
        nextRefs.map((ref, index) => [
          sessionRefKey(ref.projectId, ref.sessionFile),
          index,
        ]),
      );
      let changed = false;

      for (const { summary, sessionFile, canonicalCwd } of canonicalSummaries) {
        const key = sessionRefKey(validProjectId, sessionFile);
        const index = indexes.get(key);
        const existing = index === undefined ? undefined : nextRefs[index];
        const candidate: ProjectSessionRef = {
          projectId: validProjectId,
          sessionFile,
          ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
          title: summary.title,
          ...(summary.cwd ? { cwd: summary.cwd } : {}),
          ...(canonicalCwd ? { canonicalCwd } : {}),
          ...(summary.preview ? { preview: summary.preview } : {}),
          addedAtMs: existing?.addedAtMs ?? now,
          lastSeenAtMs: existing?.lastSeenAtMs ?? now,
          lastKnownUpdatedAtMs: summary.updatedAtMs,
          ...(summary.createdAtMs !== undefined
            ? { createdAtMs: summary.createdAtMs }
            : {}),
          ...(summary.completedAtMs !== undefined
            ? { completedAtMs: summary.completedAtMs }
            : {}),
          messageCount: summary.messageCount,
        };

        if (existing && sameSessionRefData(existing, candidate)) {
          continue;
        }
        candidate.lastSeenAtMs = now;
        if (index === undefined) {
          indexes.set(key, nextRefs.length);
          nextRefs.push(candidate);
        } else {
          nextRefs[index] = candidate;
        }
        changed = true;
      }

      for (const sessionFile of canonicalMissingSessionFiles) {
        const index = indexes.get(sessionRefKey(validProjectId, sessionFile));
        if (index === undefined) {
          continue;
        }
        const existing = nextRefs[index];
        if (existing && existing.missingSinceMs === undefined) {
          nextRefs[index] = { ...existing, missingSinceMs: now };
          changed = true;
        }
      }

      return {
        next: { ...this.state, sessionRefs: nextRefs },
        changed,
        result: changed,
      };
    });

    // Retry an accepted migration write even when this scan produced the same
    // normalized state. Rejected writes never publish state, so they do not set
    // this dirty bit.
    if (
      !changed &&
      this.persistedSessionRefsGeneration < this.sessionRefsGeneration
    ) {
      await this.persist();
    }
  }

  async upsertSessionRefFromSnapshot(options: {
    projectId: string;
    sessionFile: string;
    sessionId?: string;
    cwd?: string;
    title?: string;
    updatedAtMs?: number;
    completedAtMs?: number;
    messageCount?: number;
    preview?: string;
  }): Promise<void> {
    await this.loadIfNeeded();
    const sessionFile = await canonicalSessionFilePath(options.sessionFile);
    const canonicalCwd = options.cwd
      ? await canonicalProjectPath(options.cwd)
      : undefined;
    await this.transact(() => {
      const now = Date.now();
      const index = this.state.sessionRefs.findIndex(
        (ref) =>
          ref.projectId === options.projectId &&
          ref.sessionFile === sessionFile,
      );
      const existing = index >= 0 ? this.state.sessionRefs[index] : undefined;
      const next: ProjectSessionRef = {
        projectId: options.projectId,
        sessionFile,
        ...(options.sessionId
          ? { sessionId: options.sessionId }
          : existing?.sessionId
            ? { sessionId: existing.sessionId }
            : {}),
        title:
          options.title ??
          existing?.title ??
          path.basename(sessionFile, ".jsonl"),
        ...(options.cwd
          ? { cwd: options.cwd, canonicalCwd }
          : existing?.cwd
            ? {
                cwd: existing.cwd,
                ...(existing.canonicalCwd
                  ? { canonicalCwd: existing.canonicalCwd }
                  : {}),
              }
            : {}),
        ...(options.preview
          ? { preview: options.preview }
          : existing?.preview
            ? { preview: existing.preview }
            : {}),
        addedAtMs: existing?.addedAtMs ?? now,
        lastSeenAtMs: now,
        lastKnownUpdatedAtMs:
          options.updatedAtMs ?? existing?.lastKnownUpdatedAtMs ?? now,
        ...(existing?.createdAtMs ? { createdAtMs: existing.createdAtMs } : {}),
        ...(options.completedAtMs !== undefined
          ? { completedAtMs: options.completedAtMs }
          : options.messageCount === undefined &&
              existing?.completedAtMs !== undefined
            ? { completedAtMs: existing.completedAtMs }
            : {}),
        messageCount: options.messageCount ?? existing?.messageCount ?? 0,
      };
      return {
        next: {
          ...this.state,
          sessionRefs:
            index >= 0
              ? replaceAt(this.state.sessionRefs, index, next)
              : [...this.state.sessionRefs, next],
        },
        changed: true,
      };
    });
  }

  async getSessionRefs(projectId: string): Promise<ProjectSessionRef[]> {
    await this.loadIfNeeded();
    return this.state.sessionRefs.filter((ref) => ref.projectId === projectId);
  }

  /**
   * Return the local metadata cache without touching the session filesystem.
   * Bootstrap uses this for an immediate shell; a later repository refresh is
   * still authoritative and reconciles missing or changed files.
   */
  async getCachedSessionSummaries(
    projectId: string,
  ): Promise<ChatSessionSummary[]> {
    await this.loadIfNeeded();
    return this.state.sessionRefs
      .filter(
        (ref) =>
          ref.projectId === projectId && ref.missingSinceMs === undefined,
      )
      .map((ref) => ({
        id: ref.sessionFile,
        sessionFile: ref.sessionFile,
        ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
        ...(ref.cwd ? { cwd: ref.cwd } : {}),
        title: ref.title ?? path.basename(ref.sessionFile, ".jsonl"),
        updatedAtMs: ref.lastKnownUpdatedAtMs ?? ref.lastSeenAtMs,
        ...(ref.createdAtMs !== undefined
          ? { createdAtMs: ref.createdAtMs }
          : {}),
        ...(ref.completedAtMs !== undefined
          ? { completedAtMs: ref.completedAtMs }
          : {}),
        messageCount: ref.messageCount ?? 0,
        ...(ref.preview ? { preview: ref.preview } : {}),
      }))
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }

  async markSessionMissing(
    projectId: string,
    sessionFile: string,
  ): Promise<void> {
    await this.loadIfNeeded();
    const canonical = await canonicalSessionFilePath(sessionFile);
    await this.transact(() => {
      const index = this.state.sessionRefs.findIndex(
        (item) =>
          item.projectId === projectId && item.sessionFile === canonical,
      );
      const ref = index >= 0 ? this.state.sessionRefs[index] : undefined;
      if (!ref || ref.missingSinceMs !== undefined) {
        return { next: this.state, changed: false };
      }
      return {
        next: {
          ...this.state,
          sessionRefs: replaceAt(this.state.sessionRefs, index, {
            ...ref,
            missingSinceMs: Date.now(),
          }),
        },
        changed: true,
      };
    });
  }

  async removeSessionRef(
    projectId: string,
    sessionFile: string,
  ): Promise<void> {
    await this.loadIfNeeded();
    const canonical = await canonicalSessionFilePath(sessionFile);
    // Failed-fork compensation must not erase this reference from memory
    // until its removal is durable. Otherwise a later write can silently
    // resurrect it after callers have released their target reservation.
    await this.transact(() => {
      const sessionRefs = this.state.sessionRefs.filter(
        (ref) =>
          !(ref.projectId === projectId && ref.sessionFile === canonical),
      );
      return {
        next: { ...this.state, sessionRefs },
        changed: sessionRefs.length !== this.state.sessionRefs.length,
      };
    });
  }

  private async setProjectInvalidReason(
    projectId: string,
    invalidReason: string | undefined,
  ): Promise<void> {
    await this.transact(() => {
      const projectIndex = this.state.projects.findIndex(
        (project) => project.id === projectId,
      );
      const project =
        projectIndex >= 0 ? this.state.projects[projectIndex] : undefined;
      if (!project || project.invalidReason === invalidReason) {
        return { next: this.state, changed: false };
      }
      const nextProject = withInvalidReason(project, invalidReason);
      return {
        next: {
          ...this.state,
          projects: replaceAt(this.state.projects, projectIndex, nextProject),
        },
        changed: true,
      };
    });
  }

  private getActiveProjectRecordSync(): ProjectRecord | undefined {
    const activeId = this.state.activeProjectId;
    return activeId
      ? this.state.projects.find((project) => project.id === activeId)
      : undefined;
  }

  private async transact<T = void>(
    operation: () => { next: ProjectStoreFile; changed: boolean; result?: T },
  ): Promise<T> {
    const transaction = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        // Other project mutations still publish eagerly. Rebuild after a
        // racing update so a durable remove cannot discard it.
        for (;;) {
          const stateBeforeTransaction = JSON.stringify(this.state);
          const { next, changed, result } = operation();
          if (!changed) return result as T;
          const candidate = projectStoreFileSchema.parse(next);
          await this.writeStoreFile(candidate);
          if (JSON.stringify(this.state) !== stateBeforeTransaction) continue;
          this.state = candidate;
          this.sessionRefsGeneration += 1;
          this.persistedSessionRefsGeneration = Math.max(
            this.persistedSessionRefsGeneration,
            this.sessionRefsGeneration,
          );
          return result as T;
        }
      });
    this.persistQueue = transaction.then(
      () => undefined,
      () => undefined,
    );
    return transaction;
  }

  private async persist(): Promise<void> {
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        const sessionRefsGeneration = this.sessionRefsGeneration;
        await this.writeStoreFile(this.state);
        this.persistedSessionRefsGeneration = Math.max(
          this.persistedSessionRefsGeneration,
          sessionRefsGeneration,
        );
      });
    return this.persistQueue;
  }

  private async writeStoreFile(candidate: ProjectStoreFile): Promise<void> {
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    const tempFile = `${this.storeFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(tempFile, `${JSON.stringify(candidate, null, 2)}\n`, {
        mode: 0o600,
      });
      await fs.rename(tempFile, this.storeFile);
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function withInvalidReason(
  project: ProjectRecord,
  invalidReason: string | undefined,
): ProjectRecord {
  const { invalidReason: _invalidReason, ...withoutInvalidReason } = project;
  return invalidReason === undefined
    ? withoutInvalidReason
    : { ...withoutInvalidReason, invalidReason };
}

function sessionRefKey(projectId: string, sessionFile: string): string {
  return `${projectId}\u0000${sessionFile}`;
}

function sameSessionRefData(
  existing: ProjectSessionRef,
  candidate: ProjectSessionRef,
): boolean {
  return (
    existing.projectId === candidate.projectId &&
    existing.sessionFile === candidate.sessionFile &&
    existing.sessionId === candidate.sessionId &&
    existing.title === candidate.title &&
    existing.cwd === candidate.cwd &&
    existing.canonicalCwd === candidate.canonicalCwd &&
    existing.preview === candidate.preview &&
    existing.lastKnownUpdatedAtMs === candidate.lastKnownUpdatedAtMs &&
    existing.createdAtMs === candidate.createdAtMs &&
    existing.completedAtMs === candidate.completedAtMs &&
    existing.messageCount === candidate.messageCount &&
    existing.missingSinceMs === undefined
  );
}

function toProjectRef(project: ProjectRecord): ProjectRef {
  return {
    id: project.id,
    path: project.rootPath,
    canonicalPath: project.rootPath,
    displayName: project.displayName,
    lastOpenedAt: project.lastOpenedAtMs,
    ...(project.invalidReason ? { invalidReason: project.invalidReason } : {}),
  };
}

function displayNameFromPath(rootPath: string): string {
  return path.basename(rootPath) || rootPath;
}

async function normalizeProjectStoreFilesystemIdentities(
  state: ProjectStoreFile,
): Promise<ProjectStoreFile> {
  const normalizedRefs = await Promise.all(
    state.sessionRefs.map(async (ref) => ({
      ...ref,
      sessionFile: await canonicalSessionFilePath(ref.sessionFile),
      ...(ref.cwd
        ? { canonicalCwd: await canonicalProjectPath(ref.cwd) }
        : ref.canonicalCwd
          ? { canonicalCwd: await canonicalProjectPath(ref.canonicalCwd) }
          : {}),
    })),
  );
  const refsByIdentity = new Map<string, ProjectSessionRef>();
  for (const ref of normalizedRefs) {
    const key = sessionRefKey(ref.projectId, ref.sessionFile);
    const existing = refsByIdentity.get(key);
    if (existing === undefined || ref.lastSeenAtMs > existing.lastSeenAtMs) {
      refsByIdentity.set(key, ref);
    }
  }
  return projectStoreFileSchema.parse({
    ...state,
    sessionRefs: [...refsByIdentity.values()],
  });
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
