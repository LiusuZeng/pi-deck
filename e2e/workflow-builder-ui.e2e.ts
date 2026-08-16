import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function fakePiBinary(root: string): string {
  const binary = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return binary;
}

async function launch(
  env: NodeJS.ProcessEnv,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: { ...process.env, PI_DECK_E2E_HIDE_WINDOWS: "1", ...env },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
  return { app, page };
}

test("workflow builder remains interactive after renaming workflow and step", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-builder-ui-"));
  const env = {
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: fakePiBinary(root),
    PI_DECK_PROJECT_CWD: root,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
  };
  const { app, page } = await launch(env);
  try {
    await page.getByRole("button", { name: "Agent Workflows" }).click();
    await page.getByRole("button", { name: /New workflow/i }).click();
    await page.getByLabel("Workflow name").fill("Release checklist");
    await page
      .getByLabel("Focused role inspector")
      .getByLabel("Name")
      .fill("Implement fix");
    await page.getByLabel("Instructions").fill("Fix the renderer.");
    const next = page.getByLabel("Choose the next workflow step");
    await expect(next).toBeEnabled();
    await page.getByRole("button", { name: "Save workflow" }).click();
    await expect(
      page.getByRole("heading", { name: "Release checklist" }),
    ).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
