import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

async function launchPiDeck(
  env: NodeJS.ProcessEnv = {},
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

type ThemePreference = "system" | "light" | "dark";

function createThemeUserData(theme: ThemePreference): string {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-theme-e2e-"),
  );
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    `${JSON.stringify(
      {
        theme,
        maxRunningSessions: 4,
        warmWorkerLimit: 1,
        enableLoginShellEnvCapture: true,
      },
      null,
      2,
    )}\n`,
  );
  return userDataDir;
}

function persistedTheme(userDataDir: string): string | undefined {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(userDataDir, "settings.json"), "utf8"),
    ) as { theme?: string };
    return settings.theme;
  } catch {
    return undefined;
  }
}

function createFakePiBinary(root: string, extraArgs: string[] = []): string {
  const fakePiPath = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    fakePiPath,
    `#!/usr/bin/env node\nconst cwdLogPath = process.env.PI_DECK_TEST_FAKE_PI_CWD_LOG;\nif (cwdLogPath) {\n  require("fs").appendFileSync(cwdLogPath, process.cwd() + "\\n");\n}\nif (process.argv.includes("--version")) {\n  console.log("v42.5.0");\n  process.exit(0);\n}\nif (process.argv.includes("--list-models")) {\n  console.log("provider  model       context  max-out  thinking  images");\n  console.log("fake-provider  fake-model  128K     32K      yes       yes");\n  process.exit(0);\n}\nprocess.argv.push(...${JSON.stringify(extraArgs)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return fakePiPath;
}

function fakeRealModeEnv(options: {
  root: string;
  projectCwd?: string;
  agentDir: string;
  userDataDir?: string;
  testPickProjectCwd?: string;
  testPickProjectCwds?: string[];
  fakePiArgs?: string[];
  fakePiCwdLog?: string;
}): NodeJS.ProcessEnv {
  return {
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: createFakePiBinary(options.root, options.fakePiArgs),
    ...(options.projectCwd ? { PI_DECK_PROJECT_CWD: options.projectCwd } : {}),
    PI_CODING_AGENT_DIR: options.agentDir,
    PI_DECK_HOME: path.join(options.root, "pideck-home"),
    PI_DECK_USER_DATA_DIR:
      options.userDataDir ?? path.join(options.root, "user-data"),
    ...(options.testPickProjectCwd
      ? { PI_DECK_TEST_PICK_PROJECT_CWD: options.testPickProjectCwd }
      : {}),
    ...(options.testPickProjectCwds
      ? {
          PI_DECK_TEST_PICK_PROJECT_CWDS: JSON.stringify(
            options.testPickProjectCwds,
          ),
        }
      : {}),
    ...(options.fakePiCwdLog
      ? { PI_DECK_TEST_FAKE_PI_CWD_LOG: options.fakePiCwdLog }
      : {}),
  };
}

interface CachedSessionRef {
  sessionFile: string;
  sessionId?: string;
  title?: string;
  messageCount?: number;
  preview?: string;
}

function cachedSessionRef(home: string, sessionFile: string): CachedSessionRef {
  const store = JSON.parse(
    fs.readFileSync(path.join(home, "projects.json"), "utf8"),
  ) as { sessionRefs?: CachedSessionRef[] };
  const canonicalSessionFile = fs.realpathSync(sessionFile);
  const ref = store.sessionRefs?.find(
    (candidate) => candidate.sessionFile === canonicalSessionFile,
  );
  if (ref === undefined) {
    throw new Error(
      `Missing cached session metadata for ${canonicalSessionFile}`,
    );
  }
  return ref;
}

async function expectHealthyPreload(page: Page): Promise<void> {
  await expect(page.getByText("Preload error")).toHaveCount(0);
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
}

async function expectAllWorkLaunch(page: Page): Promise<void> {
  const route = page.locator(
    '.workspace[data-primary-view="work"][data-work-scope="all"]',
  );
  await expect(route).toBeVisible();
  await expect(
    route.getByRole("heading", { name: "All Work", exact: true }),
  ).toBeVisible();
  await expect(route.locator(".surface-title")).toHaveText("All Work");
  await expect(route.locator(".usage-toggle")).toHaveCount(0);
  await expect(route.locator(".activity-inbox-close")).toHaveCount(0);
  await expect(
    route.getByRole("button", { name: /^Close .*Work$/ }),
  ).toHaveCount(0);
}

function sidebarNewSessionButton(page: Page) {
  return page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true });
}

async function enterSessionDetail(page: Page): Promise<void> {
  const newSession = sidebarNewSessionButton(page);
  await expect(newSession).toBeVisible();
  await newSession.click();
  await expect(
    page.locator('.workspace[data-primary-view="session"]'),
  ).toBeVisible();
  await expect(page.getByLabel("Prompt text")).toBeVisible();
}

async function expectWorkRoute(page: Page, scope: string): Promise<void> {
  const route = page.locator('.workspace[data-primary-view="work"]');
  await expect(route).toBeVisible();
  await expect(route).toHaveAttribute("data-work-scope", scope);
}

async function expectRuntimeIds(
  page: Page,
  runtimeIds: readonly string[],
): Promise<void> {
  const attachedIds = await page.evaluate(
    async (ids) => {
      const statuses = await Promise.all(
        ids.map((runtimeId) =>
          window.piDeck.chat.getRuntimeStatus({ runtimeId }),
        ),
      );
      return statuses.map((status) => status.runtimeId);
    },
    [...runtimeIds],
  );
  expect(attachedIds).toEqual([...runtimeIds]);
}

function writePiSessionFixture(options: {
  sessionFile: string;
  sessionId: string;
  projectCwd: string;
}): void {
  fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true });
  fs.writeFileSync(
    options.sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: options.sessionId,
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: options.projectCwd,
    })}\n`,
  );
}

async function createWorkspaceInUi(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New workspace…" }).click();
  const dialog = page.getByTestId("workspace-create-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  const workspace = page.getByRole("button", { name: `Workspace: ${name}` });
  await expect(workspace).toHaveAttribute("aria-current", "page");
  await expect(
    workspace.locator(".workspace-tree-active-indicator"),
  ).toBeVisible();
}

async function openWorkspaceActions(page: Page, name: string): Promise<void> {
  await page
    .getByRole("button", { name: `Workspace actions for ${name}` })
    .click();
}

async function expectWorkspaceActionsMenuLayout(
  page: Page,
  name: string,
): Promise<void> {
  const trigger = page.getByRole("button", {
    name: `Workspace actions for ${name}`,
  });
  const menu = page.getByRole("menu", {
    name: `Workspace actions for ${name}`,
  });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("display", "grid");
  await expect(menu).not.toHaveClass(/workspace-tree-actions/);

  const items = [
    page.getByRole("menuitem", { name: "View Work" }),
    page.getByRole("menuitem", { name: "Rename workspace" }),
    page.getByRole("menuitem", { name: "Archive workspace" }),
  ];
  for (const item of items) {
    await expect(item).toBeVisible();
  }
  await expect(items[2]!).toHaveCSS("justify-content", "flex-start");

  const triggerBounds = await trigger.boundingBox();
  const menuBounds = await menu.boundingBox();
  const itemBounds = await Promise.all(items.map((item) => item.boundingBox()));
  if (!triggerBounds || !menuBounds || itemBounds.some((bounds) => !bounds)) {
    throw new Error(`Workspace actions menu for ${name} has no bounding box`);
  }

  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    width: window.innerWidth,
  }));
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height);
  expect(menuBounds.width).toBeLessThanOrEqual(260);
  expect(triggerBounds.x).toBeGreaterThanOrEqual(menuBounds.x);
  expect(triggerBounds.x).toBeLessThanOrEqual(menuBounds.x + menuBounds.width);

  const concreteItemBounds = itemBounds as Array<
    NonNullable<(typeof itemBounds)[number]>
  >;
  concreteItemBounds.forEach((bounds) => {
    expect(bounds.x).toBeGreaterThanOrEqual(menuBounds.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      menuBounds.x + menuBounds.width,
    );
    expect(bounds.height).toBeGreaterThan(20);
  });
  for (let index = 1; index < concreteItemBounds.length; index += 1) {
    const previous = concreteItemBounds[index - 1]!;
    const current = concreteItemBounds[index]!;
    expect(current.y).toBeGreaterThanOrEqual(previous.y + previous.height);
  }
}

async function selectWorkspaceInUi(page: Page, name: string): Promise<void> {
  const workspace = page.getByRole("button", { name: `Workspace: ${name}` });
  await workspace.click();
  await expect(workspace).toHaveAttribute("aria-current", "page");
  await expect(
    workspace.locator(".workspace-tree-active-indicator"),
  ).toBeVisible();
}

async function pasteTinyImageAttachment(
  page: Page,
  fileName = "draft-image.png",
): Promise<void> {
  const base64 = tinyPngBase64();
  await page.getByLabel("Prompt text").focus();
  await page.evaluate(
    ({ base64, fileName }) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Prompt text"]',
      );
      if (textarea === null) throw new Error("Prompt text area not found.");
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], fileName, { type: "image/png" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    },
    { base64, fileName },
  );
  await expect(page.locator(".composer .attachment-chip")).toContainText(
    fileName,
  );
}

async function confirmDeleteSessionDialog(page: Page): Promise<void> {
  const dialog = page.getByTestId("session-delete-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete session" }).click();
}

async function selectPromptDestinationInUi(
  page: Page,
  destination: "parent" | "newTaskSession",
): Promise<void> {
  const promptDestination = page.getByLabel("Prompt destination");
  await promptDestination.selectOption(destination);
  await expect(promptDestination).toHaveValue(destination);
}

