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
  extraEnv: NodeJS.ProcessEnv = {},
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
      ...extraEnv,
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

test("delayed ordinary prompt acknowledgement keeps recovery quarantined through reload", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-prompt-delivery-unconfirmed-"),
  );
  const receiptFile = path.join(root, "prompt-receipts.log");
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchLifecycleFixture(
      root,
      [
        "--delay-prompt-response-ms",
        "1000",
        "--stream-delay-ms",
        "150",
        "--prompt-receipt-signal-file",
        receiptFile,
      ],
      { PI_DECK_REAL_RPC_TIMEOUT_MS: "100" },
    );
    app = launched.app;
    const { page } = launched;
    const prompt = "accepted before delayed acknowledgement fixture";
    await startPrompt(page, prompt);

    // The fake records the ordinary user turn before deliberately withholding
    // its successful RPC acknowledgement past Deck's timeout.
    await expect.poll(() => readPromptReceipts(receiptFile)).toBe(1);
    await expect(page.locator('.composer-error[role="alert"]')).toContainText(
      "A previous send may have been accepted",
    );
    await expect(page.getByLabel("Prompt text")).toHaveValue("");
    expect(readPromptReceipts(receiptFile)).toBe(1);

    // Stream output arrives after the acknowledgement deadline. It is runtime
    // evidence, not permission to clear the pending-delivery quarantine.
    await expect(page.getByText(`Fake response to: ${prompt}`)).toBeVisible();
    await expect(page.locator('.composer-error[role="alert"]')).toContainText(
      "A previous send may have been accepted",
    );

    // Renderer reload must retain the quarantine and must not replay the
    // already-recorded text while it reconnects to the attached runtime.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `Session: ${prompt}`, exact: true })
      .click();
    await expect(page.locator('.composer-error[role="alert"]')).toContainText(
      "A previous send may have been accepted",
    );
    await expect(page.getByLabel("Prompt text")).toHaveValue("");
    expect(readPromptReceipts(receiptFile)).toBe(1);

    // Recovery restores editable text only; it is an explicit user decision
    // and never sends a second ordinary prompt by itself.
    await page
      .getByRole("button", { name: "Recover text after checking history" })
      .click();
    await expect(page.getByLabel("Prompt text")).toHaveValue(prompt);
    expect(readPromptReceipts(receiptFile)).toBe(1);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("terminal error before a delayed acknowledgement cannot retry an unconfirmed prompt", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-prompt-terminal-unconfirmed-"),
  );
  const receiptFile = path.join(root, "prompt-receipts.log");
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchLifecycleFixture(
      root,
      [
        "--prompt-scenario",
        "error",
        "--delay-prompt-response-ms",
        "1000",
        "--prompt-receipt-signal-file",
        receiptFile,
      ],
      { PI_DECK_REAL_RPC_TIMEOUT_MS: "100" },
    );
    app = launched.app;
    const prompt = "terminal before delayed acknowledgement fixture";
    await startPrompt(launched.page, prompt);

    // Pi emits its terminal provider error while the accepted command's
    // response remains delayed. That error exposes Retry prompt, but the
    // timeout still makes receipt uncertain.
    await expect.poll(() => readPromptReceipts(receiptFile)).toBe(1);
    await expect(
      launched.page.getByRole("button", { name: "Retry prompt" }),
    ).toBeVisible();
    await expect(
      launched.page.locator('.composer-error[role="alert"]'),
    ).toContainText("A previous send may have been accepted");

    await launched.page.getByRole("button", { name: "Retry prompt" }).click();
    await expect(
      launched.page.locator('.composer-error[role="alert"]'),
    ).toContainText("Recover or discard the previous uncertain submission");
    expect(readPromptReceipts(receiptFile)).toBe(1);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accepted prompt disconnect keeps the renderer delivery quarantine", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-prompt-delivery-disconnect-"),
  );
  const receiptFile = path.join(root, "prompt-receipts.log");
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchLifecycleFixture(root, [
      "--exit-after-prompt-receipt",
      "--prompt-receipt-signal-file",
      receiptFile,
    ]);
    app = launched.app;
    const prompt = "accepted before transport disconnect fixture";
    await startPrompt(launched.page, prompt);

    // The worker accepts the durable user turn, then exits before its RPC
    // acknowledgement. The actual main/IPC/preload/renderer path must keep
    // recovery quarantined instead of offering an ordinary safe retry.
    await expect.poll(() => readPromptReceipts(receiptFile)).toBe(1);
    await expect(
      launched.page.locator('.composer-error[role="alert"]'),
    ).toContainText("A previous send may have been accepted");
    await expect(launched.page.getByLabel("Prompt text")).toHaveValue("");
    await expect(
      launched.page.getByText("Error · prompt was not accepted by Pi", {
        exact: true,
      }),
    ).toHaveCount(0);
    expect(readPromptReceipts(receiptFile)).toBe(1);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function readPromptReceipts(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((receipt) => receipt === "prompt").length;
}

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
