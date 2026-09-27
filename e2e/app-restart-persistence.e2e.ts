import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  fakeArgsFile: string;
  pidFile: string;
  projectCwd: string;
  agentDir: string;
  userDataDir: string;
  piDeckHome: string;
}

interface SessionSummary {
  sessionFile: string;
  title: string;
  messageCount: number;
  preview?: string;
  attachedRuntimeId?: string;
}

function createFakePiWrapper(
  root: string,
  fakeArgsFile: string,
  pidFile: string,
): string {
  const binary = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    binary,
    `#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\ntry { fs.appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n"); } catch {}\nlet extraArgs = [];\ntry { extraArgs = JSON.parse(fs.readFileSync(${JSON.stringify(fakeArgsFile)}, "utf8")); } catch {}\nprocess.argv.push(...extraArgs);\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return binary;
}

function writeSettingsIfMissing(userDataDir: string): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  const settingsPath = path.join(userDataDir, "settings.json");
  if (fs.existsSync(settingsPath)) return;
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        theme: "system",
        maxRunningSessions: 4,
        warmWorkerLimit: 1,
        enableLoginShellEnvCapture: false,
      },
      null,
      2,
    )}\n`,
  );
}

function createFixture(name: string, fakeArgs: string[]): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-deck-${name}-`));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const piDeckHome = path.join(root, "pideck-home");
  const fakeArgsFile = path.join(root, "fake-args.json");
  const pidFile = path.join(root, "fake-pids.txt");
  for (const directory of [projectCwd, agentDir, userDataDir, piDeckHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  writeSettingsIfMissing(userDataDir);
  fs.writeFileSync(fakeArgsFile, `${JSON.stringify(fakeArgs)}\n`);

  return {
    root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: path.join(root, "home"),
      TMPDIR: os.tmpdir(),
      PI_DECK_E2E_TEST: "1",
      // Never surface or focus a native window, even in a headed test shell.
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: createFakePiWrapper(root, fakeArgsFile, pidFile),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DECK_HOME: piDeckHome,
      PI_DECK_USER_DATA_DIR: userDataDir,
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    },
    fakeArgsFile,
    pidFile,
    projectCwd,
    agentDir,
    userDataDir,
    piDeckHome,
  };
}

function setFakeArgs(fixture: Fixture, fakeArgs: string[]): void {
  fs.writeFileSync(fixture.fakeArgsFile, `${JSON.stringify(fakeArgs)}\n`);
}

async function launchPiDeck(env: NodeJS.ProcessEnv): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    await expect(page.getByText("Preload error")).toHaveCount(0);
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

async function createNamedWorkspace(page: Page, name: string): Promise<string> {
  return page.evaluate(async (workspaceName) => {
    const projects = await window.piDeck.projects.getActive();
    const defaultProjectId = projects.activeProject?.id;
    if (defaultProjectId === undefined)
      throw new Error("Missing active project");
    const created = await window.piDeck.workspaces.create({
      name: workspaceName,
      defaultProjectId,
    });
    if (created.activeWorkspace?.id === undefined) {
      throw new Error("Named workspace was not activated");
    }
    return created.activeWorkspace.id;
  }, name);
}

async function startWorkspaceSession(
  page: Page,
  workspaceId: string,
): Promise<string> {
  return page.evaluate(async (targetWorkspaceId) => {
    const snapshot = await window.piDeck.chat.createSession({
      workspaceId: targetWorkspaceId,
    });
    return snapshot.runtimeId;
  }, workspaceId);
}

async function sendPrompt(
  page: Page,
  runtimeId: string,
  prompt: string,
): Promise<void> {
  await page.evaluate(
    async ({ targetRuntimeId, text }) => {
      await window.piDeck.chat.prompt({ runtimeId: targetRuntimeId, text });
    },
    { targetRuntimeId: runtimeId, text: prompt },
  );
}

async function waitForTranscriptText(
  page: Page,
  runtimeId: string,
  expectedText: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await page.evaluate(async (targetRuntimeId) => {
        const result = await window.piDeck.chat.getSnapshot({
          runtimeId: targetRuntimeId,
        });
        return result.messages.map((message) => ({
          role: message.role,
          content: message.content,
        }));
      }, runtimeId);
      return snapshot.map(messageText);
    })
    .toContain(expectedText);
}

async function activeWorkspace(
  page: Page,
): Promise<{ id?: string; name?: string }> {
  return page.evaluate(async () => {
    const result = await window.piDeck.workspaces.getActive();
    return {
      id: result.activeWorkspace?.id,
      name: result.activeWorkspace?.name,
    };
  });
}

async function listSessions(
  page: Page,
  workspaceId: string,
): Promise<SessionSummary[]> {
  return page.evaluate(async (targetWorkspaceId) => {
    const result = await window.piDeck.chat.listSessions({
      workspaceId: targetWorkspaceId,
    });
    return result.sessions.map((session) => ({
      sessionFile: session.sessionFile,
      title: session.title,
      messageCount: session.messageCount,
      preview: session.preview,
      attachedRuntimeId: session.attachedRuntimeId,
    }));
  }, workspaceId);
}

async function waitForSessionSummary(
  page: Page,
  workspaceId: string,
  title: string,
): Promise<SessionSummary> {
  return expect
    .poll(async () => {
      const sessions = await listSessions(page, workspaceId);
      return sessions.find((session) => session.title === title);
    })
    .toMatchObject({ title })
    .then(async () => {
      const sessions = await listSessions(page, workspaceId);
      const session = sessions.find((candidate) => candidate.title === title);
      if (session === undefined) throw new Error(`Missing session ${title}`);
      return session;
    });
}

function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

async function resumeSession(
  page: Page,
  workspaceId: string,
  sessionFile: string,
) {
  return page.evaluate(
    async ({ targetWorkspaceId, targetSessionFile }) => {
      const snapshot = await window.piDeck.chat.resumeSession({
        workspaceId: targetWorkspaceId,
        sessionFile: targetSessionFile,
      });
      const status = await window.piDeck.chat.getRuntimeStatus({
        runtimeId: snapshot.runtimeId,
      });
      return {
        runtimeId: snapshot.runtimeId,
        workspaceId: snapshot.workspaceId,
        isAgentActive: status.state.isAgentActive,
        messages: snapshot.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
    },
    { targetWorkspaceId: workspaceId, targetSessionFile: sessionFile },
  );
}

async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  await app?.close().catch(() => undefined);
}

function cleanupFixture(fixture: Fixture): void {
  if (fs.existsSync(fixture.pidFile)) {
    for (const line of fs
      .readFileSync(fixture.pidFile, "utf8")
      .split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Worker already exited.
        }
      }
    }
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

async function attachInterruptedRepresentation(
  testInfo: TestInfo,
  sessionFile: string,
): Promise<void> {
  const lines = fs.existsSync(sessionFile)
    ? fs
        .readFileSync(sessionFile, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
    : [];
  const records = lines.map((line) => {
    try {
      const record = JSON.parse(line) as {
        type?: unknown;
        message?: { role?: unknown; content?: unknown };
      };
      return {
        type: record.type,
        role: record.message?.role,
        content: record.message?.content,
      };
    } catch {
      return { malformed: line };
    }
  });
  await testInfo.attach("interrupted-session-representation.json", {
    body: JSON.stringify(records, null, 2),
    contentType: "application/json",
  });
}

test("completed ordinary chat in a named workspace survives normal quit and relaunch", async () => {
  const fixture = createFixture("restart-completed", [
    "--stream-delay-ms",
    "1",
  ]);
  const workspaceName = "Restart persistence workspace";
  const firstPrompt = "completed restart persistence turn";
  const secondPrompt = "second restart persistence turn";
  let firstApp: ElectronApplication | undefined;
  let secondApp: ElectronApplication | undefined;
  try {
    const firstLaunch = await launchPiDeck(fixture.env);
    firstApp = firstLaunch.app;
    const page = firstLaunch.page;
    const workspaceId = await createNamedWorkspace(page, workspaceName);
    const firstRuntimeId = await startWorkspaceSession(page, workspaceId);
    await sendPrompt(page, firstRuntimeId, firstPrompt);
    await waitForTranscriptText(
      page,
      firstRuntimeId,
      `Fake response to: ${firstPrompt}`,
    );
    const firstSummary = await waitForSessionSummary(
      page,
      workspaceId,
      firstPrompt,
    );
    expect(firstSummary).toMatchObject({
      messageCount: 2,
      preview: `Fake response to: ${firstPrompt}`,
    });
    await firstApp.close();
    firstApp = undefined;

    const secondLaunch = await launchPiDeck(fixture.env);
    secondApp = secondLaunch.app;
    const relaunched = secondLaunch.page;
    await expect(activeWorkspace(relaunched)).resolves.toEqual({
      id: workspaceId,
      name: workspaceName,
    });
    const persistedSummary = await waitForSessionSummary(
      relaunched,
      workspaceId,
      firstPrompt,
    );
    expect(persistedSummary).toMatchObject({
      sessionFile: firstSummary.sessionFile,
      title: firstPrompt,
      messageCount: 2,
      preview: `Fake response to: ${firstPrompt}`,
      attachedRuntimeId: undefined,
    });

    const resumed = await resumeSession(
      relaunched,
      workspaceId,
      persistedSummary.sessionFile,
    );
    expect(resumed.workspaceId).toBe(workspaceId);
    expect(resumed.isAgentActive).toBe(false);
    expect(resumed.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(resumed.messages.map(messageText)).toEqual([
      firstPrompt,
      `Fake response to: ${firstPrompt}`,
    ]);
    await sendPrompt(relaunched, resumed.runtimeId, secondPrompt);
    await waitForTranscriptText(
      relaunched,
      resumed.runtimeId,
      `Fake response to: ${secondPrompt}`,
    );
    await expect
      .poll(async () => {
        const sessions = await listSessions(relaunched, workspaceId);
        return sessions.find(
          (session) => session.sessionFile === firstSummary.sessionFile,
        );
      })
      .toMatchObject({
        messageCount: 4,
        preview: `Fake response to: ${secondPrompt}`,
      });
  } finally {
    await closeApp(firstApp);
    await closeApp(secondApp);
    cleanupFixture(fixture);
  }
});

test("fake mode must preserve the selected named workspace across restart (#152)", async () => {
  const fixture = createFixture("restart-fake-workspace", []);
  const env = { ...fixture.env, PI_DECK_BACKEND: "fake" };
  const workspaceName = "Remember selected demo workspace";
  let firstApp: ElectronApplication | undefined;
  let secondApp: ElectronApplication | undefined;
  try {
    const first = await launchPiDeck(env);
    firstApp = first.app;
    const created = await first.page.evaluate(async (name) => {
      const result = await window.piDeck.workspaces.create({ name });
      return result.activeWorkspace;
    }, workspaceName);
    expect(created?.name).toBe(workspaceName);
    expect(created?.id).toBeTruthy();
    await expect(activeWorkspace(first.page)).resolves.toEqual({
      id: created!.id,
      name: workspaceName,
    });
    await firstApp.close();
    firstApp = undefined;

    const second = await launchPiDeck(env);
    secondApp = second.app;
    const workspaceIds = await second.page.evaluate(async () => {
      const result = await window.piDeck.workspaces.list();
      return result.workspaces.map((workspace) => workspace.id);
    });
    // Only active selection is lost; missing/corrupt workspace metadata must
    // not be mistaken for this specific expected failure.
    expect(workspaceIds).toContain(created!.id);
    const actual = await activeWorkspace(second.page);
    console.info("#152 active workspace after fake-mode restart:", actual);
    test.fail(true, "https://github.com/LiusuZeng/pi-deck/issues/152");
    expect(actual).toEqual({ id: created!.id, name: workspaceName });
  } finally {
    await closeApp(firstApp);
    await closeApp(secondApp);
    cleanupFixture(fixture);
  }
});

test("interrupted active ordinary turn persists user prompt without runtime resurrection and can resume", async ({}, testInfo) => {
  const receiptSignal = path.join(
    os.tmpdir(),
    `pi-deck-interrupted-receipt-${process.pid}-${Date.now()}`,
  );
  const fixture = createFixture("restart-interrupted", [
    "--stream-delay-ms",
    "60000",
    "--prompt-receipt-signal-file",
    receiptSignal,
  ]);
  const workspaceName = "Interrupted restart workspace";
  const interruptedPrompt = "interrupted restart persistence turn";
  const followUpPrompt = "post interruption resumed turn";
  let firstApp: ElectronApplication | undefined;
  let secondApp: ElectronApplication | undefined;
  try {
    const firstLaunch = await launchPiDeck(fixture.env);
    firstApp = firstLaunch.app;
    const page = firstLaunch.page;
    const workspaceId = await createNamedWorkspace(page, workspaceName);
    const firstRuntimeId = await startWorkspaceSession(page, workspaceId);
    await sendPrompt(page, firstRuntimeId, interruptedPrompt);
    await expect
      .poll(() => fs.existsSync(receiptSignal), {
        message: "Fake Pi should signal after the user turn is durable.",
      })
      .toBe(true);
    const activeSummary = await waitForSessionSummary(
      page,
      workspaceId,
      interruptedPrompt,
    );
    expect(activeSummary.messageCount).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() =>
        page.evaluate(async (runtimeId) => {
          const status = await window.piDeck.chat.getRuntimeStatus({
            runtimeId,
          });
          return status.state.isAgentActive;
        }, firstRuntimeId),
      )
      .toBe(true);
    await firstApp.close();
    firstApp = undefined;

    setFakeArgs(fixture, ["--stream-delay-ms", "1"]);
    const secondLaunch = await launchPiDeck(fixture.env);
    secondApp = secondLaunch.app;
    const relaunched = secondLaunch.page;
    await expect(activeWorkspace(relaunched)).resolves.toEqual({
      id: workspaceId,
      name: workspaceName,
    });
    const persistedSummary = await waitForSessionSummary(
      relaunched,
      workspaceId,
      interruptedPrompt,
    );
    expect(persistedSummary.sessionFile).toBe(activeSummary.sessionFile);
    expect(persistedSummary.attachedRuntimeId).toBeUndefined();

    const resumed = await resumeSession(
      relaunched,
      workspaceId,
      persistedSummary.sessionFile,
    );
    expect(resumed.workspaceId).toBe(workspaceId);
    expect(resumed.isAgentActive).toBe(false);
    expect(resumed.messages.map(messageText)).toContain(interruptedPrompt);
    expect(
      resumed.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(0);
    await attachInterruptedRepresentation(
      testInfo,
      persistedSummary.sessionFile,
    );

    await sendPrompt(relaunched, resumed.runtimeId, followUpPrompt);
    await waitForTranscriptText(
      relaunched,
      resumed.runtimeId,
      `Fake response to: ${followUpPrompt}`,
    );
    await expect
      .poll(async () => {
        const sessions = await listSessions(relaunched, workspaceId);
        return sessions.find(
          (session) => session.sessionFile === persistedSummary.sessionFile,
        );
      })
      .toMatchObject({ preview: `Fake response to: ${followUpPrompt}` });
  } finally {
    await closeApp(firstApp);
    await closeApp(secondApp);
    fs.rmSync(receiptSignal, { force: true });
    cleanupFixture(fixture);
  }
});
