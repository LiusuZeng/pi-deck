import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function fakePiBinary(
  root: string,
  promptScenario?: "error",
  args: readonly string[] = [],
): string {
  const binary = path.join(root, "fake-pi.js");
  const scenarioArgs = [
    ...(promptScenario ? ["--prompt-scenario", promptScenario] : []),
    ...args,
  ]
    .map((arg) => `process.argv.push(${JSON.stringify(arg)});`)
    .join("\n");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\n${scenarioArgs}require(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return binary;
}

async function launch(
  env: NodeJS.ProcessEnv,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      ...env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
  return { app, page };
}

function seedWorkflowStore(
  piDeckHome: string,
  store: unknown,
): { storeFile: string; bytes: Buffer } {
  fs.mkdirSync(piDeckHome, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(store, null, 2)}\n`);
  const storeFile = path.join(piDeckHome, "workflows.json");
  fs.writeFileSync(storeFile, bytes);
  return { storeFile, bytes };
}

async function expectWorkflowStoreUnavailable(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Agent Workflows" }).click();
  await expect(page.getByRole("alert")).toContainText(
    /workflow.*(?:unavailable|unsupported)|(?:unavailable|unsupported).*workflow/i,
  );
}

const graphWorkflowIds = {
  workflow: "00000000-0000-4000-8000-000000000001",
  human: "00000000-0000-4000-8000-000000000002",
  worker: "00000000-0000-4000-8000-000000000003",
  trueRoute: "00000000-0000-4000-8000-000000000004",
  falseRoute: "00000000-0000-4000-8000-000000000005",
  endRoute: "00000000-0000-4000-8000-000000000006",
};

const identityWorkflowIds = {
  workflow: "10000000-0000-4000-8000-000000000001",
  source: "10000000-0000-4000-8000-000000000002",
  fanout: "10000000-0000-4000-8000-000000000003",
  managedWorker: "10000000-0000-4000-8000-000000000004",
  target: "10000000-0000-4000-8000-000000000005",
  sourceRoute: "10000000-0000-4000-8000-000000000006",
  targetRoute: "10000000-0000-4000-8000-000000000007",
};

function graphEnvironment(
  root: string,
  promptScenario?: "error",
  fakeArgs: readonly string[] = [],
): NodeJS.ProcessEnv {
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: fakePiBinary(root, promptScenario, fakeArgs),
    PI_DECK_PROJECT_CWD: projectCwd,
    PI_CODING_AGENT_DIR: agentDir,
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
  };
}

async function createGraphWorkflow(
  page: Page,
  kind: "human" | "worker",
): Promise<void> {
  await page.evaluate(
    async ({ ids, kind }) => {
      const active = await window.piDeck.workspaces.getActive();
      if (!active.activeWorkspace) throw new Error("No active workspace");
      const workflow =
        kind === "human"
          ? {
              format: "pi-deck.agent-workflow" as const,
              schemaVersion: 2 as const,
              id: ids.workflow,
              revision: 1,
              name: "Live graph acceptance",
              inputs: [],
              entryNodeId: ids.human,
              nodes: [
                {
                  id: ids.human,
                  name: "Release approval",
                  role: "human" as const,
                  config: {
                    interaction: "approval" as const,
                    prompt: "Ship this graph?",
                  },
                },
              ],
              relationships: [
                {
                  id: ids.trueRoute,
                  from: ids.human,
                  when: { equals: true },
                  to: { end: "approved" },
                },
                {
                  id: ids.falseRoute,
                  from: ids.human,
                  when: { equals: false },
                  to: { end: "rejected" },
                },
              ],
            }
          : {
              format: "pi-deck.agent-workflow" as const,
              schemaVersion: 2 as const,
              id: ids.workflow,
              revision: 1,
              name: "Failing live graph",
              inputs: [],
              entryNodeId: ids.worker,
              nodes: [
                {
                  id: ids.worker,
                  name: "Unreliable worker",
                  role: "worker" as const,
                  config: { instructions: "Fail for this acceptance test." },
                  execution: { maxAttempts: 2 },
                },
              ],
              relationships: [
                { id: ids.endRoute, from: ids.worker, to: { end: "done" } },
              ],
            };
      await window.piDeck.workflows.createWorkflow({
        workspaceId: active.activeWorkspace.id,
        scopeWorkspaceId: null,
        workflow,
      });
    },
    { ids: graphWorkflowIds, kind },
  );
}

async function openAndStartOnlyWorkflow(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Agent Workflows" }).click();
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(
    page.getByRole("region", { name: "Workflow run" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const active = await window.piDeck.workspaces.getActive();
        if (!active.activeWorkspace) return 0;
        return (
          await window.piDeck.workflows.canonicalListRuns({
            workspaceId: active.activeWorkspace.id,
          })
        ).length;
      }),
    )
    .toBeGreaterThan(0);
  return page.evaluate(async () => {
    const active = await window.piDeck.workspaces.getActive();
    if (!active.activeWorkspace) throw new Error("No active workspace");
    const listed = await window.piDeck.workflows.canonicalListRuns({
      workspaceId: active.activeWorkspace.id,
    });
    return listed[0]!.id;
  });
}

test("workflow API creates a template, starts a fake run, and persists both across reopen", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-agent-workflow-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const env: NodeJS.ProcessEnv = {
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: fakePiBinary(root),
    PI_DECK_PROJECT_CWD: projectCwd,
    PI_CODING_AGENT_DIR: agentDir,
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
  };
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(env));
    const page = await app.firstWindow();
    const created = await page.evaluate(async () => {
      const active = await window.piDeck.workspaces.getActive();
      if (active.activeWorkspace === undefined)
        throw new Error("No active workspace");
      const template = await window.piDeck.workflows.createTemplate({
        name: "Release workflow E2E",
        inputs: [],
        steps: [
          {
            id: "root",
            name: "Root worker",
            kind: "agent",
            promptParts: [
              { type: "text", text: "Reply with a release check." },
            ],
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
      });
      const run = await window.piDeck.workflows.startRun({
        templateId: template.id,
        workspaceId: active.activeWorkspace.id,
        inputs: {},
      });
      return {
        templateId: template.id,
        templateScope: template.workspaceId,
        runId: run.id,
        workspaceId: active.activeWorkspace.id,
      };
    });

    await expect
      .poll(
        async () =>
          page.evaluate(async ({ runId, workspaceId }) => {
            const listed = await window.piDeck.workflows.listRuns({
              workspaceId,
            });
            const run = listed.runs.find((candidate) => candidate.id === runId);
            return run?.stepRuns[0]?.status;
          }, created),
        { timeout: 20_000 },
      )
      .toBe("completed");

    const persisted = await page.evaluate(
      async ({ templateId, runId, workspaceId }) => {
        const template = await window.piDeck.workflows.getTemplate({
          templateId,
        });
        const run = await window.piDeck.workflows.getRun({ runId });
        const listed = await window.piDeck.workflows.listRuns({ workspaceId });
        return {
          templateName: template.name,
          runId: run.id,
          listedRunIds: listed.runs.map((item) => item.id),
          rootStatus: run.stepRuns[0]?.status,
        };
      },
      created,
    );
    expect(created.templateScope).toBeUndefined();
    expect(persisted).toMatchObject({
      templateName: "Release workflow E2E",
      runId: created.runId,
      rootStatus: "completed",
    });
    expect(persisted.listedRunIds).toContain(created.runId);

    await app.close();
    app = undefined;
    ({ app } = await launch(env));
    const reopened = await app.firstWindow().then((page) =>
      page.evaluate(async ({ templateId, runId, workspaceId }) => {
        const templates = await window.piDeck.workflows.listTemplates();
        const runs = await window.piDeck.workflows.listRuns({ workspaceId });
        return {
          templateIds: templates.templates.map((item) => item.id),
          runIds: runs.runs.map((item) => item.id),
          run: await window.piDeck.workflows.getRun({ runId }),
        };
      }, created),
    );
    expect(reopened.templateIds).toContain(created.templateId);
    expect(reopened.runIds).toContain(created.runId);
    expect(reopened.run.stepRuns[0]?.status).toBe("completed");
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live graph subscribes, renders a human conditional route, and completes after approval", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-live-graph-"),
  );
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(graphEnvironment(root)));
    const page = await app.firstWindow();
    await createGraphWorkflow(page, "human");
    const runId = await openAndStartOnlyWorkflow(page);
    const graph = page.locator('[aria-label="Live workflow execution graph"]');
    await expect(graph).toBeVisible();
    await expect(graph.locator(".is-waiting_human")).toBeVisible();
    await expect(
      graph.locator(`[data-workflow-node-id="${graphWorkflowIds.human}"]`),
    ).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() =>
        page.evaluate(
          async ({ runId, nodeId }) => {
            const snapshot = await window.piDeck.workflows.graphGetSnapshot({
              runId,
            });
            return snapshot.nodes.find((node) => node.nodeId === nodeId)
              ?.aggregateStatus;
          },
          { runId, nodeId: graphWorkflowIds.human },
        ),
      )
      .toBe("waiting_human");

    await page.evaluate(() => {
      const target = window as Window & {
        graphEvents?: unknown[];
        stopGraphEvents?: () => void;
      };
      target.graphEvents = [];
      target.stopGraphEvents = window.piDeck.workflows.onGraphEvent((event) =>
        target.graphEvents?.push(event),
      );
    });
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(
      page.getByText("Status: Completed · Outcome: approved"),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          ({ runId, routeId }) => {
            const target = window as Window & {
              graphEvents?: Array<{
                runId: string;
                revision: number;
                snapshot: {
                  edges: Array<{ relationshipId: string; status?: string }>;
                };
              }>;
            };
            return (
              target.graphEvents?.some(
                (event) =>
                  event.runId === runId &&
                  event.revision > 1 &&
                  event.snapshot.edges.some(
                    (edge) =>
                      edge.relationshipId === routeId &&
                      edge.status === "taken",
                  ),
              ) ?? false
            );
          },
          { runId, routeId: graphWorkflowIds.trueRoute },
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          async ({ runId, routeId }) => {
            const snapshot = await window.piDeck.workflows.graphGetSnapshot({
              runId,
            });
            return snapshot.edges.find(
              (edge) => edge.relationshipId === routeId,
            )?.status;
          },
          { runId, routeId: graphWorkflowIds.falseRoute },
        ),
      )
      .toBe("not_taken");
    await graph
      .locator(`[data-workflow-node-id="${graphWorkflowIds.human}"]`)
      .click();
    await expect(
      page.getByRole("heading", { name: "Execution details" }),
    ).toBeVisible();
    await page.evaluate(() =>
      (window as Window & { stopGraphEvents?: () => void }).stopGraphEvents?.(),
    );
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live graph shows cancellation from a waiting human gate", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-cancel-graph-"),
  );
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(graphEnvironment(root)));
    const page = await app.firstWindow();
    await createGraphWorkflow(page, "human");
    const runId = await openAndStartOnlyWorkflow(page);
    await expect(page.getByText("Waiting for your input")).toBeVisible();
    await page.getByRole("button", { name: "Stop run" }).click();
    await expect(page.getByText("Status: Stopped")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const snapshot = await window.piDeck.workflows.graphGetSnapshot({
            runId: id,
          });
          return {
            runStatus: snapshot.runStatus,
            node: snapshot.nodes[0]?.aggregateStatus,
          };
        }, runId),
      )
      .toEqual({ runStatus: "stopped", node: "cancelled" });
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed fake worker exposes retry and preserves its graph identity across attempts", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-retry-graph-"),
  );
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(graphEnvironment(root, "error")));
    const page = await app.firstWindow();
    await createGraphWorkflow(page, "worker");
    const runId = await openAndStartOnlyWorkflow(page);
    await expect(page.getByText("Status: Needs attention")).toBeVisible({
      timeout: 20_000,
    });
    const graphNode = page.locator(
      `[data-workflow-node-id="${graphWorkflowIds.worker}"]`,
    );
    await graphNode.click();
    await expect(
      page.getByRole("button", { name: "Retry attempt 1" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry attempt 1" }).click();
    await expect(
      page.getByText("Iteration 1 · Attempt 2", { exact: true }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() =>
        page.evaluate(
          async ({ runId, nodeId }) => {
            const snapshot = await window.piDeck.workflows.graphGetSnapshot({
              runId,
            });
            const node = snapshot.nodes.find((item) => item.nodeId === nodeId);
            return {
              status: node?.aggregateStatus,
              attempts: node?.occurrences?.map((item) => item.attempt).sort(),
            };
          },
          { runId, nodeId: graphWorkflowIds.worker },
        ),
      )
      .toEqual({ status: "failed", attempts: [1, 2] });
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate node names retain ID relationships, fanout ownership, bindings, and historical run routing after rename", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-node-identity-"),
  );
  const env = graphEnvironment(root);
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(env));
    let page = await app.firstWindow();
    const created = await page.evaluate(async (ids) => {
      const active = await window.piDeck.workspaces.getActive();
      if (!active.activeWorkspace) throw new Error("No active workspace");
      const workflow = {
        format: "pi-deck.agent-workflow" as const,
        schemaVersion: 2 as const,
        id: ids.workflow,
        revision: 1,
        name: "Duplicate display name",
        inputs: [],
        entryNodeId: ids.source,
        nodes: [
          {
            id: ids.source,
            name: "Duplicate display name",
            role: "worker" as const,
            config: { instructions: "Produce the bound source output." },
          },
          {
            id: ids.fanout,
            name: "Duplicate display name",
            role: "orchestrator" as const,
            config: {
              mode: "fanout" as const,
              agents: [ids.managedWorker],
              maxConcurrency: 1,
              completion: "all" as const,
            },
          },
          {
            id: ids.managedWorker,
            name: "Duplicate display name",
            role: "worker" as const,
            managedBy: ids.fanout,
            config: { instructions: "Participate in the fanout." },
          },
          {
            id: ids.target,
            name: "Duplicate display name",
            role: "worker" as const,
            inputBindings: [
              {
                sourceNodeId: ids.source,
                sourceValue: "finalOutput" as const,
                label: "Bound duplicate source",
              },
            ],
            config: { instructions: "Consume the explicitly bound output." },
          },
        ],
        relationships: [
          { id: ids.sourceRoute, from: ids.source, to: { nodeId: ids.fanout } },
          { id: ids.targetRoute, from: ids.fanout, to: { nodeId: ids.target } },
          {
            id: "10000000-0000-4000-8000-000000000008",
            from: ids.target,
            to: { end: "done" },
          },
        ],
      };
      await window.piDeck.workflows.createWorkflow({
        workspaceId: active.activeWorkspace.id,
        scopeWorkspaceId: null,
        workflow,
      });
      const run = await window.piDeck.workflows.canonicalStartRun({
        workflowId: workflow.id,
        workspaceId: active.activeWorkspace.id,
        inputs: {},
      });
      return { runId: run.id, workspaceId: active.activeWorkspace.id };
    }, identityWorkflowIds);

    await expect
      .poll(
        () =>
          page.evaluate(async (runId) => {
            const run = await window.piDeck.workflows.canonicalGetRun({
              runId,
            });
            return run.status;
          }, created.runId),
        { timeout: 20_000 },
      )
      .toBe("completed");

    const beforeRename = await page.evaluate(
      async ({ runId, ids }) => {
        const [run, snapshot] = await Promise.all([
          window.piDeck.workflows.canonicalGetRun({ runId }),
          window.piDeck.workflows.graphGetSnapshot({ runId }),
        ]);
        const source = run.occurrences.find(
          (item) => item.nodeId === ids.source,
        );
        const target = run.occurrences.find(
          (item) => item.nodeId === ids.target,
        );
        const fanout = run.occurrences.find(
          (item) => item.nodeId === ids.fanout,
        );
        const managed = run.occurrences.find(
          (item) => item.nodeId === ids.managedWorker,
        );
        return {
          names: run.definition.nodes.map((item) => item.name),
          relationship: run.definition.relationships.find(
            (item) => item.id === ids.sourceRoute,
          ),
          agents: run.definition.nodes.find((item) => item.id === ids.fanout)
            ?.config,
          binding: run.definition.nodes.find((item) => item.id === ids.target)
            ?.inputBindings?.[0],
          resolvedBinding: target?.resolvedInputBindings?.[0],
          sourceOccurrenceId: source?.id,
          fanoutOccurrenceId: fanout?.id,
          managedParentId: managed?.parentOrchestratorRunId,
          fanoutGraphStates: snapshot.nodes
            .filter(
              (item) =>
                item.nodeId === ids.fanout || item.nodeId === ids.managedWorker,
            )
            .map((item) => ({
              nodeId: item.nodeId,
              status: item.aggregateStatus,
            })),
        };
      },
      { runId: created.runId, ids: identityWorkflowIds },
    );
    expect(beforeRename.names).toEqual([
      "Duplicate display name",
      "Duplicate display name",
      "Duplicate display name",
      "Duplicate display name",
    ]);
    expect(beforeRename.relationship).toMatchObject({
      from: identityWorkflowIds.source,
      to: { nodeId: identityWorkflowIds.fanout },
    });
    expect(beforeRename.agents).toMatchObject({
      mode: "fanout",
      agents: [identityWorkflowIds.managedWorker],
    });
    expect(beforeRename.binding).toMatchObject({
      sourceNodeId: identityWorkflowIds.source,
      sourceValue: "finalOutput",
    });
    expect(beforeRename.resolvedBinding).toMatchObject({
      sourceNodeId: identityWorkflowIds.source,
      sourceOccurrenceId: beforeRename.sourceOccurrenceId,
    });
    expect(beforeRename.managedParentId).toBe(beforeRename.fanoutOccurrenceId);
    expect(beforeRename.fanoutGraphStates).toEqual([
      { nodeId: identityWorkflowIds.fanout, status: "completed" },
      { nodeId: identityWorkflowIds.managedWorker, status: "completed" },
    ]);

    await page.evaluate(
      async ({ workspaceId, ids }) => {
        const listed = await window.piDeck.workflows.listWorkflows({
          workspaceId,
        });
        const current = listed.find(
          (item) => item.workflow.id === ids.workflow,
        );
        if (!current) throw new Error("Workflow was not created");
        await window.piDeck.workflows.updateWorkflow({
          workspaceId,
          scopeWorkspaceId: current.scopeWorkspaceId,
          workflow: {
            ...current.workflow,
            revision: current.workflow.revision + 1,
            nodes: current.workflow.nodes.map((node) =>
              node.id === ids.managedWorker
                ? { ...node, name: "Renamed duplicate worker" }
                : node,
            ),
          },
        });
      },
      { workspaceId: created.workspaceId, ids: identityWorkflowIds },
    );

    await page.reload();
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    await app.close();
    app = undefined;
    ({ app } = await launch(env));
    page = await app.firstWindow();

    const persisted = await page.evaluate(
      async ({ runId, workspaceId, ids }) => {
        const definitions = await window.piDeck.workflows.listWorkflows({
          workspaceId,
        });
        const definition = definitions.find(
          (item) => item.workflow.id === ids.workflow,
        )?.workflow;
        const historical = await window.piDeck.workflows.canonicalGetRun({
          runId,
        });
        return {
          renamedNode: definition?.nodes.find(
            (node) => node.id === ids.managedWorker,
          ),
          currentRelationship: definition?.relationships.find(
            (item) => item.id === ids.sourceRoute,
          ),
          currentBinding: definition?.nodes.find(
            (node) => node.id === ids.target,
          )?.inputBindings?.[0],
          historicalName: historical.name,
          historicalManagedName: historical.definition.nodes.find(
            (node) => node.id === ids.managedWorker,
          )?.name,
          historicalRoutes: historical.definition.relationships
            .filter(
              (item) =>
                item.id === ids.sourceRoute || item.id === ids.targetRoute,
            )
            .map((item) => ({ id: item.id, from: item.from, to: item.to })),
        };
      },
      {
        runId: created.runId,
        workspaceId: created.workspaceId,
        ids: identityWorkflowIds,
      },
    );
    expect(persisted.renamedNode).toMatchObject({
      id: identityWorkflowIds.managedWorker,
      name: "Renamed duplicate worker",
      managedBy: identityWorkflowIds.fanout,
    });
    expect(persisted.currentRelationship).toMatchObject({
      from: identityWorkflowIds.source,
      to: { nodeId: identityWorkflowIds.fanout },
    });
    expect(persisted.currentBinding).toMatchObject({
      sourceNodeId: identityWorkflowIds.source,
    });
    expect(persisted.historicalName).toBe("Duplicate display name");
    expect(persisted.historicalManagedName).toBe("Duplicate display name");
    expect(persisted.historicalRoutes).toEqual([
      {
        id: identityWorkflowIds.sourceRoute,
        from: identityWorkflowIds.source,
        to: { nodeId: identityWorkflowIds.fanout },
      },
      {
        id: identityWorkflowIds.targetRoute,
        from: identityWorkflowIds.fanout,
        to: { nodeId: identityWorkflowIds.target },
      },
    ]);

    await page.getByRole("button", { name: "Agent Workflows" }).click();
    await page.getByRole("button", { name: "View all runs" }).click();
    await page.locator(`button[aria-label$="ID ${created.runId}"]`).click();
    const graph = page.locator('[aria-label="Live workflow execution graph"]');
    await expect(graph).toBeVisible();
    const historicalManaged = graph.locator(
      `[data-workflow-node-id="${identityWorkflowIds.managedWorker}"]`,
    );
    await expect(historicalManaged).toHaveText("Duplicate display name");
    await historicalManaged.click();
    await expect(historicalManaged).toHaveAttribute("aria-pressed", "true");
    await expect(
      graph.locator(`[data-workflow-node-id="${identityWorkflowIds.target}"]`),
    ).toHaveAttribute("aria-pressed", "false");
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fake backend bounds fan-out concurrency and persists its complete graph", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-fanout-stress-"),
  );
  const ids = {
    workflow: "20000000-0000-4000-8000-000000000001",
    fanout: "20000000-0000-4000-8000-000000000002",
    a: "20000000-0000-4000-8000-000000000003",
    b: "20000000-0000-4000-8000-000000000004",
    c: "20000000-0000-4000-8000-000000000005",
    d: "20000000-0000-4000-8000-000000000006",
    target: "20000000-0000-4000-8000-000000000007",
  };
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(
      graphEnvironment(root, undefined, ["--stream-delay-ms", "80"]),
    ));
    const page = await app.firstWindow();
    const result = await page.evaluate(async (ids) => {
      const active = await window.piDeck.workspaces.getActive();
      if (!active.activeWorkspace) throw new Error("No active workspace");
      const agents = [ids.a, ids.b, ids.c, ids.d];
      const workflow = {
        format: "pi-deck.agent-workflow" as const,
        schemaVersion: 2 as const,
        id: ids.workflow,
        revision: 1,
        name: "Bound fanout",
        inputs: [],
        entryNodeId: ids.fanout,
        nodes: [
          {
            id: ids.fanout,
            name: "Fan out",
            role: "orchestrator" as const,
            config: {
              mode: "fanout" as const,
              agents,
              maxConcurrency: 2,
              completion: "all" as const,
            },
          },
          ...agents.map((id) => ({
            id,
            name: `Worker ${id.slice(-1)}`,
            role: "worker" as const,
            managedBy: ids.fanout,
            config: { instructions: "Return a deterministic fanout result." },
          })),
          {
            id: ids.target,
            name: "Collector",
            role: "worker" as const,
            config: { instructions: "Collect all fanout outputs." },
          },
        ],
        relationships: [
          {
            id: "20000000-0000-4000-8000-000000000008",
            from: ids.fanout,
            to: { nodeId: ids.target },
          },
          {
            id: "20000000-0000-4000-8000-000000000009",
            from: ids.target,
            to: { end: "done" },
          },
        ],
      };
      await window.piDeck.workflows.createWorkflow({
        workspaceId: active.activeWorkspace.id,
        scopeWorkspaceId: null,
        workflow,
      });
      const run = await window.piDeck.workflows.canonicalStartRun({
        workflowId: workflow.id,
        workspaceId: active.activeWorkspace.id,
        inputs: {},
      });
      return run.id;
    }, ids);
    await expect
      .poll(
        async () =>
          page.evaluate(
            async ({ runId, agents }) => {
              const run = await window.piDeck.workflows.canonicalGetRun({
                runId,
              });
              const active = run.occurrences.filter(
                (item) =>
                  agents.includes(item.nodeId) &&
                  ["ready", "running"].includes(item.status),
              ).length;
              return {
                status: run.status,
                active,
                queued: run.occurrences.filter(
                  (item) =>
                    agents.includes(item.nodeId) && item.status === "queued",
                ).length,
              };
            },
            { runId: result, agents: [ids.a, ids.b, ids.c, ids.d] },
          ),
        { timeout: 20_000 },
      )
      .toMatchObject({ status: "running", active: 2, queued: 2 });
    await expect
      .poll(
        () =>
          page.evaluate(
            async (runId) =>
              (await window.piDeck.workflows.canonicalGetRun({ runId })).status,
            result,
          ),
        { timeout: 20_000 },
      )
      .toBe("completed");
    const persisted = await page.evaluate(
      async ({ runId, ids }) => {
        const [run, graph] = await Promise.all([
          window.piDeck.workflows.canonicalGetRun({ runId }),
          window.piDeck.workflows.graphGetSnapshot({ runId }),
        ]);
        const owner = run.occurrences.find(
          (item) => item.nodeId === ids.fanout,
        );
        const children = run.occurrences.filter((item) =>
          [ids.a, ids.b, ids.c, ids.d].includes(item.nodeId),
        );
        const target = run.occurrences.find(
          (item) => item.nodeId === ids.target,
        );
        return {
          status: run.status,
          owner,
          children,
          target,
          graph: graph.nodes.find((item) => item.nodeId === ids.fanout),
        };
      },
      { runId: result, ids },
    );
    expect(persisted.owner?.aggregation).toHaveLength(4);
    expect(persisted.children.map((item) => item.nodeId).sort()).toEqual(
      [ids.a, ids.b, ids.c, ids.d].sort(),
    );
    expect(
      persisted.children.map((item) => ({
        status: item.status,
        attempt: item.attempt,
        parent: item.parentOrchestratorRunId,
      })),
    ).toEqual(
      persisted.children.map(() => ({
        status: "completed",
        attempt: 1,
        parent: persisted.owner?.id,
      })),
    );
    expect(persisted.target?.parentOccurrenceIds).toEqual([
      persisted.owner?.id,
    ]);
    expect(persisted.graph).toMatchObject({ aggregateStatus: "completed" });
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fake backend persists loop iterations and strict decider outcomes", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-loop-stress-"),
  );
  const state = path.join(root, "decisions.state");
  fs.writeFileSync(state, "0");
  const ids = {
    workflow: "30000000-0000-4000-8000-000000000001",
    loop: "30000000-0000-4000-8000-000000000002",
    worker: "30000000-0000-4000-8000-000000000003",
    decider: "30000000-0000-4000-8000-000000000004",
  };
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(
      graphEnvironment(root, undefined, [
        "--workflow-decisions",
        "false,true",
        "--workflow-decision-state-file",
        state,
      ]),
    ));
    const page = await app.firstWindow();
    const runId = await page.evaluate(async (ids) => {
      const active = await window.piDeck.workspaces.getActive();
      if (!active.activeWorkspace) throw new Error("No active workspace");
      const workflow = {
        format: "pi-deck.agent-workflow" as const,
        schemaVersion: 2 as const,
        id: ids.workflow,
        revision: 1,
        name: "Two pass loop",
        inputs: [],
        entryNodeId: ids.loop,
        nodes: [
          {
            id: ids.loop,
            name: "Loop",
            role: "orchestrator" as const,
            config: {
              mode: "loop" as const,
              agents: [ids.worker],
              decider: ids.decider,
              maxIterations: 2,
            },
          },
          {
            id: ids.worker,
            name: "Loop worker",
            role: "worker" as const,
            managedBy: ids.loop,
            config: { instructions: "Produce iteration output." },
          },
          {
            id: ids.decider,
            name: "Loop decision",
            role: "decider" as const,
            managedBy: ids.loop,
            config: { question: "Should the loop finish?" },
          },
        ],
        relationships: [
          {
            id: "30000000-0000-4000-8000-000000000005",
            from: ids.loop,
            to: { end: "accepted" },
          },
        ],
      };
      await window.piDeck.workflows.createWorkflow({
        workspaceId: active.activeWorkspace.id,
        scopeWorkspaceId: null,
        workflow,
      });
      return (
        await window.piDeck.workflows.canonicalStartRun({
          workflowId: workflow.id,
          workspaceId: active.activeWorkspace.id,
          inputs: {},
        })
      ).id;
    }, ids);
    await expect
      .poll(
        () =>
          page.evaluate(
            async (runId) =>
              (await window.piDeck.workflows.canonicalGetRun({ runId })).status,
            runId,
          ),
        { timeout: 20_000 },
      )
      .toBe("completed");
    const persisted = await page.evaluate(
      async ({ runId, ids }) => {
        const run = await window.piDeck.workflows.canonicalGetRun({ runId });
        return {
          outcome: run.terminalOutcome,
          workers: run.occurrences.filter((item) => item.nodeId === ids.worker),
          decisions: run.occurrences.filter(
            (item) => item.nodeId === ids.decider,
          ),
          owner: run.occurrences.find((item) => item.nodeId === ids.loop),
        };
      },
      { runId, ids },
    );
    expect(persisted.outcome).toBe("accepted");
    expect(
      persisted.workers.map((item) => [
        item.iteration,
        item.status,
        item.attempt,
      ]),
    ).toEqual([
      [1, "completed", 1],
      [2, "completed", 1],
    ]);
    expect(
      persisted.decisions.map((item) => [
        item.iteration,
        item.output,
        item.parentOrchestratorRunId,
      ]),
    ).toEqual([
      [1, false, persisted.owner?.id],
      [2, true, persisted.owner?.id],
    ]);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery never resurrects a fake in-flight canonical occurrence", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-recovery-stress-"),
  );
  const env = graphEnvironment(root, undefined, ["--stream-delay-ms", "500"]);
  const ids = {
    workflow: "40000000-0000-4000-8000-000000000001",
    source: "40000000-0000-4000-8000-000000000002",
    target: "40000000-0000-4000-8000-000000000003",
  };
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(env));
    let page = await app.firstWindow();
    const runId = await page.evaluate(async (ids) => {
      const active = await window.piDeck.workspaces.getActive();
      if (!active.activeWorkspace) throw new Error("No active workspace");
      const workflow = {
        format: "pi-deck.agent-workflow" as const,
        schemaVersion: 2 as const,
        id: ids.workflow,
        revision: 1,
        name: "Restart handoff",
        inputs: [],
        entryNodeId: ids.source,
        nodes: [
          {
            id: ids.source,
            name: "Source",
            role: "worker" as const,
            config: { instructions: "Source output." },
          },
          {
            id: ids.target,
            name: "Target",
            role: "worker" as const,
            inputBindings: [
              { sourceNodeId: ids.source, sourceValue: "finalOutput" as const },
            ],
            config: { instructions: "Target output." },
            execution: { maxAttempts: 2 },
          },
        ],
        relationships: [
          {
            id: "40000000-0000-4000-8000-000000000004",
            from: ids.source,
            to: { nodeId: ids.target },
          },
          {
            id: "40000000-0000-4000-8000-000000000005",
            from: ids.target,
            to: { end: "done" },
          },
        ],
      };
      await window.piDeck.workflows.createWorkflow({
        workspaceId: active.activeWorkspace.id,
        scopeWorkspaceId: null,
        workflow,
      });
      return (
        await window.piDeck.workflows.canonicalStartRun({
          workflowId: workflow.id,
          workspaceId: active.activeWorkspace.id,
          inputs: {},
        })
      ).id;
    }, ids);
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ runId, target }) =>
              (
                await window.piDeck.workflows.canonicalGetRun({ runId })
              ).occurrences.find((item) => item.nodeId === target)?.status,
            { runId, target: ids.target },
          ),
        { timeout: 20_000 },
      )
      .toBe("running");
    const before = await page.evaluate(
      async ({ runId, target }) =>
        (
          await window.piDeck.workflows.canonicalGetRun({ runId })
        ).occurrences.find((item) => item.nodeId === target),
      { runId, target: ids.target },
    );
    await app.close();
    app = undefined;
    ({ app } = await launch(env));
    page = await app.firstWindow();
    const recovered = await page.evaluate(
      async ({ runId, target }) => {
        const run = await window.piDeck.workflows.canonicalGetRun({ runId });
        return {
          status: run.status,
          occurrence: run.occurrences.find((item) => item.nodeId === target),
        };
      },
      { runId, target: ids.target },
    );
    expect(recovered.status).toBe("needsAttention");
    expect(recovered.occurrence).toMatchObject({
      id: before?.id,
      status: "failed",
      sessionFile: before?.sessionFile,
      resolvedInputBindings: before?.resolvedInputBindings,
    });
    expect(recovered.occurrence?.runtimeId).toBeUndefined();
    await page.evaluate(
      async ({ runId, occurrenceId }) =>
        window.piDeck.workflows.canonicalRetryOccurrence({
          runId,
          occurrenceId,
        }),
      { runId, occurrenceId: recovered.occurrence?.id },
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            async (runId) =>
              (await window.piDeck.workflows.canonicalGetRun({ runId })).status,
            runId,
          ),
        { timeout: 20_000 },
      )
      .toBe("completed");
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a cancellation race leaves no persisted runtime or late completion", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-cancel-race-"),
  );
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(
      graphEnvironment(root, undefined, ["--stream-delay-ms", "500"]),
    ));
    const page = await app.firstWindow();
    await createGraphWorkflow(page, "worker");
    const runId = await openAndStartOnlyWorkflow(page);
    await expect
      .poll(() =>
        page.evaluate(
          async (runId) =>
            (await window.piDeck.workflows.canonicalGetRun({ runId }))
              .occurrences[0]?.status,
          runId,
        ),
      )
      .toBe("running");
    const occurrenceId = await page.evaluate(
      async (runId) =>
        (await window.piDeck.workflows.canonicalGetRun({ runId }))
          .occurrences[0]?.id,
      runId,
    );
    // Both IPC requests enter the scheduler while the fake Pi is still
    // streaming. Regardless of serialization order, stop must win over any
    // replacement attempt and a late terminal event must have no owner.
    await page.evaluate(
      async ({ runId, occurrenceId }) =>
        Promise.allSettled([
          window.piDeck.workflows.canonicalStopRun({ runId }),
          window.piDeck.workflows.canonicalRetryOccurrence({
            runId,
            occurrenceId,
          }),
        ]),
      { runId, occurrenceId },
    );
    await page.waitForTimeout(2_200);
    const run = await page.evaluate(
      async (runId) => window.piDeck.workflows.canonicalGetRun({ runId }),
      runId,
    );
    expect(run.status).toBe("stopped");
    expect(run.occurrences.some((item) => item.status === "completed")).toBe(
      false,
    );
    expect(run.occurrences.every((item) => item.runtimeId === undefined)).toBe(
      true,
    );
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a non-empty unsupported workflow store leaves the shell usable and remains unchanged", async () => {
  // Depends on Lane B: bootstrap must retain the workflow-store error instead
  // of propagating it before the BrowserWindow is created. The unavailable
  // surface is intentionally asserted through the visible navigation path.
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workflow-store-skew-"),
  );
  const piDeckHome = path.join(root, "pideck-home");
  const fixture = seedWorkflowStore(piDeckHome, {
    version: 3,
    workflows: [{ futureWorkflowField: "must-not-be-lost" }],
    occurrences: [],
    legacyRuns: [],
    workflowScopes: {},
  });
  let app: ElectronApplication | undefined;
  try {
    // Both metadata locations are isolated so this production-shaped launch
    // cannot read from or write to a developer's normal Electron profile.
    ({ app } = await launch({
      PI_DECK_BACKEND: "fake",
      PI_DECK_HOME: piDeckHome,
      PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
    }));
    const page = await app.firstWindow();

    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    await expectWorkflowStoreUnavailable(page);
    expect(fs.readFileSync(fixture.storeFile)).toEqual(fixture.bytes);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the known empty v2 workflow store boots through the node-ID migration", async () => {
  // This fixture exercises the deliberately narrow, atomic v2 node-ID migration.
  // The preceding test covers a non-empty unsupported store that must never be
  // replaced by compatibility handling.
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-empty-v3-workflow-store-"),
  );
  const piDeckHome = path.join(root, "pideck-home");
  const fixture = seedWorkflowStore(piDeckHome, {
    version: 2,
    workflows: [],
    occurrences: [],
    runs: [],
    legacyRuns: [],
    workflowScopes: {},
  });
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch({
      PI_DECK_BACKEND: "fake",
      PI_DECK_HOME: piDeckHome,
      PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
    }));
    const page = await app.firstWindow();
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    await page.getByRole("button", { name: "Agent Workflows" }).click();
    await expect(
      page.getByRole("heading", { name: "Agent Workflows", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);

    const migrated = JSON.parse(fs.readFileSync(fixture.storeFile, "utf8"));
    expect(migrated).toMatchObject({
      version: 3,
      workflows: [],
      occurrences: [],
      legacyRuns: [],
      workflowScopes: {},
    });
    const backup = fs
      .readdirSync(piDeckHome)
      .find((name) => /^workflows\.json\.v2-node-id-backup-/.test(name));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(piDeckHome, backup as string))).toEqual(
      fixture.bytes,
    );
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
