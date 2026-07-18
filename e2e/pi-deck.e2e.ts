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

function createFakePiBinary(root: string, extraArgs: string[] = []): string {
  const fakePiPath = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    fakePiPath,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) {\n  console.log("v42.5.0");\n  process.exit(0);\n}\nprocess.argv.push(...${JSON.stringify(extraArgs)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
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
  };
}

async function expectHealthyPreload(page: Page): Promise<void> {
  await expect(page.getByText("Preload error")).toHaveCount(0);
  await expect(page.getByText(/secure renderer/i)).toBeVisible();
}

test("fake mode launches with backend runtime and send enabled", async () => {
  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "fake",
  });
  try {
    await expectHealthyPreload(page);
    await expect(page.getByText(/Local demo mode active/i)).toBeVisible();
    await expect(page.getByLabel("Recent projects")).toContainText(
      "Deleted project",
    );
    await page.getByLabel("Prompt text").fill("fake e2e prompt");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
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
    await page.getByLabel("Prompt text").fill("confirm extension request");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Fake confirm", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Approve fake extension UI request?"),
    ).toBeVisible();

    // A waiting worker remains in the sidebar after the user moves elsewhere;
    // receiving extension input never steals foreground selection.
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
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
    await expect(page.getByRole("button", { name: "Yes" })).toBeVisible();
    await page.getByRole("button", { name: "Yes" }).click();
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

