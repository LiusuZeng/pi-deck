import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  workflowRunSchema,
  workflowTemplateDefinitionSchema,
  workflowTemplateSchema,
  type WorkflowRun,
  type WorkflowTemplate,
  type WorkflowTemplateDefinition,
} from "../../shared/workflowSchemas.js";
import {
  workflowDefinitionSchema,
  workflowOccurrenceSchema,
  workflowRunEnvelopeSchema,
  type WorkflowDefinition,
  type WorkflowOccurrence,
  type WorkflowRunEnvelope,
} from "../../shared/agentWorkflowSchemas.js";
import {
  migrateV1Template,
  migrateV2NodeIds,
  preserveLegacyRun,
  type LegacyV2MigrationFile,
} from "./workflowMigrations.js";
import type { DiagnosticsRecorder } from "../diagnostics/diagnostics.js";

const v1StoreSchema = z
  .object({
    version: z.literal(1),
    templates: z.array(workflowTemplateSchema),
    runs: z.array(workflowRunSchema),
  })
  .strict();
const v2AgentWorkflowStoreSchema = z
  .object({
    version: z.literal(2),
    workflows: z.array(workflowDefinitionSchema),
    /** Migration-only pre-canonical occurrence records. */
    occurrences: z.array(workflowOccurrenceSchema).default([]),
    /** Canonical occurrence-based runs. */
    runs: z.array(workflowRunEnvelopeSchema).default([]),
    legacyRuns: z.array(workflowRunSchema),
    // Scope is store metadata, never part of the canonical agentWorkflow document.
    // Omitted entries are global for compatibility with already-persisted agentWorkflow files.
    workflowScopes: z
      .record(z.string(), z.string().min(1).max(120))
      .default({}),
  })
  .strict();
const agentWorkflowStoreSchema = v2AgentWorkflowStoreSchema.extend({
  version: z.literal(3),
});
/**
 * v2 used the current document shape but allowed human-readable node and edge
 * identities. Parse that historical boundary separately; every migrated result
 * is still parsed by `agentWorkflowStoreSchema` before it is persisted.
 */
const legacyV2AgentWorkflowStoreSchema = z
  .object({
    version: z.literal(2),
    workflows: z.array(z.unknown()),
    occurrences: z.array(z.unknown()).default([]),
    runs: z.array(z.unknown()).default([]),
    legacyRuns: z.array(workflowRunSchema),
    workflowScopes: z
      .record(z.string(), z.string().min(1).max(120))
      .default({}),
  })
  .strict();
type V1Store = z.infer<typeof v1StoreSchema>;
type V2WorkflowStoreFile = z.infer<typeof v2AgentWorkflowStoreSchema>;
type LegacyV2WorkflowStoreFile = Omit<
  V2WorkflowStoreFile,
  "workflows" | "occurrences" | "runs"
> &
  LegacyV2MigrationFile;
type WorkflowStoreFile = z.infer<typeof agentWorkflowStoreSchema>;
const emptyStore = (): WorkflowStoreFile => ({
  version: 3,
  workflows: [],
  occurrences: [],
  runs: [],
  legacyRuns: [],
  workflowScopes: {},
});

