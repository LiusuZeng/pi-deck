import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowStore,
  UnsupportedWorkflowStoreVersionError,
} from "./workflowStore.js";
import { createWorkflowRun } from "./workflowEngine.js";
import { createWorkflowRoleRun } from "./agentWorkflowRuntime.js";
import type { WorkflowTemplateDefinition } from "../../shared/workflowSchemas.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
const legacyDefinition: WorkflowTemplateDefinition = {
  name: "Legacy",
  inputs: [],
  steps: [
    {
      id: "work",
      name: "Work",
      kind: "agent",
      promptParts: [{ type: "text", text: "Do the work" }],
      inputPolicy: {
        includeWorkflowContext: false,
        includeParentFinalAnswer: false,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
      startPolicy: "auto",
    },
  ],
  transitions: [],
};
async function fresh(): Promise<WorkflowStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-workflow-"));
  dirs.push(dir);
  return new WorkflowStore(dir, undefined, () => 123);
}
const nativeWorkflowId = "00000000-0000-4000-8000-000000000001";
const nativeWorkerId = "00000000-0000-4000-8000-000000000002";
const agentWorkflowDefinition = () => ({
  format: "pi-deck.agent-workflow" as const,
  schemaVersion: 2 as const,
  id: nativeWorkflowId,
  revision: 1,
  name: "Native",
  description: "",
  inputs: [],
  entryNodeId: nativeWorkerId,
  nodes: [
    {
      id: nativeWorkerId,
      name: "Worker",
      role: "worker" as const,
      config: { instructions: "work" },
    },
  ],
  relationships: [],
});