test("bootstrap creates no worker and the first draft send creates one", async () => {
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
    // fakeRpc writes its session record synchronously when a worker starts.
    // Waiting through the background repository refresh proves bootstrap did
    // not create an eager empty worker or persisted session.
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
    await expect(
      page
        .getByLabel("Sessions")
        .getByText("Untitled new session", { exact: true }),
    ).toHaveCount(0);

    await page.getByLabel("Prompt text").fill("lazy first prompt");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Fake response").first()).toBeVisible();
    expect(fs.existsSync(fakeSessionRoot)).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closing an attached runtime preserves its saved session for recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-close-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await page.getByLabel("Prompt text").fill("close runtime recovery");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: close runtime recovery/),
    ).toBeVisible();

    const sessionRow = page.getByRole("button", {
      name: /Session: close runtime recovery/,
    });
    const closeRuntime = page.getByRole("button", {
      name: /Close runtime for close runtime recovery/,
    });
    await sessionRow.focus();
    await page.keyboard.press("Tab");
    await expect(closeRuntime).toBeFocused();
    await expect(closeRuntime).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(
      page.getByText(/Closed the Pi runtime. The saved session can be resumed/),
    ).toBeVisible();
    await expect(page.getByText("Saved · click to resume")).toBeVisible();
    await page
      .getByRole("button", { name: /Session: close runtime recovery/ })
      .click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();
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
    const sessionRow = page.getByRole("button", {
      name: "Session: keyboard-delete",
    });
    const deleteSession = page.getByRole("button", {
      name: "Delete keyboard-delete",
    });
    await expect(sessionRow).toBeVisible();

    await sessionRow.focus();
    await page.keyboard.press("Tab");
    await expect(deleteSession).toBeFocused();
    await expect(deleteSession).toHaveCSS("opacity", "1");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.keyboard.press("Enter");

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
    await expect(page.getByText(/Browse \d+ older sessions/)).toBeVisible();
    await expect(
      page.getByText("Saved · click to resume").first(),
    ).toBeVisible();
    await page.getByText("Saved · click to resume").first().click();
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
    await page.getByLabel("Prompt text").fill("attention stays visible");
    await page.getByRole("button", { name: "Send" }).click();
    const sidebar = page.getByLabel("Sessions");
    await expect(
      sidebar.getByRole("button", { name: "Session: attention stays visible" }),
    ).toBeVisible();
    await expect(sidebar.getByText("Steer 1")).toBeVisible();
    await expect(sidebar.getByText("Follow-up 2")).toBeVisible();
    await expect(
      sidebar.getByText(/Needs input 0 · Errors 0 · Working 1/),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: /Browse 2 older sessions/ }),
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
    await expect(page.getByText("Saved · click to resume")).toBeVisible();
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
    await expect(page.getByText("Saved · click to resume")).toBeVisible();
    fs.rmSync(sessionFile, { force: true });
    await page.getByText("Saved · click to resume").click();
    await expect(
      page.getByText(
        "Saved session file is missing or unreadable. Removed it from the list.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Saved · click to resume")).toHaveCount(0);
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

  const firstLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(firstLaunch.page);
    await firstLaunch.page
      .getByLabel("Prompt text")
      .fill("persisted restart session");
    await firstLaunch.page.getByRole("button", { name: "Send" }).click();
    await expect(
      firstLaunch.page.getByText(/Fake response to: persisted restart session/),
    ).toBeVisible();
  } finally {
    await firstLaunch.app.close();
  }

  const secondLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(secondLaunch.page);
    await expect(
      secondLaunch.page.getByText("Saved · click to resume").first(),
    ).toBeVisible();
    await secondLaunch.page
      .getByText("Saved · click to resume")
      .first()
      .click();
    await expect(
      secondLaunch.page.getByText("Resumed saved Pi session."),
    ).toBeVisible();
  } finally {
    await secondLaunch.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background worker continues through project A → B navigation and return", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-project-resume-"),
  );
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const canonicalProjectA = fs.realpathSync(projectA);
  const canonicalProjectB = fs.realpathSync(projectB);

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd: projectA,
      agentDir,
      testPickProjectCwds: [projectB],
      fakePiArgs: ["--stream-delay-ms", "500"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await page
      .getByLabel("Prompt text")
      .fill("project switch background worker");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

    await page.getByRole("button", { name: /Open project/i }).click();
    await expect(
      page.getByRole("heading", { name: /project-b/ }),
    ).toBeVisible();
    await expect(page.getByLabel("Active work across projects")).toContainText(
      "project switch background worker",
    );
    await expect(
      page.getByText(
        /No Pi worker was closed; 1 background active work item remains/,
      ),
    ).toBeVisible();

    const recentProjectSwitcher = page.getByLabel("Switch recent project");
    await expect(recentProjectSwitcher).toHaveValue(canonicalProjectB);
    await expect(recentProjectSwitcher.locator("option")).toHaveCount(2);
    await recentProjectSwitcher.selectOption(canonicalProjectA);
    await expect(
      page.getByRole("heading", { name: /project-a/ }),
    ).toBeVisible();
    await expect(
      page.getByText(/Fake response to: project switch background worker/),
    ).toBeVisible({ timeout: 8_000 });
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode project picker handoff persists selected cwd with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-project-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const firstLaunch = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd: projectA,
      agentDir,
      userDataDir,
      testPickProjectCwd: projectB,
    }),
  );
  try {
    await expectHealthyPreload(firstLaunch.page);
    await expect(
      firstLaunch.page.getByRole("heading", { name: /project-a/ }),
    ).toBeVisible();
    await firstLaunch.page
      .getByRole("button", { name: /Open project/i })
      .click();
    await expect(
      firstLaunch.page.getByText(/Project view switched to project-b/),
    ).toBeVisible();
    await expect(
      firstLaunch.page.getByRole("heading", { name: /project-b/ }),
    ).toBeVisible();
  } finally {
    await firstLaunch.app.close();
  }

  const secondLaunch = await launchPiDeck(
    fakeRealModeEnv({ root, agentDir, userDataDir }),
  );
  try {
    await expectHealthyPreload(secondLaunch.page);
    await expect(
      secondLaunch.page.getByRole("heading", { name: /project-b/ }),
    ).toBeVisible();
    await expect(
      secondLaunch.page.getByRole("heading", { name: /project-a/ }),
    ).toHaveCount(0);
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
    await page.getByLabel("Prompt text").fill("trigger usage limit");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("Usage limit reached for fake provider.").first(),
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
    await page.getByLabel("Prompt text").fill("background route one");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.locator(".session-item", { hasText: "background route one" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "New session" }).click();
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
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Prompt text").fill("start draft session");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: start draft session/),
    ).toBeVisible();
    await page.getByLabel("Prompt text").fill("/");
    await expect(page.getByText("/fake-worker-command")).toBeVisible();
    await page.getByText("/fake-worker-command").click();
    await expect(page.getByLabel("Prompt text")).toHaveValue(
      "/fake-worker-command ",
    );
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
    await expect(page.getByText(/Sessions in project/i)).toBeVisible();
    await expect(page.getByText(/Real Pi mode active/i)).toBeVisible();
    await expect(page.getByText("Local projects")).toHaveCount(0);
    await expect(page.getByText(/backend fake RPC active/i)).toHaveCount(0);
    await expect(page.getByText(/claude/i)).toHaveCount(0);
    await expect(page.getByLabel("Real Pi thinking")).toBeVisible();
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
