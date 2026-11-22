import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function createDelegatedStatusFakePi(root: string): string {
  const fakePiPath = path.join(root, "delegated-status-fake-pi.js");
  fs.writeFileSync(
    fakePiPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("v42.5.0");
  process.exit(0);
}
if (process.argv.includes("--list-models")) {
  console.log("provider  model       context  max-out  thinking  images");
  console.log("fake-provider  fake-model  128K     32K      yes       yes");
  process.exit(0);
}
process.argv.push("--delegated-status-fixture", "--stream-delay-ms", "300");
require(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});
`,
    { mode: 0o755 },
  );
  return fakePiPath;
}

async function launchDelegatedStatusApp(root: string): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  for (const directory of [projectCwd, agentDir, userDataDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    JSON.stringify({
      maxRunningSessions: 4,
      warmWorkerLimit: 0,
      enableLoginShellEnvCapture: false,
    }),
  );

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_E2E_HIDE_WINDOWS: process.env.PI_DECK_E2E_HIDE_WINDOWS ?? "1",
      PI_DECK_E2E_TEST: "1",
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: createDelegatedStatusFakePi(root),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DECK_HOME: path.join(root, "pideck-home"),
      PI_DECK_USER_DATA_DIR: userDataDir,
      NODE_ENV: "test",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function enterSession(page: Page): Promise<void> {
  await expect(page.getByText("Preload error")).toHaveCount(0);
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
  await page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await expect(page.getByLabel("Prompt text")).toBeVisible();
}

test("delegated status separates child outcomes from each parent phase", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-delegated-status-"),
  );
  const { app, page } = await launchDelegatedStatusApp(root);
  try {
    await enterSession(page);
    await page.evaluate(() => {
      const target = document.body;
      const windowWithCapture = window as typeof window & {
        __delegatedStatusSnapshots?: {
          all: string[];
          primary: string[];
        };
        __delegatedStatusObserver?: MutationObserver;
      };
      windowWithCapture.__delegatedStatusSnapshots = { all: [], primary: [] };
      windowWithCapture.__delegatedStatusObserver?.disconnect();
      const capture = (): void => {
        const cards = Array.from(
          document.querySelectorAll(".agent-activity-tool-card"),
        );
        const text = cards
          .map((card) => card.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .join(" || ");
        const primary = cards.find((card) =>
          card
            .querySelector(".subagent-activity-heading")
            ?.textContent?.includes("3 tasks"),
        );
        const primaryText = primary?.textContent?.replace(/\s+/g, " ").trim();
        const snapshots = windowWithCapture.__delegatedStatusSnapshots;
        if (text && snapshots?.all.at(-1) !== text) snapshots?.all.push(text);
        if (primaryText && snapshots?.primary.at(-1) !== primaryText) {
          snapshots?.primary.push(primaryText);
        }
      };
      const observer = new MutationObserver(capture);
      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      windowWithCapture.__delegatedStatusObserver = observer;
      capture();
    });

    await page
      .getByLabel("Prompt text")
      .fill("Exercise readable delegated status phases.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const snapshots = (
              window as typeof window & {
                __delegatedStatusSnapshots?: {
                  all: string[];
                  primary: string[];
                };
              }
            ).__delegatedStatusSnapshots ?? { all: [], primary: [] };
            return (
              [
                "Running delegated tasks",
                "Processing delegated results",
                "Synthesizing results",
                "Completed delegated work",
              ].every((text) =>
                snapshots.primary.some((snapshot) => snapshot.includes(text)),
              ) &&
              snapshots.all.some((snapshot) =>
                snapshot.includes("Delegated work failed"),
              )
            );
          }),
        { timeout: 15_000 },
      )
      .toBe(true);

    // The two cards overlap intentionally. Check the primary lifecycle on
    // its own card; the aggregate history is only for concurrent-card checks.
    const captured = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __delegatedStatusSnapshots?: {
              all: string[];
              primary: string[];
            };
          }
        ).__delegatedStatusSnapshots,
    );
    expect(captured).toBeDefined();
    const allSnapshots = captured?.all ?? [];
    const primarySnapshots = captured?.primary ?? [];
    const indexOf = (text: string): number =>
      primarySnapshots.findIndex((snapshot) => snapshot.includes(text));
    expect(indexOf("Running delegated tasks")).toBeGreaterThanOrEqual(0);
    expect(indexOf("Processing delegated results")).toBeGreaterThan(
      indexOf("Running delegated tasks"),
    );
    expect(indexOf("Synthesizing results")).toBeGreaterThan(
      indexOf("Processing delegated results"),
    );
    expect(indexOf("Completed delegated work")).toBeGreaterThan(
      indexOf("Synthesizing results"),
    );

    expect(primarySnapshots.join("\n")).toContain(
      "3 delegated tasks finished · 2 succeeded · 1 failed",
    );
    expect(allSnapshots.join("\n")).toContain(
      "1 delegated task finished · 1 failed",
    );
    expect(allSnapshots.join("\n")).not.toContain("3/3 done");
    expect(
      allSnapshots.some(
        (snapshot) =>
          snapshot.includes("Completed delegated work") &&
          snapshot.includes("Running delegated tasks") &&
          snapshot.includes("1 of 1 delegated task active"),
      ),
    ).toBe(true);

    const cards = page.locator(".agent-activity-tool-card");
    await expect(
      cards.filter({ hasText: "Completed delegated work" }),
    ).toHaveCount(1);
    await expect(
      cards.filter({ hasText: "Delegated work failed" }),
    ).toHaveCount(1);
  } finally {
    await page
      .evaluate(() =>
        (
          window as typeof window & {
            __delegatedStatusObserver?: MutationObserver;
          }
        ).__delegatedStatusObserver?.disconnect(),
      )
      .catch(() => undefined);
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
