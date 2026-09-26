import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function fakePiBinary(root: string, args: readonly string[]): string {
  const binary = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\nprocess.argv.push(...${JSON.stringify(args)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return binary;
}

async function launchLifecycleFixture(
  root: string,
  fakeArgs: readonly string[],
): Promise<{ app: ElectronApplication; page: Page }> {
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
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
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      PI_DECK_E2E_TEST: "1",
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: fakePiBinary(root, fakeArgs),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DECK_HOME: path.join(root, "pideck-home"),
      PI_DECK_USER_DATA_DIR: userDataDir,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
  return { app, page };
}

async function startPrompt(page: Page, prompt: string): Promise<void> {
  await page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await page.getByLabel("Prompt text").fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

async function expectCompletedWork(page: Page, prompt: string): Promise<void> {
  await page.getByRole("button", { name: /^All Work/ }).click();
  await expect(
    page.locator(".activity-inbox-row--completed").filter({ hasText: prompt }),
  ).toHaveCount(1);
  await expect(
    page.locator(".activity-inbox-row--inProgress").filter({ hasText: prompt }),
  ).toHaveCount(0);
}

test("missed agent_end is repaired into visible Completed Work", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-session-lifecycle-repair-"),
  );
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchLifecycleFixture(root, [
      "--drop-agent-end",
      "--stream-delay-ms",
      "1",
    ]);
    app = launched.app;
    const prompt = "missed terminal lifecycle fixture";
    await startPrompt(launched.page, prompt);
    await expect(
      launched.page.getByText(`Fake response to: ${prompt}`),
    ).toBeVisible();
    // The renderer remains active after message completion until its compact
    // status fallback observes the fake runtime's authoritative inactive flag.
    await expect(
      launched.page.getByRole("button", { name: "Abort" }),
    ).toHaveCount(0, { timeout: 10_000 });
    await expectCompletedWork(launched.page, prompt);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prompt IPC rejection becomes Failed Work with retry controls", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-prompt-rejection-lifecycle-"),
  );
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchLifecycleFixture(root, [
      "--fail-command",
      "prompt",
    ]);
    app = launched.app;
    const prompt = "rejected prompt lifecycle fixture";
    await startPrompt(launched.page, prompt);

    await expect(launched.page.getByText(/Prompt failed:/)).toBeVisible();
    await expect(
      launched.page.getByRole("button", { name: "Retry prompt" }),
    ).toBeVisible();
    await expect(
      launched.page.getByRole("button", { name: "Abort" }),
    ).toHaveCount(0);

    await launched.page.getByRole("button", { name: /^All Work/ }).click();
    await expect(
      launched.page
        .locator(".activity-inbox-row--failed")
        .filter({ hasText: prompt }),
    ).toHaveCount(1);
    await expect(
      launched.page
        .locator(".activity-inbox-row--inProgress")
        .filter({ hasText: prompt }),
    ).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("terminal Extension UI response and duplicate clear cannot resurrect work", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-session-lifecycle-extension-"),
  );
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchLifecycleFixture(root, [
      "--prompt-scenario",
      "extension-ui-terminal",
      "--stream-delay-ms",
      "10",
      "--extension-ui-auto-complete-timeout-ms",
      "5000",
    ]);
    app = launched.app;
    const prompt = "late extension clear lifecycle fixture";
    await startPrompt(launched.page, prompt);
    await expect(
      launched.page.getByText("Fake confirm", { exact: true }),
    ).toBeVisible();
    await expect(
      launched.page.getByText("Completed before extension acknowledgement."),
    ).toBeVisible();

    await launched.page
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await expect(
      launched.page.getByText("Fake confirm", { exact: true }),
    ).toHaveCount(0);
    await expect(launched.page.getByText("Agent is working…")).toHaveCount(0);
    await expect(
      launched.page.getByRole("button", { name: "Abort" }),
    ).toHaveCount(0);
    await expectCompletedWork(launched.page, prompt);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
