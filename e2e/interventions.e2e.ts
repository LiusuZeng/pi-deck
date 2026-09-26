import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function interventionEnv(
  root: string,
  fakePiArgs: string[],
): NodeJS.ProcessEnv {
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
  const fakePiPath = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    fakePiPath,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\nprocess.argv.push(...${JSON.stringify(fakePiArgs)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return {
    PI_DECK_E2E_TEST: "1",
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: fakePiPath,
    PI_DECK_PROJECT_CWD: projectCwd,
    PI_CODING_AGENT_DIR: agentDir,
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: userDataDir,
  };
}

async function launch(
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
  await expect(page.getByText("Preload error")).toHaveCount(0);
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
  await page
    .getByLabel("Sessions", { exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await expect(page.getByLabel("Prompt text")).toBeVisible();
  return { app, page };
}

test("queued steering stays visible across navigation and becomes consumed only from durable history", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-intervention-evidence-"),
  );
  const launched = await launch(
    interventionEnv(root, [
      "--stream-delay-ms",
      "700",
      "--consume-steering-after-ms",
      "2200",
    ]),
  );
  try {
    const { page } = launched;
    const composer = page.getByLabel("Prompt text");
    await composer.fill("start intervention evidence fixture");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();

    const instruction = "Keep the intervention instruction visible";
    await composer.fill(instruction);
    await page.getByRole("button", { name: "Steer" }).click();
    const intervention = page.locator('[data-intervention-kind="steer"]', {
      hasText: instruction,
    });
    await expect(intervention).toHaveAttribute(
      "data-intervention-status",
      "queued",
    );
    await expect(intervention).toHaveAccessibleName("Steering queued");
    await expect(
      intervention.getByText(instruction, { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByLabel("Sessions", { exact: true })
        .locator(".session-item", {
          hasText: "start intervention evidence fixture",
        })
        .getByRole("img", { name: /Steer 1/ }),
    ).toBeVisible();

    await page
      .getByLabel("Sessions", { exact: true })
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(intervention).toHaveCount(0);
    await page
      .getByLabel("Sessions", { exact: true })
      .locator(".session-item", {
        hasText: "start intervention evidence fixture",
      })
      .click();
    await expect(
      intervention.getByText(instruction, { exact: true }),
    ).toBeVisible();

    await expect(intervention).toHaveAttribute(
      "data-intervention-status",
      "consumed",
    );
    await expect(intervention).toHaveAccessibleName("Steering consumed by Pi");
    await expect(
      page.locator('[data-intervention-kind="steer"]', {
        hasText: instruction,
      }),
    ).toHaveCount(1);
  } finally {
    await launched.app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected steering send remains failed and available in the composer", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-intervention-failure-"),
  );
  const launched = await launch(
    interventionEnv(root, [
      "--stream-delay-ms",
      "700",
      "--fail-command",
      "steer",
    ]),
  );
  try {
    const { page } = launched;
    const composer = page.getByLabel("Prompt text");
    await composer.fill("start failed intervention fixture");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();

    const instruction = "This steering send must fail honestly";
    await composer.fill(instruction);
    await page.getByRole("button", { name: "Steer" }).click();
    const intervention = page.locator('[data-intervention-kind="steer"]', {
      hasText: instruction,
    });
    await expect(intervention).toHaveAttribute(
      "data-intervention-status",
      "failed",
    );
    await expect(intervention).toHaveAccessibleName("Steering failed to send");
    await expect(composer).toHaveValue(instruction);
    await expect(intervention).not.toHaveAttribute(
      "data-intervention-status",
      "queued",
    );
  } finally {
    await launched.app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