/** Version-aware store. v1 runs remain in `legacyRuns`; they are never forged into agentWorkflow occurrences. */
export class WorkflowStore {
  readonly storeFile: string;
  private state = emptyStore();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly piDeckHome: string,
    private readonly diagnostics?: DiagnosticsRecorder,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.storeFile = path.join(piDeckHome, "workflows.json");
  }

  async loadIfNeeded(): Promise<void> {
    if (!this.loaded) {
      this.loadPromise ??= this.load();
      await this.loadPromise;
    }
  }
  async listWorkflows(workspaceId?: string): Promise<WorkflowDefinition[]> {
    await this.loadIfNeeded();
    return clone(
      this.state.workflows.filter(
        (workflow) =>
          workspaceId === undefined ||
          this.state.workflowScopes[workflow.id] === undefined ||
          this.state.workflowScopes[workflow.id] === workspaceId,
      ),
    ).sort((a, b) => b.revision - a.revision);
  }
  async getWorkflow(id: string): Promise<WorkflowDefinition> {
    await this.loadIfNeeded();
    const workflow = this.state.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error(`Unknown workflow: ${id}`);
    return clone(workflow);
  }
  async getWorkflowScope(id: string): Promise<string | undefined> {
    await this.loadIfNeeded();
    if (!this.state.workflows.some((item) => item.id === id))
      throw new Error(`Unknown workflow: ${id}`);
    return this.state.workflowScopes[id];
  }
  async getWorkflowForWorkspace(
    id: string,
    workspaceId: string,
  ): Promise<WorkflowDefinition> {
    const workflow = await this.getWorkflow(id);
    const scope = this.state.workflowScopes[id];
    if (scope !== undefined && scope !== workspaceId)
      throw new Error(`Workflow ${id} is not available in this workspace`);
    return workflow;
  }
  async createWorkflow(
    workflow: WorkflowDefinition,
    workspaceId?: string,
  ): Promise<WorkflowDefinition> {
    await this.loadIfNeeded();
    const parsed = workflowDefinitionSchema.parse(workflow);
    if (this.state.workflows.some((item) => item.id === parsed.id))
      throw new Error(`Workflow already exists: ${parsed.id}`);
    await this.commit({
      ...this.state,
      workflows: [...this.state.workflows, parsed],
      workflowScopes:
        workspaceId === undefined
          ? this.state.workflowScopes
          : { ...this.state.workflowScopes, [parsed.id]: workspaceId },
    });
    return clone(parsed);
  }
  async updateWorkflow(
    workflow: WorkflowDefinition,
    workspaceId?: string,
    scopeWorkspaceId?: string | null,
  ): Promise<WorkflowDefinition> {
    await this.loadIfNeeded();
    const parsed = workflowDefinitionSchema.parse(workflow);
    const index = this.state.workflows.findIndex(
      (item) => item.id === parsed.id,
    );
    if (index < 0) throw new Error(`Unknown workflow: ${parsed.id}`);
    const scope = this.state.workflowScopes[parsed.id];
    if (scope !== undefined && workspaceId !== scope)
      throw new Error(
        `Workflow ${parsed.id} is not available in this workspace`,
      );
    const workflows = [...this.state.workflows];
    workflows[index] = parsed;
    const workflowScopes = { ...this.state.workflowScopes };
    if (scopeWorkspaceId !== undefined) {
      if (scopeWorkspaceId === null) delete workflowScopes[parsed.id];
      else workflowScopes[parsed.id] = scopeWorkspaceId;
    }
    await this.commit({ ...this.state, workflows, workflowScopes });
    return clone(parsed);
  }
  async listOccurrences(): Promise<WorkflowOccurrence[]> {
    await this.loadIfNeeded();
    return clone(this.state.occurrences);
  }
  async createOccurrence(
    occurrence: WorkflowOccurrence,
  ): Promise<WorkflowOccurrence> {
    await this.loadIfNeeded();
    const parsed = workflowOccurrenceSchema.parse(occurrence);
    await this.commit({
      ...this.state,
      occurrences: [...this.state.occurrences, parsed],
    });
    return clone(parsed);
  }

  /** Canonical run CRUD. Legacy run history remains in its explicit compatibility list. */
  async listWorkflowRuns(workspaceId?: string): Promise<WorkflowRunEnvelope[]> {
    await this.loadIfNeeded();
    return clone(
      this.state.runs.filter(
        (run) => workspaceId === undefined || run.workspaceId === workspaceId,
      ),
    );
  }
  async getWorkflowRun(id: string): Promise<WorkflowRunEnvelope> {
    await this.loadIfNeeded();
    const run = this.state.runs.find((item) => item.id === id);
    if (!run) throw new Error(`Unknown canonical workflow run: ${id}`);
    return clone(run);
  }
  async createWorkflowRun(
    run: WorkflowRunEnvelope,
  ): Promise<WorkflowRunEnvelope> {
    await this.loadIfNeeded();
    const parsed = workflowRunEnvelopeSchema.parse(run);
    if (this.state.runs.some((item) => item.id === parsed.id))
      throw new Error(`Workflow run already exists: ${parsed.id}`);
    await this.commit({ ...this.state, runs: [...this.state.runs, parsed] });
    return clone(parsed);
  }
  async updateWorkflowRun(
    run: WorkflowRunEnvelope,
  ): Promise<WorkflowRunEnvelope> {
    await this.loadIfNeeded();
    const parsed = workflowRunEnvelopeSchema.parse(run);
    const index = this.state.runs.findIndex((item) => item.id === parsed.id);
    if (index < 0)
      throw new Error(`Unknown canonical workflow run: ${parsed.id}`);
    // This is the single persistence boundary for scheduler transitions.  Assign
    // the sequence here so state is durable before the scheduler publishes it.
    const saved = { ...parsed, revision: this.state.runs[index]!.revision + 1 };
    const runs = [...this.state.runs];
    runs[index] = saved;
    await this.commit({ ...this.state, runs });
    return clone(saved);
  }

  // Compatibility boundary for the pre-agentWorkflow UI/runtime. It only handles v1
  // templates that can be normalized to Workers; agentWorkflow runtime APIs use methods above.
  async listTemplates(workspaceId?: string): Promise<WorkflowTemplate[]> {
    await this.loadIfNeeded();
    return this.state.workflows
      .map((workflow) =>
        workflowToLegacyTemplate(
          workflow,
          this.state.workflowScopes[workflow.id],
        ),
      )
      .filter((item): item is WorkflowTemplate => item !== undefined)
      .filter(
        (item) =>
          workspaceId === undefined ||
          item.workspaceId === undefined ||
          item.workspaceId === workspaceId,
      )
      .map(clone);
  }
  async getTemplate(templateId: string): Promise<WorkflowTemplate> {
    const template = (await this.listTemplates()).find(
      (item) => item.id === templateId,
    );
    if (!template) throw new Error(`Unknown workflow template: ${templateId}`);
    return template;
  }
  async createTemplate(
    definition: WorkflowTemplateDefinition,
  ): Promise<WorkflowTemplate> {
    const validated = workflowTemplateDefinitionSchema.parse(definition);
    const now = this.now();
    const template = workflowTemplateSchema.parse({
      ...validated,
      id: randomUUID(),
      createdAtMs: now,
      updatedAtMs: now,
    });
    await this.createWorkflow(
      migrateV1Template(template),
      template.workspaceId,
    );
    return template;
  }
  async updateTemplate(
    templateId: string,
    definition: WorkflowTemplateDefinition,
  ): Promise<WorkflowTemplate> {
    const current = await this.getTemplate(templateId);
    const validated = workflowTemplateDefinitionSchema.parse(definition);
    const template = workflowTemplateSchema.parse({
      ...validated,
      id: current.id,
      createdAtMs: current.createdAtMs,
      updatedAtMs: this.now(),
    });
    await this.updateWorkflow(migrateV1Template(template), current.workspaceId);
    return template;
  }
  async archiveTemplate(templateId: string): Promise<WorkflowTemplate> {
    throw new Error(
      `Archiving v1 workflow templates is not supported after agentWorkflow migration: ${templateId}`,
    );
  }
  async duplicateTemplate(templateId: string): Promise<WorkflowTemplate> {
    const source = await this.getTemplate(templateId);
    return this.createTemplate({
      ...source,
      name: `${source.name} copy`,
      steps: source.steps,
      transitions: source.transitions,
      inputs: source.inputs,
      ...(source.description === undefined
        ? {}
        : { description: source.description }),
      ...(source.workspaceId === undefined
        ? {}
        : { workspaceId: source.workspaceId }),
    });
  }
  async listRuns(workspaceId?: string): Promise<WorkflowRun[]> {
    await this.loadIfNeeded();
    return clone(
      this.state.legacyRuns.filter(
        (run) => workspaceId === undefined || run.workspaceId === workspaceId,
      ),
    );
  }
  async getRun(runId: string): Promise<WorkflowRun> {
    await this.loadIfNeeded();
    const run = this.state.legacyRuns.find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown workflow run: ${runId}`);
    return clone(run);
  }
  async createRun(run: WorkflowRun): Promise<WorkflowRun> {
    await this.loadIfNeeded();
    const parsed = workflowRunSchema.parse(run);
    await this.commit({
      ...this.state,
      legacyRuns: [...this.state.legacyRuns, parsed],
    });
    return clone(parsed);
  }
  async updateRun(run: WorkflowRun): Promise<WorkflowRun> {
    await this.loadIfNeeded();
    const parsed = workflowRunSchema.parse(run);
    const index = this.state.legacyRuns.findIndex(
      (item) => item.id === parsed.id,
    );
    if (index < 0) throw new Error(`Unknown workflow run: ${parsed.id}`);
    const legacyRuns = [...this.state.legacyRuns];
    legacyRuns[index] = parsed;
    await this.commit({ ...this.state, legacyRuns });
    return clone(parsed);
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(this.storeFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const version = z
        .object({ version: z.number() })
        .passthrough()
        .parse(parsed).version;
      if (version === 1) {
        const v1 = v1StoreSchema.parse(parsed);
        await this.writeRawBackupAtomically(raw, "v1-backup");
        this.state = migrateV1(v1);
        await this.persist();
      } else if (version === 2) {
        await this.migrateV2NodeIds(
          raw,
          legacyV2AgentWorkflowStoreSchema.parse(
            parsed,
          ) as LegacyV2WorkflowStoreFile,
        );
      } else if (version === 3) {
        const v3 = agentWorkflowStoreSchema.safeParse(parsed);
        if (!v3.success)
          throw new UnsupportedWorkflowStoreVersionError(version);
        this.state = v3.data;
      } else throw new UnsupportedWorkflowStoreVersionError(version);
    } catch (error) {
      if (
        error instanceof UnsupportedWorkflowStoreVersionError ||
        error instanceof WorkflowStoreMigrationError
      ) {
        this.diagnostics?.recordError(error.message);
        throw error;
      }
      if (!isMissingFile(error)) {
        const backup = `${this.storeFile}.corrupt-${this.now()}`;
        this.diagnostics?.recordError(
          `Pi Deck workflow metadata was invalid and defaults were applied: ${errorToMessage(error)}`,
        );
        try {
          await fs.rename(this.storeFile, backup);
        } catch {
          /* best effort */
        }
      }
      this.state = emptyStore();
      await this.persist();
    }
    this.loaded = true;
  }
  private async migrateV2NodeIds(
    raw: string,
    source: LegacyV2WorkflowStoreFile,
  ): Promise<void> {
    try {
      const migrated = migrateV2NodeIds(source);
      // Validate the complete candidate before preserving a recovery point or
      // replacing the source file. Legacy runs deliberately remain untouched.
      const next = agentWorkflowStoreSchema.parse({
        ...source,
        ...migrated,
        version: 3,
      });
      await this.writeRawBackupAtomically(raw, "v2-node-id-backup");
      this.state = next;
      await this.persist();
    } catch (error) {
      throw new WorkflowStoreMigrationError(error);
    }
  }
  private async writeRawBackupAtomically(
    raw: string,
    kind: string,
  ): Promise<void> {
    const backup = `${this.storeFile}.${kind}-${this.now()}`;
    const temp = `${backup}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(temp, raw, { mode: 0o600, flag: "wx" });
      // link creates the final backup name without replacing an existing backup.
      await fs.link(temp, backup);
      await fs.rm(temp);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  private async commit(next: WorkflowStoreFile): Promise<void> {
    this.state = agentWorkflowStoreSchema.parse(next);
    await this.persist();
  }
  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        const temp = `${this.storeFile}.tmp-${process.pid}-${this.now()}-${Math.random().toString(36).slice(2)}`;
        await fs.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, {
          mode: 0o600,
        });
        await fs.rename(temp, this.storeFile);
      });
    return this.persistQueue;
  }
}

