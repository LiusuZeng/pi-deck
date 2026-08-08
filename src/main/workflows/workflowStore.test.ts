import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowStore } from "./workflowStore.js";
import { createWorkflowRun } from "./workflowEngine.js";
import type { WorkflowTemplateDefinition } from "../../shared/workflowSchemas.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

  it("captures each queued persistence snapshot before a later commit", async () => {
    const store = await newStore();
    await store.createTemplate(definition);

    let releaseFirstPersist!: () => void;
    const firstPersist = new Promise<void>((resolve) => {
      releaseFirstPersist = resolve;
    });
    let firstPersistStarted!: () => void;
    const firstPersistStartedPromise = new Promise<void>((resolve) => {
      firstPersistStarted = resolve;
    });
    const originalMkdir = fs.mkdir.bind(fs);
    let delayed = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      if (!delayed) {
        delayed = true;
        firstPersistStarted();
        await firstPersist;
      }
      return originalMkdir(...args);
    });

    const payloads: string[] = [];
    const originalWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation((...args) => {
      payloads.push(String(args[1]));
      return originalWriteFile(...args);
    });

    const first = store.createTemplate({ ...definition, name: "First" });
    await firstPersistStartedPromise;
    const second = store.createTemplate({ ...definition, name: "Second" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirstPersist();
    await Promise.all([first, second]);

    expect(payloads).toHaveLength(2);
    expect(
      JSON.parse(payloads[0]!).roleWorkflows.map(
        (item: { name: string }) => item.name,
      ),
    ).toEqual(["Linear workflow", "First"]);
    expect(
      JSON.parse(payloads[1]!).roleWorkflows.map(
        (item: { name: string }) => item.name,
      ),
    ).toEqual(["Linear workflow", "First", "Second"]);
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

  it("captures each queued persistence snapshot before a newer update", async () => {
    const store = await newStore();
    const original = await store.createTemplate(definition);
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const enteredMkdir = new Promise<void>((resolve) => {
      let blocked = true;
      const originalMkdir = fs.mkdir.bind(fs);
      vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        if (blocked) {
          blocked = false;
          resolve();
          await persistGate;
        }
        return originalMkdir(...args);
      });
    });
    const writeFileSpy = vi.spyOn(fs, "writeFile");

    try {
      const firstUpdate = store.updateTemplate(original.id, {
        ...definition,
        name: "First queued update",
      });
      await enteredMkdir;
      const secondUpdate = store.updateTemplate(original.id, {
        ...definition,
        name: "Second queued update",
      });
      releasePersist();
      await Promise.all([firstUpdate, secondUpdate]);

      const snapshots = writeFileSpy.mock.calls.map(
        (call) =>
          JSON.parse(String(call[1])) as {
            roleWorkflows: Array<{ name: string }>;
          },
      );
      expect(
        snapshots.map((snapshot) => snapshot.roleWorkflows[0]?.name),
      ).toEqual(["First queued update", "Second queued update"]);
      expect((await store.getTemplate(original.id)).name).toBe(
        "Second queued update",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("migrates valid v1 metadata losslessly and does not rewrite v2 on reopen", async () => {
    const source = await newStore();
    const template = await source.createTemplate({
      ...definition,
      workspaceId: "workspace-1",
    });
    const run = createWorkflowRun({
      template,
      workspaceId: "workspace-1",
      inputs: {},
    });
    await fs.writeFile(
      source.storeFile,
      `${JSON.stringify({ version: 1, templates: [template], runs: [run] })}\n`,
    );

    const migrated = new WorkflowStore(path.dirname(source.storeFile));
    expect((await migrated.getTemplate(template.id)).steps).toEqual(
      template.steps,
    );
    expect((await migrated.getRun(run.id)).stepRuns).toEqual(run.stepRuns);
    const firstWrite = JSON.parse(await fs.readFile(source.storeFile, "utf8"));
    expect(firstWrite).toMatchObject({ version: 2 });
    expect(firstWrite.roleWorkflows[0]).toMatchObject({
      id: template.id,
      roles: template.steps,
    });
    expect(firstWrite.occurrences[0]).toMatchObject({
      id: run.id,
      roleWorkflowId: template.id,
      roleOccurrences: run.stepRuns,
    });

    const reopened = new WorkflowStore(path.dirname(source.storeFile));
    await reopened.listRuns();
    expect(JSON.parse(await fs.readFile(source.storeFile, "utf8"))).toEqual(
      firstWrite,
    );
  });

  it("recovers from corrupt metadata", async () => {
    const store = await newStore();
    await fs.writeFile(store.storeFile, "not-json");
    expect(await store.listTemplates()).toEqual([]);
    const files = await fs.readdir(path.dirname(store.storeFile));
    expect(
      files.some((file) => file.startsWith("workflows.json.corrupt-")),
    ).toBe(true);
    expect(
      JSON.parse(await fs.readFile(store.storeFile, "utf8")),
    ).toMatchObject({ version: 2 });
  });
});