test("New Session draft shows and commits inline workspace ownership", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-draft-workspace-"),
  );
  const projectCwd = path.join(root, "default-project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--include-usage"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await expectAllWorkLaunch(page);
    await createWorkspaceInUi(page, "Inline Alpha");
    await createWorkspaceInUi(page, "Inline Beta");
    const workspaceIds = await page.evaluate(async () => {
      const result = await window.piDeck.workspaces.list();
      const defaultWorkspace = result.workspaces.find(
        (workspace) => workspace.isDefault === true,
      );
      if (defaultWorkspace === undefined) {
        throw new Error("Default workspace not found.");
      }
      return {
        ...Object.fromEntries(
          result.workspaces.map((workspace) => [workspace.name, workspace.id]),
        ),
        default: defaultWorkspace.id,
      };
    });
    expect(workspaceIds["Inline Alpha"]).toEqual(expect.any(String));
    expect(workspaceIds["Inline Beta"]).toEqual(expect.any(String));
    expect(workspaceIds.default).toEqual(expect.any(String));
    await page.getByRole("button", { name: "All Work" }).click();
    await expectAllWorkLaunch(page);

    await sidebarNewSessionButton(page).click();
    await expect(
      page.locator('.workspace[data-primary-view="session"]'),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const globalWorkspace = page.getByLabel("New session workspace");
    await expect(globalWorkspace).toBeVisible();
    await expect(globalWorkspace).toHaveValue(workspaceIds.default!);
    await globalWorkspace.focus();
    await expect(globalWorkspace).toBeFocused();
    await expect(page.getByTestId("session-origin-back")).toHaveAttribute(
      "aria-label",
      "Back to All Work",
    );

    const prompt = page.getByLabel("Prompt text");
    await prompt.fill("global draft follows inline ownership");
    await pasteTinyImageAttachment(page);
    await globalWorkspace.selectOption({ label: "Inline Alpha" });
    await expect(globalWorkspace).toHaveValue(workspaceIds["Inline Alpha"]!);
    await expect(prompt).toHaveValue("global draft follows inline ownership");
    await expect(page.locator(".composer .attachment-chip")).toContainText(
      "draft-image.png",
    );
    await expect(page.getByTestId("session-origin-back")).toHaveAttribute(
      "aria-label",
      "Back to All Work",
    );

    await expect
      .poll(async () =>
        page.evaluate(
          async (workspaceIds) => {
            const [defaultSessions, alphaSessions, betaSessions] =
              await Promise.all([
                window.piDeck.chat.listSessions({
                  workspaceId: workspaceIds.defaultWorkspaceId,
                }),
                window.piDeck.chat.listSessions({
                  workspaceId: workspaceIds.alphaWorkspaceId,
                }),
                window.piDeck.chat.listSessions({
                  workspaceId: workspaceIds.betaWorkspaceId,
                }),
              ]);
            return {
              default: defaultSessions.sessions.length,
              alpha: alphaSessions.sessions.length,
              beta: betaSessions.sessions.length,
            };
          },
          {
            defaultWorkspaceId: workspaceIds.default!,
            alphaWorkspaceId: workspaceIds["Inline Alpha"]!,
            betaWorkspaceId: workspaceIds["Inline Beta"]!,
          },
        ),
      )
      .toEqual({ default: 0, alpha: 0, beta: 0 });

    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: global draft follows inline ownership/),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("New session workspace")).toHaveCount(0);
    await expect(
      page.locator(".topbar .session-workspace-context"),
    ).toHaveAccessibleName("Workspace: Inline Alpha");
    const committed = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      const alphaSessions = await window.piDeck.chat.listSessions({
        workspaceId: snapshot.workspaceId,
      });
      return {
        workspaceId: snapshot.workspaceId,
        title: alphaSessions.sessions[0]?.title,
        count: alphaSessions.sessions.length,
      };
    });
    expect(committed).toMatchObject({
      workspaceId: workspaceIds["Inline Alpha"],
      title: "global draft follows inline ownership",
      count: 1,
    });

    await page.getByTestId("session-origin-back").click();
    await expectAllWorkLaunch(page);
    await selectWorkspaceInUi(page, "Inline Beta");
    await sidebarNewSessionButton(page).click();
    const scopedWorkspace = page.getByLabel("New session workspace");
    await expect(scopedWorkspace).toHaveValue(workspaceIds["Inline Beta"]!);
    await page
      .getByLabel("Prompt text")
      .fill("scoped draft can switch before first prompt");
    await scopedWorkspace.selectOption({ label: "Inline Alpha" });
    await expect(scopedWorkspace).toHaveValue(workspaceIds["Inline Alpha"]!);
    await expect(page.getByTestId("session-origin-back")).toHaveAttribute(
      "aria-label",
      "Back to Inline Beta Work",
    );
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(
        /Fake response to: scoped draft can switch before first prompt/,
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () =>
        page.evaluate(
          async (workspaceIds) => {
            const [alphaSessions, betaSessions] = await Promise.all([
              window.piDeck.chat.listSessions({
                workspaceId: workspaceIds.alphaWorkspaceId,
              }),
              window.piDeck.chat.listSessions({
                workspaceId: workspaceIds.betaWorkspaceId,
              }),
            ]);
            return {
              alphaTitles: alphaSessions.sessions
                .map((session) => session.title)
                .sort(),
              betaCount: betaSessions.sessions.length,
            };
          },
          {
            alphaWorkspaceId: workspaceIds["Inline Alpha"]!,
            betaWorkspaceId: workspaceIds["Inline Beta"]!,
          },
        ),
      )
      .toEqual({
        alphaTitles: [
          "global draft follows inline ownership",
          "scoped draft can switch before first prompt",
        ],
        betaCount: 0,
      });
    await page.getByTestId("session-origin-back").click();
    await expectWorkRoute(page, workspaceIds["Inline Beta"]!);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace overflow menu remains compact and vertical with a long workspace name", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-menu-layout-"),
  );
  const projectCwd = path.join(root, "authorized-project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
    }),
  );
  try {
    await page.setViewportSize({ width: 800, height: 700 });
    await expectHealthyPreload(page);
    const longWorkspaceName =
      "Workspace with an extremely long name that should never stretch actions";
    await createWorkspaceInUi(page, longWorkspaceName);

    await openWorkspaceActions(page, longWorkspaceName);
    await expectWorkspaceActionsMenuLayout(page, longWorkspaceName);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkspaceActions(page, longWorkspaceName);
    await expectWorkspaceActionsMenuLayout(page, longWorkspaceName);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Workspace Work displays durable usage across relaunch, move, and delete", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-usage-"),
  );
  const projectCwd = path.join(root, "authorized-project");
  const agentDir = path.join(root, "agent");
  const sessionFile = path.join(
    agentDir,
    "sessions",
    "--usage--",
    "usage.jsonl",
  );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        id: "usage-session",
        timestamp: "2026-08-21T10:00:00.000Z",
        cwd: projectCwd,
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-21T10:00:01.000Z",
        message: { id: "user-one", role: "user", content: "usage please" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-21T10:00:02.000Z",
        message: {
          id: "assistant-known-cost",
          role: "assistant",
          content: "known cost",
          usage: {
            inputTokens: 1000,
            outputTokens: 400,
            cacheReadTokens: 100,
            cacheWriteTokens: 0,
            totalTokens: 1500,
            totalCostUsd: 0.42,
            contextUsedTokens: 999999,
          },
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-21T10:00:03.000Z",
        message: {
          id: "assistant-missing-cost",
          role: "assistant",
          content: "missing cost",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      }),
    ].join("\n"),
  );

  const env = fakeRealModeEnv({ root, projectCwd, agentDir });
  let launched = await launchPiDeck(env);
  let app = launched.app;
  let page = launched.page;
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await expect(page.locator(".activity-inbox-usage")).toContainText(
      "1.50K tokens",
    );
    await expect(page.locator(".activity-inbox-usage")).toContainText(
      "$0.42 known cost · 1 executions without cost data",
    );
    await page.locator(".activity-inbox-usage summary").click();
    await expect(page.locator(".activity-inbox-usage dl")).toContainText(
      "1,505",
    );
    await expect(page.locator(".activity-inbox-usage dl")).not.toContainText(
      "999999",
    );

    await app.close();
    launched = await launchPiDeck(env);
    app = launched.app;
    page = launched.page;
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await expect(page.locator(".activity-inbox-usage")).toContainText(
      "1.50K tokens",
    );

    const moved = await page.evaluate(async (file) => {
      const before = await window.piDeck.workspaces.list();
      const sourceId = before.activeWorkspaceId!;
      await window.piDeck.workspaces.create({ name: "Usage target" });
      const afterCreate = await window.piDeck.workspaces.list();
      const targetId = afterCreate.activeWorkspaceId!;
      await window.piDeck.workspaces.moveSession({
        sessionFile: file,
        toWorkspaceId: targetId,
      });
      return {
        source: await window.piDeck.workspaces.getUsage({
          workspaceId: sourceId,
        }),
        target: await window.piDeck.workspaces.getUsage({
          workspaceId: targetId,
        }),
        targetId,
      };
    }, sessionFile);
    expect(moved.source.usage.totalTokens).toBe(0);
    expect(moved.target.usage.totalTokens).toBe(1505);

    await page.evaluate(
      async ({ workspaceId, file }) => {
        await window.piDeck.chat.deleteSession({
          workspaceId,
          sessionFile: file,
        });
      },
      { workspaceId: moved.targetId, file: sessionFile },
    );
    expect(fs.existsSync(sessionFile)).toBe(false);

    await app.close();
    launched = await launchPiDeck(env);
    app = launched.app;
    page = launched.page;
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, "Usage target");
    await expect(page.locator(".activity-inbox-usage")).toContainText(
      "1.50K tokens",
    );
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Workspace usage includes private task attempts and parent synthesis exactly once", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-private-usage-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const fixture = path.join(root, "usage-plan.json");
  for (const directory of [projectCwd, agentDir, userDataDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    '{"maxRunningSessions":4}',
  );
  fs.writeFileSync(
    fixture,
    JSON.stringify({
      version: 1,
      tasks: [
        { name: "Count private worker usage", lifecycle: "completed" },
        {
          name: "Retry before success",
          lifecycle: "failed",
          attempts: 2,
        },
      ],
      synthesis: "Synthesis: private usage counted.",
    }),
  );

  const { app, page } = await launchPiDeck({
    ...fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      userDataDir,
      fakePiArgs: [
        "--prompt-scenario",
        "routing",
        "--task-routing-fixture",
        fixture,
        "--include-usage",
        "--stream-delay-ms",
        "10",
      ],
    }),
    NODE_ENV: "test",
    PI_DECK_E2E_TASK_SESSION_ACCEPTANCE: "1",
    PI_DECK_TEST_TASK_ROUTING_FIXTURE: fixture,
  });
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    const workspaceId = await page.evaluate(
      async () => (await window.piDeck.workspaces.list()).activeWorkspaceId!,
    );
    await page.evaluate(() =>
      window.piDeck.settings.update({ maxRunningSessions: 4 }),
    );
    await enterSessionDetail(page);
    await page
      .getByRole("button", { name: "Parallel multitasking: Off" })
      .click();
    await selectPromptDestinationInUi(page, "newTaskSession");
    await page
      .getByLabel("Prompt text")
      .fill("Run usage-accounting private tasks.");
    await page.getByRole("button", { name: "Send" }).click();

    const panel = page.getByRole("region", {
      name: "Parallel task sessions",
    });
    await expect(panel.getByRole("listitem")).toHaveCount(2);
    await expect(panel).toHaveCount(0, { timeout: 30_000 });

    const usage = await page.evaluate(
      async (id) =>
        (await window.piDeck.workspaces.getUsage({ workspaceId: id })).usage,
      workspaceId,
    );
    // Five settled model executions report usage: one successful private task,
    // the retrying task's two failed provider attempts plus its successful
    // third attempt, and the parent synthesis turn. Re-querying proves the
    // cumulative runtime/session views are upserted rather than appended.
    expect(usage.totalTokens).toBe(575);
    expect(usage.contributorsWithCost).toBe(5);
    expect(usage.knownCostUsd).toBeCloseTo(0.25, 8);
    const repeated = await page.evaluate(
      async (id) =>
        (await window.piDeck.workspaces.getUsage({ workspaceId: id })).usage,
      workspaceId,
    );
    expect(repeated.totalTokens).toBe(575);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace management UI keeps Pi JSONL membership reversible and deletion explicit", async () => {
  // The fixture JSONL is written directly to the deterministic fake-real-mode
  // repository, then discovered and managed exclusively through visible app
  // controls. No native picker, prompt, or confirmation dialog is invoked.
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-management-ui-"),
  );
  const projectCwd = path.join(root, "authorized-project");
  const agentDir = path.join(root, "agent");
  const sessionFile = path.join(
    agentDir,
    "sessions",
    "--workspace-ui--",
    "ui-membership.jsonl",
  );
  fs.mkdirSync(projectCwd, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "20000"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    const workspaceTree = page.getByTestId("workspace-tree");
    await expect
      .poll(() =>
        workspaceTree.evaluate((element) => ({
          overflowX: getComputedStyle(element).overflowX,
          overflowY: getComputedStyle(element).overflowY,
        })),
      )
      .toEqual({ overflowX: "hidden", overflowY: "auto" });

    // A busy runtime is a workspace-level archival guard. Runtime shutdown is
    // otherwise internal, so users do not need a separate close affordance.
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("keep archive disabled");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Close runtime/i }),
    ).toHaveCount(0);
    const busyRuntimeId = await page.evaluate(
      async () => (await window.piDeck.chat.getSnapshot()).runtimeId,
    );
    const busyCloseError = await page.evaluate(async (runtimeId) => {
      try {
        await window.piDeck.chat.closeSession({ runtimeId });
        return "unexpected success";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, busyRuntimeId);
    expect(busyCloseError).toMatch(/finish the active turn/i);
    await openWorkspaceActions(page, "authorized-project");
    await expectWorkspaceActionsMenuLayout(page, "authorized-project");
    await page.getByRole("menuitem", { name: "Archive workspace" }).click();
    const blockedArchiveDialog = page.getByTestId("workspace-archive-dialog");
    await expect(
      blockedArchiveDialog.getByRole("button", { name: "Archive workspace" }),
    ).toBeDisabled();
    await expect(blockedArchiveDialog).toContainText(
      "Finish active sessions before archiving this workspace.",
    );
    await blockedArchiveDialog.getByRole("button", { name: "Cancel" }).click();

    await createWorkspaceInUi(page, "UI source");
    await openWorkspaceActions(page, "UI source");
    await expectWorkspaceActionsMenuLayout(page, "UI source");
    await page.getByRole("menuitem", { name: "Rename workspace" }).click();
    const renameDialog = page.getByTestId("workspace-rename-dialog");
    await expect(renameDialog).toBeVisible();
    await renameDialog.getByLabel("Workspace name").fill("UI source renamed");
    await renameDialog.getByRole("button", { name: "Save name" }).click();
    await expect(
      page.getByRole("button", {
        name: "Workspace: UI source renamed",
      }),
    ).toHaveAttribute("aria-current", "page");

    // Seed after startup so this file has no pre-existing workspace owner.
    writePiSessionFixture({
      sessionFile,
      sessionId: "workspace-ui-membership",
      projectCwd,
    });
    const canonicalSessionFile = fs.realpathSync(sessionFile);
    await page.getByRole("button", { name: "Add existing session…" }).click();
    const unassignedDialog = page.getByTestId("unassigned-sessions");
    await expect(unassignedDialog).toBeVisible();
    await expect(unassignedDialog.getByText("ui-membership")).toBeVisible();
    await unassignedDialog.getByRole("checkbox").check();
    await unassignedDialog
      .getByRole("button", { name: "Add selected sessions" })
      .click();
    const sessionRow = page.getByRole("button", {
      name: "Session: ui-membership",
    });
    await expect(sessionRow).toBeVisible();

    await createWorkspaceInUi(page, "UI destination");
    await selectWorkspaceInUi(page, "UI source renamed");
    const sessionActions = page.getByRole("button", {
      name: "Session actions for ui-membership",
    });
    await sessionActions.click();
    await page.getByRole("menuitem", { name: "Move to workspace…" }).click();
    const moveDialog = page.getByTestId("session-move-dialog");
    await expect(moveDialog).toBeVisible();
    await moveDialog
      .getByLabel("Destination workspace")
      .selectOption({ label: "UI destination" });
    await moveDialog.getByRole("button", { name: "Move session" }).click();
    // The sidebar now keeps destination workspaces browseable in place. Scope
    // the source assertion to the active workspace tree instead of assuming
    // a moved row disappears from the entire sidebar.
    await expect(
      page
        .locator(".workspace-tree-item.active")
        .getByRole("button", { name: "Session: ui-membership" }),
    ).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);

    // The source is empty after move. Archiving changes only workspace
    // metadata, which is intentionally independent from the Pi JSONL file.
    await openWorkspaceActions(page, "UI source renamed");
    await page.getByRole("menuitem", { name: "Archive workspace" }).click();
    const archiveDialog = page.getByTestId("workspace-archive-dialog");
    await expect(archiveDialog).toBeVisible();
    await archiveDialog
      .getByRole("button", { name: "Archive workspace" })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Workspace: UI source renamed",
      }),
    ).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);

    await selectWorkspaceInUi(page, "UI destination");
    await expect(sessionRow).toBeVisible();
    await page
      .getByRole("button", { name: "Session actions for ui-membership" })
      .click();
    await page.getByRole("menuitem", { name: "Archive session" }).click();
    await expect(sessionRow).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);
    await page.getByRole("button", { name: /Archived/ }).click();
    const archivedTree = page.getByTestId("archived-tree");
    await expect(archivedTree).toContainText("ui-membership");
    await expect(
      workspaceTree.locator('[data-testid="archived-tree"]'),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Restore session" }).click();
    await expect(sessionRow).toBeVisible();

    await createWorkspaceInUi(page, "Cascade workspace");
    await selectWorkspaceInUi(page, "UI destination");
    await page
      .getByRole("button", { name: "Session actions for ui-membership" })
      .click();
    await page.getByRole("menuitem", { name: "Move to workspace…" }).click();
    const cascadeMoveDialog = page.getByTestId("session-move-dialog");
    await cascadeMoveDialog
      .getByLabel("Destination workspace")
      .selectOption({ label: "Cascade workspace" });
    await cascadeMoveDialog
      .getByRole("button", { name: "Move session" })
      .click();
    await selectWorkspaceInUi(page, "Cascade workspace");
    await expect(sessionRow).toBeVisible();
    await openWorkspaceActions(page, "Cascade workspace");
    await page.getByRole("menuitem", { name: "Archive workspace" }).click();
    await page
      .getByTestId("workspace-archive-dialog")
      .getByRole("button", { name: "Archive workspace" })
      .click();
    await expect(
      page.getByRole("button", { name: "Workspace: Cascade workspace" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("archived-tree")).toContainText(
      "Cascade workspace",
    );
    await expect(
      page
        .locator(".archived-tree-workspace")
        .filter({ hasText: "Cascade workspace" })
        .getByRole("button", { name: "Restore session" }),
    ).toBeDisabled();
    await page
      .locator(".archived-tree-workspace")
      .filter({ hasText: "Cascade workspace" })
      .getByRole("button", { name: "Restore workspace" })
      .click();
    await expect(
      page.getByRole("button", { name: "Workspace: Cascade workspace" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(sessionRow).toBeVisible();

    await page
      .getByRole("button", { name: "Session actions for ui-membership" })
      .click();
    await page.getByRole("menuitem", { name: "Remove from workspace" }).click();
    const removeDialog = page.getByTestId("session-remove-dialog");
    await expect(removeDialog).toBeVisible();
    await removeDialog
      .getByRole("button", { name: "Remove from workspace" })
      .click();
    await expect(sessionRow).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);

    // Re-importing the now-unassigned file makes the destructive action an
    // explicit, separately confirmed operation rather than a side effect of
    // removing workspace membership.
    await page.getByRole("button", { name: "Add existing session…" }).click();
    await expect(unassignedDialog).toBeVisible();
    await expect(unassignedDialog.getByText("ui-membership")).toBeVisible();
    await unassignedDialog.getByRole("checkbox").check();
    await unassignedDialog
      .getByRole("button", { name: "Add selected sessions" })
      .click();
    await expect(sessionRow).toBeVisible();
    await page
      .getByRole("button", { name: "Session actions for ui-membership" })
      .click();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);
    await expect(sessionRow).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Unified Work opens a saved sidebar row across workspaces through canonical resume", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-cross-workspace-row-"),
  );
  const sourceCwd = path.join(root, "source-project");
  const agentDir = path.join(root, "agent");
  const sessionFile = path.join(
    agentDir,
    "sessions",
    "--cross-workspace--",
    "saved-cross-workspace.jsonl",
  );
  fs.mkdirSync(sourceCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  writePiSessionFixture({
    sessionFile,
    sessionId: "saved-cross-workspace",
    projectCwd: sourceCwd,
  });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd: sourceCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    const sourceName = path.basename(sourceCwd);
    await createWorkspaceInUi(page, "Cross destination");
    const destinationId = await page.evaluate(async () => {
      const active = await window.piDeck.workspaces.getActive();
      if (active.activeWorkspace === undefined) {
        throw new Error("Destination workspace was not selected.");
      }
      return active.activeWorkspace.id;
    });
    await page.evaluate(
      ({ destinationId, sessionFile }) =>
        window.piDeck.workspaces.addSession({
          workspaceId: destinationId,
          sessionFile,
        }),
      { destinationId, sessionFile: fs.realpathSync(sessionFile) },
    );
    await page.getByLabel("Refresh sessions").click();
    const savedRow = page.getByRole("button", {
      name: "Session: saved-cross-workspace",
    });
    await expect(savedRow).toBeVisible();

    // Leave the source workspace active so this is a direct cross-workspace
    // sidebar selection rather than a prior workspace navigation. Keep a
    // source runtime attached as well; the transaction must not evict it.
    await selectWorkspaceInUi(page, sourceName);
    await enterSessionDetail(page);
    const sourcePrompt = "Keep source runtime attached";
    await page.getByLabel("Prompt text").fill(sourcePrompt);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(`Fake response to: ${sourcePrompt}`, { exact: true }),
    ).toBeVisible();
    const sourceRuntimeId = await page.evaluate(
      async () => (await window.piDeck.chat.getSnapshot()).runtimeId,
    );
    await expectRuntimeIds(page, [sourceRuntimeId]);

    await savedRow.click();
    await expect(
      page.locator('.workspace[data-primary-view="session"]'),
    ).toBeVisible();
    await expect(page.locator(".ui-status-message")).toContainText(
      "Resumed saved Pi session.",
    );
    const resumedRuntimeId = await page.evaluate(
      async () => (await window.piDeck.chat.getSnapshot()).runtimeId,
    );
    expect(resumedRuntimeId).not.toBe(sourceRuntimeId);
    await expectRuntimeIds(page, [sourceRuntimeId, resumedRuntimeId]);
    await expect(page.getByTestId("session-origin-back")).toHaveAttribute(
      "aria-label",
      `Back to ${sourceName} Work`,
    );
    await expect
      .poll(async () =>
        page.evaluate(
          async () =>
            (await window.piDeck.workspaces.getActive()).activeWorkspace
              ?.name ?? null,
        ),
      )
      .toBe("Cross destination");
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new workspaces send with managed context and model defaults without a folder picker", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-managed-workspace-"),
  );
  const bootstrapCwd = path.join(root, "bootstrap-project");
  const agentDir = path.join(root, "agent");
  const fakePiCwdLog = path.join(root, "fake-pi-cwds.log");
  const piDeckHome = path.join(root, "pideck-home");
  const managedCwd = path.join(piDeckHome, "runtime-context");
  fs.mkdirSync(bootstrapCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd: bootstrapCwd,
      agentDir,
      fakePiCwdLog,
      // If first send regresses to the project picker, it consumes this
      // cancellation and cannot produce the response asserted below.
      testPickProjectCwds: ["__cancel__"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await createWorkspaceInUi(page, "Managed topic");
    await enterSessionDetail(page);

    await expect(
      page.getByRole("button", { name: /working folder/i }),
    ).toHaveCount(0);
    const configuration = page.locator(".pi-configuration-trigger");
    await expect(configuration).toHaveAttribute("data-model-id", "fake-model");
    await expect(configuration).toHaveAttribute(
      "data-model-provider",
      "fake-provider",
    );
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );

    const beforeSend = await page.evaluate(async () => {
      const result = await window.piDeck.workspaces.getActive();
      return result.activeWorkspace;
    });
    expect(beforeSend?.name).toBe("Managed topic");
    expect(beforeSend?.defaultProjectId).toBeUndefined();

    await configuration.click();
    await page.getByRole("menuitemradio", { name: "max", exact: true }).click();
    await expect(configuration).toHaveAttribute("data-thinking-level", "max");

    const composer = page.getByLabel("Prompt text");
    await composer.fill("managed context first prompt");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: managed context first prompt/),
    ).toBeVisible({ timeout: 20_000 });

    const created = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      const workspaces = await window.piDeck.workspaces.getActive();
      return {
        cwd: snapshot.state.cwd,
        sessionFile: snapshot.state.sessionFile,
        thinkingLevel: snapshot.state.thinkingLevel,
        workspace: workspaces.activeWorkspace,
      };
    });
    expect(created.cwd).toBe(fs.realpathSync(managedCwd));
    expect(created.thinkingLevel).toBe("max");
    expect(created.workspace?.defaultProjectId).toBeUndefined();
    expect(created.sessionFile).toEqual(expect.any(String));
    const sessionFile = fs.realpathSync(created.sessionFile as string);

    const loggedCwds = fs.readFileSync(fakePiCwdLog, "utf8").trim().split("\n");
    expect(loggedCwds.at(-1)).toBe(fs.realpathSync(managedCwd));

    await expect(
      page.getByRole("button", { name: /Close runtime/i }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Session actions for managed context first prompt",
      })
      .click();
    await page.getByRole("menuitem", { name: "Archive session" }).click();
    await expect(page.getByText(/Archived session/)).toBeVisible();
    await page.getByRole("button", { name: /Archived/ }).click();
    await expect(page.getByTestId("archived-tree")).toContainText(
      "managed context first prompt",
    );
    await page.getByRole("button", { name: "Restore session" }).click();
    await page
      .getByRole("button", { name: "Session: managed context first prompt" })
      .click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();
    const resumedCwd = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      return snapshot.state.cwd;
    });
    expect(resumedCwd).toBe(fs.realpathSync(managedCwd));

    await page
      .locator(".session-list .session-item.active")
      .locator("..")
      .getByRole("button", { name: /^Session actions for / })
      .click();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);
    await expect(page.getByText("Deleted Pi session.")).toBeVisible();
    expect(fs.existsSync(sessionFile)).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real-mode workspace membership lifecycle stays explicit and reversible", async () => {
  // This deliberately calls preload APIs from the hidden Electron window. It
  // never invokes a native dialog or file picker, so it is safe for CI and
  // other headless desktop environments.
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-lifecycle-"),
  );
  const projectCwd = path.join(root, "authorized-project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--workspace-e2e--");
  const sessionFile = path.join(sessionDir, "move-me.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "workspace-lifecycle-session",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  const canonicalSessionFile = fs.realpathSync(sessionFile);
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    const outcome = await page.evaluate(async (sessionFile) => {
      const api = window.piDeck;
      const projects = await api.projects.getActive();
      const defaultProjectId = projects.activeProject?.id;
      if (defaultProjectId === undefined) {
        throw new Error("Expected an authorized default project.");
      }

      const first = await api.workspaces.create({
        name: "Lifecycle source",
        defaultProjectId,
      });
      const source = first.activeWorkspace;
      if (source === undefined)
        throw new Error("Source workspace was not selected.");
      const second = await api.workspaces.create({
        name: "Lifecycle destination",
        defaultProjectId,
      });
      const destination = second.activeWorkspace;
      if (destination === undefined) {
        throw new Error("Destination workspace was not selected.");
      }

      const added = await api.workspaces.addSession({
        workspaceId: source.id,
        sessionFile,
      });
      const sourceAfterAdd = await api.chat.listSessions({
        workspaceId: source.id,
      });
      const destinationBeforeMove = await api.chat.listSessions({
        workspaceId: destination.id,
      });

      const moved = await api.workspaces.moveSession({
        sessionFile,
        toWorkspaceId: destination.id,
      });
      const sourceAfterMove = await api.chat.listSessions({
        workspaceId: source.id,
      });
      const destinationAfterMove = await api.chat.listSessions({
        workspaceId: destination.id,
      });

      const archivedSession = await api.workspaces.archiveSession({
        workspaceId: destination.id,
        sessionFile,
      });
      const hiddenAfterSessionArchive = await api.chat.listSessions({
        workspaceId: destination.id,
      });
      const archivedSessionList = await api.workspaces.listSessions({
        workspaceId: destination.id,
        includeArchived: true,
      });
      const restoredSession = await api.workspaces.restoreSession({
        workspaceId: destination.id,
        sessionFile,
      });
      const visibleAfterSessionRestore = await api.chat.listSessions({
        workspaceId: destination.id,
      });

      // Source is now empty, so archiving it must affect metadata only.
      const archivedSource = await api.workspaces.archive({
        workspaceId: source.id,
      });
      const archived = await api.workspaces.archive({
        workspaceId: destination.id,
      });
      const archivedWorkspaceSessions = await api.workspaces.listSessions({
        workspaceId: destination.id,
        includeArchived: true,
      });
      const restoredWorkspace = await api.workspaces.restore({
        workspaceId: destination.id,
      });
      const visibleAfterWorkspaceRestore = await api.chat.listSessions({
        workspaceId: destination.id,
      });
      const removed = await api.workspaces.removeSession({
        workspaceId: destination.id,
        sessionFile,
      });
      const destinationAfterRemove = await api.chat.listSessions({
        workspaceId: destination.id,
      });
      const unassigned = await api.workspaces.listUnassignedSessions();

      return {
        sourceId: source.id,
        destinationId: destination.id,
        added,
        moved,
        removed,
        sourceAfterAdd: sourceAfterAdd.sessions,
        destinationBeforeMove: destinationBeforeMove.sessions,
        sourceAfterMove: sourceAfterMove.sessions,
        destinationAfterMove: destinationAfterMove.sessions,
        archivedSession,
        hiddenAfterSessionArchive: hiddenAfterSessionArchive.sessions,
        archivedSessionList: archivedSessionList.sessions,
        restoredSession,
        visibleAfterSessionRestore: visibleAfterSessionRestore.sessions,
        archivedSourceWorkspaceIds: archivedSource.archivedWorkspaces?.map(
          (workspace) => workspace.id,
        ),
        archivedWorkspaceSessions: archivedWorkspaceSessions.sessions,
        restoredWorkspaceId: restoredWorkspace.activeWorkspaceId,
        visibleAfterWorkspaceRestore: visibleAfterWorkspaceRestore.sessions,
        destinationAfterRemove: destinationAfterRemove.sessions,
        unassigned: unassigned.sessions,
        activeWorkspaceId: archived.activeWorkspaceId,
        remainingWorkspaceIds: archived.workspaces.map(
          (workspace) => workspace.id,
        ),
      };
    }, canonicalSessionFile);

    expect(outcome.added).toMatchObject({
      workspaceId: outcome.sourceId,
      sessionFile: canonicalSessionFile,
    });
    expect(
      outcome.sourceAfterAdd.map((session) => session.sessionFile),
    ).toEqual([canonicalSessionFile]);
    expect(outcome.destinationBeforeMove).toEqual([]);
    expect(outcome.moved).toMatchObject({
      workspaceId: outcome.destinationId,
      sessionFile: canonicalSessionFile,
    });
    expect(outcome.sourceAfterMove).toEqual([]);
    expect(
      outcome.destinationAfterMove.map((session) => session.sessionFile),
    ).toEqual([canonicalSessionFile]);
    expect(outcome.archivedSession).toMatchObject({
      workspaceId: outcome.destinationId,
      sessionFile: canonicalSessionFile,
    });
    expect(outcome.hiddenAfterSessionArchive).toEqual([]);
    expect(outcome.archivedSessionList[0]).toMatchObject({
      sessionFile: canonicalSessionFile,
      archivedAtMs: expect.any(Number),
    });
    expect(outcome.restoredSession).toMatchObject({
      workspaceId: outcome.destinationId,
      sessionFile: canonicalSessionFile,
    });
    expect(
      outcome.visibleAfterSessionRestore.map((session) => session.sessionFile),
    ).toEqual([canonicalSessionFile]);
    expect(outcome.archivedSourceWorkspaceIds).toContain(outcome.sourceId);
    expect(outcome.archivedWorkspaceSessions[0]).toMatchObject({
      sessionFile: canonicalSessionFile,
      archivedAtMs: expect.any(Number),
    });
    expect(outcome.restoredWorkspaceId).toBe(outcome.destinationId);
    expect(
      outcome.visibleAfterWorkspaceRestore.map(
        (session) => session.sessionFile,
      ),
    ).toEqual([canonicalSessionFile]);
    expect(outcome.remainingWorkspaceIds).not.toContain(outcome.sourceId);
    expect(outcome.activeWorkspaceId).not.toBe(outcome.sourceId);
    expect(outcome.removed).toMatchObject({
      workspaceId: outcome.destinationId,
      sessionFile: canonicalSessionFile,
    });
    expect(outcome.destinationAfterRemove).toEqual([]);
    expect(outcome.unassigned.map((session) => session.sessionFile)).toContain(
      canonicalSessionFile,
    );
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace and session archive state persists across relaunch", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-archive-relaunch-"),
  );
  const projectCwd = path.join(root, "authorized-project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const sessionDir = path.join(agentDir, "sessions", "--archive-relaunch--");
  const independentlyArchivedFile = path.join(sessionDir, "independent.jsonl");
  const cascadeArchivedFile = path.join(sessionDir, "cascade.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    independentlyArchivedFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "independent-archive",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  fs.writeFileSync(
    cascadeArchivedFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "cascade-archive",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  const env = fakeRealModeEnv({
    root,
    projectCwd,
    agentDir,
    userDataDir,
  });
  const firstLaunch = await launchPiDeck(env);
  let workspaceId: string | undefined;
  try {
    await expectHealthyPreload(firstLaunch.page);
    workspaceId = await firstLaunch.page.evaluate(
      async ({ independentlyArchivedFile, cascadeArchivedFile }) => {
        const api = window.piDeck;
        const created = await api.workspaces.create({
          name: "Persistent archive topic",
        });
        const workspace = created.activeWorkspace;
        if (workspace === undefined) {
          throw new Error("Expected the archive workspace to be active.");
        }
        await api.workspaces.addSession({
          workspaceId: workspace.id,
          sessionFile: independentlyArchivedFile,
        });
        await api.workspaces.addSession({
          workspaceId: workspace.id,
          sessionFile: cascadeArchivedFile,
        });
        await api.workspaces.archiveSession({
          workspaceId: workspace.id,
          sessionFile: independentlyArchivedFile,
        });
        const archived = await api.workspaces.archive({
          workspaceId: workspace.id,
        });
        // Leave only the stable default active so relaunch exercises the
        // default-only disclosure path while keeping both named archives
        // discoverable.
        const remainingNamed = archived.workspaces.find(
          (candidate) => candidate.isDefault !== true,
        );
        if (remainingNamed !== undefined) {
          await api.workspaces.archive({ workspaceId: remainingNamed.id });
        }
        return workspace.id;
      },
      { independentlyArchivedFile, cascadeArchivedFile },
    );
  } finally {
    await firstLaunch.app.close().catch(() => undefined);
  }

  const secondLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(secondLaunch.page);
    await expectAllWorkLaunch(secondLaunch.page);
    const defaultWorkspace = await secondLaunch.page.evaluate(async () => {
      const result = await window.piDeck.workspaces.getActive();
      const workspace = result.workspaces.find(
        (candidate) => candidate.isDefault === true,
      );
      if (workspace === undefined) {
        throw new Error(
          "Expected the stable default workspace after relaunch.",
        );
      }
      return workspace;
    });
    await expect(
      secondLaunch.page.getByRole("button", {
        name: `Workspace: ${defaultWorkspace.name}`,
      }),
    ).toHaveCount(0);
    await expect(
      secondLaunch.page
        .getByLabel("Current Work scope", { exact: true })
        .locator("option")
        .filter({ hasText: defaultWorkspace.name }),
    ).toHaveCount(0);
    await expect(
      secondLaunch.page.getByRole("button", { name: /^Archived/ }).first(),
    ).toBeVisible();
    await secondLaunch.page.getByRole("button", { name: /^Archived/ }).click();
    await expect(secondLaunch.page.getByTestId("archived-tree")).toContainText(
      "Persistent archive topic",
    );

    const persisted = await secondLaunch.page.evaluate(async (workspaceId) => {
      const api = window.piDeck;
      const listed = await api.workspaces.getActive();
      const archivedWorkspace = listed.archivedWorkspaces?.find(
        (workspace) => workspace.id === workspaceId,
      );
      const beforeRestore = await api.workspaces.listSessions({
        workspaceId,
        includeArchived: true,
      });
      const restored = await api.workspaces.restore({ workspaceId });
      const afterRestore = await api.chat.listSessions({ workspaceId });
      const allAfterRestore = await api.workspaces.listSessions({
        workspaceId,
        includeArchived: true,
      });
      return {
        archivedWorkspaceName: archivedWorkspace?.name,
        archivedSessionFiles: beforeRestore.sessions
          .filter((session) => session.archivedAtMs !== undefined)
          .map((session) => session.sessionFile),
        restoredWorkspaceId: restored.activeWorkspaceId,
        visibleAfterRestore: afterRestore.sessions.map(
          (session) => session.sessionFile,
        ),
        stillArchivedAfterRestore: allAfterRestore.sessions
          .filter((session) => session.archivedAtMs !== undefined)
          .map((session) => session.sessionFile),
      };
    }, workspaceId);

    expect(persisted.archivedWorkspaceName).toBe("Persistent archive topic");
    expect(persisted.archivedSessionFiles).toEqual(
      expect.arrayContaining([
        fs.realpathSync(independentlyArchivedFile),
        fs.realpathSync(cascadeArchivedFile),
      ]),
    );
    expect(persisted.restoredWorkspaceId).toBe(workspaceId);
    expect(persisted.visibleAfterRestore).toEqual([
      fs.realpathSync(cascadeArchivedFile),
    ]);
    expect(persisted.stillArchivedAfterRestore).toEqual([
      fs.realpathSync(independentlyArchivedFile),
    ]);
  } finally {
    await secondLaunch.app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removed legacy workspace sessions stay excluded and survive bulk delete", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-exclusion-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--workspace-exclusion--");
  const sessionFile = path.join(sessionDir, "keep-on-disk.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "keep-on-disk",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  const canonicalSessionFile = fs.realpathSync(sessionFile);
  const env = fakeRealModeEnv({ root, projectCwd, agentDir });

  const firstLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(firstLaunch.page);
    const outcome = await firstLaunch.page.evaluate(async (sessionFile) => {
      const api = window.piDeck;
      const listedWorkspaces = await api.workspaces.getActive();
      const workspace = listedWorkspaces.workspaces.find(
        (candidate) => candidate.defaultProjectId !== undefined,
      );
      if (workspace === undefined) {
        throw new Error("Expected a migrated project workspace.");
      }
      await api.workspaces.select({ workspaceId: workspace.id });
      const before = await api.chat.listSessions({
        workspaceId: workspace.id,
      });
      await api.workspaces.removeSession({
        workspaceId: workspace.id,
        sessionFile,
      });
      const afterRemove = await api.chat.listSessions({
        workspaceId: workspace.id,
      });
      const deleted = await api.chat.deleteAllSessions({
        workspaceId: workspace.id,
      });
      return {
        workspaceId: workspace.id,
        before: before.sessions,
        afterRemove: afterRemove.sessions,
        deleted,
      };
    }, canonicalSessionFile);

    expect(outcome.before.map((session) => session.sessionFile)).toContain(
      canonicalSessionFile,
    );
    expect(outcome.afterRemove).toEqual([]);
    expect(outcome.deleted).toMatchObject({
      deletedCount: 0,
      deletedSessionFiles: [],
    });
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);
  } finally {
    await firstLaunch.app.close().catch(() => undefined);
  }

  const secondLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(secondLaunch.page);
    const sessions = await secondLaunch.page.evaluate(async () => {
      const api = window.piDeck;
      const listedWorkspaces = await api.workspaces.getActive();
      const workspace = listedWorkspaces.workspaces.find(
        (candidate) => candidate.defaultProjectId !== undefined,
      );
      if (workspace === undefined) {
        throw new Error("Expected a migrated project workspace.");
      }
      await api.workspaces.select({ workspaceId: workspace.id });
      return api.chat.listSessions({ workspaceId: workspace.id });
    });
    expect(sessions.sessions).toEqual([]);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);
  } finally {
    await secondLaunch.app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function startRuntimeExitTracking(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __piDeckRuntimeExitTracker?: {
        runtimeIds: string[];
        unsubscribe: () => void;
      };
    };
    testWindow.__piDeckRuntimeExitTracker?.unsubscribe();
    const runtimeIds: string[] = [];
    testWindow.__piDeckRuntimeExitTracker = {
      runtimeIds,
      unsubscribe: window.piDeck.chat.onEvent((event) => {
        if (event.type === "worker_exit") {
          runtimeIds.push(event.runtimeId);
        }
      }),
    };
  });
}

