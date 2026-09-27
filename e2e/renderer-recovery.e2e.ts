/// <reference path="../src/renderer/global.d.ts" />

import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");
const longTurnMs = 120_000;

interface Harness {
  app: ElectronApplication;
  page: Page;
  root: string;
  sessionPidFile: string;
  discoverySignalFile: string;
  discoveryBarrierDir: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionPids(harness: Harness): number[] {
  if (!fs.existsSync(harness.sessionPidFile)) return [];
  return fs
    .readFileSync(harness.sessionPidFile, "utf8")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

async function launchHarness(options: {
  name: string;
  fakeArgs?: string[];
  holdDiscovery?: boolean;
}): Promise<Harness> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-deck-renderer-recovery-${options.name}-`),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const sessionPidFile = path.join(root, "session-pids");
  const discoverySignalFile = path.join(root, "discovery-get-state");
  const discoveryBarrierDir = path.join(root, "discovery-barrier");
  const discoveryEnabledFile = path.join(root, "hold-discovery");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(discoveryBarrierDir, { recursive: true });
  if (options.holdDiscovery) fs.writeFileSync(discoveryEnabledFile, "hold\n");
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
  const fakeArgs = [
    ...(options.fakeArgs ?? []),
    ...(options.holdDiscovery
      ? [
          "--delay-get-state-enabled-file",
          discoveryEnabledFile,
          "--get-state-barrier-dir",
          discoveryBarrierDir,
          "--get-state-signal-file",
          discoverySignalFile,
        ]
      : []),
  ];
  fs.writeFileSync(
    fakePi,
    `#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\nconst fs = require("node:fs");\nif (!process.argv.includes("--no-session")) fs.appendFileSync(${JSON.stringify(sessionPidFile)}, String(process.pid) + "\\n");\nprocess.argv.push(...${JSON.stringify(fakeArgs)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      PI_DECK_E2E_TEST: "1",
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: fakePi,
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
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
    ),
  ).toBe(true);
  return {
    app,
    page,
    root,
    sessionPidFile,
    discoverySignalFile,
    discoveryBarrierDir,
  };
}

async function closeHarness(harness: Harness | undefined): Promise<void> {
  if (harness === undefined) return;
  fs.writeFileSync(
    path.join(harness.discoveryBarrierDir, "release-get-state"),
    "release\n",
  );
  for (const pid of sessionPids(harness)) {
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Best-effort cleanup; assertions retain the original failure.
      }
    }
  }
  await harness.app.close().catch(() => undefined);
  fs.rmSync(harness.root, { recursive: true, force: true });
}

async function openNewSession(page: Page): Promise<void> {
  await page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await expect(
    page.locator('.workspace[data-primary-view="session"]'),
  ).toBeVisible();
}

async function startPrompt(page: Page, prompt: string): Promise<void> {
  await openNewSession(page);
  await page.getByLabel("Prompt text").fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

async function reloadAndOpenAttached(page: Page, title: string): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: `Session: ${title}` }).click();
  await expect(
    page.locator('.workspace[data-primary-view="session"]'),
  ).toBeVisible();
}

test("reload hydrates active attached history and Abort without another worker", async () => {
  let harness: Harness | undefined;
  try {
    harness = await launchHarness({
      name: "active",
      fakeArgs: ["--stream-delay-ms", String(longTurnMs)],
    });
    const prompt = "active renderer recovery";
    await startPrompt(harness.page, prompt);
    await expect(
      harness.page.getByRole("button", { name: "Abort" }),
    ).toBeVisible();
    await expect.poll(() => sessionPids(harness!)).toHaveLength(1);
    const beforePids = sessionPids(harness);
    const beforeRuntime = await harness.page.evaluate(
      async () => (await window.piDeck.chat.getSnapshot()).runtimeId,
    );
    const unsentText = "keep this unsent during renderer reload";
    await harness.page.getByLabel("Prompt text").fill(unsentText);

    await reloadAndOpenAttached(harness.page, prompt);

    await expect(
      harness.page
        .getByRole("region", { name: "Chat / Agent Timeline" })
        .getByText(prompt, { exact: true }),
    ).toBeVisible();
    await expect(
      harness.page.getByRole("button", { name: "Abort" }),
    ).toBeEnabled();
    await expect(harness.page.getByLabel("Prompt text")).toHaveValue(
      unsentText,
    );
    expect(sessionPids(harness)).toEqual(beforePids);
    await expect
      .poll(() =>
        harness!.page.evaluate(async (runtimeId) => {
          const status = await window.piDeck.chat.getRuntimeStatus({
            runtimeId,
          });
          return status.state.isAgentActive;
        }, beforeRuntime),
      )
      .toBe(true);
    await harness.page.getByRole("button", { name: "Abort" }).click();
    await expect
      .poll(() =>
        harness!.page.evaluate(async (runtimeId) => {
          const status = await window.piDeck.chat.getRuntimeStatus({
            runtimeId,
          });
          return status.state.isAgentActive;
        }, beforeRuntime),
      )
      .toBe(false);
  } finally {
    await closeHarness(harness);
  }
});

