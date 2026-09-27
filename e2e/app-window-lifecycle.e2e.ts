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
  projectCwd: string;
  pidLogFile: string;
  promptReceiptFile: string;
  sigtermReceivedFile: string;
  exitSignalFile: string;
}

interface RuntimeIdentity {
  runtimeId: string;
  sessionFile?: string;
}

function fakePiBinary(root: string, args: readonly string[]): string {
  const binary = path.join(root, "fake-pi.js");
  const pidLogFile = path.join(root, "worker-pids.log");
  fs.writeFileSync(
    binary,
    `#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\nrequire("node:fs").appendFileSync(${JSON.stringify(pidLogFile)}, String(process.pid) + "\\n");\nprocess.argv.push(...${JSON.stringify(args)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return binary;
}

async function launchHarness(
  name: string,
  fakeArgs: readonly string[],
): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-deck-e2e-${name}-`));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const promptReceiptFile = path.join(root, "prompt-receipts.log");
  const sigtermReceivedFile = path.join(root, "sigterm-received");
  const exitSignalFile = path.join(root, "worker-exited.log");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
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

  const allFakeArgs = [
    ...fakeArgs,
    "--prompt-receipt-signal-file",
    promptReceiptFile,
    "--sigterm-received-signal-file",
    sigtermReceivedFile,
    "--exit-signal-file",
    exitSignalFile,
  ];
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_E2E_HIDE_WINDOWS: process.env.PI_DECK_E2E_HIDE_WINDOWS ?? "1",
      PI_DECK_E2E_TEST: "1",
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: fakePiBinary(root, allFakeArgs),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DECK_HOME: path.join(root, "pideck-home"),
      PI_DECK_USER_DATA_DIR: userDataDir,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("Preload error")).toHaveCount(0);
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();

  return {
    app,
    page,
    root,
    projectCwd,
    pidLogFile: path.join(root, "worker-pids.log"),
    promptReceiptFile,
    sigtermReceivedFile,
    exitSignalFile,
  };
}

async function closeHarness(harness: Harness | undefined): Promise<void> {
  if (harness === undefined) return;
  for (const pid of readWorkerPids(harness.pidLogFile)) {
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Best-effort orphan cleanup; assertions report the real failure.
      }
    }
  }
  await harness.app.close().catch(() => undefined);
  fs.rmSync(harness.root, { recursive: true, force: true });
}