async function trackedRuntimeExitIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const testWindow = window as typeof window & {
      __piDeckRuntimeExitTracker?: { runtimeIds: string[] };
    };
    return [...(testWindow.__piDeckRuntimeExitTracker?.runtimeIds ?? [])];
  });
}

async function waitForRuntimeExitCount(
  page: Page,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await trackedRuntimeExitIds(page)).length, {
      timeout: 5_000,
    })
    .toBe(count);
}

async function stopRuntimeExitTracking(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __piDeckRuntimeExitTracker?: { unsubscribe: () => void };
    };
    testWindow.__piDeckRuntimeExitTracker?.unsubscribe();
    delete testWindow.__piDeckRuntimeExitTracker;
  });
}

function tinyPngBase64(): string {
  const data = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(1, 16);
  data.writeUInt32BE(1, 20);
  return data.toString("base64");
}

test("fake mode launches with backend runtime and send enabled", async () => {
  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "fake",
  });
  try {
    await expectHealthyPreload(page);
    await expect(page.getByText(/Local demo mode active/i)).toBeVisible();
    await expect(page.getByTestId("workspace-tree")).toBeVisible();
    await expectAllWorkLaunch(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("fake e2e prompt");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
  }
});

test("expanded tool details stay scrollable above the composer", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-tool-detail-layout-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--prompt-scenario", "tool", "--stream-delay-ms", "1"],
    }),
  );
  try {
    await page.setViewportSize({ width: 920, height: 560 });
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("show a tool detail card");
    await page.getByRole("button", { name: "Send" }).click();

    const activityGroup = page.locator(".agent-activity-group").first();
    await expect(activityGroup).toBeVisible();
    await expect(activityGroup.locator(":scope > summary")).toContainText(
      "Agent activity",
    );
    await expect(activityGroup.locator(":scope > summary")).not.toContainText(
      "toolName",
    );
    await expect(
      page.getByText("Fake response to: show a tool detail card"),
    ).toBeVisible();
    await expect(activityGroup).not.toHaveAttribute("open", "");
    await activityGroup.locator(":scope > summary").click();
    await expect(activityGroup).toHaveAttribute("open", "");

    const toolCard = activityGroup.locator(".tool-card").first();
    await expect(toolCard).toBeVisible();
    await expect(toolCard.getByText("Read", { exact: true })).toBeVisible();

    await toolCard.locator("pre").evaluate((pre) => {
      pre.style.whiteSpace = "pre";
      const wideLine = "wide-output-".repeat(90);
      pre.textContent = Array.from(
        { length: 80 },
        (_, index) => `${String(index + 1).padStart(2, "0")} ${wideLine}`,
      ).join("\n");
    });
    await page.locator(".timeline-scroll").evaluate((timeline) => {
      timeline.scrollTop = timeline.scrollHeight;
    });

    async function expandedToolMetrics(): Promise<{
      composerTop: number;
      detailsBottom: number;
      preBottom: number;
      preClientHeight: number;
      preScrollHeight: number;
      preClientWidth: number;
      preScrollWidth: number;
    }> {
      return page.evaluate(() => {
        const timeline =
          document.querySelector<HTMLElement>(".timeline-scroll");
        const composer = document.querySelector<HTMLElement>(".composer");
        const details = document.querySelector<HTMLElement>(
          ".agent-activity-group .tool-card details",
        );
        const pre = document.querySelector<HTMLElement>(
          ".agent-activity-group .tool-card pre",
        );
        if (
          timeline === null ||
          composer === null ||
          details === null ||
          pre === null
        ) {
          throw new Error("Missing expanded tool detail layout fixture.");
        }
        const timelineRect = timeline.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        const detailsRect = details.getBoundingClientRect();
        const preRect = pre.getBoundingClientRect();
        return {
          composerTop: Math.min(timelineRect.bottom, composerRect.top),
          detailsBottom: detailsRect.bottom,
          preBottom: preRect.bottom,
          preClientHeight: pre.clientHeight,
          preScrollHeight: pre.scrollHeight,
          preClientWidth: pre.clientWidth,
          preScrollWidth: pre.scrollWidth,
        };
      });
    }

    await toolCard.locator("summary").click();
    await expect(toolCard.locator("details")).toHaveAttribute("open", "");
    await expect
      .poll(async () => {
        const metrics = await expandedToolMetrics();
        return metrics.detailsBottom <= metrics.composerTop - 1;
      })
      .toBe(true);
    let metrics = await expandedToolMetrics();
    expect(metrics.preBottom).toBeLessThanOrEqual(metrics.composerTop - 1);
    expect(metrics.preScrollHeight).toBeGreaterThan(metrics.preClientHeight);
    expect(metrics.preScrollWidth).toBeGreaterThan(metrics.preClientWidth);

    await toolCard.locator("summary").click();
    await expect(toolCard.locator("details")).not.toHaveAttribute("open", "");
    await toolCard.locator("summary").click();
    await expect(toolCard.locator("details")).toHaveAttribute("open", "");
    await page.setViewportSize({ width: 920, height: 500 });
    await expect
      .poll(async () => {
        const metrics = await expandedToolMetrics();
        return metrics.detailsBottom <= metrics.composerTop - 1;
      })
      .toBe(true);
    metrics = await expandedToolMetrics();
    expect(metrics.preBottom).toBeLessThanOrEqual(metrics.composerTop - 1);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tool-heavy turns use a compact agent activity hierarchy", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-agent-activity-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: [
        "--prompt-scenario",
        "tool-heavy",
        "--stream-delay-ms",
        "10",
      ],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("summarize after tool work");
    await page.getByRole("button", { name: "Send" }).click();

    const activityGroup = page.locator(".agent-activity-group").first();
    const groupSummary = activityGroup.locator(":scope > summary");
    await expect(groupSummary).toContainText("Agent activity");
    await expect(groupSummary).toContainText(/60 steps/);
    await expect(groupSummary).not.toContainText("toolName");
    await expect(groupSummary).not.toContainText("renderer tests passed");

    await expect(
      page.getByText("Fake response to: summarize after tool work"),
    ).toBeVisible();
    await expect(
      page.getByLabel("Agent activity, 60 steps, completed"),
    ).toBeVisible();
    await expect(activityGroup).not.toHaveAttribute("open", "");

    await groupSummary.focus();
    await expect(groupSummary).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(activityGroup).toHaveAttribute("open", "");
    await expect(activityGroup.locator(".agent-activity-step")).toHaveCount(60);
    const compactToolCards = activityGroup.locator(".agent-activity-tool-card");
    await expect(compactToolCards).toHaveCount(59);
    await expect(compactToolCards.first()).toHaveCSS("border-top-width", "0px");
    await expect(
      compactToolCards.first().locator(".tool-summary"),
    ).toBeVisible();
    await expect(compactToolCards.first().locator(".tool-copy")).toHaveCSS(
      "display",
      "flex",
    );
    await expect(compactToolCards.first().locator(".tool-status")).toBeHidden();
    await expect(activityGroup.locator(".agent-activity-steps")).toHaveCSS(
      "overflow-y",
      "auto",
    );
    const activityStepsBox = await activityGroup
      .locator(".agent-activity-steps")
      .boundingBox();
    expect(
      activityStepsBox?.height ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(570);
    const compactHeights = await compactToolCards.evaluateAll((cards) =>
      cards.slice(0, 12).map((card) => card.getBoundingClientRect().height),
    );
    expect(Math.max(...compactHeights)).toBeLessThanOrEqual(36);
    await expect(activityGroup.locator(".tool-card").first()).toBeVisible();
    await expect(activityGroup.getByText("Thinking…")).toHaveCount(0);
    await expect(activityGroup.getByText("Thought process")).toBeVisible();
    await expect(
      activityGroup.getByText("Read", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      activityGroup.getByText("Search", { exact: true }),
    ).toBeVisible();
    await expect(
      activityGroup.getByText("Bash", { exact: true }),
    ).toBeVisible();

    const bashSummary = activityGroup
      .locator(".tool-card")
      .filter({ hasText: "Bash" })
      .locator("summary");
    await bashSummary.focus();
    await expect(bashSummary).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      activityGroup
        .locator(".tool-card pre")
        .filter({ hasText: "renderer tests passed" }),
    ).toBeVisible();
    await expect(page.locator(".assistant-message").last()).toContainText(
      "Fake response to: summarize after tool work",
    );
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed tool activity remains conspicuous and inspectable", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-agent-activity-error-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--prompt-scenario", "tool-error", "--stream-delay-ms", "1"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("show a failed tool");
    await page.getByRole("button", { name: "Send" }).click();

    const activityGroup = page.locator(".agent-activity-group").first();
    await expect(activityGroup.locator(":scope > summary")).toContainText(
      "needs attention",
    );
    await expect(activityGroup).toHaveAttribute("open", "");
    await expect(
      activityGroup.locator(".tool-status.error").first(),
    ).toContainText("error");

    await activityGroup.locator(".tool-card summary").first().click();
    await expect(activityGroup.locator(".tool-card pre").first()).toContainText(
      "fake tool failed",
    );
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fake named workspace drafts keep fake backend and sidebar behavior", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-fake-workspace-draft-"),
  );
  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "fake",
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
  });
  try {
    await expectHealthyPreload(page);
    await createWorkspaceInUi(page, "Fake named workspace");
    await selectWorkspaceInUi(page, "Fake named workspace");
    await enterSessionDetail(page);

    await expect(
      page.getByRole("heading", { name: /Untitled new session/ }),
    ).toBeVisible();
    await expect(page.locator(".pi-configuration-trigger")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh sessions" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Delete saved sessions" }),
    ).toHaveCount(0);
    await expect(page.locator('[data-testid^="session-actions-"]')).toHaveCount(
      0,
    );

    const prompt = "fake named workspace prompt";
    await page.getByLabel("Prompt text").fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(`Fake response to: ${prompt}`, { exact: true }),
    ).toBeVisible();

    const runtime = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      const active = await window.piDeck.workspaces.getActive();
      return {
        backendMode: snapshot.backendMode,
        snapshotWorkspaceId: snapshot.workspaceId,
        activeWorkspaceId: active.activeWorkspace?.id,
        activeWorkspaceName: active.activeWorkspace?.name,
      };
    });
    expect(runtime).toMatchObject({
      backendMode: "fake",
      activeWorkspaceName: "Fake named workspace",
    });
    expect(runtime.activeWorkspaceId).toEqual(expect.any(String));
    expect(runtime.snapshotWorkspaceId).toBe(runtime.activeWorkspaceId);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default workspace stays implicit until a named workspace exists", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-default-disclosure-"),
  );
  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "fake",
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
  });
  try {
    await expectHealthyPreload(page);
    await expectAllWorkLaunch(page);

    const defaultWorkspace = await page.evaluate(async () => {
      const result = await window.piDeck.workspaces.getActive();
      const workspace = result.workspaces.find(
        (candidate) => candidate.isDefault === true,
      );
      if (workspace === undefined) {
        throw new Error("Expected a stable default workspace.");
      }
      return workspace;
    });
    const defaultRow = page.getByRole("button", {
      name: `Workspace: ${defaultWorkspace.name}`,
    });
    await expect(defaultRow).toHaveCount(0);
    await expect(
      page
        .getByLabel("Current Work scope", { exact: true })
        .locator("option")
        .filter({ hasText: defaultWorkspace.name }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("workspace-tree").getByText("No workspaces yet.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(sidebarNewSessionButton(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New workspace…", exact: true }),
    ).toBeVisible();
    const defaultOwnedWork = page
      .locator(".activity-inbox-row")
      .filter({ hasText: "Extension approval request" });
    await expect(defaultOwnedWork).toBeVisible();
    await expect(defaultOwnedWork).not.toContainText(defaultWorkspace.name);
    await expect(defaultOwnedWork).not.toHaveAttribute(
      "aria-label",
      new RegExp(defaultWorkspace.name),
    );

    const globalPrompt = "Default-only global session";
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill(globalPrompt);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(`Fake response to: ${globalPrompt}`, { exact: true }),
    ).toBeVisible();
    const globalSnapshot = await page.evaluate(() =>
      window.piDeck.chat.getSnapshot(),
    );
    expect(globalSnapshot.workspaceId).toBe(defaultWorkspace.id);
    await page.getByRole("button", { name: /^All Work/ }).click();
    await expectAllWorkLaunch(page);
    const persistedDefaultRow = page
      .locator(".activity-inbox-row")
      .filter({ hasText: globalPrompt });
    await expect(persistedDefaultRow).toBeVisible();
    await expect(persistedDefaultRow).not.toContainText(defaultWorkspace.name);

    await createWorkspaceInUi(page, "Named disclosure workspace");
    await expect(defaultRow).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Workspace: Named disclosure workspace",
      }),
    ).toBeVisible();
    await expect(
      page
        .getByLabel("Current Work scope", { exact: true })
        .locator("option")
        .filter({ hasText: defaultWorkspace.name }),
    ).toHaveCount(1);

    const firstSessionRow = page.locator(".session-item").first();
    const sessionList = firstSessionRow.locator("..");
    await expect(firstSessionRow).toHaveCSS("display", "grid");
    const sessionListBox = await sessionList.boundingBox();
    const firstSessionRowBox = await firstSessionRow.boundingBox();
    expect(firstSessionRowBox?.width).toBeGreaterThanOrEqual(
      (sessionListBox?.width ?? 0) - 1,
    );
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attachment selections release and revoke through preload/main IPC", async () => {
  const { app, page } = await launchPiDeck({ PI_DECK_BACKEND: "fake" });
  try {
    await expectHealthyPreload(page);
    const result = await page.evaluate(async (dataBase64) => {
      const api = (
        window as unknown as {
          piDeck: typeof window.piDeck;
        }
      ).piDeck.attachments;
      const ownerId = "attachment-e2e-owner-generation";
      const sessionId = "attachment-e2e-session";
      const request = (fileName: string) => ({
        ownerId,
        sessionId,
        images: [
          {
            fileName,
            mimeType: "image/png",
            size: 24,
            dataBase64,
          },
        ],
      });
      const first = await api.importImages(request("first.png"));
      if (!first.selected) {
        throw new Error("Expected image import to create a selection.");
      }
      await api.release({
        ownerId,
        selectedPathTokens: first.attachments.map(
          (attachment) => attachment.selectedPathToken,
        ),
      });
      const second = await api.importImages(request("second.png"));
      if (!second.selected) {
        throw new Error("Expected release to allow a replacement selection.");
      }
      await api.releaseOwner({ ownerId });
      try {
        await api.importImages(request("late.png"));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("Discarded attachment owner was unexpectedly reusable.");
    }, tinyPngBase64());
    expect(result).toMatch(/owner is no longer active/i);
  } finally {
    await app.close();
  }
});

