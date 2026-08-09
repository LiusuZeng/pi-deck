import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowStore,
  UnsupportedWorkflowStoreVersionError,
} from "./workflowStore.js";
import { createWorkflowRun } from "./workflowEngine.js";
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
const v2 = () => ({
  format: "pi-deck.agent-workflow" as const,
  schemaVersion: 2 as const,
  id: "native",
  revision: 1,
  name: "Native",
  description: "",
  inputs: [],
  entryNodeId: "worker",
  nodes: [
    {
      id: "worker",
      name: "Worker",
      role: "worker" as const,
      config: { instructions: "work" },
    },
  ],
  relationships: [],
});

describe("WorkflowStore v2 migration foundation", () => {
  it("persists native v2 workflows without v1 roles or templates", async () => {
    const store = await fresh();
    await store.createWorkflow(v2());
    const disk = JSON.parse(await fs.readFile(store.storeFile, "utf8"));
    expect(disk).toMatchObject({
      version: 2,
      workflows: [v2()],
      occurrences: [],
      legacyRuns: [],
    });
    expect(JSON.stringify(disk)).not.toContain('"roles"');
    expect(JSON.stringify(disk)).not.toContain('"templates"');
  });

  it("validates and updates canonical v2 workflows without coercing them to v1", async () => {
    const store = await fresh();
    await store.createWorkflow(v2());
    await expect(store.createWorkflow(v2())).rejects.toThrow(
      "Workflow already exists: native",
    );
    await expect(
      store.updateWorkflow({ ...v2(), name: "Updated native", revision: 2 }),
    ).resolves.toMatchObject({ name: "Updated native", revision: 2 });
    await expect(
      store.updateWorkflow({ ...v2(), entryNodeId: "missing" }),
    ).rejects.toThrow(/Entry node/);
  });

  it("filters scoped workflows while retaining global definitions and rejects cross-workspace updates", async () => {
    const store = await fresh();
    const global = { ...v2(), id: "global" };
    const scoped = { ...v2(), id: "scoped" };
    await store.createWorkflow(global);
    await store.createWorkflow(scoped, "workspace-a");

    expect(
      (await store.listWorkflows("workspace-a")).map(({ id }) => id),
    ).toEqual(["global", "scoped"]);
    expect(
      (await store.listWorkflows("workspace-b")).map(({ id }) => id),
    ).toEqual(["global"]);
    await expect(
      store.updateWorkflow({ ...scoped, revision: 2 }, "workspace-b"),
    ).rejects.toThrow("not available in this workspace");
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
    expect((await migrated.getWorkflow(legacy.id)).nodes).toMatchObject([
      { id: "work", role: "worker", config: { instructions: "Do the work" } },
    ]);
    expect(await migrated.getRun(run.id)).toEqual(run);
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
    expect(
      workflow.nodes.find((node) => node.id === "to-review-approval")?.role,
    ).toBe("human");
  });

  it("backs up and migrates the exact empty v3 store shape to an empty v2 store", async () => {
    const store = await fresh();
    const original = '{"version":3,"workflows":[],"runs":[]}';
    await fs.writeFile(store.storeFile, original);

    expect(await store.listWorkflows()).toEqual([]);
    expect(await fs.readFile(`${store.storeFile}.v3-backup-123`, "utf8")).toBe(
      original,
    );
    expect(JSON.parse(await fs.readFile(store.storeFile, "utf8"))).toEqual({
      version: 2,
      workflows: [],
      occurrences: [],
      legacyRuns: [],
      workflowScopes: {},
    });
  });

  it("preserves a non-empty v3 store byte-for-byte and rejects it", async () => {
    const store = await fresh();
    const original = JSON.stringify({
      version: 3,
      workflows: [{ workspaceId: "workspace", definition: v2() }],
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

  it("backs up corrupt metadata before initializing an empty v2 store", async () => {
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
