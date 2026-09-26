import { expect, test, type Locator, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function createFakePiBinary(root: string, fixtureArgs: string[]): string {
  const binary = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    binary,
    `#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\nprocess.argv.push(...${JSON.stringify(fixtureArgs)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return binary;
}

async function launchFixture(
  root: string,
  barriers: string,
): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
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
      PI_DECK_E2E_TEST: "1",
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: createFakePiBinary(root, [
        "--prompt-scenario",
        "subagent",
        "--subagent-activity-barrier-dir",
        barriers,
        "--stream-delay-ms",
        "1",
      ]),
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

async function enterNewSession(page: Page): Promise<void> {
  await page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await expect(page.getByLabel("Prompt text")).toBeVisible();
}

async function send(page: Page, prompt: string): Promise<void> {
  await page.getByLabel("Prompt text").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
}

async function openLatestActivityGroup(page: Page): Promise<Locator> {
  const group = page.locator(".agent-activity-group").last();
  await expect(group).toBeVisible();
  if ((await group.getAttribute("open")) === null) {
    await group.locator(":scope > summary").click();
  }
  await expect(group).toHaveAttribute("open", "");
  return group;
}

function child(region: Locator, index: number): Locator {
  return region.locator(`[role="listitem"][data-subagent-index="${index}"]`);
}

async function openChildActivity(row: Locator): Promise<Locator> {
  const details = row.locator("details.subagent-history");
  if ((await details.getAttribute("open")) === null) {
    await details.getByText("View activity", { exact: true }).click();
  }
  await expect(details).toHaveAttribute("open", "");
  return details;
}

async function expectParallelOff(page: Page): Promise<void> {
  const control = page.getByRole("button", {
    name: "Parallel multitasking: Off",
  });
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute("aria-pressed", "false");
}

function release(barriers: string, marker: string): void {
  fs.writeFileSync(path.join(barriers, marker), "release\n", { flag: "wx" });
}

const excludedValues = [
  "PRIVATE_THINKING_DO_NOT_RENDER",
  "SYSTEM_SECRET_DO_NOT_RENDER",
  "USER_SECRET_DO_NOT_RENDER",
  "RAW_TOOL_RESULT_DO_NOT_RENDER",
  "eyJhbGciOiJIUzI1NiJ9.fixture.signature",
  "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  "/private/fixture/sessionRuntimeReducer.ts",
  "tool_execution_update",
];

async function expectExcluded(region: Locator): Promise<void> {
  for (const value of excludedValues) {
    await expect(region).not.toContainText(value);
  }
}

test("single extension subagent succeeds with cumulative telemetry while Parallel is off", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-subagent-single-"),
  );
  const barriers = path.join(root, "barriers");
  fs.mkdirSync(barriers, { recursive: true });
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchFixture(root, barriers);
    app = launched.app;
    const page = launched.page;
    await enterNewSession(page);
    await expectParallelOff(page);

    await send(page, "single success fixture");
    const group = await openLatestActivityGroup(page);
    const activity = group.getByRole("region", { name: "Subagent activity" });
    await expect(activity).toBeVisible();
    await expectParallelOff(page);
    await expect(
      activity.locator('[role="listitem"][data-subagent-index]'),
    ).toHaveCount(1);
    const row = child(activity, 0);
    await expect(row).toContainText("worker");
    await expect(row).toContainText("Inspect one deterministic target");
    await expect(row).toContainText("Waiting for activity");
    await expect(row.getByText("View activity", { exact: true })).toBeVisible();

    release(barriers, "single-update-1");
    await expect(row).toContainText("Activity observed");
    await expect(row).toContainText("1 completed turn");
    await expect(row).toContainText("30 tokens");
    await expect(row.getByText(/Last observed:/i)).toBeVisible();
    const history = await openChildActivity(row);
    await expect(history).toContainText("read");
    await expect(history).toContainText("Located the single-agent target.");

    release(barriers, "single-update-2");
    await expect(row).toContainText("2 completed turns");
    await expect(row).toContainText("45 tokens");
    await expect(row).not.toContainText("75 tokens");
    await expect(history).toContainText("Verified the single-agent result.");

    release(barriers, "single-finish");
    await expect(row).toContainText("Completed");
    await expect(row).toContainText("45 tokens");
    await expectParallelOff(page);
    await expect(
      page.getByText("Fake response to: single success fixture", {
        exact: false,
      }),
    ).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("user Abort interrupts an unresolved extension subagent without a tool end", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-subagent-cancel-"),
  );
  const barriers = path.join(root, "barriers");
  fs.mkdirSync(barriers, { recursive: true });
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchFixture(root, barriers);
    app = launched.app;
    const page = launched.page;
    await enterNewSession(page);

    await send(page, "cancellation fixture");
    const group = await openLatestActivityGroup(page);
    const activity = group.getByRole("region", { name: "Subagent activity" });
    const row = child(activity, 0);
    await expect(row).toContainText("Waiting for activity");
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

    release(barriers, "cancellation-update");
    await expect(row).toContainText("Activity observed");
    const history = await openChildActivity(row);
    await expect(history).toContainText("Started cancellable child work.");

    await page.getByRole("button", { name: "Abort" }).click();
    await expect(row).toContainText("Interrupted");
    await expect(row).not.toContainText("Activity observed");
    await expect(page.getByRole("button", { name: "Abort" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed details fall back and oversized child activity remains bounded", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-subagent-edge-"),
  );
  const barriers = path.join(root, "barriers");
  fs.mkdirSync(barriers, { recursive: true });
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchFixture(root, barriers);
    app = launched.app;
    const page = launched.page;
    await enterNewSession(page);

    await send(page, "malformed details fixture");
    const malformedGroup = await openLatestActivityGroup(page);
    await expect(
      malformedGroup.getByRole("region", { name: "Subagent activity" }),
    ).toHaveCount(0);
    await expect(
      malformedGroup.getByText("Input / Output", { exact: true }),
    ).toBeVisible();
    release(barriers, "malformed-update");
    await expect(
      malformedGroup.getByRole("region", { name: "Subagent activity" }),
    ).toHaveCount(0);
    release(barriers, "malformed-finish");
    await expect(
      page.getByText("Fake response to: malformed details fixture", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      malformedGroup.getByRole("region", { name: "Subagent activity" }),
    ).toHaveCount(0);

    await send(page, "oversized details fixture");
    const oversizedGroup = await openLatestActivityGroup(page);
    const activity = oversizedGroup.getByRole("region", {
      name: "Subagent activity",
    });
    const row = child(activity, 0);
    await expect(row).toContainText("Waiting for activity");
    release(barriers, "oversized-update");
    await expect(row).toContainText("Activity observed");
    const history = await openChildActivity(row);
    await expect(history).toContainText("oversized-public-entry-139-");
    await expect(history).not.toContainText("oversized-public-entry-0-");
    await expect
      .poll(() =>
        row.evaluate((element) => {
          const task = element.querySelector<HTMLElement>(".subagent-task");
          const historyItems = [
            ...element.querySelectorAll<HTMLElement>(
              ".subagent-history ol > li",
            ),
          ];
          const longestHistoryItem = Math.max(
            0,
            ...historyItems.map((item) => item.innerText.length),
          );
          return {
            hasHistory: historyItems.length > 0,
            historyIsBounded: historyItems.length <= 24,
            historyTextIsBounded: longestHistoryItem <= 1_200,
            regionIsBounded: (element as HTMLElement).innerText.length < 9_000,
            taskIsBounded: (task?.innerText.length ?? 0) <= 500,
          };
        }),
      )
      .toEqual({
        hasHistory: true,
        historyIsBounded: true,
        historyTextIsBounded: true,
        regionIsBounded: true,
        taskIsBounded: true,
      });

    release(barriers, "oversized-finish");
    await expect(row).toContainText("Completed");
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension subagent activity streams safely and restores parallel and failed-chain children", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-subagent-activity-"),
  );
  const barriers = path.join(root, "barriers");
  fs.mkdirSync(barriers, { recursive: true });
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchFixture(root, barriers);
    app = launched.app;
    const page = launched.page;
    await page.setViewportSize({ width: 900, height: 680 });
    await enterNewSession(page);
    await expectParallelOff(page);

    await send(page, "parallel extension activity fixture");
    const parallelGroup = await openLatestActivityGroup(page);
    const parallel = parallelGroup.getByRole("region", {
      name: "Subagent activity",
    });
    await expect(parallel).toBeVisible();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
    await expect(
      parallel.locator('[role="listitem"][data-subagent-index]'),
    ).toHaveCount(3);
    await expect(child(parallel, 0)).toContainText("scout");
    await expect(child(parallel, 0)).toContainText(
      "Inspect runtime event projection",
    );
    await expect(child(parallel, 1)).toContainText("scout");
    await expect(child(parallel, 1)).toContainText("Review privacy boundaries");
    await expect(child(parallel, 2)).toContainText("reviewer");
    for (const index of [0, 1, 2]) {
      await expect(child(parallel, index)).toContainText(
        "Waiting for activity",
      );
      await expect(
        child(parallel, index).getByText("View activity", { exact: true }),
      ).toBeVisible();
    }

    release(barriers, "parallel-update-1");
    await expect(child(parallel, 0)).toContainText("Activity observed");
    await expect(child(parallel, 0)).toContainText(
      "Located the runtime projection boundary.",
    );
    await expect(child(parallel, 0)).toContainText("105 tokens");
    await expect(child(parallel, 0)).not.toContainText("Completed");
    await expect(child(parallel, 1)).toContainText("Waiting for activity");
    await expectExcluded(parallel);

    const firstDisclosure = child(parallel, 0).getByText("View activity", {
      exact: true,
    });
    await firstDisclosure.click();
    await expect(child(parallel, 0)).toContainText("read");
    await expect(firstDisclosure).toBeFocused();
    await expect(parallel.getByRole("textbox")).toHaveCount(0);
    await expect(
      parallel.locator("input, textarea, [contenteditable=true]"),
    ).toHaveCount(0);
    release(barriers, "parallel-update-2");
    await expect(child(parallel, 0)).toContainText("grep");
    await expect(child(parallel, 0)).toContainText(
      "Confirmed cumulative updates preserve child identity.",
    );
    await expect(child(parallel, 0)).toContainText("165 tokens");
    await expect(child(parallel, 0)).not.toContainText("270 tokens");
    await expect(child(parallel, 0)).not.toContainText("Completed");
    await expect(child(parallel, 1)).toContainText("Activity observed");
    await expect(firstDisclosure).toBeFocused();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

    release(barriers, "parallel-finish");
    await expect(child(parallel, 0)).toContainText("Completed");
    await expect(child(parallel, 0)).toContainText(/2 completed turns?/i);
    await expect(child(parallel, 1)).toContainText("Failed");
    const failedParallelHistory = await openChildActivity(child(parallel, 1));
    await expect(failedParallelHistory).toContainText(
      "Privacy review found a deterministic fixture failure.",
    );
    await expect(child(parallel, 2)).toContainText("Completed");
    await expect(
      page.getByText("Fake response to: parallel extension activity fixture", {
        exact: false,
      }),
    ).toBeVisible();
    await expectExcluded(parallel);

    await page.setViewportSize({ width: 480, height: 520 });
    await expect
      .poll(() =>
        parallel.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            insideViewport: bounds.left >= 0 && bounds.right <= innerWidth,
            documentFits: document.documentElement.scrollWidth <= innerWidth,
            timelineScrolls: (() => {
              const timeline =
                document.querySelector<HTMLElement>(".timeline-scroll");
              return (
                timeline !== null &&
                timeline.scrollHeight > timeline.clientHeight &&
                getComputedStyle(timeline).overflowY !== "visible"
              );
            })(),
          };
        }),
      )
      .toEqual({
        insideViewport: true,
        documentFits: true,
        timelineScrolls: true,
      });

    await send(page, "chain failure fixture");
    const chainGroup = await openLatestActivityGroup(page);
    const chain = chainGroup.getByRole("region", {
      name: "Subagent activity",
    });
    await expect(chain).toBeVisible();
    await expect(
      chain.locator('[role="listitem"][data-subagent-index]'),
    ).toHaveCount(3);
    await expect(child(chain, 0)).toContainText("worker");
    await expect(child(chain, 1)).toContainText("reviewer");
    await expect(child(chain, 2)).toContainText("worker");
    await expect(child(chain, 2)).toContainText("Waiting for activity");

    release(barriers, "chain-update-1");
    await expect(child(chain, 0)).toContainText("Activity observed");
    release(barriers, "chain-finish");
    await expect(child(chain, 0)).toContainText("Completed");
    await expect(child(chain, 1)).toContainText("Failed");
    const failedChainHistory = await openChildActivity(child(chain, 1));
    await expect(failedChainHistory).toContainText(
      "Chain stopped on deterministic review failure.",
    );
    await expect(child(chain, 2)).toContainText("Not run");

    await page.getByRole("button", { name: /^All Work/ }).click();
    await expect(
      page.locator('.workspace[data-primary-view="work"]'),
    ).toBeVisible();
    await page
      .getByLabel("Sessions", { exact: true })
      .locator(".session-item", {
        hasText: "parallel extension activity fixture",
      })
      .click();
    const navigatedGroup = await openLatestActivityGroup(page);
    await expect(
      child(
        navigatedGroup.getByRole("region", { name: "Subagent activity" }),
        2,
      ),
    ).toContainText("Not run");

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    await page
      .getByLabel("Sessions", { exact: true })
      .locator(".session-item", {
        hasText: "parallel extension activity fixture",
      })
      .click();
    const restoredGroup = await openLatestActivityGroup(page);
    const restored = restoredGroup.getByRole("region", {
      name: "Subagent activity",
    });
    await expect(child(restored, 0)).toContainText("Completed");
    await expect(child(restored, 1)).toContainText("Failed");
    await expect(child(restored, 2)).toContainText("Not run");
    await expectExcluded(restored);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
