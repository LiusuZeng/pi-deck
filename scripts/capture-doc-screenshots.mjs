import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import gifenc from "gifenc";
import { _electron as electron } from "playwright";
import { PNG } from "pngjs";
import electronPath from "electron";

const { applyPalette, GIFEncoder, quantize } = gifenc;
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const mainEntry = path.join(repoRoot, "dist/main/main.js");
const siteOutputs = [
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
const additionalOutputs = [
  {
    name: "pi-deck-inbox.png",
    width: 1193,
    height: 776,
  },
  {
    name: "pi-deck-conversation.png",
    width: 1193,
    height: 776,
  },
];
const animatedOutputs = [
  {
    name: "pi-deck-conversation.gif",
    width: 896,
    height: 582,
  },
];

function encodeGif(frames, width, height) {
  const rgbaFrames = frames.map(({ screenshot }) => {
    const decoded = PNG.sync.read(screenshot);
    if (decoded.width !== width || decoded.height !== height) {
      throw new Error(
        `Expected GIF frame ${width}x${height}, got ${decoded.width}x${decoded.height}`,
      );
    }
    return decoded.data;
  });
  const combined = new Uint8Array(
    rgbaFrames.reduce((total, frame) => total + frame.length, 0),
  );
  let offset = 0;
  for (const frame of rgbaFrames) {
    combined.set(frame, offset);
    offset += frame.length;
  }
  const palette = quantize(combined, 256);
  const gif = GIFEncoder();
  for (const [index, frame] of rgbaFrames.entries()) {
    gif.writeFrame(applyPalette(frame, palette), width, height, {
      palette: index === 0 ? palette : undefined,
      delay: frames[index].delay,
      repeat: index === 0 ? 0 : undefined,
    });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

function createFakePiBinary(root, extraArgs = []) {
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
process.argv.push(...${JSON.stringify(extraArgs)});
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
  const attachmentImageBase64 = fs.readFileSync(
    path.join(repoRoot, "docs/assets/pi-deck-dark.png"),
    "base64",
  );

  const app = await electron.launch({
    executablePath: electronPath,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_BACKEND: "real",
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      PI_DECK_PI_BINARY: createFakePiBinary(root, [
        "--prompt-scenario",
        "tool",
        "--stream-delay-ms",
        "2000",
      ]),
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

    const capturedScreenshots = new Map();
    const workspaceOutput = siteOutputs[0];
    const workspaceScreenshot = path.join(root, workspaceOutput.name);
    await page.setViewportSize({
      width: workspaceOutput.width,
      height: workspaceOutput.height,
    });
    await page.screenshot({ path: workspaceScreenshot });
    capturedScreenshots.set(workspaceOutput.name, workspaceScreenshot);

    const inboxOutput = siteOutputs[1];
    await page.getByRole("button", { name: "Work inbox", exact: true }).click();
    await page.getByRole("heading", { name: "Work inbox" }).waitFor();
    await page.getByRole("status").waitFor({ state: "hidden" });
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByLabel("Hide sessions")
      .click();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .waitFor({ state: "detached" });
    await page.setViewportSize({
      width: inboxOutput.width,
      height: inboxOutput.height,
    });
    const inboxScreenshot = path.join(root, inboxOutput.name);
    await page.screenshot({ path: inboxScreenshot });
    capturedScreenshots.set(inboxOutput.name, inboxScreenshot);

    await page.getByLabel("Show sessions").click();
    await page.getByRole("complementary", { name: "Sessions" }).waitFor();
    await page.getByRole("button", { name: "Work inbox", exact: true }).click();
    await page.getByRole("heading", { name: "Work inbox" }).waitFor({
      state: "detached",
    });
    await page.getByRole("button", { name: "Workspace: pi-deck" }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[aria-label="Workspace: pi-deck"][aria-current="page"]',
        ) !== null,
    );
    await page
      .getByRole("button", { name: "Workspace actions for pi-deck" })
      .click();
    await page
      .getByRole("menuitem", { name: "View work inbox", exact: true })
      .click();
    await page
      .getByRole("heading", { name: /Work inbox · pi-deck/i })
      .waitFor();
    await page.getByRole("status").waitFor({ state: "hidden" });
    const workspaceInboxOutput = additionalOutputs[0];
    const workspaceInboxScreenshot = path.join(root, workspaceInboxOutput.name);
    await page.setViewportSize({
      width: workspaceInboxOutput.width,
      height: workspaceInboxOutput.height,
    });
    await page.screenshot({ path: workspaceInboxScreenshot });
    capturedScreenshots.set(
      workspaceInboxOutput.name,
      workspaceInboxScreenshot,
    );

    await page.getByRole("button", { name: "Work inbox", exact: true }).click();
    await page.getByRole("heading", { name: /Work inbox · pi-deck/i }).waitFor({
      state: "detached",
    });
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await page.getByLabel("Prompt text").waitFor();
    await page
      .getByLabel("Prompt text")
      .fill("Review this workspace and summarize the next steps.");
    await page.evaluate((dataBase64) => {
      const bytes = Uint8Array.from(atob(dataBase64), (character) =>
        character.charCodeAt(0),
      );
      const image = new File([bytes], "workspace-reference.png", {
        type: "image/png",
      });
      const clipboard = new DataTransfer();
      clipboard.items.add(image);
      const textarea = document.querySelector(
        'textarea[aria-label="Prompt text"]',
      );
      if (textarea === null) {
        throw new Error("Prompt textarea is unavailable.");
      }
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }, attachmentImageBase64);
    await page.getByText("workspace-reference.png").waitFor();
    const gifOutput = animatedOutputs[0];
    const gifFrames = [];
    const captureGifFrame = async (delay) => {
      gifFrames.push({ screenshot: await page.screenshot(), delay });
    };
    await page.setViewportSize({
      width: gifOutput.width,
      height: gifOutput.height,
    });
    await captureGifFrame(900);
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Abort" }).waitFor();
    await page.locator(".tool-card").waitFor();
    await page
      .locator(".tool-card .tool-title")
      .filter({ hasText: /^read$/ })
      .waitFor();
    await page.getByRole("button", { name: "Steer" }).waitFor();
    await page.getByRole("button", { name: "Follow-up" }).waitFor();
    await captureGifFrame(900);
    await page.waitForTimeout(2_100);
    await captureGifFrame(700);
    await page.waitForTimeout(2_100);
    await captureGifFrame(700);
    await page.waitForTimeout(2_100);
    await captureGifFrame(700);
    await page.getByRole("status").waitFor({ state: "hidden" });
    const conversationOutput = additionalOutputs[1];
    const conversationScreenshot = path.join(root, conversationOutput.name);
    await page.setViewportSize({
      width: conversationOutput.width,
      height: conversationOutput.height,
    });
    await page.screenshot({ path: conversationScreenshot });
    capturedScreenshots.set(conversationOutput.name, conversationScreenshot);
    await page.setViewportSize({
      width: gifOutput.width,
      height: gifOutput.height,
    });
    await page.waitForTimeout(1_800);
    await captureGifFrame(1_400);
    const conversationGif = path.join(root, gifOutput.name);
    fs.writeFileSync(
      conversationGif,
      encodeGif(gifFrames, gifOutput.width, gifOutput.height),
    );
    capturedScreenshots.set(gifOutput.name, conversationGif);

    for (const output of [
      ...siteOutputs,
      ...additionalOutputs,
      ...animatedOutputs,
    ]) {
      const source = capturedScreenshots.get(output.name);
      if (source === undefined) {
        throw new Error(`Missing captured screenshot for ${output.name}`);
      }
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