test("reload restores a pending extension request and answers it on the same worker", async () => {
  let harness: Harness | undefined;
  try {
    harness = await launchHarness({
      name: "extension-ui",
      fakeArgs: ["--prompt-scenario", "extension-ui", "--stream-delay-ms", "1"],
    });
    const prompt = "recover pending extension input";
    await startPrompt(harness.page, prompt);
    await expect(
      harness.page.getByText("Approve fake extension UI request?"),
    ).toBeVisible();
    await expect.poll(() => sessionPids(harness!)).toHaveLength(1);
    const beforePids = sessionPids(harness);
    const runtimeId = await harness.page.evaluate(
      async () => (await window.piDeck.chat.getSnapshot()).runtimeId,
    );

    await reloadAndOpenAttached(harness.page, prompt);

    await expect(
      harness.page.getByText("Approve fake extension UI request?"),
    ).toBeVisible();
    const recoveredSnapshot = await harness.page.evaluate(
      async (id) => window.piDeck.chat.getSnapshot({ runtimeId: id }),
      runtimeId,
    );
    expect(recoveredSnapshot.pendingExtensionUiRequests).toMatchObject([
      { id: expect.any(String), method: "confirm", title: "Fake confirm" },
    ]);
    await harness.page
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await expect(
      harness.page.getByText("Extension UI response delivered to Pi."),
    ).toBeVisible();
    await expect(
      harness.page.getByText(
        /Fake response to: recover pending extension input/,
      ),
    ).toBeVisible();
    await expect
      .poll(() =>
        harness!.page.evaluate(
          async (id) =>
            (await window.piDeck.chat.getSnapshot({ runtimeId: id }))
              .pendingExtensionUiRequests?.length ?? 0,
          runtimeId,
        ),
      )
      .toBe(0);
    expect(sessionPids(harness)).toEqual(beforePids);
  } finally {
    await closeHarness(harness);
  }
});

test("reload hydrates completed history from an attached idle worker", async () => {
  let harness: Harness | undefined;
  try {
    harness = await launchHarness({ name: "completed" });
    const prompt = "completed renderer recovery";
    await startPrompt(harness.page, prompt);
    await expect(harness.page.getByText("Fake response").first()).toBeVisible();
    await expect.poll(() => sessionPids(harness!)).toHaveLength(1);
    const beforePids = sessionPids(harness);

    await reloadAndOpenAttached(harness.page, prompt);

    const timeline = harness.page.getByRole("region", {
      name: "Chat / Agent Timeline",
    });
    await expect(timeline.getByText(prompt, { exact: true })).toBeVisible();
    await expect(timeline.getByText("Fake response").first()).toBeVisible();
    await expect(
      harness.page.getByRole("button", { name: "Abort" }),
    ).toHaveCount(0);
    expect(sessionPids(harness)).toEqual(beforePids);
  } finally {
    await closeHarness(harness);
  }
});

test("a first draft receives real thinking defaults after delayed bootstrap discovery", async () => {
  let harness: Harness | undefined;
  try {
    harness = await launchHarness({
      name: "draft-defaults",
      holdDiscovery: true,
    });
    await expect
      .poll(() => fs.existsSync(harness!.discoverySignalFile))
      .toBe(true);
    await openNewSession(harness.page);

    fs.writeFileSync(
      path.join(harness.discoveryBarrierDir, "release-get-state"),
      "release\n",
    );
    const configuration = harness.page.locator(".pi-configuration-trigger");
    await expect(configuration).toHaveAttribute("data-model-id", "fake-model");
    await expect(configuration).toHaveAttribute(
      "data-model-provider",
      "fake-provider",
    );
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );
    expect(sessionPids(harness)).toEqual([]);
  } finally {
    await closeHarness(harness);
  }
});