export function migrateV1(file: V1Store): WorkflowStoreFile {
  const v2 = {
    version: 2 as const,
    workflows: file.templates.map(migrateV1Template),
    occurrences: [],
    runs: [],
    legacyRuns: file.runs.map(preserveLegacyRun),
    workflowScopes: Object.fromEntries(
      file.templates.flatMap((template) =>
        template.workspaceId === undefined
          ? []
          : [[template.id, template.workspaceId]],
      ),
    ),
  };
  return agentWorkflowStoreSchema.parse({
    ...v2,
    version: 3,
  });
}
export class UnsupportedWorkflowStoreVersionError extends Error {
  constructor(version: number) {
    super(`Unsupported workflow metadata version: ${version}`);
    this.name = "UnsupportedWorkflowStoreVersionError";
  }
}
class WorkflowStoreMigrationError extends Error {
  constructor(error: unknown) {
    super(
      `Could not migrate v2 workflow node identities: ${errorToMessage(error)}`,
    );
    this.name = "WorkflowStoreMigrationError";
  }
}
function workflowToLegacyTemplate(
  workflow: WorkflowDefinition,
  workspaceId?: string,
): WorkflowTemplate | undefined {
  // Canonical role workflows may exceed the compatibility runtime. Do not
  // misrepresent them as compatibility templates.
  if (
    workflow.nodes.some((node) => node.role !== "worker" || node.managedBy) ||
    workflow.relationships.some((edge) => edge.when || !("nodeId" in edge.to))
  )
    return undefined;
  const now = 0;
  const result = workflowTemplateSchema.safeParse({
    id: workflow.id,
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    inputs: workflow.inputs,
    steps: workflow.nodes.map((node) => {
      // The preflight above excludes other roles, but narrow here as well so
      // only Worker configuration is ever read as legacy instructions.
      if (node.role !== "worker") return undefined;
      return {
        id: node.id,
        name: node.name,
        kind: "agent",
        promptParts: [{ type: "text", text: node.config.instructions }],
        inputPolicy: {
          includeWorkflowContext: false,
          includeParentFinalAnswer: false,
          includeParentSummary: false,
          includeParentTranscript: false,
        },
        startPolicy: "auto",
      };
    }),
    transitions: workflow.relationships.map((edge) => ({
      id: edge.id,
      fromStepId: edge.from,
      kind: "always",
      toStepId: (edge.to as { nodeId: string }).nodeId,
    })),
    createdAtMs: now,
    updatedAtMs: now,
  });
  return result.success ? result.data : undefined;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT",
  );
}
function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
