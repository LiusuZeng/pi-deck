import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import electronPath from "electron";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const mainEntry = path.join(repoRoot, "dist/main/main.js");
const outputPairs = [
  {
    name: "pi-deck.png",
    width: 1193,
    height: 776,
  },
  {
    name: "pi-deck-dark.png",
    width: 931,
    height: 672,
  },
];

function createFakePiBinary(root) {
  const fakePiPath = path.join(root, "fake-pi.js");
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
require(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});
`,
    { mode: 0o755 },
  );
  return fakePiPath;
}

function writeSessionFixture(sessionFile, sessionId, projectCwd, title, ageMs) {
  const now = Date.now();
  const timestamp = new Date(now - ageMs).toISOString();
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp,
      cwd: projectCwd,
    })}
${JSON.stringify({
  type: "message",
  timestamp,
  message: { role: "user", content: title },
})}
`,
  );
}

async function waitForReady(page) {
  await page.waitForSelector('.workspace[data-load-state="ready"]');
  await page.getByTestId("workspace-tree").waitFor();
}

async function main() {
  if (!fs.existsSync(mainEntry)) {
    throw new Error("Build Pi Deck first with: npm run build");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-doc-capture-"));
  const projectCwd = path.join(root, "pi-deck");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  const userDataDir = path.join(root, "user-data");
  const piDeckHome = path.join(root, "pideck-home");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    `${JSON.stringify({
      theme: "dark",
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: true,
    })}\n`,
  );

  const sessions = [
    {
      file: path.join(sessionDir, "roadmap.jsonl"),
      id: "roadmap-session",
      title: "read this repo and come up with 3 next roadmap items.",
      ageMs: 25 * 60 * 1000,
    },
    {
      file: path.join(sessionDir, "test5.jsonl"),
      id: "test5-session",
      title: "test5",
      ageMs: 37 * 60 * 1000,
    },
  ];
  for (const session of sessions) {
    writeSessionFixture(
      session.file,
      session.id,
      projectCwd,
      session.title,
      session.ageMs,
    );
  }

  const app = await electron.launch({
    executablePath: electronPath,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_BACKEND: "real",
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      PI_DECK_PI_BINARY: createFakePiBinary(root),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_DECK_HOME: piDeckHome,
      PI_DECK_USER_DATA_DIR: userDataDir,
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await waitForReady(page);

    const workspaceIds = await page.evaluate(
      async (sessionFiles) => {
        const api = window.piDeck;
        let listed = await api.workspaces.list();
        let projectWorkspace = listed.workspaces.find(
          (workspace) => workspace.name === "pi-deck",
        );
        if (!projectWorkspace) {
          const projects = await api.projects.list();
          const projectId = projects.activeProject?.id;
          if (!projectId) {
            throw new Error("Could not resolve the seeded project workspace.");
          }
          const created = await api.workspaces.create({
            name: "pi-deck",
            defaultProjectId: projectId,
          });
          projectWorkspace = created.activeWorkspace;
        }
        if (!projectWorkspace) {
          throw new Error("Could not create the seeded project workspace.");
        }

        const activity = await api.workspaces.create({
          name: "activity-inbox-integration",
        });
        const activityWorkspace = activity.activeWorkspace;
        if (!activityWorkspace) {
          throw new Error("Could not create the activity workspace.");
        }

        for (const sessionFile of sessionFiles) {
          await api.workspaces.addSession({
            workspaceId: projectWorkspace.id,
            sessionFile,
          });
        }

        listed = await api.workspaces.list();
        const defaultWorkspace = listed.workspaces.find(
          (workspace) => workspace.isDefault,
        );
        if (!defaultWorkspace) {
          throw new Error("Could not resolve the default workspace.");
        }
        await api.workspaces.select({ workspaceId: projectWorkspace.id });
        await api.workspaces.select({ workspaceId: defaultWorkspace.id });
        return {
          defaultWorkspaceId: defaultWorkspace.id,
          projectWorkspaceId: projectWorkspace.id,
          activityWorkspaceId: activityWorkspace.id,
        };
      },
      sessions.map((session) => session.file),
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForReady(page);
    await page.waitForFunction(
      (workspaceId) =>
        document.querySelector(
          `[data-workspace-id="${workspaceId}"] .workspace-tree-count`,
        )?.textContent === "2",
      workspaceIds.projectWorkspaceId,
    );
    await page.getByRole("status").waitFor({ state: "hidden" });

    await page.getByLabel(/Model and thinking\. Current model:/).click();
    await page
      .getByRole("menuitemradio", { name: "high", exact: true })
      .click();
    await page.getByRole("status").waitFor({ state: "hidden" });

    const workspaceOutput = outputPairs[0];
    const workspaceScreenshot = path.join(root, workspaceOutput.name);
    await page.setViewportSize({
      width: workspaceOutput.width,
      height: workspaceOutput.height,
    });
    await page.screenshot({ path: workspaceScreenshot });

    await page.getByRole("button", { name: "Work inbox", exact: true }).click();
    await page.getByRole("heading", { name: "Work inbox" }).waitFor();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByLabel("Hide sessions")
      .click();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .waitFor({ state: "detached" });
    const inboxOutput = outputPairs[1];
    await page.setViewportSize({
      width: inboxOutput.width,
      height: inboxOutput.height,
    });
    const inboxScreenshot = path.join(root, inboxOutput.name);
    await page.screenshot({ path: inboxScreenshot });

    for (const output of outputPairs) {
      const source =
        output.name === "pi-deck.png" ? workspaceScreenshot : inboxScreenshot;
      for (const directory of [
        path.join(repoRoot, "docs/assets"),
        path.join(repoRoot, "site/assets"),
      ]) {
        fs.copyFileSync(source, path.join(directory, output.name));
      }
      console.log(`${output.name}: ${source}`);
    }
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
