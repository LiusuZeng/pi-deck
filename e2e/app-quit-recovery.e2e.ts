import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");
const longFixtureTimeoutMs = 120_000;

interface Harness {
  app: ElectronApplication;
  page: Page;
  root: string;
  sessionPidLogFile: string;
  allPidLogFile: string;
  promptReceiptFile: string;
}

interface RuntimeIdentity {
  runtimeId: string;
  sessionFile: string | undefined;
}

function fakePiBinary(root: string, args: readonly string[]): string {
  const binary = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    binary,
    `#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(path.join(root, "worker-pids.log"))}, String(process.pid) + "\\n");\nif (!process.argv.includes("--no-session")) { fs.appendFileSync(${JSON.stringify(path.join(root, "session-pids.log"))}, String(process.pid) + "\\n"); process.argv.push(...${JSON.stringify(args)}); }\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return binary;
}

async function launchHarness(
  name: string,
  options: { quitResponses?: string } = {},
): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-deck-e2e-${name}-`));
  const projectCwd = path.join(root, "project");
  const userDataDir = path.join(root, "user-data");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    `${JSON.stringify({
      theme: "system",
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: false,
    })}\n`,
  );
  const promptReceiptFile = path.join(root, "prompt-receipts.log");
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: path.join(root, "home"),
      TMPDIR: os.tmpdir(),
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      // Deliberately omit PI_DECK_E2E_TEST: hidden-window shutdown must use
      // scripted/default responses without allocating an invisible dialog.
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      ...(options.quitResponses !== undefined
        ? { PI_DECK_E2E_QUIT_DIALOG_RESPONSES: options.quitResponses }
        : {}),
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: fakePiBinary(root, [
        "--stream-delay-ms",
        String(longFixtureTimeoutMs),
        "--prompt-receipt-signal-file",
        promptReceiptFile,
      ]),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
      PI_DECK_HOME: path.join(root, "pideck-home"),
      PI_DECK_USER_DATA_DIR: userDataDir,
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
    return {
      app,
      page,
      root,
      sessionPidLogFile: path.join(root, "session-pids.log"),
      allPidLogFile: path.join(root, "worker-pids.log"),
      promptReceiptFile,
    };
  } catch (error) {
    killKnownWorkers(path.join(root, "worker-pids.log"));
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeHarness(harness: Harness | undefined): Promise<void> {
  if (harness === undefined) return;
  killKnownWorkers(harness.allPidLogFile);
  await harness.app.close().catch(() => undefined);
  fs.rmSync(harness.root, { recursive: true, force: true });
}

function readPids(file: string): number[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killKnownWorkers(file: string): void {
  for (const pid of readPids(file)) {
    if (!isPidAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Assertions report ownership failures; this is fixture cleanup only.
    }
  }
}

async function startActivePrompt(
  harness: Harness,
  prompt: string,
): Promise<void> {
  await harness.page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await harness.page.getByLabel("Prompt text").fill(prompt);
  await harness.page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      () =>
        fs.existsSync(harness.promptReceiptFile)
          ? fs.readFileSync(harness.promptReceiptFile, "utf8")
          : "",
      { timeout: 10_000 },
    )
    .toContain("prompt");
  await expect
    .poll(() => readPids(harness.sessionPidLogFile), { timeout: 10_000 })
    .toHaveLength(1);
}

async function runtimeIdentity(page: Page): Promise<RuntimeIdentity> {
  return page.evaluate(async () => {
    const snapshot = await window.piDeck.chat.getSnapshot();
    return {
      runtimeId: snapshot.runtimeId,
      sessionFile: snapshot.state.sessionFile,
    };
  });
}

test("Cancel on last-window close retains the hidden window and active worker, then confirmation stops it", async () => {
  let harness: Harness | undefined;
  try {
    harness = await launchHarness("quit-cancel-confirm", {
      quitResponses: "cancel,quit",
    });
    await startActivePrompt(harness, "cancel keeps this work running");
    const identity = await runtimeIdentity(harness.page);
    const [workerPid] = readPids(harness.sessionPidLogFile);
    expect(workerPid).toBeDefined();

    await harness.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect
      .poll(() =>
        harness!.app.evaluate(
          () => process.env.PI_DECK_E2E_QUIT_DIALOG_RESPONSES ?? "",
        ),
      )
      .toBe("quit");
    expect(
      await harness.app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);
    expect(
      await harness.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
    expect(isPidAlive(workerPid!)).toBe(true);
    expect(
      await harness.page.evaluate(
        async (runtimeId) =>
          (await window.piDeck.chat.getRuntimeStatus({ runtimeId })).state
            .isAgentActive,
        identity.runtimeId,
      ),
    ).toBe(true);

    const closed = harness.app.waitForEvent("close");
    const aliveAtQuit = await harness.app.evaluate(
      async ({ app, BrowserWindow }, pid) => {
        const result = new Promise<boolean>((resolve) => {
          app.once("will-quit", () => {
            try {
              process.kill(pid, 0);
              resolve(true);
            } catch {
              resolve(false);
            }
          });
        });
        BrowserWindow.getAllWindows()[0]?.close();
        return result;
      },
      workerPid!,
    );
    expect(aliveAtQuit).toBe(false);
    await closed;
  } finally {
    await closeHarness(harness);
  }
});

test("an active renderer crash reloads the UI without replacing its main-owned runtime", async () => {
  let harness: Harness | undefined;
  try {
    harness = await launchHarness("renderer-crash-recovery");
    await startActivePrompt(harness, "crash recovery keeps this runtime");
    const before = await runtimeIdentity(harness.page);
    const beforePids = readPids(harness.sessionPidLogFile);
    const mainPid = await harness.app.evaluate(() => process.pid);

    await harness.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Expected a BrowserWindow.");
      window.webContents.forcefullyCrashRenderer();
    });

    await expect(
      harness.page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    expect(await harness.app.evaluate(() => process.pid)).toBe(mainPid);
    expect(await runtimeIdentity(harness.page)).toEqual(before);
    expect(readPids(harness.sessionPidLogFile)).toEqual(beforePids);
    expect(beforePids.every(isPidAlive)).toBe(true);

    // Main-owned controls remain usable. Visible Abort rehydration is asserted
    // by the #155 integration work rather than weakened here.
    await harness.page.evaluate(async (runtimeId) => {
      await window.piDeck.chat.abort({ runtimeId });
    }, before.runtimeId);
    await expect
      .poll(() =>
        harness!.page.evaluate(
          async (runtimeId) =>
            (await window.piDeck.chat.getRuntimeStatus({ runtimeId })).state
              .isAgentActive,
          before.runtimeId,
        ),
      )
      .toBe(false);
  } finally {
    await closeHarness(harness);
  }
});
