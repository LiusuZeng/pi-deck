import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function resolvePiBinary(): string | undefined {
  const explicit = process.env.PI_DECK_PI_BINARY;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const resolved = spawnSync("/bin/sh", ["-lc", "command -v pi"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .stdout.split(/\r?\n/)
    .find(Boolean);
  if (resolved && fs.existsSync(resolved)) {
    return resolved;
  }

  for (const candidate of ["/usr/local/bin/pi", "/opt/homebrew/bin/pi"]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

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
  return { app, page };
}

async function expectHealthyPreload(page: Page): Promise<void> {
  await expect(page.getByText("Preload error")).toHaveCount(0);
  await expect(page.getByText(/secure renderer/i)).toBeVisible();
}

function listJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listJsonlFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [entryPath] : [];
  });
}

const runRealSmoke = process.env.PI_DECK_E2E_REAL_SMOKE === "1";

test.skip(
  !runRealSmoke,
  "Set PI_DECK_E2E_REAL_SMOKE=1 or run npm run test:e2e:real-smoke to exercise real Pi GUI P0 flows.",
);

test("real Pi GUI P0 smoke: prompt, project switch, restart, resume", async () => {
  test.setTimeout(
    Number(process.env.PI_DECK_E2E_REAL_SMOKE_TIMEOUT_MS ?? 240_000),
  );
  const piBinary = resolvePiBinary();
  test.skip(!piBinary, "Pi binary not found");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-real-p0-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const userDataDir = path.join(root, "user-data");
  const piDeckHome = path.join(root, "pideck-home");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(piDeckHome, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const token = `PI_DECK_REAL_GUI_P0_${Date.now()}`;
  const baseEnv: NodeJS.ProcessEnv = {
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_USER_DATA_DIR: userDataDir,
    PI_DECK_HOME: piDeckHome,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_DECK_DISABLE_PREWARM_REAL_WORKER: "1",
    PI_DECK_TEST_PICK_PROJECT_CWDS: JSON.stringify([projectB, projectA]),
  };

  try {
    const firstLaunch = await launchPiDeck({
      ...baseEnv,
      PI_DECK_PROJECT_CWD: projectA,
    });
    try {
      await expectHealthyPreload(firstLaunch.page);
      await expect(firstLaunch.page.getByText("Real Pi session")).toBeVisible();
      await expect(
        firstLaunch.page.getByRole("heading", { name: /project-a/ }),
      ).toBeVisible();

      await firstLaunch.page
        .getByRole("button", { name: "New session" })
        .click();
      await expect(
        firstLaunch.page.getByText(/New real Pi chat is ready/),
      ).toBeVisible();

      await firstLaunch.page
        .getByLabel("Prompt text")
        .fill(`Reply with exactly: ${token}`);
      await firstLaunch.page.getByRole("button", { name: "Send" }).click();
      await expect(
        firstLaunch.page.locator(".assistant-row", { hasText: token }).first(),
      ).toBeVisible({
        timeout: Number(
          process.env.PI_DECK_E2E_REAL_PROMPT_TIMEOUT_MS ?? 180_000,
        ),
      });
      await expect(firstLaunch.page.getByText("Agent is working…")).toHaveCount(
        0,
      );
      await expect
        .poll(() => listJsonlFiles(sessionDir).length, {
          message: "Pi should persist the prompted real session before restart",
          timeout: 30_000,
        })
        .toBeGreaterThan(0);
    } finally {
      await firstLaunch.app.close();
    }

    const secondLaunch = await launchPiDeck(baseEnv);
    try {
      await expectHealthyPreload(secondLaunch.page);
      await expect(
        secondLaunch.page.getByRole("heading", { name: /project-a/ }),
      ).toBeVisible();
      await expect(
        secondLaunch.page.getByText("Saved · click to resume").first(),
      ).toBeVisible();

      await secondLaunch.page
        .getByRole("button", { name: /Open project/i })
        .click();
      await expect(
        secondLaunch.page.getByRole("heading", { name: /project-b/ }),
      ).toBeVisible();
      await expect(
        secondLaunch.page.getByText("Saved · click to resume"),
      ).toHaveCount(0);

      await secondLaunch.page
        .getByRole("button", { name: /Open project/i })
        .click();
      await expect(
        secondLaunch.page.getByRole("heading", { name: /project-a/ }),
      ).toBeVisible();
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
      await expect(
        secondLaunch.page.locator(".assistant-row", { hasText: token }).first(),
      ).toBeVisible();
    } finally {
      await secondLaunch.app.close();
    }
  } finally {
    if (process.env.PI_DECK_E2E_KEEP_REAL_SMOKE_ARTIFACTS !== "1") {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
