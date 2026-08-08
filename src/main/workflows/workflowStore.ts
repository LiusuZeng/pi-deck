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
  roleWorkflowSchema,
  workflowOccurrenceSchema,
  type RoleWorkflow,
  type WorkflowOccurrence,
} from "../../shared/workflowV2Schemas.js";
import type { DiagnosticsRecorder } from "../diagnostics/diagnostics.js";

const workflowStoreFileV1Schema = z
  .object({
    version: z.literal(1),
    templates: z.array(workflowTemplateSchema),
    runs: z.array(workflowRunSchema),
  })
  .strict();
const workflowStoreFileSchema = z
  .object({
    version: z.literal(2),
    roleWorkflows: z.array(roleWorkflowSchema),
    occurrences: z.array(workflowOccurrenceSchema),
  })
  .strict();
type WorkflowStoreFile = z.infer<typeof workflowStoreFileSchema>;
type WorkflowStoreFileV1 = z.infer<typeof workflowStoreFileV1Schema>;
const emptyStore = (): WorkflowStoreFile => ({
  version: 2,
  roleWorkflows: [],
  occurrences: [],
});

/** Persistent v2 store. The v1-named methods are intentionally adapters while
 * IPC/runtime move independently; on disk only role workflows/occurrences are written. */
export class WorkflowStore {
  readonly storeFile: string;
  private state: WorkflowStoreFile = emptyStore();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private persistQueue: Promise<void> = Promise.resolve();
  private generation = 0;

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

  async listTemplates(workspaceId?: string): Promise<WorkflowTemplate[]> {
    await this.loadIfNeeded();
    return this.state.roleWorkflows
      .filter(
        (item) =>
          item.archivedAtMs === undefined &&
          (workspaceId === undefined ||
            item.workspaceId === undefined ||
            item.workspaceId === workspaceId),
      )
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map((item) => clone(roleWorkflowToTemplate(item)));
  }
  async getTemplate(templateId: string): Promise<WorkflowTemplate> {
    await this.loadIfNeeded();
    const item = this.state.roleWorkflows.find(
      (candidate) => candidate.id === templateId,
    );
    if (!item || item.archivedAtMs !== undefined)
      throw new Error(`Unknown workflow template: ${templateId}`);
    return clone(roleWorkflowToTemplate(item));
  }
  async createTemplate(
    definition: WorkflowTemplateDefinition,
  ): Promise<WorkflowTemplate> {
    await this.loadIfNeeded();
    const validated = workflowTemplateDefinitionSchema.parse(definition);
    const now = this.now();
    const template = workflowTemplateSchema.parse({
      ...validated,
      id: randomUUID(),
      createdAtMs: now,
      updatedAtMs: now,
    });
    await this.commit({
      ...this.state,
      roleWorkflows: [
        ...this.state.roleWorkflows,
        templateToRoleWorkflow(template),
      ],
    });
    return clone(template);
  }
  async updateTemplate(
    templateId: string,
    definition: WorkflowTemplateDefinition,
  ): Promise<WorkflowTemplate> {
    await this.loadIfNeeded();
    const index = this.state.roleWorkflows.findIndex(
      (item) => item.id === templateId,
    );
    if (
      index < 0 ||
      this.state.roleWorkflows[index]!.archivedAtMs !== undefined
    )
      throw new Error(`Unknown workflow template: ${templateId}`);
    const current = this.state.roleWorkflows[index]!;
    const validated = workflowTemplateDefinitionSchema.parse(definition);
    const updated = workflowTemplateSchema.parse({
      ...validated,
      id: current.id,
      createdAtMs: current.createdAtMs,
      updatedAtMs: this.now(),
    });
    const roleWorkflows = [...this.state.roleWorkflows];
    roleWorkflows[index] = templateToRoleWorkflow(updated);
    await this.commit({ ...this.state, roleWorkflows });
    return clone(updated);
  }
  async archiveTemplate(templateId: string): Promise<WorkflowTemplate> {
    await this.loadIfNeeded();
    const index = this.state.roleWorkflows.findIndex(
      (item) => item.id === templateId,
    );
    if (index < 0) throw new Error(`Unknown workflow template: ${templateId}`);
    const current = this.state.roleWorkflows[index]!;
    if (current.archivedAtMs !== undefined)
      return clone(roleWorkflowToTemplate(current));
    const archived = roleWorkflowSchema.parse({
      ...current,
      archivedAtMs: this.now(),
      updatedAtMs: this.now(),
    });
    const roleWorkflows = [...this.state.roleWorkflows];
    roleWorkflows[index] = archived;
    await this.commit({ ...this.state, roleWorkflows });
    return clone(roleWorkflowToTemplate(archived));
  }
  async duplicateTemplate(templateId: string): Promise<WorkflowTemplate> {
    const source = await this.getTemplate(templateId);
    return this.createTemplate({
      name: `${source.name} copy`,
      ...(source.description === undefined
        ? {}
        : { description: source.description }),
      ...(source.workspaceId === undefined
        ? {}
        : { workspaceId: source.workspaceId }),
      ...(source.context === undefined ? {} : { context: source.context }),
      ...(source.defaultModel === undefined
        ? {}
        : { defaultModel: source.defaultModel }),
      ...(source.defaultThinkingLevel === undefined
        ? {}
        : { defaultThinkingLevel: source.defaultThinkingLevel }),
      inputs: source.inputs,
      steps: source.steps,
      transitions: source.transitions,
    });
  }
  async listRuns(workspaceId?: string): Promise<WorkflowRun[]> {
    await this.loadIfNeeded();
    return this.state.occurrences
      .filter(
        (item) => workspaceId === undefined || item.workspaceId === workspaceId,
      )
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map((item) => clone(occurrenceToRun(item)));
  }
  async getRun(runId: string): Promise<WorkflowRun> {
    await this.loadIfNeeded();
    const item = this.state.occurrences.find(
      (candidate) => candidate.id === runId,
    );
    if (!item) throw new Error(`Unknown workflow run: ${runId}`);
    return clone(occurrenceToRun(item));
  }
  async createRun(run: WorkflowRun): Promise<WorkflowRun> {
    await this.loadIfNeeded();
    const validated = workflowRunSchema.parse(run);
    await this.commit({
      ...this.state,
      occurrences: [...this.state.occurrences, runToOccurrence(validated)],
    });
    return clone(validated);
  }
  async updateRun(run: WorkflowRun): Promise<WorkflowRun> {
    await this.loadIfNeeded();
    const validated = workflowRunSchema.parse(run);
    const index = this.state.occurrences.findIndex(
      (item) => item.id === validated.id,
    );
    if (index < 0) throw new Error(`Unknown workflow run: ${validated.id}`);
    const occurrences = [...this.state.occurrences];
    occurrences[index] = runToOccurrence(validated);
    await this.commit({ ...this.state, occurrences });
    return clone(validated);
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(this.storeFile, "utf8"),
      );
      const version = z
        .object({ version: z.number() })
        .passthrough()
        .parse(parsed).version;
      if (version === 1) {
        this.state = migrateV1(workflowStoreFileV1Schema.parse(parsed));
        this.generation += 1;
        await this.persist();
      } else if (version === 2)
        this.state = workflowStoreFileSchema.parse(parsed);
      else throw new Error(`Unsupported workflow metadata version: ${version}`);
    } catch (error) {
      if (!isMissingFile(error)) {
        const backup = `${this.storeFile}.corrupt-${this.now()}`;
        this.diagnostics?.recordError(
          `Pi Deck workflow metadata was invalid and defaults were applied: ${errorToMessage(error)}`,
        );
        try {
          await fs.rename(this.storeFile, backup);
        } catch {
          /* recovery is still safe */
        }
      }
      this.state = emptyStore();
      this.generation += 1;
      await this.persist();
    }
    this.loaded = true;
  }
  private async commit(next: WorkflowStoreFile): Promise<void> {
    this.state = workflowStoreFileSchema.parse(next);
    this.generation += 1;
    await this.persist();
  }
  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const generation = this.generation;
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        const tempFile = `${this.storeFile}.tmp-${process.pid}-${this.now()}-${Math.random().toString(36).slice(2)}`;
        await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
        await fs.writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
          mode: 0o600,
        });
        await fs.rename(tempFile, this.storeFile);
        void generation;
      });
    return this.persistQueue;
  }
}

