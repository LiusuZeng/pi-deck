import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./workflowStore.js";
import { createWorkflowRun } from "./workflowEngine.js";
import type { WorkflowTemplateDefinition } from "../../shared/workflowSchemas.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const definition: WorkflowTemplateDefinition = {
  name: "Linear workflow",
  inputs: [],
  steps: [
    {
      id: "first",
      name: "First",
      kind: "agent",
      promptParts: [{ type: "text", text: "First" }],
      inputPolicy: {
        includeWorkflowContext: true,
        includeParentFinalAnswer: false,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
      startPolicy: "auto",
    },
  ],
  transitions: [],
};

async function newStore(): Promise<WorkflowStore> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-workflow-"),
  );
  tempDirs.push(directory);
  return new WorkflowStore(directory);
}

describe("WorkflowStore", () => {
  it("persists templates and runs across store instances", async () => {
    const store = await newStore();
    const template = await store.createTemplate(definition);
    const run = createWorkflowRun({
      template,
      workspaceId: "workspace-1",
      inputs: {},
    });
    await store.createRun(run);

    const reopened = new WorkflowStore(path.dirname(store.storeFile));
    expect((await reopened.listTemplates()).map((item) => item.name)).toEqual([
      "Linear workflow",
    ]);
    expect(
      (await reopened.listRuns("workspace-1")).map((item) => item.id),
    ).toEqual([run.id]);
  });

  it("keeps a global template global when workspaceId is omitted", async () => {
    const store = await newStore();
    const original = await store.createTemplate(definition);
    expect(original.workspaceId).toBeUndefined();
    const updated = await store.updateTemplate(original.id, {
      ...definition,
      name: "Edited global workflow",
    });
    expect(updated.name).toBe("Edited global workflow");
    expect(updated.workspaceId).toBeUndefined();
    expect(
      (await store.listTemplates("another-workspace")).map((item) => item.id),
    ).toEqual([original.id]);
  });

  it("moves a global template when workspaceId is explicitly selected", async () => {
    const store = await newStore();
    const original = await store.createTemplate(definition);
    const updated = await store.updateTemplate(original.id, {
      ...definition,
      workspaceId: "selected-workspace",
    });
    expect(updated.workspaceId).toBe("selected-workspace");
    expect(await store.listTemplates("selected-workspace")).toHaveLength(1);
    expect(await store.listTemplates("another-workspace")).toEqual([]);
  });

  it("clears a scoped template back to global when workspaceId is omitted", async () => {
    const store = await newStore();
    const original = await store.createTemplate({
      ...definition,
      workspaceId: "selected-workspace",
    });
    const updated = await store.updateTemplate(original.id, {
      ...definition,
      name: "Edited global workflow",
    });

    expect(updated.workspaceId).toBeUndefined();
    expect(
      (await store.listTemplates()).map((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
      })),
    ).toEqual([{ id: original.id, workspaceId: undefined }]);
    expect(
      (await store.listTemplates("another-workspace")).map((item) => item.id),
    ).toEqual([original.id]);
  });

  it("duplicates a template without sharing its identity", async () => {
    const store = await newStore();
    const original = await store.createTemplate(definition);
    const copy = await store.duplicateTemplate(original.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("Linear workflow copy");
  });

  it("recovers from corrupt metadata", async () => {
    const store = await newStore();
    await fs.writeFile(store.storeFile, "not-json");
    expect(await store.listTemplates()).toEqual([]);
    const files = await fs.readdir(path.dirname(store.storeFile));
    expect(
      files.some((file) => file.startsWith("workflows.json.corrupt-")),
    ).toBe(true);
  });
});
