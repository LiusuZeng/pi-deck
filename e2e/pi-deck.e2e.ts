import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
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
    await expect(page.getByLabel("Model")).toHaveCount(0);

    await page
      .getByLabel("Prompt text")
      .fill("real e2e prompt without sending");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
  }
});