/** Pure, lossless and idempotent v1 -> v2 migration. */
export function migrateV1(file: WorkflowStoreFileV1): WorkflowStoreFile {
  return workflowStoreFileSchema.parse({
    version: 2,
    roleWorkflows: file.templates.map(templateToRoleWorkflow),
    occurrences: file.runs.map(runToOccurrence),
  });
}
function templateToRoleWorkflow(template: WorkflowTemplate): RoleWorkflow {
  const { steps, ...rest } = template;
  return roleWorkflowSchema.parse({ ...rest, roles: steps });
}
function roleWorkflowToTemplate(workflow: RoleWorkflow): WorkflowTemplate {
  const { roles, ...rest } = workflow;
  return workflowTemplateSchema.parse({ ...rest, steps: roles });
}
function runToOccurrence(run: WorkflowRun): WorkflowOccurrence {
  const { templateId, templateSnapshot, stepRuns, transitionRuns, ...rest } =
    run;
  return workflowOccurrenceSchema.parse({
    ...rest,
    ...(templateId === undefined ? {} : { roleWorkflowId: templateId }),
    roleWorkflowSnapshot: templateToRoleWorkflow(templateSnapshot),
    roleOccurrences: stepRuns,
    transitionOccurrences: transitionRuns,
  });
}
function occurrenceToRun(occurrence: WorkflowOccurrence): WorkflowRun {
  const {
    roleWorkflowId,
    roleWorkflowSnapshot,
    roleOccurrences,
    transitionOccurrences,
    ...rest
  } = occurrence;
  return workflowRunSchema.parse({
    ...rest,
    ...(roleWorkflowId === undefined ? {} : { templateId: roleWorkflowId }),
    templateSnapshot: roleWorkflowToTemplate(roleWorkflowSnapshot),
    stepRuns: roleOccurrences,
    transitionRuns: transitionOccurrences,
  });
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
