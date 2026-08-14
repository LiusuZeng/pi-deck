import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function fakePiBinary(root: string): string {
  const binary = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
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
