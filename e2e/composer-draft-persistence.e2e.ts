import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");
const draftStorageKey = "pi-deck:composer-drafts";

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  pidFile: string;
}

function createFixture(
  name: string,
  fakeArgs: readonly string[] = [],
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-deck-${name}-`));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const piDeckHome = path.join(root, "pideck-home");
  const pidFile = path.join(root, "session-pids.log");
  for (const directory of [projectCwd, agentDir, userDataDir, piDeckHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    `${JSON.stringify({
      theme: "system",
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: false,
    })}\n`,
  );
  const fakePi = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    fakePi,
    `#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider model context max-out thinking images"); console.log("fake-provider fake-model 128K 32K yes yes"); process.exit(0); }\nif (!process.argv.includes("--no-session")) fs.appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");\nprocess.argv.push(...${JSON.stringify(fakeArgs)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return {
    root,
    pidFile,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: path.join(root, "home"),
      TMPDIR: os.tmpdir(),
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      PI_DECK_E2E_TEST: "1",
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: fakePi,
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DECK_HOME: piDeckHome,
      PI_DECK_USER_DATA_DIR: userDataDir,
    },
  };
}

async function launch(fixture: Fixture): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: fixture.env,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Preload error")).toHaveCount(0);
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

async function enterNewSession(page: Page): Promise<void> {
  await page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await expect(page.getByLabel("Prompt text")).toBeVisible();
}

async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New workspace…" }).click();
  const dialog = page.getByTestId("workspace-create-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(
    page.getByRole("button", { name: `Workspace: ${name}` }),
  ).toHaveAttribute("aria-current", "page");
}

async function openWorkspaceDraft(page: Page, name: string): Promise<void> {
  const workspaceButton = page.getByRole("button", {
    name: `Workspace: ${name}`,
  });
  await workspaceButton.click();
  await expect(workspaceButton).toHaveAttribute("aria-current", "page");
  const workspaceItem = page
    .locator(".workspace-tree-item")
    .filter({ has: workspaceButton });
  const draft = workspaceItem.getByRole("button", {
    name: "Session: Untitled new session",
  });
  await expect(draft).toHaveCount(1);
  await draft.click();
  await expect(page.getByLabel("Prompt text")).toBeVisible();
}

async function expectDraftStored(page: Page, text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ key, expected }) =>
          window.localStorage.getItem(key)?.includes(expected) ?? false,
        { key: draftStorageKey, expected: text },
      ),
    )
    .toBe(true);
}

function sessionWorkerCount(fixture: Fixture): number {
  if (!fs.existsSync(fixture.pidFile)) return 0;
  return fs
    .readFileSync(fixture.pidFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
}

function cleanup(fixture: Fixture): void {
  if (fs.existsSync(fixture.pidFile)) {
    for (const line of fs
      .readFileSync(fixture.pidFile, "utf8")
      .split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The app already retired this worker.
      }
    }
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("renderer reload restores a renderer-only draft without creating a worker", async () => {
  const fixture = createFixture("draft-reload");
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const page = launched.page;
    await enterNewSession(page);
    const text = "unsent renderer-only text survives reload";
    await page.getByLabel("Prompt text").fill(text);
    await expectDraftStored(page, text);
    expect(sessionWorkerCount(fixture)).toBe(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    // Startup intentionally opens All Work; restore the existing draft, not a
    // new session, to verify durable text independently of route persistence.
    const restoredDraft = page.getByRole("button", {
      name: "Session: Untitled new session",
      exact: true,
    });
    await expect(restoredDraft).toHaveCount(1);
    await restoredDraft.click();
    await expect(page.getByLabel("Prompt text")).toHaveValue(text);
    expect(sessionWorkerCount(fixture)).toBe(0);
  } finally {
    await app?.close().catch(() => undefined);
    cleanup(fixture);
  }
});

test("orderly restart restores distinct renderer-only drafts in multiple workspaces", async () => {
  const fixture = createFixture("draft-restart-workspaces");
  const alphaWorkspace = "Durable Alpha";
  const betaWorkspace = "Durable Beta";
  const alphaText = "alpha workspace unsent draft";
  const betaText = "beta workspace unsent draft";
  let firstApp: ElectronApplication | undefined;
  let secondApp: ElectronApplication | undefined;
  try {
    const first = await launch(fixture);
    firstApp = first.app;
    await createWorkspace(first.page, alphaWorkspace);
    await enterNewSession(first.page);
    await first.page.getByLabel("Prompt text").fill(alphaText);
    await expectDraftStored(first.page, alphaText);

    await createWorkspace(first.page, betaWorkspace);
    await enterNewSession(first.page);
    await first.page.getByLabel("Prompt text").fill(betaText);
    await expectDraftStored(first.page, betaText);
    expect(sessionWorkerCount(fixture)).toBe(0);
    await firstApp.close();
    firstApp = undefined;

    const second = await launch(fixture);
    secondApp = second.app;
    await openWorkspaceDraft(second.page, betaWorkspace);
    await expect(second.page.getByLabel("Prompt text")).toHaveValue(betaText);
    await openWorkspaceDraft(second.page, alphaWorkspace);
    await expect(second.page.getByLabel("Prompt text")).toHaveValue(alphaText);
    await openWorkspaceDraft(second.page, betaWorkspace);
    await expect(second.page.getByLabel("Prompt text")).toHaveValue(betaText);
    expect(sessionWorkerCount(fixture)).toBe(0);
  } finally {
    await firstApp?.close().catch(() => undefined);
    await secondApp?.close().catch(() => undefined);
    cleanup(fixture);
  }
});

test("a rejected first send keeps durable text through renderer reload", async () => {
  const fixture = createFixture("draft-rejected-send", [
    "--fail-command",
    "prompt",
  ]);
  const text = "rejected prompt must remain an unsent draft";
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const page = launched.page;
    await enterNewSession(page);
    await page.getByLabel("Prompt text").fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByLabel("Prompt text")).toHaveValue(text);
    await expect(page.locator('.composer-error[role="alert"]')).toContainText(
      /prompt/i,
    );
    await expectDraftStored(page, text);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    const failedSession = page
      .locator(".session-item")
      .filter({ has: page.locator(".session-draft-marker") });
    await expect(failedSession).toHaveCount(1);
    await failedSession.click();
    await expect(page.getByLabel("Prompt text")).toHaveValue(text);
  } finally {
    await app?.close().catch(() => undefined);
    cleanup(fixture);
  }
});
