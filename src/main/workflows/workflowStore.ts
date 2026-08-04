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
import type { DiagnosticsRecorder } from "../diagnostics/diagnostics.js";

const workflowStoreFileSchema = z
  .object({
    version: z.literal(1),
    templates: z.array(workflowTemplateSchema),
    runs: z.array(workflowRunSchema),
  })
  .strict();

type WorkflowStoreFile = z.infer<typeof workflowStoreFileSchema>;

const emptyStore = (): WorkflowStoreFile => ({
  version: 1,
  templates: [],
  runs: [],
});

export class WorkflowStore {
  readonly storeFile: string;
  private state: WorkflowStoreFile = emptyStore();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private persistQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private persistedGeneration = 0;

  constructor(
    private readonly piDeckHome: string,
    private readonly diagnostics?: DiagnosticsRecorder,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.storeFile = path.join(piDeckHome, "workflows.json");
  }

  async loadIfNeeded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.load();
    await this.loadPromise;
  }

  async listTemplates(workspaceId?: string): Promise<WorkflowTemplate[]> {
    await this.loadIfNeeded();
    return this.state.templates
      .filter(
        (template) =>
          template.archivedAtMs === undefined &&
          (workspaceId === undefined ||
            template.workspaceId === undefined ||
            template.workspaceId === workspaceId),
      )
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .map(clone);
  }

  async getTemplate(templateId: string): Promise<WorkflowTemplate> {
    await this.loadIfNeeded();
    const template = this.state.templates.find(
      (item) => item.id === templateId,
    );
    if (template === undefined || template.archivedAtMs !== undefined) {
      throw new Error(`Unknown workflow template: ${templateId}`);
    }
    return clone(template);
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
      templates: [...this.state.templates, template],
    });
    return clone(template);
  }

  async updateTemplate(
    templateId: string,
    definition: WorkflowTemplateDefinition,
  ): Promise<WorkflowTemplate> {
    await this.loadIfNeeded();
    const index = this.state.templates.findIndex(
      (item) => item.id === templateId,
    );
    if (index < 0 || this.state.templates[index]!.archivedAtMs !== undefined) {
      throw new Error(`Unknown workflow template: ${templateId}`);
    }
    const current = this.state.templates[index]!;
    const validated = workflowTemplateDefinitionSchema.parse(definition);
    const updated = workflowTemplateSchema.parse({
      ...validated,
      // A global template must remain global when a renderer update includes
      // the current workspace as context. Scoped templates keep the existing
      // update behavior and may change scope through the definition.
      ...(current.workspaceId === undefined ? { workspaceId: undefined } : {}),
      id: current.id,
      createdAtMs: current.createdAtMs,
      updatedAtMs: this.now(),
    });
    const templates = [...this.state.templates];
    templates[index] = updated;
    await this.commit({ ...this.state, templates });
    return clone(updated);
  }

  async archiveTemplate(templateId: string): Promise<WorkflowTemplate> {
    await this.loadIfNeeded();
    const index = this.state.templates.findIndex(
      (item) => item.id === templateId,
    );
    if (index < 0) throw new Error(`Unknown workflow template: ${templateId}`);
    const current = this.state.templates[index]!;
    if (current.archivedAtMs !== undefined) return clone(current);
    const archived = {
      ...current,
      archivedAtMs: this.now(),
      updatedAtMs: this.now(),
    };
    const templates = [...this.state.templates];
    templates[index] = archived;
    await this.commit({ ...this.state, templates });
    return clone(archived);
  }

  async duplicateTemplate(templateId: string): Promise<WorkflowTemplate> {
    const source = await this.getTemplate(templateId);
    return this.createTemplate({
      name: `${source.name} copy`,
      ...(source.description !== undefined
        ? { description: source.description }
        : {}),
      ...(source.workspaceId !== undefined
        ? { workspaceId: source.workspaceId }
        : {}),
      ...(source.context !== undefined ? { context: source.context } : {}),
      ...(source.defaultModel !== undefined
        ? { defaultModel: source.defaultModel }
        : {}),
      ...(source.defaultThinkingLevel !== undefined
        ? { defaultThinkingLevel: source.defaultThinkingLevel }
        : {}),
      inputs: source.inputs,
      steps: source.steps,
      transitions: source.transitions,
    });
  }

  async listRuns(workspaceId?: string): Promise<WorkflowRun[]> {
    await this.loadIfNeeded();
    return this.state.runs
      .filter(
        (run) => workspaceId === undefined || run.workspaceId === workspaceId,
      )
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .map(clone);
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    await this.loadIfNeeded();
    const run = this.state.runs.find((item) => item.id === runId);
    if (run === undefined) throw new Error(`Unknown workflow run: ${runId}`);
    return clone(run);
  }

  async createRun(run: WorkflowRun): Promise<WorkflowRun> {
    await this.loadIfNeeded();
    const validated = workflowRunSchema.parse(run);
    await this.commit({ ...this.state, runs: [...this.state.runs, validated] });
    return clone(validated);
  }

  async updateRun(run: WorkflowRun): Promise<WorkflowRun> {
    await this.loadIfNeeded();
    const validated = workflowRunSchema.parse(run);
    const index = this.state.runs.findIndex((item) => item.id === validated.id);
    if (index < 0) throw new Error(`Unknown workflow run: ${validated.id}`);
    const runs = [...this.state.runs];
    runs[index] = validated;
    await this.commit({ ...this.state, runs });
    return clone(validated);
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(this.storeFile, "utf8");
      this.state = workflowStoreFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (!isMissingFile(error)) {
        const backup = `${this.storeFile}.corrupt-${this.now()}`;
        this.diagnostics?.recordError(
          `Pi Deck workflow metadata was invalid and defaults were applied: ${errorToMessage(error)}`,
        );
        try {
          await fs.rename(this.storeFile, backup);
        } catch {
          // Recovery remains safe even when the corrupt backup cannot be made.
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
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        const generation = this.generation;
        const tempFile = `${this.storeFile}.tmp-${process.pid}-${this.now()}-${Math.random().toString(36).slice(2)}`;
        await fs.mkdir(this.piDeckHome, { recursive: true, mode: 0o700 });
        await fs.writeFile(
          tempFile,
          `${JSON.stringify(this.state, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        await fs.rename(tempFile, this.storeFile);
        this.persistedGeneration = Math.max(
          this.persistedGeneration,
          generation,
        );
      });
    return this.persistQueue;
  }
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