describe("WorkflowStore agentWorkflow migration foundation", () => {
  it("persists native agentWorkflow workflows without v1 roles or templates", async () => {
    const store = await fresh();
    await store.createWorkflow(agentWorkflowDefinition());
    const disk = JSON.parse(await fs.readFile(store.storeFile, "utf8"));
    expect(disk).toMatchObject({
      version: 3,
      workflows: [agentWorkflowDefinition()],
      occurrences: [],
      legacyRuns: [],
    });
    expect(JSON.stringify(disk)).not.toContain('"roles"');
    expect(JSON.stringify(disk)).not.toContain('"templates"');
  });

  it("validates and updates canonical agentWorkflow workflows without coercing them to v1", async () => {
    const store = await fresh();
    await store.createWorkflow(agentWorkflowDefinition());
    await expect(
      store.createWorkflow(agentWorkflowDefinition()),
    ).rejects.toThrow(`Workflow already exists: ${nativeWorkflowId}`);
    await expect(
      store.updateWorkflow({
        ...agentWorkflowDefinition(),
        name: "Updated native",
        revision: 2,
      }),
    ).resolves.toMatchObject({ name: "Updated native", revision: 2 });
    await expect(
      store.updateWorkflow({
        ...agentWorkflowDefinition(),
        entryNodeId: "missing",
      }),
    ).rejects.toThrow(/Entry node/);
  });

  it("filters scoped workflows while retaining global definitions and rejects cross-workspace updates", async () => {
    const store = await fresh();
    const global = {
      ...agentWorkflowDefinition(),
      id: "00000000-0000-4000-8000-000000000003",
    };
    const scoped = {
      ...agentWorkflowDefinition(),
      id: "00000000-0000-4000-8000-000000000004",
    };
    await store.createWorkflow(global);
    await store.createWorkflow(scoped, "workspace-a");

    expect(
      (await store.listWorkflows("workspace-a")).map(({ id }) => id),
    ).toEqual([global.id, scoped.id]);
    expect(
      (await store.listWorkflows("workspace-b")).map(({ id }) => id),
    ).toEqual([global.id]);
    await expect(
      store.updateWorkflow({ ...scoped, revision: 2 }, "workspace-b"),
    ).rejects.toThrow("not available in this workspace");
    await store.updateWorkflow(
      { ...scoped, revision: 2 },
      "workspace-a",
      "workspace-b",
    );
    expect(await store.getWorkflowScope(scoped.id)).toBe("workspace-b");
    await store.updateWorkflow({ ...scoped, revision: 3 }, "workspace-b", null);
    expect(await store.getWorkflowScope(scoped.id)).toBeUndefined();
    expect(
      JSON.stringify(await fs.readFile(store.storeFile, "utf8")),
    ).not.toContain('"workspaceId"');
  });

  it("backs up v1, migrates templates to nodes, and preserves runs unchanged", async () => {
    const source = await fresh();
    const legacy = await source.createTemplate(legacyDefinition);
    const run = createWorkflowRun({
      template: legacy,
      workspaceId: "workspace",
      inputs: {},
    });
    const v1 = { version: 1, templates: [legacy], runs: [run] };
    await fs.writeFile(source.storeFile, JSON.stringify(v1));
    const migrated = new WorkflowStore(
      path.dirname(source.storeFile),
      undefined,
      () => 123,
    );
    const workflow = await migrated.getWorkflow(legacy.id);
    expect(workflow.nodes).toMatchObject([
      { role: "worker", config: { instructions: "Do the work" } },
    ]);
    // Definitions enter the canonical collection, while v1 run snapshots stay
    // available through the explicit compatibility boundary rather than being
    // forged into occurrence envelopes.
    expect(
      (await migrated.listWorkflows("workspace")).map(({ id }) => id),
    ).toEqual([legacy.id]);
    for (const node of workflow.nodes)
      expect(node.id).toMatch(/^[0-9a-f-]{36}$/i);
    for (const relationship of workflow.relationships)
      expect(relationship.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await migrated.getRun(run.id)).toEqual(run);
    expect(await migrated.listRuns("workspace")).toEqual([run]);
    const files = await fs.readdir(path.dirname(source.storeFile));
    expect(files).toContain("workflows.json.v1-backup-123");
    const disk = JSON.parse(await fs.readFile(source.storeFile, "utf8"));
    expect(disk.legacyRuns).toEqual([run]);
    expect(disk.occurrences).toEqual([]);
  });

  it("preserves a legacy template workspace scope during migration", async () => {
    const store = await fresh();
    const template = await store.createTemplate({
      ...legacyDefinition,
      workspaceId: "workspace-a",
    });
    await fs.writeFile(
      store.storeFile,
      JSON.stringify({ version: 1, templates: [template], runs: [] }),
    );
    const migrated = new WorkflowStore(path.dirname(store.storeFile));
    expect(
      (await migrated.listWorkflows("workspace-a")).map(({ id }) => id),
    ).toEqual([template.id]);
    expect(await migrated.listWorkflows("workspace-b")).toEqual([]);
  });

  it("migrates approval before a non-entry legacy step without disconnecting it", async () => {
    const store = await fresh();
    const template = await store.createTemplate({
      ...legacyDefinition,
      steps: [
        ...legacyDefinition.steps,
        {
          ...legacyDefinition.steps[0]!,
          id: "review",
          name: "Review",
          startPolicy: "manualApproval",
        },
      ],
      transitions: [
        {
          id: "to-review",
          fromStepId: "work",
          kind: "always",
          toStepId: "review",
        },
      ],
    });
    await fs.writeFile(
      store.storeFile,
      JSON.stringify({ version: 1, templates: [template], runs: [] }),
    );
    const migrated = new WorkflowStore(
      path.dirname(store.storeFile),
      undefined,
      () => 123,
    );
    const workflow = await migrated.getWorkflow(template.id);
    expect(workflow.nodes.some((node) => node.role === "human")).toBe(true);
    expect(workflow.entryNodeId).toMatch(/^[0-9a-f-]{36}$/i);
    for (const node of workflow.nodes)
      expect(node.id).toMatch(/^[0-9a-f-]{36}$/i);
    for (const relationship of workflow.relationships)
      expect(relationship.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("persists canonical run envelopes across reload without fabricating legacy history", async () => {
    const store = await fresh();
    const definition = agentWorkflowDefinition();
    await store.createWorkflow(definition, "workspace");
    const run = await store.createWorkflowRun(
      createWorkflowRoleRun(definition, "workspace"),
    );
    const reloaded = new WorkflowStore(path.dirname(store.storeFile));
    expect(await reloaded.getWorkflowRun(run.id)).toEqual(run);
    expect(await reloaded.listRuns("workspace")).toEqual([]);
  });

  it("persists resolved explicit handoffs for restart recovery", async () => {
    const store = await fresh();
    const definition = agentWorkflowDefinition();
    const initial = createWorkflowRoleRun(definition, "workspace");
    const run = {
      ...initial,
      occurrences: initial.occurrences.map((occurrence) => ({
        ...occurrence,
        resolvedInputBindings: [
          {
            sourceNodeId: nativeWorkerId,
            sourceValue: "finalOutput" as const,
            label: "Saved source",
            value: "bounded saved output",
          },
        ],
      })),
    };
    await store.createWorkflowRun(run);
    const restarted = new WorkflowStore(path.dirname(store.storeFile));
    expect(
      (await restarted.getWorkflowRun(run.id)).occurrences[0]!
        .resolvedInputBindings,
    ).toEqual(run.occurrences[0]!.resolvedInputBindings);
  });

  it("migrates v2 node identities, preserves snapshots and legacy runs, and backs up raw data", async () => {
    const store = await fresh();
    const definition = {
      ...agentWorkflowDefinition(),
      id: "workflow-00000000-0000-4000-8000-000000000005",
      entryNodeId: "plan",
      nodes: [
        {
          id: "plan",
          name: "Duplicate",
          role: "worker" as const,
          config: { instructions: "plan" },
        },
        {
          id: "deliver",
          name: "Duplicate",
          role: "worker" as const,
          config: { instructions: "deliver" },
          inputBindings: [
            { sourceNodeId: "plan", sourceValue: "finalOutput" as const },
          ],
        },
      ],
      relationships: [
        { id: "plan-deliver", from: "plan", to: { nodeId: "deliver" } },
      ],
    };
    const canonicalRunDefinition = {
      ...definition,
      id: "00000000-0000-4000-8000-000000000005",
      entryNodeId: nativeWorkerId,
      nodes: definition.nodes.map((node, index) => ({
        ...node,
        id:
          index === 0 ? nativeWorkerId : "00000000-0000-4000-8000-000000000006",
        ...(node.inputBindings
          ? {
              inputBindings: node.inputBindings.map((binding) => ({
                ...binding,
                sourceNodeId: nativeWorkerId,
              })),
            }
          : {}),
      })),
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000007",
          from: nativeWorkerId,
          to: { nodeId: "00000000-0000-4000-8000-000000000006" },
        },
      ],
    };
    const run = createWorkflowRoleRun(canonicalRunDefinition, "workspace");
    const legacyRoleRun = {
      ...run,
      definition,
      occurrences: run.occurrences.map((occurrence) => ({
        ...occurrence,
        nodeId: "plan",
      })),
    };
    const legacyRun = createWorkflowRun({
      template: await store.createTemplate(legacyDefinition),
      workspaceId: "workspace",
      inputs: {},
    });
    const source = {
      version: 2,
      workflows: [definition],
      occurrences: [],
      runs: [legacyRoleRun],
      legacyRuns: [legacyRun],
      workflowScopes: { [definition.id]: "workspace" },
    };
    const raw = JSON.stringify(source);
    await fs.writeFile(store.storeFile, raw);

    const migrated = new WorkflowStore(
      path.dirname(store.storeFile),
      undefined,
      () => 123,
    );
    const workflow = (await migrated.listWorkflows())[0]!;
    expect(workflow.id).not.toBe(definition.id);
    expect(workflow.id).toMatch(/^[0-9a-f-]{36}$/i);
    const ids = new Set(workflow.nodes.map((node) => node.id));
    expect([...ids]).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(workflow.entryNodeId).toBe(workflow.nodes[0]!.id);
    expect(workflow.relationships[0]).toMatchObject({
      from: workflow.nodes[0]!.id,
      to: { nodeId: workflow.nodes[1]!.id },
    });
    expect(workflow.relationships[0]!.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(workflow.nodes[1]!.inputBindings).toEqual([
      { sourceNodeId: workflow.nodes[0]!.id, sourceValue: "finalOutput" },
    ]);
    const migratedRun = await migrated.getWorkflowRun(run.id);
    expect(migratedRun.id).toBe(run.id);
    expect(migratedRun.occurrences[0]!.nodeId).toBe(
      migratedRun.definition.entryNodeId,
    );
    // Legacy IDs map once per workflow, including immutable run snapshots;
    // duplicate display labels are never consulted for this resolution.
    expect(migratedRun.definition.nodes.map((node) => node.id)).toEqual(
      workflow.nodes.map((node) => node.id),
    );
    const renamed = await migrated.updateWorkflow(
      {
        ...workflow,
        revision: 2,
        nodes: workflow.nodes.map((node, index) => ({
          ...node,
          name: index === 0 ? "Renamed duplicate" : node.name,
        })),
      },
      "workspace",
    );
    expect(renamed.nodes[0]!.id).toBe(workflow.nodes[0]!.id);
    expect(
      (await migrated.getWorkflowRun(run.id)).definition.nodes[0]!.name,
    ).toBe("Duplicate");
    expect(await migrated.getRun(legacyRun.id)).toEqual(legacyRun);
    expect(
      await fs.readFile(`${store.storeFile}.v2-node-id-backup-123`, "utf8"),
    ).toBe(raw);
    expect(JSON.parse(await fs.readFile(store.storeFile, "utf8")).version).toBe(
      3,
    );

    const reloaded = new WorkflowStore(
      path.dirname(store.storeFile),
      undefined,
      () => 123,
    );
    expect(await reloaded.getWorkflow(workflow.id)).toEqual(renamed);
    expect(await fs.readdir(path.dirname(store.storeFile))).not.toContain(
      "workflows.json.v2-node-id-backup-123-2",
    );
  });

  it("preserves malformed v3 data byte-for-byte and rejects it", async () => {
    const store = await fresh();
    const original = JSON.stringify({
      version: 3,
      workflows: [
        { workspaceId: "workspace", definition: agentWorkflowDefinition() },
      ],
      runs: [],
    });
    await fs.writeFile(store.storeFile, original);

    await expect(store.listWorkflows()).rejects.toBeInstanceOf(
      UnsupportedWorkflowStoreVersionError,
    );
    expect(await fs.readFile(store.storeFile, "utf8")).toBe(original);
    expect(await fs.readdir(path.dirname(store.storeFile))).not.toContain(
      "workflows.json.v3-backup-123",
    );
  });

  it("preserves malformed v3 and future stores byte-for-byte and rejects them", async () => {
    const store = await fresh();
    const malformedV3 = '{"version":3,"workflows":[]}';
    await fs.writeFile(store.storeFile, malformedV3);

    await expect(store.listWorkflows()).rejects.toBeInstanceOf(
      UnsupportedWorkflowStoreVersionError,
    );
    expect(await fs.readFile(store.storeFile, "utf8")).toBe(malformedV3);

    const futureStore = '{"version":4,"workflows":[],"runs":[]}';
    await fs.writeFile(store.storeFile, futureStore);
    const reloaded = new WorkflowStore(path.dirname(store.storeFile));
    await expect(reloaded.listWorkflows()).rejects.toBeInstanceOf(
      UnsupportedWorkflowStoreVersionError,
    );
    expect(await fs.readFile(store.storeFile, "utf8")).toBe(futureStore);
  });

  it("backs up corrupt metadata before initializing an empty agentWorkflow store", async () => {
    const store = await fresh();
    await fs.writeFile(store.storeFile, "not-json");
    expect(await store.listWorkflows()).toEqual([]);
    expect(
      (await fs.readdir(path.dirname(store.storeFile))).some((name) =>
        name.startsWith("workflows.json.corrupt-"),
      ),
    ).toBe(true);
  });
});
