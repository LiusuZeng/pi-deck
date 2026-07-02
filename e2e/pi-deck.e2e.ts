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
      ...env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
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
    await expect(page.getByText(/backend fake RPC mode active/i)).toBeVisible();
    await page.getByLabel("Prompt text").fill("fake e2e prompt");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
  }
});

test("real mode startup failure is not mislabeled as preload/fake UI", async () => {
  const piBinary = process.env.PI_DECK_PI_BINARY || "/usr/local/bin/pi";
  test.skip(!fs.existsSync(piBinary), `Pi binary not found at ${piBinary}`);

  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_PROJECT_CWD: path.join(repoRoot, "missing-e2e-project"),
  });
  try {
    await expect(
      page.getByText("Startup error", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Preload error")).toHaveCount(0);
    await expect(page.getByText("Local projects")).toHaveCount(0);
    await expect(page.getByText(/backend fake RPC active/i)).toHaveCount(0);
    await expect(page.getByText(/claude/i)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("real mode can show and resume a saved project session", async () => {
  const piBinary = process.env.PI_DECK_PI_BINARY || "/usr/local/bin/pi";
  test.skip(!fs.existsSync(piBinary), `Pi binary not found at ${piBinary}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-resume-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const sessionDir = path.join(agentDir, "sessions", "--e2e--");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "manual-e2e-session.jsonl"),
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "manual-e2e-session",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );

  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_PROJECT_CWD: projectCwd,
    PI_CODING_AGENT_DIR: agentDir,
  });
  try {
    await expectHealthyPreload(page);
    await expect(page.getByText(/Real Pi mode active/i)).toBeVisible();
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

test("real mode does not fall back to fake/local UI and can send from active runtime", async () => {
  const piBinary = process.env.PI_DECK_PI_BINARY || "/usr/local/bin/pi";
  test.skip(!fs.existsSync(piBinary), `Pi binary not found at ${piBinary}`);

  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_PROJECT_CWD: repoRoot,
  });
  try {
    await expectHealthyPreload(page);
    await expect(page.getByText("Real Pi session")).toBeVisible();
    await expect(page.getByText(/Real Pi mode active/i)).toBeVisible();
    await expect(page.getByText("Local projects")).toHaveCount(0);
    await expect(page.getByText(/backend fake RPC active/i)).toHaveCount(0);
    await expect(page.getByText(/claude/i)).toHaveCount(0);
    await expect(page.getByLabel("Real Pi model")).toBeVisible();
    await expect(page.getByLabel("Real Pi thinking")).toBeVisible();
    await page.getByLabel("Real Pi thinking").selectOption("high");
    await expect(page.getByText("Switched thinking to high.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /New real session/i }),
    ).toHaveCount(0);

    await page
      .getByLabel("Prompt text")
      .fill("real e2e prompt without sending");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
  }
});
