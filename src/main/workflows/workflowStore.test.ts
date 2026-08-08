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

  it("does not overwrite or rename unsupported stores", async () => {
    const store = await fresh();
    const original = JSON.stringify({
      version: 3,
      workflows: [{ future: true }],
    });
    await fs.writeFile(store.storeFile, original);
    await expect(store.listWorkflows()).rejects.toBeInstanceOf(
      UnsupportedWorkflowStoreVersionError,
    );
    expect(await fs.readFile(store.storeFile, "utf8")).toBe(original);
    expect(
      (await fs.readdir(path.dirname(store.storeFile))).some((name) =>
        name.includes("corrupt"),
      ),
    ).toBe(false);
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