function readWorkerPids(pidLogFile: string): number[] {
  if (!fs.existsSync(pidLogFile)) return [];
  return fs
    .readFileSync(pidLogFile, "utf8")
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

async function startPrompt(page: Page, prompt: string): Promise<void> {
  await page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await page.getByLabel("Prompt text").fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

async function waitForPromptReceipt(harness: Harness): Promise<void> {
  await expect
    .poll(
      () =>
        fs.existsSync(harness.promptReceiptFile)
          ? fs.readFileSync(harness.promptReceiptFile, "utf8")
          : "",
      { timeout: 10_000 },
    )
    .toContain("prompt");
}

async function workerPids(harness: Harness): Promise<number[]> {
  await expect
    .poll(() => readWorkerPids(harness.pidLogFile), { timeout: 10_000 })
    .not.toHaveLength(0);
  return readWorkerPids(harness.pidLogFile);
}

function sortedPids(pids: readonly number[]): number[] {
  return [...pids].sort((left, right) => left - right);
}

function liveWorkerPids(harness: Harness): number[] {
  return readWorkerPids(harness.pidLogFile).filter(isPidAlive);
}

function exitedWorkerCount(exitSignalFile: string): number {
  if (!fs.existsSync(exitSignalFile)) return 0;
  return fs
    .readFileSync(exitSignalFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
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

test("closing the last BrowserWindow during an active prompt exits after the RPC worker exits", async () => {
  let harness: Harness | undefined;
  try {
    harness = await launchHarness("last-window-close", [
      "--prompt-scenario",
      "extension-ui",
      "--extension-ui-auto-complete-timeout-ms",
      String(longFixtureTimeoutMs),
    ]);
    await startPrompt(harness.page, "last window close active prompt");
    await waitForPromptReceipt(harness);
    await expect(
      harness.page.getByText("Fake confirm", { exact: true }),
    ).toBeVisible();
    await workerPids(harness);
    const knownWorkerPids = liveWorkerPids(harness);
    expect(knownWorkerPids.length).toBeGreaterThan(0);

    const closed = harness.app.waitForEvent("close");
    await harness.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Expected a BrowserWindow.");
      window.close();
    });

    await expect
      .poll(() => fs.existsSync(harness!.sigtermReceivedFile), {
        timeout: 10_000,
      })
      .toBe(true);
    await expect
      .poll(() => exitedWorkerCount(harness!.exitSignalFile), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(knownWorkerPids.length);
    await expect
      .poll(() => knownWorkerPids.every((pid) => !isPidAlive(pid)), {
        timeout: 10_000,
      })
      .toBe(true);
    await closed;
  } finally {
    await closeHarness(harness);
  }
});

test("app.quit escalates a SIGTERM-ignoring active RPC worker before Electron exits", async () => {
  let harness: Harness | undefined;
  try {
    harness = await launchHarness("quit-escalates", [
      "--ignore-sigterm",
      "--prompt-scenario",
      "extension-ui",
      "--extension-ui-auto-complete-timeout-ms",
      String(longFixtureTimeoutMs),
    ]);
    await startPrompt(harness.page, "quit escalation active prompt");
    await waitForPromptReceipt(harness);
    await expect(
      harness.page.getByText("Fake confirm", { exact: true }),
    ).toBeVisible();
    await workerPids(harness);
    const knownWorkerPids = liveWorkerPids(harness);
    expect(knownWorkerPids.length).toBeGreaterThan(0);
    const closed = harness.app.waitForEvent("close");
    const willQuitWorkerState = await harness.app.evaluate(
      async ({ app }, { pids }) => {
        const willQuit = new Promise<string>((resolve) => {
          app.once("will-quit", () => {
            const alivePids = pids.filter((pid) => {
              try {
                process.kill(pid, 0);
                return true;
              } catch {
                return false;
              }
            });
            resolve(
              alivePids.length === 0 ? "dead" : `alive:${alivePids.join(",")}`,
            );
          });
        });
        app.quit();
        return willQuit;
      },
      { pids: knownWorkerPids },
    );

    expect(willQuitWorkerState).toBe("dead");
    await closed;
    expect(knownWorkerPids.every((pid) => !isPidAlive(pid))).toBe(true);
  } finally {
    await closeHarness(harness);
  }
});

test("renderer reload preserves the active prompt runtime and does not spawn an extra worker", async () => {
  let harness: Harness | undefined;
  try {
    harness = await launchHarness("reload-active-prompt", [
      "--stream-delay-ms",
      String(longFixtureTimeoutMs),
    ]);
    const prompt = "reload retains active work";
    await startPrompt(harness.page, prompt);
    await waitForPromptReceipt(harness);
    await expect(
      harness.page.getByRole("button", { name: "Abort" }),
    ).toBeVisible();
    const before = await runtimeIdentity(harness.page);
    await workerPids(harness);
    const beforeWorkerPids = readWorkerPids(harness.pidLogFile);

    await harness.page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      harness.page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    await expect(harness.page.getByText(prompt)).toBeVisible();
    await harness.page
      .getByRole("button", { name: `Session: ${prompt}` })
      .click();
    await expect(
      harness.page.locator('.workspace[data-primary-view="session"]'),
    ).toBeVisible();
    const after = await runtimeIdentity(harness.page);
    expect(after).toEqual(before);
    expect(liveWorkerPids(harness).length).toBeGreaterThan(0);
    expect(sortedPids(readWorkerPids(harness.pidLogFile))).toEqual(
      sortedPids(beforeWorkerPids),
    );

    await harness.page.evaluate(async (runtimeId) => {
      await window.piDeck.chat.abort({ runtimeId });
    }, after.runtimeId);
    expect(sortedPids(readWorkerPids(harness.pidLogFile))).toEqual(
      sortedPids(beforeWorkerPids),
    );
  } finally {
    await closeHarness(harness);
  }
});
