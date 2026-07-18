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
    preview: z.string().optional(),
    addedAtMs: z.number(),
    lastSeenAtMs: z.number(),
    lastKnownUpdatedAtMs: z.number().optional(),
    createdAtMs: z.number().optional(),
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
    try {
      const raw = await fs.readFile(this.storeFile, "utf8");
      this.state = projectStoreFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (!isMissingFile(error)) {
        const backup = `${this.storeFile}.corrupt-${Date.now()}`;
        this.diagnostics?.recordError(
          `Pi Deck project metadata was invalid and defaults were applied: ${errorToMessage(error)}`,
        );
        try {
          await fs.rename(this.storeFile, backup);
          this.diagnostics?.recordError(
            `Corrupt Pi Deck project metadata moved to ${backup}`,
          );
        } catch {
          // Best effort only.
        }
      }
      this.state = emptyStore();
      await this.persist();
    }
    this.loaded = true;
  }

  async list(): Promise<ProjectListResult> {
    await this.loadIfNeeded();
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
    const canonical = await canonicalOrResolved(rootPath);
    const now = Date.now();
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

    if (existingIndex >= 0) {
      this.state.projects[existingIndex] = next;
    } else {
      this.state.projects.push(next);
    }
    this.state.activeProjectId = next.id;
    await this.persist();
    return toProjectRef(next);
  }

  async selectProject(projectId: string): Promise<ProjectRef> {
    await this.loadIfNeeded();
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    const canonical = await canonicalOrResolved(project.rootPath);
    if (canonical !== project.rootPath) {
      throw new Error(
        `Project folder moved or is unavailable: ${project.rootPath}`,
      );
    }
    const now = Date.now();
    project.lastOpenedAtMs = now;
    project.updatedAtMs = now;
    project.invalidReason = undefined;
    this.state.activeProjectId = project.id;
    await this.persist();
    return toProjectRef(project);
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
            sessionFile: await canonicalOrResolved(summary.sessionFile),
          })),
        ),
        Promise.all(
          missingSessionFiles.map((sessionFile) =>
            canonicalOrResolved(sessionFile),
          ),
        ),
      ]);

    await this.loadIfNeeded();
    const now = Date.now();
    const nextRefs = [...this.state.sessionRefs];
    const indexes = new Map(
      nextRefs.map((ref, index) => [
        sessionRefKey(ref.projectId, ref.sessionFile),
        index,
      ]),
    );
    let changed = false;

    for (const { summary, sessionFile } of canonicalSummaries) {
      const key = sessionRefKey(validProjectId, sessionFile);
      const index = indexes.get(key);
      const existing = index === undefined ? undefined : nextRefs[index];
      const candidate: ProjectSessionRef = {
        projectId: validProjectId,
        sessionFile,
        ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
        title: summary.title,
        ...(summary.cwd ? { cwd: summary.cwd } : {}),
        ...(summary.preview ? { preview: summary.preview } : {}),
        addedAtMs: existing?.addedAtMs ?? now,
        lastSeenAtMs: existing?.lastSeenAtMs ?? now,
        lastKnownUpdatedAtMs: summary.updatedAtMs,
        ...(summary.createdAtMs !== undefined
          ? { createdAtMs: summary.createdAtMs }
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

    if (changed) {
      // Keep the on-disk schema as the final guard before committing the batch.
      const nextState = projectStoreFileSchema.parse({
        ...this.state,
        sessionRefs: nextRefs,
      });
      this.state = nextState;
      this.sessionRefsGeneration += 1;
    }

    // Retry a prior failed batch write even when this scan produced the same
    // normalized state. Otherwise the in-memory update could be lost at exit.
    if (
      changed ||
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
    messageCount?: number;
    preview?: string;
  }): Promise<void> {
    await this.loadIfNeeded();
    const sessionFile = await canonicalOrResolved(options.sessionFile);
    const now = Date.now();
    const index = this.state.sessionRefs.findIndex(
      (ref) =>
        ref.projectId === options.projectId && ref.sessionFile === sessionFile,
    );
    const existing = index >= 0 ? this.state.sessionRefs[index] : undefined;
    const next: ProjectSessionRef = {
      projectId: options.projectId,
      sessionFile,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      title:
        options.title ??
        existing?.title ??
        path.basename(sessionFile, ".jsonl"),
      ...(options.cwd
        ? { cwd: options.cwd }
        : existing?.cwd
          ? { cwd: existing.cwd }
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
      messageCount: options.messageCount ?? existing?.messageCount ?? 0,
    };
    if (index >= 0) {
      this.state.sessionRefs[index] = next;
    } else {
      this.state.sessionRefs.push(next);
    }
    await this.persist();
  }

  async getSessionRefs(projectId: string): Promise<ProjectSessionRef[]> {
    await this.loadIfNeeded();
    return this.state.sessionRefs.filter((ref) => ref.projectId === projectId);
  }

  async markSessionMissing(
    projectId: string,
    sessionFile: string,
  ): Promise<void> {
    await this.loadIfNeeded();
    const canonical = await canonicalOrResolved(sessionFile);
    const ref = this.state.sessionRefs.find(
      (item) => item.projectId === projectId && item.sessionFile === canonical,
    );
    if (ref && ref.missingSinceMs === undefined) {
      ref.missingSinceMs = Date.now();
      await this.persist();
    }
  }

  async removeSessionRef(
    projectId: string,
    sessionFile: string,
  ): Promise<void> {
    await this.loadIfNeeded();
    const canonical = await canonicalOrResolved(sessionFile);
    this.state.sessionRefs = this.state.sessionRefs.filter(
      (ref) => !(ref.projectId === projectId && ref.sessionFile === canonical),
    );
    await this.persist();
  }

  private getActiveProjectRecordSync(): ProjectRecord | undefined {
    const activeId = this.state.activeProjectId;
    return activeId
      ? this.state.projects.find((project) => project.id === activeId)
      : undefined;
  }

  private async persist(): Promise<void> {
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        const sessionRefsGeneration = this.sessionRefsGeneration;
        await this.writeStoreFile();
        this.persistedSessionRefsGeneration = Math.max(
          this.persistedSessionRefsGeneration,
          sessionRefsGeneration,
        );
      });
    return this.persistQueue;
  }

  private async writeStoreFile(): Promise<void> {
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    const tempFile = `${this.storeFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(tempFile, this.storeFile);
  }
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
    existing.preview === candidate.preview &&
    existing.lastKnownUpdatedAtMs === candidate.lastKnownUpdatedAtMs &&
    existing.createdAtMs === candidate.createdAtMs &&
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

async function canonicalOrResolved(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
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
