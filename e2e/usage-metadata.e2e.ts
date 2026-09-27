import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

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
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
  return { app, page };
}

function createFakePiBinary(root: string, extraArgs: string[]): string {
  const fakePiPath = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    fakePiPath,
    `#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("v0.87.1"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model  context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K  32K  yes  yes"); process.exit(0); }\nprocess.argv.push(...${JSON.stringify(extraArgs)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return fakePiPath;
}

function createFixture(extraArgs: string[]): {
  root: string;
  env: NodeJS.ProcessEnv;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-usage-meta-e2e-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  for (const directory of [projectCwd, agentDir, userDataDir]) {
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
  return {
    root,
    env: {
      PI_DECK_E2E_TEST: "1",
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: createFakePiBinary(root, extraArgs),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DECK_HOME: path.join(root, "pi-deck-home"),
      PI_DECK_USER_DATA_DIR: userDataDir,
    },
  };
}

async function enterNewSession(page: Page): Promise<void> {
  await page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await expect(page.getByLabel("Prompt text")).toBeVisible();
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  await page.getByLabel("Prompt text").fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

async function ensureUsageVisible(page: Page) {
  const usage = page.locator(".usage-stats");
  if (!(await usage.isVisible())) {
    await page.locator(".usage-toggle").click();
  }
  await expect(usage).toBeVisible();
  return usage;
}

test("missing production-shaped usage stays unavailable beside known model context", async () => {
  const fixture = createFixture([
    "--production-shaped",
    "--structured-messages",
    "--stream-delay-ms",
    "1",
  ]);
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launchPiDeck(fixture.env));
    const page = await app.firstWindow();
    await enterNewSession(page);
    await sendPrompt(page, "Usage unavailable fixture");
    await expect(
      page.getByText("I’ll review the workspace and summarize the next steps."),
    ).toBeVisible();

    const usage = await ensureUsageVisible(page);
    await expect(usage).toHaveAttribute(
      "aria-label",
      "Session-local usage; private task worker usage is accounted separately",
    );
    await expect(usage).toContainText("Context: unknown / 128,000");
    await expect(usage).toContainText("Tokens: unavailable");
    await expect(usage).toContainText("Cache: unavailable");
    await expect(usage).toContainText("Cost: unavailable");
    await expect(usage).not.toContainText("Tokens: 0 in / 0 out");
    await expect(usage).not.toContainText("$0.0000");
  } finally {
    await app?.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reported usage and structured metadata survive terminal refresh, navigation, and relaunch", async () => {
  const fixture = createFixture([
    "--production-shaped",
    "--structured-messages",
    "--include-usage",
    "--stream-delay-ms",
    "1",
  ]);
  const firstPrompt = "Structured usage metadata";
  let firstApp: ElectronApplication | undefined;
  try {
    ({ app: firstApp } = await launchPiDeck(fixture.env));
    const page = await firstApp.firstWindow();
    await enterNewSession(page);
    await sendPrompt(page, firstPrompt);

    const usage = await ensureUsageVisible(page);
    await expect(usage).toContainText("Context: 105 / 128,000");
    await expect(usage).toContainText("Tokens: 100 in / 10 out");
    await expect(usage).toContainText("Cache: 5 read / 0 write");
    await expect(usage).toContainText("Cost: $0.05");

    // Route away and back through the actual Work/session UI. A sparse
    // navigation snapshot must not replace the settled cumulative totals.
    await page.getByTestId("session-origin-back").click();
    await expect(
      page.locator('.workspace[data-primary-view="work"]'),
    ).toBeVisible();
    const runtimeRow = page.locator(".session-item", { hasText: firstPrompt });
    await expect(runtimeRow).toBeVisible();
    await runtimeRow.click();
    await expect(usage).toContainText("Tokens: 100 in / 10 out");

    await sendPrompt(page, "Second usage turn");
    await expect(usage).toContainText("Tokens: 200 in / 20 out");
    await expect(usage).toContainText("Cache: 10 read / 0 write");
    await expect(usage).toContainText("Cost: $0.10");
  } finally {
    await firstApp?.close();
  }

  let secondApp: ElectronApplication | undefined;
  try {
    ({ app: secondApp } = await launchPiDeck(fixture.env));
    const page = await secondApp.firstWindow();
    await expect
      .poll(
        () =>
          page.evaluate(async (title) => {
            const workspaces = await window.piDeck.workspaces.getActive();
            const workspaceId = workspaces.activeWorkspace?.id;
            if (workspaceId === undefined) return undefined;
            const result = await window.piDeck.chat.listSessions({
              workspaceId,
            });
            return result.sessions.find((session) => session.title === title);
          }, firstPrompt),
        {
          message:
            "Durable structured metadata should converge without a fixture sleep.",
        },
      )
      .toMatchObject({
        title: firstPrompt,
        preview: "I’ll review the workspace and summarize the next steps.",
        messageCount: 4,
        completedAtMs: expect.any(Number),
      });

    const savedRow = page.locator(".session-item", { hasText: firstPrompt });
    await expect(savedRow).toBeVisible();
    await savedRow.click();
    await expect(
      page
        .getByText("I’ll review the workspace and summarize the next steps.")
        .first(),
    ).toBeVisible();
    const usage = await ensureUsageVisible(page);
    await expect(usage).toContainText("Tokens: 200 in / 20 out");
    await expect(usage).toContainText("Cost: $0.10");
  } finally {
    await secondApp?.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