test("icon controls retain names, neutral styles, and fit a 900×600 viewport", async () => {
  const userDataDir = createThemeUserData("light");
  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "fake",
    PI_DECK_USER_DATA_DIR: userDataDir,
  });
  try {
    await page.setViewportSize({ width: 900, height: 600 });
    await expectHealthyPreload(page);
    await enterSessionDetail(page);

    const send = page.getByRole("button", { name: "Send" });
    await page.getByLabel("Prompt text").fill("style check");
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
    await expect(send).toHaveText("");
    const sendBox = await send.boundingBox();
    expect(sendBox).not.toBeNull();
    expect(
      (sendBox?.y ?? Infinity) + (sendBox?.height ?? 0),
    ).toBeLessThanOrEqual(600);
    await expect
      .poll(() =>
        send.evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgb(32, 33, 36)");
    await expect(
      page.getByRole("button", { name: "Add attachments" }),
    ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    await send.click();
    const userBubble = page.locator(".user-bubble").last();
    await expect(userBubble).toHaveCSS(
      "background-color",
      "rgb(244, 244, 244)",
    );
    await expect(userBubble).toHaveCSS("color", "rgb(47, 47, 47)");
    await expect(userBubble).toHaveCSS("box-shadow", "none");

    const sidebarToggle = page.locator(".topbar .sidebar-toggle");
    await page.getByLabel("Prompt text").hover();
    await expect(sidebarToggle).not.toHaveAttribute("aria-describedby");
    await sidebarToggle.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/sessions/);
    await expect(sidebarToggle).toHaveAttribute("aria-describedby");
    await page.getByLabel("Prompt text").hover();
    await expect(sidebarToggle).not.toHaveAttribute("aria-describedby");

    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({ path: "test-results/ui-controls-900x600.png" });
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("long unbroken chat text does not overflow at 900×600", async () => {
  const { app, page } = await launchPiDeck({ PI_DECK_BACKEND: "fake" });
  try {
    await page.setViewportSize({ width: 900, height: 600 });
    await expectHealthyPreload(page);
    await enterSessionDetail(page);

    const token = "unbroken-chat-token-".repeat(180);
    const prompt = page.getByLabel("Prompt text");
    await prompt.fill(token);
    await page.getByRole("button", { name: "Send" }).click();

    const userBubble = page.locator(".user-bubble").last();
    const assistantMessage = page.locator(".assistant-message").last();
    await expect(userBubble).toContainText(token);
    await expect(assistantMessage).toContainText(token);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const timeline = document.querySelector(".timeline-scroll");
          return (
            timeline !== null &&
            timeline.scrollWidth <= timeline.clientWidth + 1 &&
            document.documentElement.scrollWidth <= window.innerWidth
          );
        }),
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});

test("composer has symmetric gutters at and below 560px", async () => {
  const { app, page } = await launchPiDeck({ PI_DECK_BACKEND: "fake" });
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    for (const width of [560, 320]) {
      await page.setViewportSize({ width, height: 600 });
      const composer = page.locator(".composer");
      const prompt = page.getByLabel("Prompt text");
      const send = page.getByRole("button", { name: "Send" });
      await expect(composer).toBeVisible();
      await expect(prompt).toBeVisible();
      await expect(send).toBeVisible();
      await prompt.fill("composer viewport check");
      await expect(send).toBeEnabled();

      const layout = await page.evaluate(() => {
        const composer = document.querySelector(".composer");
        const workspace = document.querySelector(".workspace");
        const input = document.querySelector(".composer-input-wrap");
        const send = document.querySelector(
          '.composer button[aria-label="Send"]',
        );
        if (
          composer === null ||
          workspace === null ||
          input === null ||
          send === null
        ) {
          throw new Error("Composer controls are missing.");
        }
        const composerBox = composer.getBoundingClientRect();
        const workspaceBox = workspace.getBoundingClientRect();
        const inputBox = input.getBoundingClientRect();
        const sendBox = send.getBoundingClientRect();
        return {
          leftGutter: composerBox.left - workspaceBox.left,
          rightGutter: workspaceBox.right - composerBox.right,
          inputWithinComposer:
            inputBox.left >= composerBox.left &&
            inputBox.right <= composerBox.right,
          sendWithinComposer:
            sendBox.left >= composerBox.left &&
            sendBox.right <= composerBox.right,
          sendWithinViewport:
            sendBox.left >= 0 && sendBox.right <= window.innerWidth,
          pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });
      expect(
        Math.abs(layout.leftGutter - layout.rightGutter),
      ).toBeLessThanOrEqual(1);
      expect(layout.inputWithinComposer).toBe(true);
      expect(layout.sendWithinComposer).toBe(true);
      expect(layout.sendWithinViewport).toBe(true);
      expect(layout.pageFits).toBe(true);
    }
  } finally {
    await app.close();
  }
});

test("appearance preference switches themes and persists across relaunch", async () => {
  const userDataDir = createThemeUserData("dark");
  const env = {
    PI_DECK_BACKEND: "fake",
    PI_DECK_USER_DATA_DIR: userDataDir,
  };
  let launched = await launchPiDeck(env);

  try {
    await launched.page.setViewportSize({ width: 900, height: 600 });
    await expectHealthyPreload(launched.page);
    await expectAllWorkLaunch(launched.page);
    await enterSessionDetail(launched.page);
    const darkTrigger = launched.page.getByRole("button", {
      name: "Appearance: Dark",
    });
    await expect(darkTrigger).toBeVisible();
    await expect(launched.page.locator("html")).toHaveCSS(
      "color-scheme",
      "dark",
    );
    await expect(launched.page.locator(".app-shell")).toHaveCSS(
      "background-color",
      "rgb(23, 26, 31)",
    );
    await expect(launched.page.locator(".composer-input-wrap")).toHaveCSS(
      "background-color",
      "rgb(56, 56, 56)",
    );
    await expect
      .poll(() =>
        launched.app.evaluate(({ BrowserWindow, nativeTheme }) => ({
          background:
            BrowserWindow.getAllWindows()[0]
              ?.getBackgroundColor()
              .toLowerCase() ?? "",
          source: nativeTheme.themeSource,
        })),
      )
      .toEqual({ background: "#171a1f", source: "dark" });
    await launched.page.screenshot({
      path: "test-results/ui-controls-dark-900x600.png",
    });

    await darkTrigger.click();
    const appearanceMenu = launched.page.getByRole("menu", {
      name: "Appearance options",
    });
    await expect(appearanceMenu).toBeVisible();
    const systemOption = launched.page.getByRole("menuitemradio", {
      name: "System",
      exact: true,
    });
    const lightOption = launched.page.getByRole("menuitemradio", {
      name: "Light",
      exact: true,
    });
    const darkOption = launched.page.getByRole("menuitemradio", {
      name: "Dark",
      exact: true,
    });
    await expect(darkOption).toHaveAttribute("aria-checked", "true");
    await expect(lightOption).toHaveAttribute("aria-checked", "false");
    await expect(systemOption).toBeFocused();
    await launched.page.keyboard.press("ArrowDown");
    await expect(lightOption).toBeFocused();
    await launched.page.keyboard.press("Escape");
    await expect(darkTrigger).toBeFocused();
    await expect(appearanceMenu).toHaveCount(0);

    await darkTrigger.click();
    await expect(systemOption).toBeFocused();
    await launched.page.keyboard.press("ArrowDown");
    await launched.page.keyboard.press("Enter");
    await expect(
      launched.page.getByRole("button", { name: "Appearance: Light" }),
    ).toBeVisible();
    await expect(launched.page.locator("html")).toHaveCSS(
      "color-scheme",
      "light",
    );
    await expect(launched.page.locator(".app-shell")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await expect
      .poll(() =>
        launched.app.evaluate(({ BrowserWindow, nativeTheme }) => ({
          background:
            BrowserWindow.getAllWindows()[0]
              ?.getBackgroundColor()
              .toLowerCase() ?? "",
          source: nativeTheme.themeSource,
        })),
      )
      .toEqual({ background: "#ffffff", source: "light" });
    await expect.poll(() => persistedTheme(userDataDir)).toBe("light");

    await launched.app.close();
    launched = await launchPiDeck(env);
    await launched.page.setViewportSize({ width: 900, height: 600 });
    await expectHealthyPreload(launched.page);
    const lightTrigger = launched.page.getByRole("button", {
      name: "Appearance: Light",
    });
    await expect(lightTrigger).toBeVisible();

    await lightTrigger.click();
    const relaunchedSystemOption = launched.page.getByRole("menuitemradio", {
      name: "System",
      exact: true,
    });
    const relaunchedDarkOption = launched.page.getByRole("menuitemradio", {
      name: "Dark",
      exact: true,
    });
    await expect(relaunchedSystemOption).toBeFocused();
    await launched.page.keyboard.press("End");
    await expect(relaunchedDarkOption).toBeFocused();
    await launched.page.keyboard.press("Enter");
    await expect(
      launched.page.getByRole("button", { name: "Appearance: Dark" }),
    ).toBeVisible();
    await expect.poll(() => persistedTheme(userDataDir)).toBe("dark");

    await launched.page
      .getByRole("button", { name: "Appearance: Dark" })
      .click();
    const finalSystemOption = launched.page.getByRole("menuitemradio", {
      name: "System",
      exact: true,
    });
    await expect(finalSystemOption).toBeFocused();
    await launched.page.keyboard.press("Enter");
    await expect(
      launched.page.getByRole("button", { name: "Appearance: System" }),
    ).toBeVisible();
    await expect.poll(() => persistedTheme(userDataDir)).toBe("system");
    await expect
      .poll(() =>
        launched.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
      )
      .toBe("system");
  } finally {
    await launched.app.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("working sessions expose steer, follow-up, extension, and abort interventions", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-intervention-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "400"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    const composer = page.getByLabel("Prompt text");
    await composer.fill("start intervention fixture");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Follow-up" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

    await composer.fill("focus on focused tests");
    await page.getByRole("button", { name: "Steer" }).click();
    await expect(
      page.getByText("Steering instruction queued in Pi."),
    ).toBeVisible();

    await composer.fill("summarize afterward");
    await page.getByRole("button", { name: "Follow-up" }).click();
    await expect(
      page.getByText("Follow-up queued in Pi after current work."),
    ).toBeVisible();

    await composer.fill("/fake-worker-command now");
    await expect(page.getByRole("button", { name: "Steer" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Run command now" }),
    ).toBeEnabled();

    await page.getByRole("button", { name: "Abort" }).click();
    await expect(
      page.getByText("Abort requested; waiting for Pi to confirm completion.", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension UI confirm request completes through renderer, IPC, and fake Pi", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-extension-ui-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: [
        "--prompt-scenario",
        "extension-ui",
        "--stream-delay-ms",
        "1",
      ],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("confirm extension request");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Fake confirm", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Approve fake extension UI request?"),
    ).toBeVisible();

    const waitingComposer = page.getByLabel("Prompt text");
    await waitingComposer.fill("blocked while extension input is pending");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await waitingComposer.fill("");

    const waitingSessionActions = page.getByRole("button", {
      name: "Session actions for confirm extension request",
    });
    await expect(waitingSessionActions).toBeVisible();
    await waitingSessionActions.click();
    const waitingActionsMenu = page.getByRole("menu", {
      name: "Session actions for confirm extension request",
    });
    await expect(
      waitingActionsMenu.getByRole("menuitem", {
        name: "Move to workspace…",
      }),
    ).toBeDisabled();
    await expect(
      waitingActionsMenu.getByRole("menuitem", { name: "Archive session" }),
    ).toBeDisabled();
    await expect(
      waitingActionsMenu.getByRole("menuitem", {
        name: "Remove from workspace",
      }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");

    // A waiting worker remains in the sidebar after the user moves elsewhere;
    // receiving extension input never steals foreground selection.
    await sidebarNewSessionButton(page).click();
    await expect(
      page.getByRole("heading", { name: /Untitled new session/ }),
    ).toBeVisible();
    await expect(
      page.locator(".session-item", {
        hasText: "Waiting · extension input required",
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /Session: confirm extension request/ })
      .click();
    await expect(
      page.getByRole("button", { name: "Confirm", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(
      page.getByText("Extension UI response delivered to Pi."),
    ).toBeVisible();
    await expect(
      page.getByText(/Fake response to: confirm extension request/),
    ).toBeVisible();
    await expect(page.getByText("Needs input", { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode renders a draft shell before an unavailable backend is touched", async () => {
  const piBinary = process.env.PI_DECK_PI_BINARY || "/usr/local/bin/pi";
  test.skip(!fs.existsSync(piBinary), `Pi binary not found at ${piBinary}`);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-startup-fail-"),
  );

  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_PROJECT_CWD: path.join(repoRoot, "missing-e2e-project"),
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
  });
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await expect(
      page.getByRole("heading", { name: /Untitled new session/ }),
    ).toBeVisible();
    await expect(page.getByText("Startup error", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText(/backend fake RPC active/i)).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fake delegation is status-only, parent-scoped, and honors direct handling", async () => {
  const root = fs.mkdtempSync("/tmp/pd-");
  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "fake",
    PI_DECK_FAKE_DELEGATE_SCENARIO: "1",
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
  });
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);

    // A fresh draft can opt in before its first prompt. The initial mode is
    // passed to worker creation so that first prompt can be delegated.
    const multitaskControl = page.locator(".multitask-control");
    await expect(multitaskControl).toHaveText("Parallel: Off");
    await expect(multitaskControl).toHaveAttribute("aria-pressed", "false");
    await expect(multitaskControl).toBeEnabled();
    await multitaskControl.hover();
    const modeTooltip = page.getByRole("tooltip");
    await expect(modeTooltip).toHaveText(
      "Parallel multitasking is off. Enable it to let Pi delegate independent work.",
    );
    const controlBox = await multitaskControl.boundingBox();
    const tooltipBox = await modeTooltip.boundingBox();
    expect(controlBox).not.toBeNull();
    expect(tooltipBox).not.toBeNull();
    expect(
      Math.abs(
        tooltipBox!.x +
          tooltipBox!.width / 2 -
          (controlBox!.x + controlBox!.width / 2),
      ),
    ).toBeLessThan(2);
    expect(Math.abs(tooltipBox!.y - controlBox!.y)).toBeLessThan(100);
    await multitaskControl.click();
    await expect(multitaskControl).toHaveText("Parallel: On");
    await expect(multitaskControl).toHaveAttribute("aria-pressed", "true");
    // deck_delegate is a parent extension bridge, not production task routing.
    await selectPromptDestinationInUi(page, "parent");

    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __piDeckMultitaskStates?: Array<{
          tasks: Array<{
            generatedName: string;
            lifecycle: string;
            taskNumber: number;
          }>;
        }>;
        __piDeckMultitaskUnsubscribe?: () => void;
      };
      testWindow.__piDeckMultitaskUnsubscribe?.();
      testWindow.__piDeckMultitaskStates = [];
      testWindow.__piDeckMultitaskUnsubscribe = window.piDeck.multitask.onState(
        (state) => testWindow.__piDeckMultitaskStates?.push(state),
      );
    });

    await page.getByLabel("Prompt text").fill("delegated acceptance task");
    await page.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __piDeckMultitaskStates?: Array<{
                  tasks: Array<{ lifecycle: string }>;
                }>;
              }
            ).__piDeckMultitaskStates?.flatMap((state) =>
              state.tasks.map((task) => task.lifecycle),
            ) ?? [],
        ),
      )
      .toEqual(expect.arrayContaining(["queued", "running", "completed"]));

    // The only GUI projection is the numbered, named terminal status. It has
    // no task navigation or direct child controls, and no child enters the
    // session sidebar; the child handoff is rendered in the parent timeline.
    await multitaskControl.focus();
    const statusList = page.getByRole("list", { name: "Task statuses" });
    await expect(statusList).toHaveText("#1 Fake delegated task — completed");
    await expect(statusList.getByRole("button")).toHaveCount(0);
    await expect(
      page.getByLabel("Sessions").locator(".session-item", {
        hasText: "Fake delegated task",
      }),
    ).toHaveCount(0);
    await expect(
      page
        .getByText("Fake response to: delegated acceptance task", {
          exact: true,
        })
        .first(),
    ).toBeVisible();

    const stateCountBeforeDirectOverride = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __piDeckMultitaskStates?: unknown[];
          }
        ).__piDeckMultitaskStates?.length ?? 0,
    );
    await selectPromptDestinationInUi(page, "parent");
    await page.getByLabel("Prompt text").fill("Handle this directly.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("Fake response to: Handle this directly.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __piDeckMultitaskStates?: unknown[];
            }
          ).__piDeckMultitaskStates?.length ?? 0,
      ),
    ).toBe(stateCountBeforeDirectOverride);
    await multitaskControl.focus();
    await expect(statusList).toHaveText("#1 Fake delegated task — completed");
  } finally {
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __piDeckMultitaskUnsubscribe?: () => void;
      };
      testWindow.__piDeckMultitaskUnsubscribe?.();
      delete testWindow.__piDeckMultitaskUnsubscribe;
      delete testWindow.__piDeckMultitaskStates;
    });
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model submenu stays inside a narrow viewport", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-model-menu-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.setViewportSize({ width: 390, height: 600 });
    await page.locator(".pi-configuration-trigger").click();
    await page.getByRole("menuitem", { name: /Fake model/ }).click();
    const modelMenu = page.getByRole("menu", { name: "Available Pi models" });
    await expect(modelMenu).toBeVisible();
    const box = await modelMenu.boundingBox();
    if (box === null) throw new Error("Model menu has no bounding box");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap creates no saved session and the first draft send creates one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-lazy-new-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await expectAllWorkLaunch(page);
    await enterSessionDetail(page);
    const configuration = page.locator(".pi-configuration-trigger");
    await expect(configuration).toHaveAttribute("data-model-id", "fake-model");
    await expect(configuration).toHaveAttribute(
      "data-model-provider",
      "fake-provider",
    );
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );
    await expect(configuration).toHaveCSS("width", "90px");
    await configuration.click();
    const maxThinking = page.getByRole("menuitemradio", {
      name: "max",
      exact: true,
    });
    await expect(maxThinking).toBeVisible();
    const firstThinking = page.getByRole("menuitemradio", {
      name: "off",
      exact: true,
    });
    await expect(firstThinking).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitemradio", { name: "minimal", exact: true }),
    ).toBeFocused();
    const modelMenuTrigger = page.getByRole("menuitem", {
      name: /Fake model/,
    });
    await expect(modelMenuTrigger).toBeVisible();
    await page.keyboard.press("End");
    await expect(modelMenuTrigger).toBeFocused();
    await modelMenuTrigger.press("ArrowRight");
    const modelMenu = page.getByRole("menu", { name: "Available Pi models" });
    await expect(modelMenu).toBeVisible();
    await expect(modelMenu.getByRole("menuitemradio").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modelMenuTrigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(configuration).toBeFocused();
    await configuration.click();
    await expect(maxThinking).toBeVisible();
    await maxThinking.click();
    await expect(configuration).toHaveAttribute("data-thinking-level", "max");
    // fakeRpc writes its session record synchronously for persistent workers.
    // Waiting through the background refresh proves the no-session defaults
    // probe did not create an eager saved conversation.
    await page.waitForTimeout(150);
    const fakeSessionRoot = path.join(agentDir, "sessions");
    expect(fs.existsSync(fakeSessionRoot)).toBe(false);
    const newSession = page.getByRole("button", {
      name: "New session",
      exact: true,
    });
    for (let index = 0; index < 5; index += 1) {
      await newSession.click();
    }
    await expect(configuration).toHaveAttribute("data-model-id", "fake-model");
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );
    await expect(
      page
        .getByLabel("Sessions")
        .getByText("Untitled new session", { exact: true }),
    ).toHaveCount(0);

    const prompt = page.getByLabel("Prompt text");
    await prompt.fill("lazy first prompt");
    await prompt.press("Enter");
    await expect(page.getByText("Fake response").first()).toBeVisible();
    expect(fs.existsSync(fakeSessionRoot)).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed draft setup releases its worker before the next retry", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-draft-setup-cleanup-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--fail-command", "set_model", "--no-session"],
    }),
  );
  let trackingStarted = false;
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await expect(page.locator(".pi-configuration-trigger")).toHaveAttribute(
      "data-model-id",
      "fake-model",
    );
    await page.evaluate(async () => {
      await window.piDeck.settings.update({ maxRunningSessions: 1 });
    });
    await startRuntimeExitTracking(page);
    trackingStarted = true;

    const composer = page.getByLabel("Prompt text");
    const send = page.getByRole("button", { name: "Send" });
    await composer.fill("retry model setup");
    for (let index = 0; index < 5; index += 1) {
      await expect(send).toBeEnabled();
      await send.click();
      await waitForRuntimeExitCount(page, index + 1);
      await expect(page.locator(".composer-error")).toHaveText(
        "Fake RPC configured to fail command: set_model",
      );
      await expect(page.getByLabel("New session workspace")).toBeEnabled();
    }

    const failedRuntimeIds = await trackedRuntimeExitIds(page);
    expect(failedRuntimeIds).toHaveLength(5);
    expect(new Set(failedRuntimeIds).size).toBe(5);
    const staleRuntimeMessages = await page.evaluate(
      async (runtimeIds) =>
        Promise.all(
          runtimeIds.map(async (runtimeId) => {
            try {
              await window.piDeck.chat.getRuntimeStatus({ runtimeId });
              return "still attached";
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          }),
        ),
      failedRuntimeIds,
    );
    for (const message of staleRuntimeMessages) {
      expect(message).toMatch(/Chat runtime is no longer attached/);
    }

    // A sixth allocation under the one-worker limit proves the failed draft
    // workers no longer occupy adapter capacity.
    const recoveredSnapshot = await page.evaluate(() =>
      window.piDeck.chat.createSession(),
    );
    expect(recoveredSnapshot.runtimeId.length).toBeGreaterThan(0);
    await page.evaluate(
      (runtimeId) => window.piDeck.chat.closeSession({ runtimeId }),
      recoveredSnapshot.runtimeId,
    );
    await waitForRuntimeExitCount(page, 6);
  } finally {
    if (trackingStarted) {
      await stopRuntimeExitTracking(page).catch(() => undefined);
    }
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed initial snapshots release runtime maps and capacity", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-snapshot-cleanup-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--fail-command", "get_state", "--no-session"],
    }),
  );
  let trackingStarted = false;
  try {
    await expectHealthyPreload(page);
    await page.evaluate(async () => {
      await window.piDeck.settings.update({ maxRunningSessions: 1 });
    });
    await startRuntimeExitTracking(page);
    trackingStarted = true;

    const failureMessages = await page.evaluate(async () => {
      const messages: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        try {
          await window.piDeck.chat.createSession();
          messages.push("unexpected successful snapshot");
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }
      return messages;
    });
    expect(failureMessages).toHaveLength(5);
    for (const message of failureMessages) {
      // The original get_state failure must survive cleanup rather than being
      // replaced by a close failure or a later capacity error.
      expect(message).toBe("Fake RPC configured to fail command: get_state");
    }

    await waitForRuntimeExitCount(page, 5);
    const failedRuntimeIds = await trackedRuntimeExitIds(page);
    expect(new Set(failedRuntimeIds).size).toBe(5);
    const staleRuntimeMessages = await page.evaluate(
      async (runtimeIds) =>
        Promise.all(
          runtimeIds.map(async (runtimeId) => {
            try {
              await window.piDeck.chat.getRuntimeStatus({ runtimeId });
              return "still attached";
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          }),
        ),
      failedRuntimeIds,
    );
    for (const message of staleRuntimeMessages) {
      expect(message).toMatch(/Chat runtime is no longer attached/);
    }
  } finally {
    if (trackingStarted) {
      await stopRuntimeExitTracking(page).catch(() => undefined);
    }
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metadata-only model and thinking changes preserve session title, transcript, and cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-metadata-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const piDeckHome = path.join(root, "pideck-home");
  const prompt = "keep this title";
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--extra-model"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(`Fake response to: ${prompt}`, { exact: true }),
    ).toBeVisible();

    // A full snapshot establishes the cache before the following RPC calls
    // return their intentionally metadata-only snapshots.
    const snapshot = await page.evaluate(() =>
      window.piDeck.chat.getSnapshot(),
    );
    const sessionFile = snapshot.state.sessionFile;
    if (sessionFile === undefined) {
      throw new Error("Fake Pi did not report a session file");
    }
    const cachedBefore = cachedSessionRef(piDeckHome, sessionFile);
    expect(cachedBefore.title).toBe(prompt);
    expect(cachedBefore.messageCount).toBeGreaterThan(0);

    const configuration = page.locator(".pi-configuration-trigger");
    await configuration.click();
    await page
      .getByRole("menuitemradio", { name: "high", exact: true })
      .click();
    await expect(page.getByText("Switched thinking to high.")).toBeVisible();
    await expect(page.getByRole("heading", { name: prompt })).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Session: ${prompt}` }),
    ).toBeVisible();
    await expect(
      page.getByText(`Fake response to: ${prompt}`, { exact: true }),
    ).toBeVisible();
    expect(cachedSessionRef(piDeckHome, sessionFile)).toMatchObject({
      sessionId: cachedBefore.sessionId,
      title: cachedBefore.title,
      messageCount: cachedBefore.messageCount,
      preview: cachedBefore.preview,
    });

    await configuration.click();
    await page
      .getByRole("menuitem", { name: "Fake model", exact: true })
      .click();
    await page
      .getByRole("menuitemradio", { name: "Fake model 2", exact: true })
      .click();
    await expect(
      page.getByText("Switched model to fake-provider/fake-model-2."),
    ).toBeVisible();
    await expect(configuration).toHaveAttribute(
      "data-model-id",
      "fake-model-2",
    );
    await expect(page.getByRole("heading", { name: prompt })).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Session: ${prompt}` }),
    ).toBeVisible();
    await expect(
      page.getByText(`Fake response to: ${prompt}`, { exact: true }),
    ).toBeVisible();
    expect(cachedSessionRef(piDeckHome, sessionFile)).toMatchObject({
      sessionId: cachedBefore.sessionId,
      title: cachedBefore.title,
      messageCount: cachedBefore.messageCount,
      preview: cachedBefore.preview,
    });
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("idle runtime shutdown stays internal during session archive and restore", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-archive-runtime-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("archive runtime recovery");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: archive runtime recovery/),
    ).toBeVisible();

    const sessionRow = page.getByRole("button", {
      name: /Session: archive runtime recovery/,
    });
    await expect(
      page.getByRole("button", { name: /Close runtime/i }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Session actions for archive runtime recovery",
      })
      .click();
    await page.getByRole("menuitem", { name: "Archive session" }).click();
    await expect(page.getByText(/Archived session/)).toBeVisible();
    await page.getByRole("button", { name: /Archived/ }).click();
    await page
      .getByTestId("archived-tree")
      .getByRole("button", { name: "Restore session" })
      .click();
    const restoredRow = page.getByRole("button", {
      name: "Session: archive runtime recovery",
    });
    await expect(restoredRow).toBeVisible();
    await restoredRow.click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed saved-session deletion preserves the composer draft and attachment owner", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-delete-preserve-"),
  );
  const projectCwd = path.join(root, "project");
  const unrelatedProjectCwd = path.join(root, "other-project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-delete-preserve--");
  const sessionFile = path.join(sessionDir, "preserve-draft.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(unrelatedProjectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "preserve-draft",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "20000"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await page.getByRole("button", { name: "Session: preserve-draft" }).click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();

    const composer = page.getByLabel("Prompt text");
    await composer.fill("preserve this unsent draft");
    await page.evaluate((dataBase64) => {
      const bytes = Uint8Array.from(atob(dataBase64), (character) =>
        character.charCodeAt(0),
      );
      const image = new File([bytes], "keep-after-delete-failure.png", {
        type: "image/png",
      });
      const clipboard = new DataTransfer();
      clipboard.items.add(image);
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Prompt text"]',
      );
      if (textarea === null) {
        throw new Error("Prompt textarea is unavailable.");
      }
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }, tinyPngBase64());
    await expect(
      page
        .locator(".composer .attachment-chip")
        .getByText("keep-after-delete-failure.png"),
    ).toBeVisible();

    // Simulate an independent active turn without sending the displayed
    // composer draft. The busy runtime exposes Delete instead of Close while
    // leaving this intact draft/owner available for the failure path below.
    await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      await window.piDeck.chat.prompt({
        runtimeId: snapshot.runtimeId,
        text: "make deletion control active",
        attachments: [],
      });
    });
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

    // A mismatched Pi header fails main-side validation before close/trash
    // work. Read the active runtime's reported file so this mutation targets
    // the same canonical path the renderer will submit for deletion.
    const runtimeSessionFile = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      return snapshot.state.sessionFile;
    });
    expect(runtimeSessionFile).toEqual(expect.any(String));
    fs.writeFileSync(
      runtimeSessionFile as string,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "preserve-draft",
        timestamp: "2026-07-02T00:00:00.000Z",
        cwd: unrelatedProjectCwd,
      })}\n`,
    );
    const validationError = await page.evaluate(async (file) => {
      const project = await window.piDeck.projects.getActive();
      try {
        await window.piDeck.chat.resumeSession({
          projectId: project.activeProject?.id,
          sessionFile: file,
        });
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, runtimeSessionFile as string);
    expect(validationError).toMatch(/belongs to a different project/i);

    const sessionActions = page
      .locator(".session-list .session-item.active")
      .locator("..")
      .getByRole("button", { name: /^Session actions for / });
    await sessionActions.click();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);

    await expect(page.locator(".ui-status-message")).toHaveText(
      /Failed to delete session:/,
    );
    await expect(composer).toHaveValue("preserve this unsent draft");
    await expect(
      page
        .locator(".composer .attachment-chip")
        .getByText("keep-after-delete-failure.png"),
    ).toBeVisible();
    await page
      .getByTestId("session-delete-dialog")
      .getByRole("button", { name: "Cancel" })
      .click();

    // Stop the unrelated active turn, then prove the retained owner still
    // authorizes delivery. A blanket release would reject this prompt before
    // the fake backend could respond.
    await page.getByRole("button", { name: "Abort" }).click();
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(page.locator(".composer .attachment-chip")).toHaveCount(0);
    await page.getByRole("button", { name: "Abort" }).click();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post-close delete failure keeps the saved file and composer generation resumable", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-delete-post-close-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(
    agentDir,
    "sessions",
    "--e2e-delete-post-close--",
  );
  const sessionFile = path.join(sessionDir, "post-close-delete.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "post-close-delete",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  const canonicalSessionFile = fs.realpathSync(sessionFile);

  const { app, page } = await launchPiDeck({
    ...fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "5000"],
    }),
    PI_DECK_TEST_FAIL_SESSION_DELETE_PATH: canonicalSessionFile,
  });
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await page
      .getByRole("button", { name: "Session: post-close-delete" })
      .click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();

    const composer = page.getByLabel("Prompt text");
    await composer.fill("retain after post-close failure");
    await page.evaluate((dataBase64) => {
      const bytes = Uint8Array.from(atob(dataBase64), (character) =>
        character.charCodeAt(0),
      );
      const clipboard = new DataTransfer();
      clipboard.items.add(
        new File([bytes], "post-close-retained.png", { type: "image/png" }),
      );
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Prompt text"]',
      );
      if (textarea === null) throw new Error("Prompt textarea is unavailable.");
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }, tinyPngBase64());
    await expect(page.getByText("post-close-retained.png")).toBeVisible();

    // Keep Pi active without consuming the displayed composer. Active saved
    // rows expose Delete (which closes transactionally) rather than Detach.
    await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      await window.piDeck.chat.prompt({
        runtimeId: snapshot.runtimeId,
        text: "keep runtime active for forced delete failure",
        attachments: [],
      });
    });
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

    const sessionActions = page
      .locator(".session-list .session-item.active")
      .locator("..")
      .getByRole("button", { name: /^Session actions for / });
    await sessionActions.click();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);

    await expect(page.locator(".ui-status-message")).toHaveText(
      /Failed to delete session after closing its runtime/,
    );
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);
    await expect(composer).toHaveValue("retain after post-close failure");
    await expect(page.getByText("post-close-retained.png")).toBeVisible();
    await page
      .getByTestId("session-delete-dialog")
      .getByRole("button", { name: "Cancel" })
      .click();

    // The detached row keeps its old composer generation. Resume transfers it
    // to a fresh runtime generation, and successful delivery proves main did
    // not revoke the token during the failed delete transaction.
    await page.locator(".session-list .session-item.active").click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: retain after post-close failure/),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".composer .attachment-chip")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bulk deletion reports exact removals and releases only deleted saved-session owners", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-bulk-delete-owners-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-bulk-delete--");
  const attachedFile = path.join(sessionDir, "attached.jsonl");
  const deletedFile = path.join(sessionDir, "delete-me.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const [file, id] of [
    [attachedFile, "attached"],
    [deletedFile, "delete-me"],
  ]) {
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-07-02T00:00:00.000Z",
        cwd: projectCwd,
      })}\n`,
    );
  }

  const canonicalAttachedFile = fs.realpathSync(attachedFile);
  const canonicalDeletedFile = fs.realpathSync(deletedFile);
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    const outcome = await page.evaluate(
      async ({ attachedFile, deletedFile, dataBase64 }) => {
        const api = window.piDeck;
        const project = await api.projects.getActive();
        const projectId = project.activeProject?.id;
        if (projectId === undefined) {
          throw new Error("Expected an active project.");
        }
        const imageRequest = (ownerId: string, sessionId: string) => ({
          ownerId,
          sessionId,
          images: [
            {
              fileName: "owner-check.png",
              mimeType: "image/png",
              size: 24,
              dataBase64,
            },
          ],
        });
        const attachedOwnerId = "attached-owner-generation";
        const deletedOwnerId = "deleted-owner-generation";
        await api.attachments.importImages(
          imageRequest(attachedOwnerId, attachedFile),
        );
        await api.attachments.importImages(
          imageRequest(deletedOwnerId, deletedFile),
        );
        await api.chat.resumeSession({ projectId, sessionFile: attachedFile });
        const result = await api.chat.deleteAllSessions({ projectId });
        let deletedOwnerError: string | undefined;
        try {
          await api.attachments.importImages(
            imageRequest(deletedOwnerId, deletedFile),
          );
        } catch (error) {
          deletedOwnerError =
            error instanceof Error ? error.message : String(error);
        }
        const retainedOwner = await api.attachments.importImages(
          imageRequest(attachedOwnerId, attachedFile),
        );
        return { result, deletedOwnerError, retainedOwner };
      },
      {
        attachedFile: canonicalAttachedFile,
        deletedFile: canonicalDeletedFile,
        dataBase64: tinyPngBase64(),
      },
    );

    expect(outcome.result).toMatchObject({
      deleted: true,
      deletedCount: 1,
      skippedCount: 1,
      deletedSessionFiles: [canonicalDeletedFile],
    });
    expect(outcome.deletedOwnerError).toMatch(/owner is no longer active/i);
    expect(outcome.retainedOwner).toMatchObject({ selected: true });
    expect(fs.existsSync(canonicalAttachedFile)).toBe(true);
    expect(fs.existsSync(canonicalDeletedFile)).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("saved session deletion control is reachable and activated with the keyboard", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-delete-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-delete--");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "keyboard-delete.jsonl"),
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "keyboard-delete",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await expect(
      page.getByRole("button", { name: "Delete saved sessions", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".sidebar .ui-menu-popover")).toHaveCount(0);
    const sessionRow = page.getByRole("button", {
      name: "Session: keyboard-delete",
    });
    const sessionActions = page.getByRole("button", {
      name: "Session actions for keyboard-delete",
    });
    await expect(sessionRow).toBeVisible();

    await sessionRow.focus();
    await page.keyboard.press("Tab");
    await expect(sessionActions).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Delete session…" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);

    await expect(page.getByText("Deleted Pi session.")).toBeVisible();
    await expect(sessionRow).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode can show and resume a saved project session with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-resume-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const sessionDir = path.join(agentDir, "sessions", "--e2e--");
  fs.mkdirSync(sessionDir, { recursive: true });
  for (let index = 0; index < 7; index += 1) {
    fs.writeFileSync(
      path.join(sessionDir, `manual-e2e-session-${index}.jsonl`),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: `manual-e2e-session-${index}`,
        timestamp: `2026-07-02T00:0${index}:00.000Z`,
        cwd: projectCwd,
      })}\n`,
    );
  }

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await expect(page.getByText(/Real Pi mode active/i)).toBeVisible();
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await expect(
      page.getByRole("button", { name: "Session: manual-e2e-session-0" }),
    ).toBeVisible();
    const savedSession = page
      .getByRole("button", { name: /Session: manual-e2e-session-/ })
      .first();
    await expect(savedSession).toBeVisible();
    await savedSession.click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();
    await page
      .getByLabel("Prompt text")
      .fill("resume e2e prompt without sending");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode keeps attention sessions visible, labels queues, searches, and refreshes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-inbox-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-inbox--");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const writeSavedSession = (name: string, timestamp: string): void => {
    fs.writeFileSync(
      path.join(sessionDir, `${name}.jsonl`),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: name,
        timestamp,
        cwd: projectCwd,
      })}\n`,
    );
  };
  for (let index = 0; index < 7; index += 1) {
    writeSavedSession(
      `saved-inbox-${index}`,
      `2026-07-02T00:0${index}:00.000Z`,
    );
  }

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "10000", "--prompt-scenario", "queue"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("attention stays visible");
    await page.getByRole("button", { name: "Send" }).click();
    const sidebar = page.getByLabel("Sessions");
    await expect(
      sidebar.getByRole("button", { name: "Session: attention stays visible" }),
    ).toBeVisible();
    await expect(sidebar.getByText("Steer 1")).toBeVisible();
    await expect(sidebar.getByText("Follow-up 2")).toBeVisible();
    await expect(sidebar.getByText("1 working", { exact: true })).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "Session: saved-inbox-0" }),
    ).toBeVisible();

    await sidebar.getByLabel("Search sessions").fill("saved-inbox-6");
    await expect(
      sidebar.getByRole("button", { name: "Session: saved-inbox-6" }),
    ).toBeVisible();

    writeSavedSession("refreshed-inbox-target", "2026-07-03T00:00:00.000Z");
    await sidebar.getByRole("button", { name: "Refresh sessions" }).click();
    await sidebar.getByLabel("Search sessions").fill("refreshed-inbox-target");
    await expect(
      sidebar.getByRole("button", { name: "Session: refreshed-inbox-target" }),
    ).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode concurrent duplicate resume reuses one runtime with fake Pi", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-duplicate-resume-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-duplicate--");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "duplicate-resume.jsonl");
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "duplicate-resume",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await expect(
      page.getByRole("button", { name: "Session: duplicate-resume" }),
    ).toBeVisible();
    const runtimeIds = await page.evaluate(async (file) => {
      const api = window.piDeck;
      const [first, second] = await Promise.all([
        api.chat.resumeSession({ sessionFile: file }),
        api.chat.resumeSession({ sessionFile: file }),
      ]);
      return [first.runtimeId, second.runtimeId];
    }, sessionFile);

    expect(runtimeIds[0]).toBe(runtimeIds[1]);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode removes missing saved session after resume failure with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-missing-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-missing--");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "missing-before-resume.jsonl");
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "missing-before-resume",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    const missingSession = page.getByRole("button", {
      name: "Session: missing-before-resume",
    });
    await expect(missingSession).toBeVisible();
    fs.rmSync(sessionFile, { force: true });
    await missingSession.click();
    await expect(
      page.getByText(
        "Saved session file is missing or unreadable. Removed it from the list.",
      ),
    ).toBeVisible();
    await expect(missingSession).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode lists a newly prompted session after restart with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-persist-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const env = fakeRealModeEnv({ root, projectCwd, agentDir });
  const token = `persisted-restart-${Date.now()}`;

  const firstLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(firstLaunch.page);
    await selectWorkspaceInUi(firstLaunch.page, path.basename(projectCwd));
    await enterSessionDetail(firstLaunch.page);
    await firstLaunch.page
      .getByLabel("Prompt text")
      .fill(`persisted restart session ${token}`);
    await firstLaunch.page.getByRole("button", { name: "Send" }).click();
    await expect(
      firstLaunch.page.getByText(
        `Fake response to: persisted restart session ${token}`,
      ),
    ).toBeVisible();
  } finally {
    await firstLaunch.app.close();
  }

  const secondLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(secondLaunch.page);
    await selectWorkspaceInUi(secondLaunch.page, path.basename(projectCwd));
    const persistedSession = secondLaunch.page.getByRole("button", {
      name: "Session: persisted restart session",
    });
    await expect(persistedSession).toBeVisible();
    await persistedSession.click();
    await expect(
      secondLaunch.page.getByText("Resumed saved Pi session."),
    ).toBeVisible();
    await expect(
      secondLaunch.page
        .getByLabel("Chat / Agent Timeline")
        .getByText(token)
        .first(),
    ).toBeVisible();
  } finally {
    await secondLaunch.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode authorizes opaque project IDs before any project-scoped Pi work", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-project-authority-"),
  );
  const selectedDir = path.join(root, "selected-project");
  const unselectedDir = path.join(root, "unselected-project");
  const agentDir = path.join(root, "agent");
  const piDeckHome = path.join(root, "pideck-home");
  const fakePiCwdLog = path.join(root, "fake-pi-cwds.log");
  fs.mkdirSync(selectedDir, { recursive: true });
  fs.mkdirSync(unselectedDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(piDeckHome, { recursive: true });
  const selectedProject = fs.realpathSync(selectedDir);
  const unselectedProject = fs.realpathSync(unselectedDir);
  const selectedProjectId = "opaque-selected-project-id";
  const now = Date.now();
  fs.writeFileSync(
    path.join(piDeckHome, "projects.json"),
    `${JSON.stringify({
      version: 1,
      activeProjectId: selectedProjectId,
      projects: [
        {
          id: selectedProjectId,
          rootPath: selectedProject,
          displayName: "selected-project",
          createdAtMs: now,
          updatedAtMs: now,
          lastOpenedAtMs: now,
        },
      ],
      sessionRefs: [],
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, agentDir, fakePiCwdLog }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, "selected-project");
    await enterSessionDetail(page);

    const rejectionMessages = await page.evaluate(
      async ({ projectId, sessionFile }) => {
        const reject = async (operation: Promise<unknown>) => {
          try {
            await operation;
            return "unexpected success";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        };
        const api = window.piDeck;
        return {
          create: await reject(api.chat.createSession({ projectId })),
          listModels: await reject(api.chat.listModels({ projectId })),
          listSessions: await reject(api.chat.listSessions({ projectId })),
          resume: await reject(
            api.chat.resumeSession({ projectId, sessionFile }),
          ),
          delete: await reject(
            api.chat.deleteSession({ projectId, sessionFile }),
          ),
          deleteAll: await reject(api.chat.deleteAllSessions({ projectId })),
        };
      },
      {
        projectId: unselectedProject,
        sessionFile: path.join(unselectedProject, "unregistered.jsonl"),
      },
    );
    for (const message of Object.values(rejectionMessages)) {
      expect(message).toMatch(/unknown project/i);
    }

    const positive = await page.evaluate(async (projectId) => {
      const api = window.piDeck;
      const [models, sessions] = await Promise.all([
        api.chat.listModels({ projectId }),
        api.chat.listSessions({ projectId }),
      ]);
      return {
        modelCount: models.models.length,
        projectId: sessions.projectId,
        projectCwd: sessions.projectCwd,
      };
    }, selectedProjectId);
    expect(positive.modelCount).toBeGreaterThan(0);
    expect(positive.projectId).toBe(selectedProjectId);
    expect(positive.projectCwd).toBe(selectedProject);

    await page.getByLabel("Prompt text").fill("opaque project authority");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: opaque project authority/),
    ).toBeVisible();
    const snapshot = await page.evaluate(() =>
      window.piDeck.chat.getSnapshot(),
    );
    expect(snapshot.projectId).toBe(selectedProjectId);
    expect(snapshot.state.cwd).toBe(selectedProject);
    await expect(
      page.locator('.workspace[data-primary-view="session"]'),
    ).toBeVisible();

    const runtimeProjectRejection = await page.evaluate(
      async ({ runtimeId, projectId }) => {
        try {
          await window.piDeck.chat.listModels({ runtimeId, projectId });
          return "unexpected success";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      { runtimeId: snapshot.runtimeId, projectId: unselectedProject },
    );
    expect(runtimeProjectRejection).toMatch(/unknown project/i);

    const launchedCwds = fs.existsSync(fakePiCwdLog)
      ? fs
          .readFileSync(fakePiCwdLog, "utf8")
          .split("\n")
          .filter((cwd) => cwd.length > 0)
      : [];
    expect(launchedCwds).toContain(selectedProject);
    expect(launchedCwds).not.toContain(unselectedProject);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background worker continues while a directory-independent workspace is created", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-background-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "500"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("workspace background worker");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
    const runtimeId = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      return snapshot.runtimeId;
    });

    await createWorkspaceInUi(page, "Background topic");
    const activeWorkspace = await page.evaluate(async () => {
      const result = await window.piDeck.workspaces.getActive();
      return result.activeWorkspace;
    });
    expect(activeWorkspace?.name).toBe("Background topic");
    expect(activeWorkspace?.defaultProjectId).toBeUndefined();
    await expect(
      page.getByRole("button", { name: /working folder/i }),
    ).toHaveCount(0);

    await expect
      .poll(async () =>
        page.evaluate(async (id) => {
          const status = await window.piDeck.chat.getRuntimeStatus({
            runtimeId: id,
          });
          return status.state.isAgentActive;
        }, runtimeId),
      )
      .toBe(false);
    await selectWorkspaceInUi(page, "Default workspace");
    await page
      .getByRole("button", { name: "Session: workspace background worker" })
      .click();
    await expect(
      page.getByText(/Fake response to: workspace background worker/),
    ).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed workspace context persists across relaunch", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-managed-relaunch-"),
  );
  const bootstrapCwd = path.join(root, "bootstrap-project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const managedCwd = path.join(root, "pideck-home", "runtime-context");
  fs.mkdirSync(bootstrapCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const firstLaunch = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd: bootstrapCwd,
      agentDir,
      userDataDir,
      testPickProjectCwds: ["__cancel__"],
    }),
  );
  let sessionFile: string | undefined;
  try {
    await expectHealthyPreload(firstLaunch.page);
    await createWorkspaceInUi(firstLaunch.page, "Persistent topic");
    await enterSessionDetail(firstLaunch.page);
    await expect(
      firstLaunch.page.locator(".pi-configuration-trigger"),
    ).toHaveAttribute("data-model-id", "fake-model");
    await firstLaunch.page
      .getByLabel("Prompt text")
      .fill("managed relaunch prompt");
    await firstLaunch.page.getByRole("button", { name: "Send" }).click();
    await expect(
      firstLaunch.page.getByText(/Fake response to: managed relaunch prompt/),
    ).toBeVisible();
    const snapshot = await firstLaunch.page.evaluate(() =>
      window.piDeck.chat.getSnapshot(),
    );
    expect(snapshot.state.cwd).toBe(fs.realpathSync(managedCwd));
    sessionFile = snapshot.state.sessionFile;
    expect(sessionFile).toEqual(expect.any(String));
  } finally {
    await firstLaunch.app.close();
  }

  // Simulate a process exit that happened before the final metadata snapshot
  // reached the workspace cache. The JSONL remains authoritative and contains
  // the prompt, so relaunch must repair this filename fallback.
  const workspaceStorePath = path.join(root, "pideck-home", "workspaces.json");
  const workspaceStore = JSON.parse(
    fs.readFileSync(workspaceStorePath, "utf8"),
  ) as {
    sessionRefs?: Array<{
      sessionFile: string;
      title?: string;
      messageCount?: number;
      preview?: string;
    }>;
  };
  const cachedRef = workspaceStore.sessionRefs?.find(
    (ref) => ref.sessionFile === fs.realpathSync(sessionFile as string),
  );
  if (cachedRef === undefined) {
    throw new Error("Missing managed workspace session cache entry");
  }
  cachedRef.title = path.basename(sessionFile as string, ".jsonl");
  cachedRef.messageCount = 0;
  delete cachedRef.preview;
  fs.writeFileSync(workspaceStorePath, `${JSON.stringify(workspaceStore)}\n`);

  const secondLaunch = await launchPiDeck(
    fakeRealModeEnv({ root, agentDir, userDataDir }),
  );
  try {
    await expectHealthyPreload(secondLaunch.page);
    await expectAllWorkLaunch(secondLaunch.page);
    await selectWorkspaceInUi(secondLaunch.page, "Persistent topic");
    const activeWorkspace = await secondLaunch.page.evaluate(async () => {
      const result = await window.piDeck.workspaces.getActive();
      return result.activeWorkspace;
    });
    expect(activeWorkspace?.defaultProjectId).toBeUndefined();
    await secondLaunch.page
      .getByRole("button", { name: "Session: managed relaunch prompt" })
      .click();
    await expect(
      secondLaunch.page.getByText("Resumed saved Pi session."),
    ).toBeVisible();
    const resumed = await secondLaunch.page.evaluate(() =>
      window.piDeck.chat.getSnapshot(),
    );
    expect(resumed.state.cwd).toBe(fs.realpathSync(managedCwd));
    expect(fs.realpathSync(resumed.state.sessionFile as string)).toBe(
      fs.realpathSync(sessionFile as string),
    );
  } finally {
    await secondLaunch.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode explains long no-output active work with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-no-output-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "10000"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("slow first output");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Agent is working… \d+s elapsed\./),
    ).toBeVisible();
    await expect(page.getByText("Pi agent started")).toBeVisible();
    await expect(page.getByText(/No visible output yet/)).toBeVisible({
      timeout: 8_000,
    });
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode surfaces asynchronous provider errors with fake Pi", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-provider-error-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--prompt-scenario", "error"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("trigger usage limit");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.locator('[role="alert"]').filter({
        hasText: "Usage limit reached for fake provider.",
      }),
    ).toBeVisible();
    await expect(page.getByText("Agent is working…")).toHaveCount(0);
    await expect(page.getByText("Error").first()).toBeVisible();
    await page.getByLabel("Prompt text").fill("can edit after error");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode reconciles a working session when completion event is missed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-reconcile-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--drop-completion-events"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("missed completion event");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(
        "Reconciled from Pi runtime status because the live completion event was not observed.",
      ),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Agent is working…")).toHaveCount(0);
    await expect(
      page.getByText(/Fake response to: missed completion event/),
    ).toBeVisible();
    await page.getByLabel("Prompt text").fill("can send after reconcile");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode routes background session events to the right session with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-routing-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "150"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await page.getByLabel("Prompt text").fill("background route one");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.locator(".session-item", { hasText: "background route one" }),
    ).toBeVisible();

    await sidebarNewSessionButton(page).click();
    await page.getByLabel("Prompt text").fill("foreground route two");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: foreground route two/),
    ).toBeVisible();

    await page
      .locator(".session-item", { hasText: "background route one" })
      .click();
    await expect(
      page.getByText(/Fake response to: background route one/),
    ).toBeVisible();
    await expect(
      page.getByText(/Fake response to: foreground route two/),
    ).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode compact plus creates another attached session with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-new-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await sidebarNewSessionButton(page).click();
    await page.getByLabel("Prompt text").fill("start draft session");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: start draft session/),
    ).toBeVisible();
    const composer = page.getByLabel("Prompt text");
    await composer.fill("/");
    await expect(composer).toHaveAttribute("role", "combobox");
    await expect(composer).toHaveAttribute("aria-expanded", "true");
    const workerCommand = page.getByRole("option", {
      name: /\/fake-worker-command/,
    });
    await expect(workerCommand).toBeVisible();
    await composer.press("End");
    await expect(workerCommand).toHaveAttribute("aria-selected", "true");
    await composer.press("Enter");
    await expect(composer).toHaveValue("/fake-worker-command ");
    await expect(composer).toHaveAttribute("aria-expanded", "false");
    await page
      .getByLabel("Prompt text")
      .fill("new session e2e prompt without sending");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode does not fall back to fake/local UI and can send from active runtime", async () => {
  const piBinary = process.env.PI_DECK_PI_BINARY || "/usr/local/bin/pi";
  test.skip(!fs.existsSync(piBinary), `Pi binary not found at ${piBinary}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-real-ui-"));
  const projectCwd = path.join(root, "project");
  fs.mkdirSync(projectCwd, { recursive: true });

  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_PROJECT_CWD: projectCwd,
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
  });
  try {
    await expectHealthyPreload(page);
    await enterSessionDetail(page);
    await expect(page.getByTestId("workspace-tree")).toBeVisible();
    await expect(page.getByText(/Real Pi mode active/i)).toBeVisible();
    await expect(page.getByText("Local projects")).toHaveCount(0);
    await expect(page.getByText(/backend fake RPC active/i)).toHaveCount(0);
    await expect(page.getByText(/claude/i)).toHaveCount(0);
    await expect(page.locator(".pi-configuration-trigger")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /New real session/i }),
    ).toHaveCount(0);

    await page
      .getByLabel("Prompt text")
      .fill("real e2e prompt without sending");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.describe("Unified Work", () => {
  test("Unified Work routes launch, scopes, origins, ownership, and runtimes", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-e2e-unified-work-"),
    );
    const projectCwd = path.join(root, "activity-source");
    const agentDir = path.join(root, "agent");
    const userDataDir = path.join(root, "user-data");
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      `${JSON.stringify({ maxRunningSessions: 12 })}\n`,
    );

    const { app, page } = await launchPiDeck(
      fakeRealModeEnv({ root, projectCwd, agentDir, userDataDir }),
    );
    try {
      await expectHealthyPreload(page);
      // Keep the fresh-launch contract visible before entering either chat
      // journey below: launch is All Work, not an implicit session detail.
      await expectAllWorkLaunch(page);
      const allWork = page.getByRole("button", { name: /^All Work/ });
      await expect(allWork).toHaveAttribute("aria-current", "page");
      const defaultWorkspace = await page.evaluate(async () => {
        const result = await window.piDeck.workspaces.getActive();
        const workspace =
          result.workspaces.find((candidate) => candidate.isDefault) ??
          result.activeWorkspace;
        if (workspace === undefined) {
          throw new Error("Expected a default workspace at launch.");
        }
        return { id: workspace.id, name: workspace.name };
      });
      const workspaceId = async (name: string): Promise<string> => {
        const id = await page
          .getByRole("button", { name: `Workspace: ${name}` })
          .getAttribute("data-workspace-id");
        if (id === null) throw new Error(`Missing workspace id for ${name}.`);
        return id;
      };
      const activityRow = (title: string) =>
        page.locator(".activity-inbox-row").filter({ hasText: title });

      await createWorkspaceInUi(page, "Unified A");
      const unifiedAId = await workspaceId("Unified A");
      await expectWorkRoute(page, unifiedAId);
      await expect(
        page.getByRole("heading", { name: "Unified A Work", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".surface-title")).toHaveText("Unified A Work");

      await createWorkspaceInUi(page, "Unified B");
      const unifiedBId = await workspaceId("Unified B");
      await expectWorkRoute(page, unifiedBId);
      await expect(
        page.getByRole("heading", { name: "Unified B Work", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".surface-title")).toHaveText("Unified B Work");

      await selectWorkspaceInUi(page, "Unified A");
      await expectWorkRoute(page, unifiedAId);
      await enterSessionDetail(page);
      const aPrompt = "Unified A active runtime";
      await page.getByLabel("Prompt text").fill(aPrompt);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page.getByText(`Fake response to: ${aPrompt}`, { exact: true }),
      ).toBeVisible();
      const aRuntimeId = await page.evaluate(
        async () => (await window.piDeck.chat.getSnapshot()).runtimeId,
      );

      await allWork.click();
      await expectAllWorkLaunch(page);
      await expectRuntimeIds(page, [aRuntimeId]);
      await selectWorkspaceInUi(page, "Unified B");
      await expectWorkRoute(page, unifiedBId);
      await enterSessionDetail(page);
      const bPrompt = "Unified B active runtime";
      await page.getByLabel("Prompt text").fill(bPrompt);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page.getByText(`Fake response to: ${bPrompt}`, { exact: true }),
      ).toBeVisible();
      const bRuntimeId = await page.evaluate(
        async () => (await window.piDeck.chat.getSnapshot()).runtimeId,
      );
      expect(bRuntimeId).not.toBe(aRuntimeId);
      await expectRuntimeIds(page, [aRuntimeId, bRuntimeId]);

      // Navigation between the global and scoped routes must retain both
      // workers; only the primary view and selected session change.
      await allWork.click();
      await expectAllWorkLaunch(page);
      await expectRuntimeIds(page, [aRuntimeId, bRuntimeId]);
      await selectWorkspaceInUi(page, "Unified A");
      await expectWorkRoute(page, unifiedAId);
      await expectRuntimeIds(page, [aRuntimeId, bRuntimeId]);
      await allWork.click();
      await expectAllWorkLaunch(page);
      await selectWorkspaceInUi(page, "Unified B");
      await expectWorkRoute(page, unifiedBId);
      await expectRuntimeIds(page, [aRuntimeId, bRuntimeId]);

      // Global creation is routed to the persisted default workspace even
      // while the current visible Work scope is B.
      await allWork.click();
      await expectAllWorkLaunch(page);
      await enterSessionDetail(page);
      const globalOwner = await page.evaluate(async () => {
        const result = await window.piDeck.workspaces.getActive();
        return result.activeWorkspace;
      });
      expect(globalOwner?.id).toBe(defaultWorkspace.id);
      expect(globalOwner?.name).toBe(defaultWorkspace.name);

      // A scoped New session follows the selected workspace instead of the
      // default/global creation rule.
      await allWork.click();
      await expectAllWorkLaunch(page);
      await selectWorkspaceInUi(page, "Unified B");
      await expectWorkRoute(page, unifiedBId);
      await enterSessionDetail(page);
      const scopedOwner = await page.evaluate(async () => {
        const result = await window.piDeck.workspaces.getActive();
        return result.activeWorkspace;
      });
      expect(scopedOwner?.id).toBe(unifiedBId);
      expect(scopedOwner?.name).toBe("Unified B");

      // Drill-in preserves the exact origin for both global and scoped Work.
      await allWork.click();
      await expectAllWorkLaunch(page);
      const globalA = activityRow(aPrompt);
      await expect(globalA).toHaveCount(1);
      await globalA.focus();
      await globalA.press("Enter");
      await expect(
        page.locator('.workspace[data-primary-view="session"]'),
      ).toBeVisible();
      await expect(page.getByTestId("session-origin-back")).toHaveAttribute(
        "aria-label",
        "Back to All Work",
      );
      await expect(
        page
          .getByLabel("Chat / Agent Timeline")
          .getByText(aPrompt, { exact: true }),
      ).toBeVisible();
      const backToAllWork = page.getByTestId("session-origin-back");
      await backToAllWork.focus();
      await page.keyboard.press("Enter");
      await expectAllWorkLaunch(page);
      await expect(globalA).toBeFocused();

      await selectWorkspaceInUi(page, "Unified A");
      await expectWorkRoute(page, unifiedAId);
      const scopedA = activityRow(aPrompt);
      await expect(scopedA).toHaveCount(1);
      await scopedA.click();
      await expect(page.getByTestId("session-origin-back")).toHaveAttribute(
        "aria-label",
        "Back to Unified A Work",
      );
      await page.getByTestId("session-origin-back").click();
      await expectWorkRoute(page, unifiedAId);

      // A targeted action in A must not appear after navigating to B.
      await allWork.click();
      await expectAllWorkLaunch(page);
      await activityRow(aPrompt).click();
      const targetedPrompt = "Only Unified A receives this follow-up";
      await page.getByLabel("Prompt text").fill(targetedPrompt);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page.getByText(`Fake response to: ${targetedPrompt}`, { exact: true }),
      ).toBeVisible();
      await expectRuntimeIds(page, [aRuntimeId, bRuntimeId]);

      await allWork.click();
      await expectAllWorkLaunch(page);
      await activityRow(bPrompt).click();
      const bTimeline = page.getByLabel("Chat / Agent Timeline");
      await expect(bTimeline.getByText(bPrompt, { exact: true })).toBeVisible();
      await expect(
        bTimeline.getByText(targetedPrompt, { exact: true }),
      ).toHaveCount(0);
      await expectRuntimeIds(page, [aRuntimeId, bRuntimeId]);

      // Populate enough ordinary Work rows to make the real Work viewport
      // scrollable without modifying production layout or row ordering.
      await allWork.click();
      await expectAllWorkLaunch(page);
      for (const prompt of Array.from(
        { length: 6 },
        (_, index) => `Unified Work scroll filler ${index + 1}`,
      )) {
        await enterSessionDetail(page);
        await page.getByLabel("Prompt text").fill(prompt);
        await page.getByRole("button", { name: "Send" }).click();
        await expect(
          page.getByText(`Fake response to: ${prompt}`, { exact: true }),
        ).toBeVisible();
        await allWork.click();
        await expectAllWorkLaunch(page);
      }
      const inbox = page.locator(".activity-inbox");
      await inbox.hover();
      await page.mouse.wheel(0, 300);
      const savedWorkScrollTop = await inbox.evaluate((element) =>
        Math.round(element.scrollTop),
      );
      expect(savedWorkScrollTop).toBeGreaterThan(100);
      const scrollTargetId = await inbox.evaluate((element) => {
        const inboxBounds = element.getBoundingClientRect();
        const target = Array.from(
          element.querySelectorAll<HTMLElement>("[data-activity-item-id]"),
        ).find((row) => {
          const bounds = row.getBoundingClientRect();
          return (
            bounds.top >= inboxBounds.top && bounds.bottom <= inboxBounds.bottom
          );
        });
        return target?.dataset.activityItemId;
      });
      if (scrollTargetId === undefined) {
        throw new Error("Missing a visible Work row after mouse scrolling.");
      }
      const scrollTarget = page.locator(
        `[data-activity-item-id=${JSON.stringify(scrollTargetId)}]`,
      );
      const scrollTargetBox = await scrollTarget.boundingBox();
      if (scrollTargetBox === null) {
        throw new Error("Scrolled Work row has no bounding box.");
      }
      await page.mouse.click(
        scrollTargetBox.x + scrollTargetBox.width / 2,
        scrollTargetBox.y + scrollTargetBox.height / 2,
      );
      await expect(
        page.locator('.workspace[data-primary-view="session"]'),
      ).toBeVisible();
      const backToScrolledWork = page.getByTestId("session-origin-back");
      await backToScrolledWork.focus();
      await page.keyboard.press("Enter");
      await expectAllWorkLaunch(page);
      await expect(scrollTarget).toBeFocused();
      await expect
        .poll(() => inbox.evaluate((element) => Math.round(element.scrollTop)))
        .toBe(savedWorkScrollTop);
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unified Work All Work counts use the same total across sidebar, scope, and filter", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-e2e-work-count-consistency-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const userDataDir = path.join(root, "user-data");
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      `${JSON.stringify({ maxRunningSessions: 12, warmWorkerLimit: 0 })}\n`,
    );

    const { app, page } = await launchPiDeck({
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: createFakePiBinary(root, [
        "--stream-delay-ms",
        "120000",
        "--prompt-error-prefix",
        "count consistency failed",
      ]),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DECK_HOME: path.join(root, "pideck-home"),
      PI_DECK_USER_DATA_DIR: userDataDir,
    });
    try {
      await expectHealthyPreload(page);
      await expectAllWorkLaunch(page);
      const allWork = page
        .getByLabel("Sessions", { exact: true })
        .getByRole("button", { name: /^All Work/ });

      for (const prompt of [
        "count consistency running 1",
        "count consistency running 2",
      ]) {
        await enterSessionDetail(page);
        await page.getByLabel("Prompt text").fill(prompt);
        await page.getByRole("button", { name: "Send" }).click();
        await expect(page.getByText("Pi agent started")).toBeVisible();
        await allWork.click();
        await expectAllWorkLaunch(page);
      }

      for (const prompt of [
        "count consistency failed 1",
        "count consistency failed 2",
        "count consistency failed 3",
        "count consistency failed 4",
      ]) {
        await enterSessionDetail(page);
        await page.getByLabel("Prompt text").fill(prompt);
        await page.getByRole("button", { name: "Send" }).click();
        await expect(
          page.locator('[role="alert"]').filter({
            hasText: "Usage limit reached for fake provider.",
          }),
        ).toBeVisible();
        await allWork.click();
        await expectAllWorkLaunch(page);
      }

      const route = page.locator(
        '.workspace[data-primary-view="work"][data-work-scope="all"]',
      );
      const filters = route.getByRole("group", {
        name: "Filter Work by status",
      });

      await expect(
        allWork.locator(".activity-inbox-badge [aria-hidden]"),
      ).toHaveText("6");
      await expect(allWork).toHaveAccessibleName(
        /All Work\s+6 total work items/,
      );
      await expect(route.locator('option[value="all"]')).toHaveText(
        "All Work (6)",
      );
      await expect(
        filters.getByRole("button", { name: /^All\s+6$/ }),
      ).toBeVisible();
      await expect(
        filters.getByRole("button", { name: /^Failed\s+4$/ }),
      ).toBeVisible();
      await expect(
        filters.getByRole("button", { name: /^In progress\s+2$/ }),
      ).toBeVisible();
      await expect(route.locator(".activity-inbox-row")).toHaveCount(6);
      await expect(route.locator(".activity-inbox-row--failed")).toHaveCount(4);
      await expect(
        route.locator(".activity-inbox-row--inProgress"),
      ).toHaveCount(2);
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unified Work keeps in-progress card order stable during runtime updates", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-e2e-work-stable-order-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const userDataDir = path.join(root, "user-data");
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      `${JSON.stringify({ maxRunningSessions: 12 })}\n`,
    );

    const { app, page } = await launchPiDeck(
      fakeRealModeEnv({
        root,
        projectCwd,
        agentDir,
        userDataDir,
        fakePiArgs: ["--stream-delay-ms", "8000", "--drop-completion-events"],
      }),
    );
    try {
      await expectHealthyPreload(page);
      await expectAllWorkLaunch(page);
      await createWorkspaceInUi(page, "Stable order workspace");
      const workspaceId = await page
        .getByRole("button", { name: "Workspace: Stable order workspace" })
        .getAttribute("data-workspace-id");
      if (workspaceId === null) {
        throw new Error("Missing stable-order workspace id.");
      }

      const marker = "Stable order active";
      const alphaPrompt = `${marker} alpha`;
      const betaPrompt = `${marker} beta`;
      const visibleStableOrderTitles = () =>
        page
          .locator(".activity-inbox-row-title")
          .evaluateAll(
            (nodes, markerText) =>
              nodes
                .map((node) => node.textContent?.trim() ?? "")
                .filter((title) => title.includes(markerText)),
            marker,
          );
      const rowUpdatedAtMs = (title: string) =>
        page
          .locator(".activity-inbox-row", { hasText: title })
          .locator("time")
          .evaluate((time) => Date.parse(time.dateTime));

      await enterSessionDetail(page);
      await page.getByLabel("Prompt text").fill(alphaPrompt);
      await page.getByRole("button", { name: "Send" }).click();
      await page.waitForTimeout(1000);
      await page.getByRole("button", { name: /^All Work/ }).click();
      await expectAllWorkLaunch(page);

      await selectWorkspaceInUi(page, "Stable order workspace");
      await expectWorkRoute(page, workspaceId);
      await enterSessionDetail(page);
      await page.getByLabel("Prompt text").fill(betaPrompt);
      await page.getByRole("button", { name: "Send" }).click();

      await page.getByRole("button", { name: /^All Work/ }).click();
      await expectAllWorkLaunch(page);
      await expect(
        page.locator(".activity-inbox-row--inProgress", {
          hasText: alphaPrompt,
        }),
      ).toHaveCount(1);
      await expect(
        page.locator(".activity-inbox-row--inProgress", {
          hasText: betaPrompt,
        }),
      ).toHaveCount(1);
      const initialOrder = [betaPrompt, alphaPrompt];
      await expect.poll(visibleStableOrderTitles).toEqual(initialOrder);

      // Let alpha receive a normal runtime message_update after beta has
      // entered In progress, but before beta's first stream chunk. The row's
      // recency metadata should change without becoming a live layout key.
      await expect
        .poll(
          async () =>
            (await rowUpdatedAtMs(alphaPrompt)) >
            (await rowUpdatedAtMs(betaPrompt)),
        )
        .toBe(true);
      await expect.poll(visibleStableOrderTitles).toEqual(initialOrder);

      await selectWorkspaceInUi(page, "Stable order workspace");
      await expectWorkRoute(page, workspaceId);
      await expect.poll(visibleStableOrderTitles).toEqual(initialOrder);
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unified Work orders Completed as a completion-time follow-up queue", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-e2e-work-completed-queue-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const userDataDir = path.join(root, "user-data");
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      `${JSON.stringify({ maxRunningSessions: 12 })}\n`,
    );

    const { app, page } = await launchPiDeck(
      fakeRealModeEnv({
        root,
        projectCwd,
        agentDir,
        userDataDir,
        fakePiArgs: ["--stream-delay-ms", "800"],
      }),
    );
    try {
      await expectHealthyPreload(page);
      await expectAllWorkLaunch(page);

      const marker = `Completed queue ${Date.now()}`;
      const alphaPrompt = `${marker} alpha`;
      const betaPrompt = `${marker} beta`;
      const alphaFollowUp = `${marker} alpha follow-up`;
      const allWork = page.getByRole("button", { name: /^All Work/ });
      const completedRow = (title: string) =>
        page
          .locator(".activity-inbox-row--completed")
          .filter({ hasText: title });
      const inProgressRow = (title: string) =>
        page
          .locator(".activity-inbox-row--inProgress")
          .filter({ hasText: title });
      const completedQueueTitles = () =>
        page
          .locator(".activity-inbox-row--completed .activity-inbox-row-title")
          .evaluateAll(
            (nodes, markerText) =>
              nodes
                .map((node) => node.textContent?.trim() ?? "")
                .filter((title) => title.includes(markerText)),
            marker,
          );
      const completedDateTime = async (title: string): Promise<number> => {
        const dateTime = await completedRow(title)
          .locator("time")
          .getAttribute("datetime");
        if (dateTime === null) throw new Error(`Missing time for ${title}.`);
        return Date.parse(dateTime);
      };

      await enterSessionDetail(page);
      await page.getByLabel("Prompt text").fill(alphaPrompt);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

      await allWork.click();
      await expectAllWorkLaunch(page);
      await enterSessionDetail(page);
      await page.getByLabel("Prompt text").fill(betaPrompt);
      await page.getByRole("button", { name: "Send" }).click();

      await allWork.click();
      await expectAllWorkLaunch(page);
      await expect(completedRow(alphaPrompt)).toHaveCount(1, {
        timeout: 10_000,
      });
      await expect(completedRow(betaPrompt)).toHaveCount(1, {
        timeout: 10_000,
      });
      await expect
        .poll(completedQueueTitles)
        .toEqual([alphaPrompt, betaPrompt]);
      await expect(completedRow(alphaPrompt)).toHaveAttribute(
        "aria-label",
        /Completed .+ View result\./,
      );
      const alphaCompletedAt = await completedDateTime(alphaPrompt);
      const betaCompletedAt = await completedDateTime(betaPrompt);
      expect(alphaCompletedAt).toBeLessThanOrEqual(betaCompletedAt);

      // Opening a completed result for review must not mutate its queue slot.
      await completedRow(betaPrompt).click();
      await expect(
        page.locator('.workspace[data-primary-view="session"]'),
      ).toBeVisible();
      await page.getByTestId("session-origin-back").click();
      await expectAllWorkLaunch(page);
      await expect
        .poll(completedQueueTitles)
        .toEqual([alphaPrompt, betaPrompt]);

      // Sending a follow-up removes alpha from Completed, then its new terminal
      // event gives it a fresh queue position behind beta.
      await completedRow(alphaPrompt).click();
      await page.getByLabel("Prompt text").fill(alphaFollowUp);
      await page.getByRole("button", { name: "Send" }).click();
      await allWork.click();
      await expectAllWorkLaunch(page);
      await expect(completedRow(alphaPrompt)).toHaveCount(0);
      await expect(inProgressRow(alphaPrompt)).toHaveCount(1);
      await expect(completedRow(betaPrompt)).toHaveCount(1);
      await expect(completedRow(alphaPrompt)).toHaveCount(1, {
        timeout: 10_000,
      });
      await expect
        .poll(completedQueueTitles)
        .toEqual([betaPrompt, alphaPrompt]);
      expect(await completedDateTime(alphaPrompt)).toBeGreaterThan(
        betaCompletedAt,
      );
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unified Work preserves Completed saved sessions across app relaunch", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-e2e-work-completed-relaunch-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const userDataDir = path.join(root, "user-data");
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });

    const env = fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      userDataDir,
      fakePiArgs: ["--stream-delay-ms", "80"],
    });
    let launched = await launchPiDeck(env);
    let app = launched.app;
    let page = launched.page;
    const marker = `Durable completed relaunch ${Date.now()}`;
    const alphaPrompt = `${marker} alpha`;
    const betaPrompt = `${marker} beta`;
    const prompts = [alphaPrompt, betaPrompt];
    const completedRow = (title: string) =>
      page.locator(".activity-inbox-row--completed").filter({ hasText: title });
    const completedQueueTitles = () =>
      page
        .locator(".activity-inbox-row--completed .activity-inbox-row-title")
        .evaluateAll(
          (nodes, markerText) =>
            nodes
              .map((node) => node.textContent?.trim() ?? "")
              .filter((title) => title.includes(markerText)),
          marker,
        );
    const completedDateTime = async (title: string): Promise<number> => {
      const dateTime = await completedRow(title)
        .locator("time")
        .getAttribute("datetime");
      if (dateTime === null)
        throw new Error(`Missing completed row timestamp for ${title}.`);
      return Date.parse(dateTime);
    };
    const persistedAssistantCreatedAts = (): Record<string, number> => {
      const sessionRoot = path.join(agentDir, "sessions", "--fake-rpc--");
      const files = fs
        .readdirSync(sessionRoot)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(sessionRoot, name));
      expect(files).toHaveLength(2);
      return Object.fromEntries(
        files.map((file) => {
          let title: string | undefined;
          let assistantCreatedAt: number | undefined;
          for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
            if (line.trim().length === 0) continue;
            const record = JSON.parse(line) as {
              message?: {
                role?: string;
                content?: unknown;
                createdAt?: number;
              };
            };
            if (
              record.message?.role === "user" &&
              typeof record.message.content === "string"
            ) {
              title = record.message.content;
            }
            if (
              record.message?.role === "assistant" &&
              typeof record.message.createdAt === "number"
            ) {
              assistantCreatedAt = record.message.createdAt;
            }
          }
          if (title === undefined || assistantCreatedAt === undefined) {
            throw new Error(`Missing durable completion metadata in ${file}.`);
          }
          return [title, assistantCreatedAt];
        }),
      );
    };

    try {
      await expectHealthyPreload(page);
      await expectAllWorkLaunch(page);
      for (const prompt of prompts) {
        await enterSessionDetail(page);
        await page.getByLabel("Prompt text").fill(prompt);
        await page.getByRole("button", { name: "Send" }).click();
        await page.getByRole("button", { name: /^All Work/ }).click();
        await expectAllWorkLaunch(page);
        await expect(completedRow(prompt)).toHaveCount(1, { timeout: 10_000 });
      }
      await expect.poll(completedQueueTitles).toEqual(prompts);
      const durableCompletedAts = persistedAssistantCreatedAts();
      for (const prompt of prompts) {
        expect(
          Math.abs(
            (await completedDateTime(prompt)) - durableCompletedAts[prompt]!,
          ),
        ).toBeLessThan(5_000);
      }
      expect(durableCompletedAts[alphaPrompt]!).toBeLessThanOrEqual(
        durableCompletedAts[betaPrompt]!,
      );

      await app.close();
      launched = await launchPiDeck(env);
      app = launched.app;
      page = launched.page;
      await expectHealthyPreload(page);
      await expectAllWorkLaunch(page);
      for (const prompt of prompts) {
        await expect(completedRow(prompt)).toHaveCount(1, { timeout: 10_000 });
        expect(await completedDateTime(prompt)).toBe(
          durableCompletedAts[prompt],
        );
      }
      await expect.poll(completedQueueTitles).toEqual(prompts);

      await completedRow(betaPrompt).click();
      await expect(
        page.locator('.workspace[data-primary-view="session"]'),
      ).toBeVisible();
      await page.getByTestId("session-origin-back").click();
      await expectAllWorkLaunch(page);
      await expect.poll(completedQueueTitles).toEqual(prompts);
      for (const prompt of prompts) {
        await expect(completedRow(prompt)).toHaveCount(1);
        expect(await completedDateTime(prompt)).toBe(
          durableCompletedAts[prompt],
        );
      }
    } finally {
      await app.close().catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unified Work shows Queued work and omits idle saved sessions from Work", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-e2e-work-queued-taxonomy-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const idleSessionFile = path.join(
      agentDir,
      "sessions",
      "--work-taxonomy--",
      "idle-saved-session.jsonl",
    );
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    writePiSessionFixture({
      sessionFile: idleSessionFile,
      sessionId: "idle-saved-session",
      projectCwd,
    });

    const { app, page } = await launchPiDeck(
      fakeRealModeEnv({
        root,
        projectCwd,
        agentDir,
        fakePiArgs: ["--stream-delay-ms", "20000"],
      }),
    );
    try {
      await expectHealthyPreload(page);
      await expectAllWorkLaunch(page);
      await page.evaluate(async (sessionFile) => {
        const active = await window.piDeck.workspaces.getActive();
        const workspace = active.activeWorkspace;
        if (workspace === undefined) {
          throw new Error("Expected an active workspace for taxonomy test.");
        }
        await window.piDeck.workspaces.addSession({
          workspaceId: workspace.id,
          sessionFile,
        });
      }, fs.realpathSync(idleSessionFile));
      await page.getByLabel("Refresh sessions").click();
      const inbox = page.locator(".activity-inbox");
      const statusFilters = inbox.getByRole("group", {
        name: "Filter Work by status",
      });

      await expect(
        page.getByRole("button", { name: "Session: idle-saved-session" }),
      ).toBeVisible();
      await expect(
        inbox.locator(".activity-inbox-row", {
          hasText: "idle-saved-session",
        }),
      ).toHaveCount(0);
      await expect(
        statusFilters.getByRole("button", { name: /^Queued/ }),
      ).toBeVisible();
      await expect(
        statusFilters.getByRole("button", { name: /^Pending/ }),
      ).toHaveCount(0);
      await expect(
        statusFilters.getByRole("button", { name: /^Idle/ }),
      ).toHaveCount(0);

      const queuedPrompt = "Work taxonomy queued parent";
      await enterSessionDetail(page);
      await page.getByLabel("Prompt text").fill(queuedPrompt);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page.getByRole("button", { name: "Follow-up" }),
      ).toBeVisible();
      await page
        .getByLabel("Prompt text")
        .fill("Run this after the current turn");
      await page.getByRole("button", { name: "Follow-up" }).click();
      await expect(
        page.getByText("Follow-up queued in Pi after current work."),
      ).toBeVisible();

      await page.getByRole("button", { name: /^All Work/ }).click();
      await expectAllWorkLaunch(page);
      const queuedRow = page
        .locator(".activity-inbox-row--queued")
        .filter({ hasText: queuedPrompt });
      await expect(queuedRow).toHaveCount(1);
      await expect(queuedRow).toContainText("Queued");
      await expect(queuedRow).toContainText("1 follow-up queued");
      await expect(queuedRow).toContainText("View queued work");
      await expect(
        inbox.locator(".activity-inbox-row", {
          hasText: "idle-saved-session",
        }),
      ).toHaveCount(0);
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unified Work retains scoped status filters through Session and Back", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-e2e-work-filter-state-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const userDataDir = path.join(root, "user-data");
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      `${JSON.stringify({ maxRunningSessions: 12 })}\n`,
    );
    const { app, page } = await launchPiDeck(
      fakeRealModeEnv({
        root,
        projectCwd,
        agentDir,
        userDataDir,
        fakePiArgs: [
          "--prompt-scenario",
          "extension-ui",
          "--extension-ui-auto-complete-timeout-ms",
          "120000",
        ],
      }),
    );
    try {
      await expectHealthyPreload(page);
      await expectAllWorkLaunch(page);
      await createWorkspaceInUi(page, "Filter state workspace");
      const workspaceId = await page
        .getByRole("button", { name: "Workspace: Filter state workspace" })
        .getAttribute("data-workspace-id");
      if (workspaceId === null) throw new Error("Missing filter workspace id.");

      await enterSessionDetail(page);
      const prompt = "filter state extension request";
      await page.getByLabel("Prompt text").fill(prompt);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page.getByText("Fake confirm", { exact: true }),
      ).toBeVisible();

      // All Work retains its Needs attention filter and restores the opened row.
      await page.getByRole("button", { name: /^All Work/ }).click();
      await expectAllWorkLaunch(page);
      const allNeedsAttention = page
        .getByRole("group", { name: "Filter Work by status" })
        .getByRole("button", { name: /^Needs attention/ });
      await allNeedsAttention.click();
      await expect(allNeedsAttention).toHaveAttribute("aria-pressed", "true");
      const allRow = page
        .locator(".activity-inbox-row")
        .filter({ hasText: prompt });
      await expect(allRow).toHaveCount(1);
      await allRow.click();
      await page.getByTestId("session-origin-back").click();
      await expectAllWorkLaunch(page);
      await expect(allNeedsAttention).toHaveAttribute("aria-pressed", "true");
      await expect(allRow).toBeFocused();

      // The workspace keeps an independent filter. Resolving the row changes
      // its category; Back retains Needs attention and falls back to the title.
      await selectWorkspaceInUi(page, "Filter state workspace");
      await expectWorkRoute(page, workspaceId);
      const workspaceRoute = page.locator(
        '.workspace[data-primary-view="work"]',
      );
      const workspaceInbox = workspaceRoute.locator(".activity-inbox");
      const workspaceNeedsAttention = workspaceInbox
        .getByRole("group", { name: "Filter Work by status" })
        .getByRole("button", { name: /^Needs attention/ });
      await expect(workspaceNeedsAttention).toHaveAttribute(
        "aria-pressed",
        "false",
      );

      // Keep enough matching rows in this scoped filter for a real, meaningful
      // mouse scroll before the opened row disappears from it.
      for (const filler of Array.from({ length: 8 }, (_, index) => index + 1)) {
        await enterSessionDetail(page);
        await page
          .getByLabel("Prompt text")
          .fill(`filter state scroll filler ${filler}`);
        await page.getByRole("button", { name: "Send" }).click();
        await expect(
          page.getByText("Fake confirm", { exact: true }),
        ).toBeVisible();
        await page.getByTestId("session-origin-back").click();
        await expectWorkRoute(page, workspaceId);
      }

      await workspaceNeedsAttention.click();
      await expect(workspaceNeedsAttention).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const workspaceRow = workspaceInbox
        .locator(".activity-inbox-row")
        .filter({ hasText: prompt });
      await expect(workspaceRow).toHaveCount(1);
      await expect(workspaceRow).toHaveClass(
        /activity-inbox-row--needsAttention/,
      );
      const activityItemId = await workspaceRow.getAttribute(
        "data-activity-item-id",
      );
      if (activityItemId === null) {
        throw new Error("Missing stable activity item identity.");
      }
      await workspaceInbox.hover();
      await page.mouse.wheel(0, 400);
      const savedFilteredScrollTop = await workspaceInbox.evaluate((element) =>
        Math.round(element.scrollTop),
      );
      expect(savedFilteredScrollTop).toBeGreaterThan(100);
      await workspaceRow.click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(
        page.getByText("Extension UI response delivered to Pi."),
      ).toBeVisible();
      await expect(
        page.getByText(`Fake response to: ${prompt}`, { exact: true }),
      ).toBeVisible();
      const completedSessionActions = page.getByRole("button", {
        name: "Session actions for filter state extension request",
      });
      await completedSessionActions.click();
      const completedActionsMenu = page.getByRole("menu", {
        name: "Session actions for filter state extension request",
      });
      await expect(
        completedActionsMenu.getByRole("menuitem", { name: "Archive session" }),
      ).toBeEnabled();
      await page.keyboard.press("Escape");
      await page.getByTestId("session-origin-back").click();
      await expectWorkRoute(page, workspaceId);
      await expect(workspaceNeedsAttention).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(workspaceRow).toHaveCount(0);
      const workspaceHeading = workspaceInbox.locator("#activity-inbox-title");
      await expect(workspaceHeading).toBeFocused();
      await expect
        .poll(() =>
          workspaceInbox.evaluate((element) => Math.round(element.scrollTop)),
        )
        .toBe(0);
      await expect
        .poll(() =>
          workspaceInbox.evaluate((inbox) => {
            const heading = inbox.querySelector("#activity-inbox-title");
            if (heading === null) return false;
            const inboxBounds = inbox.getBoundingClientRect();
            const headingBounds = heading.getBoundingClientRect();
            return (
              headingBounds.top >= inboxBounds.top &&
              headingBounds.bottom <= inboxBounds.bottom
            );
          }),
        )
        .toBe(true);

      const workspaceCompleted = workspaceInbox
        .getByRole("group", { name: "Filter Work by status" })
        .getByRole("button", { name: /^Completed/ });
      await workspaceCompleted.click();
      await expect(workspaceCompleted).toHaveAttribute("aria-pressed", "true");
      const completedRow = page.locator(
        `[data-activity-item-id=${JSON.stringify(activityItemId)}]`,
      );
      await expect(completedRow).toHaveCount(1);
      await expect(
        completedRow.locator(".activity-inbox-row-title"),
      ).toHaveText(prompt);
      await expect(completedRow).toHaveClass(/activity-inbox-row--completed/);
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unified Work keeps private task status out of Work while workflows coexist", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-e2e-unified-work-private-"),
    );
    const { app, page } = await launchPiDeck({
      PI_DECK_BACKEND: "fake",
      PI_DECK_FAKE_DELEGATE_SCENARIO: "1",
      PI_DECK_HOME: path.join(root, "pideck-home"),
      PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
    });
    try {
      await expectHealthyPreload(page);
      await expectAllWorkLaunch(page);
      await enterSessionDetail(page);
      const multitaskControl = page.locator(".multitask-control");
      await expect(multitaskControl).toHaveText("Parallel: Off");
      await multitaskControl.click();
      await selectPromptDestinationInUi(page, "parent");
      const privatePrompt = "Unified Work private task parent";
      await page.getByLabel("Prompt text").fill(privatePrompt);
      await page.getByRole("button", { name: "Send" }).click();
      const taskPanel = page.getByRole("region", {
        name: "Parallel task sessions",
      });
      await expect(
        taskPanel.locator('[data-lifecycle="completed"]'),
      ).toBeVisible();
      await multitaskControl.focus();
      const taskStatuses = page.getByRole("list", { name: "Task statuses" });
      await expect(taskStatuses).toContainText(
        "#1 Fake delegated task — completed",
      );
      await expect(
        page.getByLabel("Sessions").locator(".session-item", {
          hasText: "Fake delegated task",
        }),
      ).toHaveCount(0);

      await page.getByRole("button", { name: "Agent Workflows" }).click();
      await expect(
        page.locator('.workspace[data-primary-view="workflow"]'),
      ).toBeVisible();
      await page.getByRole("button", { name: /^All Work/ }).click();
      await expectAllWorkLaunch(page);
      await expect(
        page
          .locator(".activity-inbox-row")
          .filter({ hasText: "Fake delegated task" }),
      ).toHaveCount(0);
      const parentRow = page
        .locator(".activity-inbox-row")
        .filter({ hasText: privatePrompt });
      await expect(parentRow).toHaveCount(1);
      await parentRow.click();
      await expect(
        page.locator('.workspace[data-primary-view="session"]'),
      ).toBeVisible();
      await expect(
        page.getByLabel("Chat / Agent Timeline").getByText(privatePrompt, {
          exact: true,
        }),
      ).toBeVisible();
      await multitaskControl.focus();
      await expect(taskStatuses).toContainText(
        "#1 Fake delegated task — completed",
      );
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Deterministic fake-RPC coverage of the production task-session route. */
test.describe("task-session routing acceptance", () => {
  test("starts and advances a private task session while the parent turn is active", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-task-parent-active-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const userDataDir = path.join(root, "user-data");
    const traceFile = path.join(root, "fixture-trace.log");
    const fixture = path.join(root, "parent-active-plan.json");
    for (const directory of [projectCwd, agentDir, userDataDir])
      fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      JSON.stringify({ maxRunningSessions: 4 }),
    );
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        tasks: [{ name: "Independent task while parent is busy" }],
      }),
    );

    const parentArgs = [
      "--prompt-scenario",
      "routing",
      "--task-routing-fixture",
      fixture,
      "--fixture-trace-file",
      traceFile,
      "--stream-delay-ms",
      "3000",
      "--fail-task-prompt-record-while-active",
    ];
    const fakePiBinary = createFakePiBinary(root, parentArgs);
    const { app, page } = await launchPiDeck({
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: fakePiBinary,
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DECK_HOME: path.join(root, "pideck-home"),
      PI_DECK_USER_DATA_DIR: userDataDir,
      NODE_ENV: "test",
      PI_DECK_E2E_TASK_SESSION_ACCEPTANCE: "1",
      PI_DECK_TEST_TASK_ROUTING_FIXTURE: fixture,
    });
    try {
      await expectHealthyPreload(page);
      await enterSessionDetail(page);
      await page.evaluate(() =>
        window.piDeck.settings.update({ maxRunningSessions: 4 }),
      );
      await page
        .getByRole("button", { name: "Parallel multitasking: Off" })
        .click();
      const destination = page.getByLabel("Prompt destination");
      await expect(destination).toHaveValue("newTaskSession");

      await page.evaluate(() => {
        const w = window as typeof window & {
          __parentActiveTaskStates?: Array<{
            tasks: Array<{ lifecycle: string }>;
          }>;
          __stopParentActiveTaskStates?: () => void;
        };
        w.__stopParentActiveTaskStates?.();
        w.__parentActiveTaskStates = [];
        w.__stopParentActiveTaskStates = window.piDeck.multitask.onState(
          (state) => w.__parentActiveTaskStates?.push(state),
        );
      });

      await destination.selectOption("parent");
      await page
        .getByLabel("Prompt text")
        .fill("Keep the parent turn active while starting private work.");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
      await expect(page.getByText(/Working in Pi RPC backend/)).toBeVisible();
      await expect(destination).toHaveValue("newTaskSession");

      await page
        .getByLabel("Prompt text")
        .fill("Start independent private work while the parent is active.");
      await page.getByRole("button", { name: "Plan task" }).click();

      const panel = page.getByRole("region", {
        name: "Parallel task sessions",
      });
      await expect(panel.getByRole("listitem")).toHaveCount(1, {
        timeout: 8_000,
      });
      await expect(panel.getByRole("listitem").first()).toContainText(
        "Independent task while parent is busy",
      );
      await expect
        .poll(() =>
          page.evaluate(() => {
            const states =
              (
                window as typeof window & {
                  __parentActiveTaskStates?: Array<{
                    tasks: Array<{ lifecycle: string }>;
                  }>;
                }
              ).__parentActiveTaskStates ?? [];
            return states.flatMap((state) =>
              state.tasks.map((task) => task.lifecycle),
            );
          }),
        )
        .toEqual(expect.arrayContaining(["queued", "running", "completed"]));
      await expect
        .poll(
          () =>
            fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "",
          { timeout: 25_000 },
        )
        .toContain("task_session_prompt_recorded");
      expect(
        fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "",
      ).not.toContain("task_session_prompt_record_rejected_while_active");
      await expect(page.getByText(/Working in Pi RPC backend/)).toHaveCount(0, {
        timeout: 10_000,
      });
    } finally {
      await page.evaluate(() => {
        const w = window as typeof window & {
          __stopParentActiveTaskStates?: () => void;
        };
        w.__stopParentActiveTaskStates?.();
      });
      await app.close().catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("routes a 12-task plan through the flat parent projection", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-task-routing-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const traceFile = path.join(root, "fixture-trace.log");
    const routingFixture = path.join(
      repoRoot,
      "e2e/fixtures/task-routing-contract.json",
    );
    const userDataDir = path.join(root, "user-data");
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    // The adapter snapshots this setting during startup, so persist it before
    // launch as well as exercising the settings IPC before submitting a plan.
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      JSON.stringify({ maxRunningSessions: 20 }),
    );
    const { app, page } = await launchPiDeck({
      ...fakeRealModeEnv({
        root,
        projectCwd,
        agentDir,
        userDataDir,
        fakePiArgs: [
          "--prompt-scenario",
          "routing",
          "--task-routing-fixture",
          routingFixture,
          "--fixture-trace-file",
          traceFile,
          "--stream-delay-ms",
          "500",
        ],
      }),
      NODE_ENV: "test",
      PI_DECK_E2E_TASK_SESSION_ACCEPTANCE: "1",
      PI_DECK_TEST_TASK_ROUTING_FIXTURE: routingFixture,
    });
    try {
      await expectHealthyPreload(page);
      await enterSessionDetail(page);
      // Leave room for the parent plus all ten active child workers.
      await page.evaluate(() =>
        window.piDeck.settings.update({ maxRunningSessions: 20 }),
      );
      const parallel = page.getByRole("button", {
        name: "Parallel multitasking: Off",
      });
      await parallel.click();
      const destination = page.getByLabel("Prompt destination");
      await expect(destination).toHaveValue("newTaskSession");

      await page.evaluate(() => {
        const w = window as typeof window & {
          __taskStates?: unknown[];
          __stopTaskStates?: () => void;
        };
        w.__stopTaskStates?.();
        w.__taskStates = [];
        w.__stopTaskStates = window.piDeck.multitask.onState((state) =>
          w.__taskStates?.push(state),
        );
      });
      // The parent override is deliberately one prompt only.
      await destination.selectOption("parent");
      await page.getByLabel("Prompt text").fill("Only this stays in parent.");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page.getByText(/Ordinary routing fixture accepted/),
      ).toBeVisible();
      await expect(destination).toHaveValue("newTaskSession");

      await page
        .getByLabel("Prompt text")
        .fill(
          "Prepare the release: inspect, implement, test, and document it.",
        );
      await page.getByRole("button", { name: "Send" }).click();
      const panel = page.getByRole("region", {
        name: "Parallel task sessions",
      });
      const rows = panel.getByRole("listitem");
      await expect(rows).toHaveCount(12);
      await expect(rows.nth(0)).toContainText("#1 Inventory affected files");
      await expect(rows.nth(0)).toContainText("Attempt 1");
      await expect(rows.nth(10)).toContainText("#11 Queued eleventh task");
      await expect(rows.nth(11)).toContainText("#12 Queued twelfth task");
      await expect(rows.nth(0)).toContainText(
        "Complete Inventory affected files",
      );
      await expect(rows.nth(0).getByRole("button")).toHaveCount(0);
      await expect(rows.nth(0).locator("[data-lifecycle]")).toHaveText(
        /^(queued|starting|running|completed)$/,
      );
      await expect(rows.nth(0)).toContainText(/Attempt 1 · \d+s/);
      // Mode changes affect future routing only; active task visibility remains.
      await page
        .getByRole("button", { name: "Parallel multitasking: On" })
        .click();
      await expect(panel).toBeVisible();
      await page
        .getByRole("button", { name: "Parallel multitasking: Off" })
        .click();
      await expect(destination).toHaveValue("newTaskSession");

      await expect
        .poll(() =>
          page.evaluate(() => {
            const states =
              (
                window as typeof window & {
                  __taskStates?: Array<{
                    activeCount: number;
                    tasks: Array<{ lifecycle: string }>;
                  }>;
                }
              ).__taskStates ?? [];
            return states.some(
              (state) =>
                state.activeCount === 10 &&
                state.tasks.filter((task) => task.lifecycle === "queued")
                  .length >= 2,
            );
          }),
        )
        .toBe(true);
      // The task-origin request is recorded on the parent, whose composer
      // remains usable while private work is active.
      await expect(
        page
          .getByLabel("Chat / Agent Timeline")
          .getByText(
            "Prepare the release: inspect, implement, test, and document it.",
            { exact: true },
          ),
      ).toBeVisible();
      await expect(page.getByLabel("Prompt text")).toBeEnabled();
      await destination.selectOption("parent");
      await page.getByLabel("Prompt text").fill("Add rollback guidance.");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page
          .getByLabel("Chat / Agent Timeline")
          .getByText("Add rollback guidance.", { exact: true }),
      ).toBeVisible();
      await expect(destination).toHaveValue("newTaskSession");
      await expect(
        page
          .getByLabel("Sessions")
          .locator(".session-item", { hasText: "Inventory affected files" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "All Work", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /^All Work/ }),
      ).toBeVisible();

      // The configured failure retries three times after its initial attempt.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const states =
                (
                  window as typeof window & {
                    __taskStates?: Array<{
                      tasks: Array<{
                        taskNumber: number;
                        lifecycle: string;
                        attempt: number;
                      }>;
                    }>;
                  }
                ).__taskStates ?? [];
              const seen = states.flatMap((state) =>
                state.tasks
                  .filter((task) => task.taskNumber === 3)
                  .map((task) => `${task.lifecycle}:${task.attempt}`),
              );
              return {
                retried: [1, 2, 3].every((attempt) =>
                  seen.includes(`retrying:${attempt}`),
                ),
                failedAtFour: seen.includes("failed:4"),
              };
            }),
          { timeout: 30_000 },
        )
        .toEqual({ retried: true, failedAtFour: true });

      // The parent receives every successful handoff and the attempt-4 failure.
      const synthesizedReport = page
        .getByLabel("Chat / Agent Timeline")
        .locator(".assistant-message")
        .last();
      await expect(synthesizedReport).toContainText(
        "#1 Inventory affected files: Ordinary routing fixture accepted",
        { timeout: 30_000 },
      );
      await expect(synthesizedReport).toContainText(
        "#3 Verify regression coverage: Configured task failure on attempt 4.",
      );
      // Rows are transient and clear only after that parent report completes.
      await expect(panel).toHaveCount(0, { timeout: 30_000 });
      expect(fs.readFileSync(traceFile, "utf8")).toContain("ordinary_prompt");
      expect(fs.readFileSync(traceFile, "utf8")).not.toContain("deck_delegate");
    } finally {
      await page.evaluate(() => {
        const w = window as typeof window & { __stopTaskStates?: () => void };
        w.__stopTaskStates?.();
      });
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("materializes task attachments once without persisting private payloads", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-task-attachment-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const userDataDir = path.join(root, "user-data");
    const traceFile = path.join(root, "fixture-trace.log");
    const fixture = path.join(root, "attachment-plan.json");
    for (const directory of [projectCwd, agentDir, userDataDir])
      fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        tasks: [{ name: "Inspect supplied image", lifecycle: "interrupted" }],
      }),
    );
    const { app, page } = await launchPiDeck({
      ...fakeRealModeEnv({
        root,
        projectCwd,
        agentDir,
        userDataDir,
        fakePiArgs: [
          "--prompt-scenario",
          "routing",
          "--fixture-trace-file",
          traceFile,
          "--stream-delay-ms",
          "50",
        ],
      }),
      NODE_ENV: "test",
      PI_DECK_E2E_TASK_SESSION_ACCEPTANCE: "1",
      PI_DECK_TEST_TASK_ROUTING_FIXTURE: fixture,
    });
    try {
      await expectHealthyPreload(page);
      await enterSessionDetail(page);
      await page.getByLabel("Prompt text").fill("Create the parent runtime.");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page.getByText(/Ordinary routing fixture accepted/),
      ).toBeVisible();
      const result = await page.evaluate(async (dataBase64) => {
        const snapshot = await window.piDeck.chat.getSnapshot();
        const runtimeId = snapshot.runtimeId;
        await window.piDeck.multitask.updateMode({
          runtimeId,
          mode: "parallel",
        });
        const ownerId = "task-attachment-owner";
        const imported = await window.piDeck.attachments.importImages({
          ownerId,
          sessionId: runtimeId,
          images: [
            {
              fileName: "task.png",
              mimeType: "image/png",
              size: 24,
              dataBase64,
            },
          ],
        });
        if (!imported.selected) throw new Error("Image import was cancelled.");
        const token = imported.attachments[0]!.selectedPathToken;
        await window.piDeck.chat.prompt({
          runtimeId,
          text: "Inspect the supplied image privately.",
          destination: "newTaskSession",
          attachmentOwnerId: ownerId,
          attachments: [{ selectedPathToken: token, sendMode: "imageInput" }],
        });
        let reusedError = "";
        try {
          await window.piDeck.chat.prompt({
            runtimeId,
            text: "Try to reuse the consumed image.",
            destination: "newTaskSession",
            attachmentOwnerId: ownerId,
            attachments: [{ selectedPathToken: token, sendMode: "imageInput" }],
          });
        } catch (error) {
          reusedError = error instanceof Error ? error.message : String(error);
        }
        return { runtimeId, reusedError, token };
      }, tinyPngBase64());
      expect(result.reusedError).toMatch(/no longer available|reselect/i);
      await expect
        .poll(() =>
          page.evaluate(
            async (runtimeId) =>
              (await window.piDeck.multitask.getMode({ runtimeId })).tasks[0]
                ?.lifecycle,
            result.runtimeId,
          ),
        )
        .toBe("running");
      await expect
        .poll(() =>
          fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "",
        )
        .toContain("prompt_images:1");
      const statePath = path.join(userDataDir, "task-session-state.json");
      await expect
        .poll(() =>
          fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "",
        )
        .toContain('"lifecycle":"running"');
      const persisted = fs.readFileSync(statePath, "utf8");
      expect(persisted).not.toContain(result.token);
      expect(persisted).not.toContain(tinyPngBase64());
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("restart preserves interrupted trace without resuming private work", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-deck-task-restart-"),
    );
    const projectCwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const traceFile = path.join(root, "restart-trace.log");
    const fixture = path.join(root, "interrupted-plan.json");
    for (const directory of [projectCwd, agentDir])
      fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        tasks: [
          {
            name: "Long private task",
            lifecycle: "interrupted",
          },
        ],
      }),
    );
    const env = {
      ...fakeRealModeEnv({
        root,
        projectCwd,
        agentDir,
        fakePiArgs: [
          "--prompt-scenario",
          "routing",
          "--fixture-trace-file",
          traceFile,
          "--stream-delay-ms",
          "250",
        ],
      }),
      NODE_ENV: "test",
      PI_DECK_E2E_TASK_SESSION_ACCEPTANCE: "1",
      PI_DECK_TEST_TASK_ROUTING_FIXTURE: fixture,
    };

    let privatePromptCountBeforeRestart = 0;
    const first = await launchPiDeck(env);
    try {
      await expectHealthyPreload(first.page);
      await enterSessionDetail(first.page);
      await first.page
        .getByRole("button", { name: "Parallel multitasking: Off" })
        .click();
      await first.page
        .getByLabel("Prompt text")
        .fill("Start work that will be interrupted by restart.");
      await first.page.getByRole("button", { name: "Send" }).click();
      const row = first.page
        .getByRole("region", { name: "Parallel task sessions" })
        .getByRole("listitem");
      await expect(row).toContainText("#1 Long private task");
      await expect(row.locator('[data-lifecycle="running"]')).toBeVisible();
      await expect
        .poll(() =>
          fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "",
        )
        .toContain("ordinary_prompt");
      privatePromptCountBeforeRestart =
        fs.readFileSync(traceFile, "utf8").split("ordinary_prompt").length - 1;
    } finally {
      await first.app.close();
    }

    const second = await launchPiDeck(env);
    try {
      await expectHealthyPreload(second.page);
      await expectAllWorkLaunch(second.page);
      await expect(
        second.page.locator(".activity-inbox-row").filter({
          hasText: "Start work that will be interrupted by restart.",
        }),
      ).toHaveCount(0);
      const savedSession = second.page.getByRole("button", {
        name: "Session: Start work that will be interrupted by restart.",
      });
      await expect(savedSession).toBeVisible();
      await savedSession.click();
      await expect(second.page.locator(".multitask-control")).toBeEnabled({
        timeout: 30_000,
      });
      const panel = second.page.getByRole("region", {
        name: "Parallel task sessions",
      });
      const interrupted = panel.getByRole("listitem");
      await expect(interrupted).toContainText("#1 Long private task");
      await expect(
        interrupted.locator('[data-lifecycle="interrupted"]'),
      ).toBeVisible();
      await expect(interrupted).toContainText("Attempt 1");
      await expect(panel.getByText("0 active of 10")).toBeVisible();
      const runtimeState = await second.page.evaluate(async () => {
        const snapshot = await window.piDeck.chat.getSnapshot();
        return window.piDeck.multitask.getMode({
          runtimeId: snapshot.runtimeId,
        });
      });
      expect(runtimeState.tasks).toEqual([
        expect.objectContaining({
          taskNumber: 1,
          lifecycle: "interrupted",
          attempt: 1,
        }),
      ]);
      expect(runtimeState.activeCount).toBe(0);
      await second.page.waitForTimeout(500);
      const privatePromptCountAfterRestart = fs.existsSync(traceFile)
        ? fs.readFileSync(traceFile, "utf8").split("ordinary_prompt").length - 1
        : 0;
      expect(privatePromptCountAfterRestart).toBe(
        privatePromptCountBeforeRestart,
      );
    } finally {
      await second.app.close();
      if (process.env.PI_DECK_E2E_KEEP_REAL_SMOKE_ARTIFACTS !== "1")
        fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
