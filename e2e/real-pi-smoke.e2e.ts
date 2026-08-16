import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function resolvePiBinary(): string | undefined {
  const explicit = process.env.PI_DECK_PI_BINARY;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const resolved = spawnSync("/bin/sh", ["-lc", "command -v pi"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .stdout.split(/\r?\n/)
    .find(Boolean);
  if (resolved && fs.existsSync(resolved)) {
    return resolved;
  }

  for (const candidate of ["/usr/local/bin/pi", "/opt/homebrew/bin/pi"]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function launchPiDeck(
  env: NodeJS.ProcessEnv,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_E2E_HIDE_WINDOWS: process.env.PI_DECK_E2E_HIDE_WINDOWS ?? "1",
      ...env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function expectHealthyPreload(page: Page): Promise<void> {
  await expect(page.getByText("Preload error")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => Boolean(window.piDeck)))
    .toBe(true);
  await expect(
    page.getByRole("region", { name: "Pi Deck chat workspace" }),
  ).toBeVisible();
}

function listJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listJsonlFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [entryPath] : [];
  });
}

const runRealSmoke = process.env.PI_DECK_E2E_REAL_SMOKE === "1";

test.skip(
  !runRealSmoke,
  "Set PI_DECK_E2E_REAL_SMOKE=1 or run npm run test:e2e:real-smoke to exercise real Pi GUI P0 flows.",
);

test("real Pi Agent Workflow: real worker persists run, session, and graph across restart", async () => {
  test.setTimeout(
    Number(process.env.PI_DECK_E2E_REAL_SMOKE_TIMEOUT_MS ?? 240_000),
  );
  const piBinary = resolvePiBinary();
  test.skip(!piBinary, "Pi binary not found");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-real-workflow-"));
  const userDataDir = path.join(root, "user-data");
  const piDeckHome = path.join(root, "pideck-home");
  const sessionDir = path.join(root, "sessions");
  const projectCwd = path.join(root, "project");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(piDeckHome, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(projectCwd, { recursive: true });

  const token = `PI_DECK_REAL_WORKFLOW_${Date.now()}`;
  const workflowId = "c0000000-0000-4000-8000-000000000001";
  const workerId = "c0000000-0000-4000-8000-000000000002";
  const baseEnv: NodeJS.ProcessEnv = {
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_USER_DATA_DIR: userDataDir,
    PI_DECK_HOME: piDeckHome,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_DECK_PROJECT_CWD: projectCwd,
  };

  let runId: string | undefined;
  try {
    const firstLaunch = await launchPiDeck(baseEnv);
    try {
      await expectHealthyPreload(firstLaunch.page);
      const started = await firstLaunch.page.evaluate(
        async ({ token, workflowId, workerId }) => {
          const active = await window.piDeck.workspaces.getActive();
          if (!active.activeWorkspace) throw new Error("No active workspace");
          await window.piDeck.workflows.createWorkflow({
            workspaceId: active.activeWorkspace.id,
            scopeWorkspaceId: null,
            workflow: {
              format: "pi-deck.agent-workflow" as const,
              schemaVersion: 2 as const,
              id: workflowId,
              revision: 1,
              name: "Real Pi workflow smoke",
              inputs: [],
              entryNodeId: workerId,
              nodes: [
                {
                  id: workerId,
                  name: "Real Pi worker",
                  role: "worker" as const,
                  config: { instructions: `Reply with exactly: ${token}` },
                },
              ],
              relationships: [
                {
                  id: "c0000000-0000-4000-8000-000000000003",
                  from: workerId,
                  to: { end: "done" },
                },
              ],
            },
          });
          const run = await window.piDeck.workflows.canonicalStartRun({
            workflowId,
            workspaceId: active.activeWorkspace.id,
            inputs: {},
          });
          return { runId: run.id, workspaceId: active.activeWorkspace.id };
        },
        { token, workflowId, workerId },
      );
      runId = started.runId;

      await expect
        .poll(
          () =>
            firstLaunch.page.evaluate(async (id) => {
              const run = await window.piDeck.workflows.canonicalGetRun({
                runId: id,
              });
              return run.status;
            }, started.runId),
          {
            message: "Real Pi workflow run must complete",
            timeout: Number(
              process.env.PI_DECK_E2E_REAL_PROMPT_TIMEOUT_MS ?? 180_000,
            ),
          },
        )
        .toBe("completed");

      const completed = await firstLaunch.page.evaluate(async (id) => {
        const run = await window.piDeck.workflows.canonicalGetRun({
          runId: id,
        });
        const snapshot = await window.piDeck.workflows.graphGetSnapshot({
          runId: id,
        });
        return { run, snapshot };
      }, started.runId);
      expect(completed.run.occurrences).toHaveLength(1);
      expect(completed.run.occurrences[0]).toMatchObject({
        nodeId: workerId,
        status: "completed",
      });
      expect(String(completed.run.occurrences[0]?.output)).toContain(token);
      expect(completed.run.occurrences[0]?.sessionFile).toBeTruthy();
      expect(completed.snapshot.nodes).toEqual([
        expect.objectContaining({
          nodeId: workerId,
          aggregateStatus: "completed",
        }),
      ]);
      await expect
        .poll(() => listJsonlFiles(sessionDir), {
          message: "Real Pi workflow worker must persist its session",
          timeout: 30_000,
        })
        .toContain(completed.run.occurrences[0]!.sessionFile);
    } finally {
      await firstLaunch.app.close();
    }

    const secondLaunch = await launchPiDeck(baseEnv);
    try {
      await expectHealthyPreload(secondLaunch.page);
      const persisted = await secondLaunch.page.evaluate(async (id) => {
        const run = await window.piDeck.workflows.canonicalGetRun({
          runId: id,
        });
        const snapshot = await window.piDeck.workflows.graphGetSnapshot({
          runId: id,
        });
        return { run, snapshot };
      }, runId!);
      expect(persisted.run.status).toBe("completed");
      expect(persisted.run.occurrences).toHaveLength(1);
      expect(persisted.run.occurrences[0]).toMatchObject({
        nodeId: workerId,
        status: "completed",
      });
      expect(String(persisted.run.occurrences[0]?.output)).toContain(token);
      expect(persisted.run.occurrences[0]?.sessionFile).toBeTruthy();
      expect(persisted.snapshot.nodes).toEqual([
        expect.objectContaining({
          nodeId: workerId,
          aggregateStatus: "completed",
        }),
      ]);
      expect(listJsonlFiles(sessionDir)).toContain(
        persisted.run.occurrences[0]!.sessionFile,
      );

      await secondLaunch.page
        .getByRole("button", { name: "Agent Workflows" })
        .click();
      await secondLaunch.page
        .getByRole("button", { name: new RegExp(`Open run.*${runId}`) })
        .click();
      const graph = secondLaunch.page.getByLabel(
        "Live workflow execution graph",
      );
      await expect(graph).toBeVisible();
      const graphNode = graph.locator(`[data-workflow-node-id="${workerId}"]`);
      await expect(graphNode).toContainText("Real Pi worker");
      await graphNode.click();
      const openSession = secondLaunch.page.getByRole("button", {
        name: "Open Pi session",
      });
      await expect(openSession).toBeVisible();
      await openSession.click();
      await expect(
        secondLaunch.page
          .getByLabel("Chat / Agent Timeline")
          .getByText(token)
          .first(),
      ).toBeVisible();
    } finally {
      await secondLaunch.app.close();
    }
  } finally {
    if (process.env.PI_DECK_E2E_KEEP_REAL_SMOKE_ARTIFACTS !== "1") {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("real Pi GUI P0 smoke: default workspace prompt and resume", async () => {
  test.setTimeout(
    Number(process.env.PI_DECK_E2E_REAL_SMOKE_TIMEOUT_MS ?? 240_000),
  );
  const piBinary = resolvePiBinary();
  test.skip(!piBinary, "Pi binary not found");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-real-p0-"));
  const userDataDir = path.join(root, "user-data");
  const piDeckHome = path.join(root, "pideck-home");
  const sessionDir = path.join(root, "sessions");
  const projectCwd = path.join(root, "project");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(piDeckHome, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(projectCwd, { recursive: true });

  const token = `PI_DECK_REAL_GUI_P0_${Date.now()}`;
  const baseEnv: NodeJS.ProcessEnv = {
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_USER_DATA_DIR: userDataDir,
    PI_DECK_HOME: piDeckHome,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    // The real Pi acceptance harness loads beside the generated extension and
    // invokes its actual deck_delegate tool definition. It never uses fake RPC.
    PI_DECK_E2E_DELEGATE_HARNESS: "1",
  };

  try {
    const firstLaunch = await launchPiDeck({
      ...baseEnv,
      PI_DECK_PROJECT_CWD: projectCwd,
    });
    try {
      await expectHealthyPreload(firstLaunch.page);
      await expect(
        firstLaunch.page.getByRole("button", {
          name: "Workspace: Default workspace",
        }),
      ).toHaveAttribute("aria-current", "page");
      await expect
        .poll(() => listJsonlFiles(sessionDir).length, {
          message: "Startup must not leave a hidden empty warm-worker session",
          timeout: 30_000,
        })
        .toBe(0);

      await firstLaunch.page
        .getByRole("button", { name: "New session" })
        .click();
      await firstLaunch.page
        .getByLabel("Prompt text")
        .fill(`Reply with exactly: ${token}`);
      await firstLaunch.page.getByRole("button", { name: "Send" }).click();
      await expect(firstLaunch.page.getByText("Agent is working…")).toHaveCount(
        0,
        {
          timeout: Number(
            process.env.PI_DECK_E2E_REAL_PROMPT_TIMEOUT_MS ?? 180_000,
          ),
        },
      );

      await expect(
        firstLaunch.page
          .getByLabel("Chat / Agent Timeline")
          .getByText(token)
          .first(),
      ).toBeVisible();

      // The parent exists before enabling its parent-scoped mode. The explicit
      // instruction is also the deterministic harness trigger; that harness
      // calls the real generated deck_delegate tool, not a fake RPC endpoint.
      const multitaskControl = firstLaunch.page.locator(".multitask-control");
      await expect(multitaskControl).toHaveAttribute(
        "title",
        "Turn on multitasking",
      );
      const sessionItemCount = await firstLaunch.page
        .locator(".session-list .session-item")
        .count();
      await multitaskControl.click();
      await expect(multitaskControl).toHaveAttribute(
        "title",
        "Turn off multitasking",
      );
      await firstLaunch.page.evaluate(() => {
        const testWindow = window as typeof window & {
          __piDeckRealDelegateStates?: Array<{
            tasks: Array<{ generatedName: string; status: string }>;
          }>;
          __piDeckRealDelegateUnsubscribe?: () => void;
        };
        testWindow.__piDeckRealDelegateUnsubscribe?.();
        testWindow.__piDeckRealDelegateStates = [];
        testWindow.__piDeckRealDelegateUnsubscribe =
          window.piDeck.multitask.onState((state) =>
            testWindow.__piDeckRealDelegateStates?.push(state),
          );
      });
      await firstLaunch.page
        .getByLabel("Prompt text")
        .fill(
          "PI_DECK_E2E_INVOKE_DECK_DELEGATE: use deck_delegate now for one tiny task.",
        );
      await firstLaunch.page.getByRole("button", { name: "Send" }).click();
      await expect
        .poll(
          async () =>
            firstLaunch.page.evaluate(
              () =>
                (
                  window as typeof window & {
                    __piDeckRealDelegateStates?: Array<{
                      tasks: Array<{ status: string }>;
                    }>;
                  }
                ).__piDeckRealDelegateStates?.flatMap((state) =>
                  state.tasks.map((task) => task.status),
                ) ?? [],
            ),
          {
            timeout: Number(
              process.env.PI_DECK_E2E_REAL_DELEGATE_TIMEOUT_MS ?? 180_000,
            ),
          },
        )
        .toEqual(expect.arrayContaining(["queued", "running", "completed"]));
      await multitaskControl.focus();
      const statusList = firstLaunch.page.getByRole("list", {
        name: "Task statuses",
      });
      await expect(statusList).toContainText(
        "#1 Real delegated acceptance task — completed",
      );
      // A completed state is the terminal child result returned to the parent
      // extension; the renderer intentionally projects only that safe parent
      // status, not child transcript/session data.
      // Delegated workers remain private: there are no task controls or child
      // sessions, only the parent status and parent result.
      await expect(statusList.getByRole("button")).toHaveCount(0);
      await expect(
        firstLaunch.page.locator(".session-list .session-item"),
      ).toHaveCount(sessionItemCount);
      await expect(
        firstLaunch.page.getByLabel("Sessions").locator(".session-item", {
          hasText: "Real delegated acceptance task",
        }),
      ).toHaveCount(0);

      await expect
        .poll(() => listJsonlFiles(sessionDir).length, {
          message: "Pi should persist the prompted real session before restart",
          timeout: 30_000,
        })
        .toBeGreaterThan(0);
    } finally {
      await firstLaunch.page.evaluate(() => {
        (
          window as typeof window & {
            __piDeckRealDelegateUnsubscribe?: () => void;
          }
        ).__piDeckRealDelegateUnsubscribe?.();
      });
      await firstLaunch.app.close();
    }

    const secondLaunch = await launchPiDeck(baseEnv);
    try {
      await expectHealthyPreload(secondLaunch.page);
      await expect(
        secondLaunch.page.getByRole("button", {
          name: "Workspace: Default workspace",
        }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        secondLaunch.page.locator(".session-list .session-item").first(),
      ).toBeVisible();

      const savedSession = secondLaunch.page.getByRole("button", {
        name: `Session: Reply with exactly: ${token}`,
      });
      await expect(savedSession).toBeVisible();
      await savedSession.click();
      await expect(
        secondLaunch.page
          .getByLabel("Chat / Agent Timeline")
          .getByText(token)
          .first(),
      ).toBeVisible();
    } finally {
      await secondLaunch.app.close();
    }
  } finally {
    if (process.env.PI_DECK_E2E_KEEP_REAL_SMOKE_ARTIFACTS !== "1") {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
