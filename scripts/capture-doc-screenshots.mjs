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
const featureOutputs = [
  {
    name: "pi-deck-models.png",
    width: 1193,
    height: 776,
  },
  {
    name: "pi-deck-appearance.png",
    width: 1193,
    height: 776,
  },
  {
    name: "pi-deck-extension.png",
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
  // Keep the production real-mode UI/backend wiring while substituting a
  // deterministic, production-shaped fake Pi RPC process. This capture never
  // invokes an installed Pi executable or contacts a model provider.
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
  console.log("anthropic  claude-sonnet-4.5  200K     32K      yes       yes");
  console.log("openai     gpt-5-codex       128K     32K      yes       no");
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

function writeAttachmentFixture(file) {
  const image = new PNG({ width: 160, height: 90 });
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = 28 + Math.round((x / image.width) * 35);
      image.data[offset + 1] = 78 + Math.round((y / image.height) * 60);
      image.data[offset + 2] = 121;
      image.data[offset + 3] = 255;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(image));
}

async function waitForReady(page) {
  await page.waitForSelector('.workspace[data-load-state="ready"]');
  await page.getByTestId("workspace-tree").waitFor();
}

async function captureExtensionScreenshot(root, output) {
  const extensionRoot = path.join(root, "extension-capture");
  const projectCwd = path.join(extensionRoot, "project");
  const agentDir = path.join(extensionRoot, "agent");
  const sessionDir = path.join(extensionRoot, "sessions");
  const userDataDir = path.join(extensionRoot, "user-data");
  const piDeckHome = path.join(extensionRoot, "pideck-home");
  for (const directory of [projectCwd, agentDir, sessionDir, userDataDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    `${JSON.stringify({ theme: "dark" })}\n`,
  );

  const app = await electron.launch({
    executablePath: electronPath,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_BACKEND: "real",
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      PI_DECK_PI_BINARY: createFakePiBinary(extensionRoot, [
        "--prompt-scenario",
        "extension-ui",
        "--stream-delay-ms",
        "400",
        "--production-shaped",
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
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await page.locator('.workspace[data-primary-view="session"]').waitFor();
    await page
      .getByLabel("Prompt text")
      .fill("Approve this extension request.");
    await page.getByRole("button", { name: "Send" }).click();
    await page
      .getByText("Allow Pi to continue with this workspace action?", {
        exact: true,
      })
      .waitFor();
    await page.getByRole("button", { name: "Confirm", exact: true }).waitFor();
    await page
      .locator(".session-item")
      .filter({ hasText: "Waiting · extension input required" })
      .waitFor();
    await page.setViewportSize({
      width: output.width,
      height: output.height,
    });
    const screenshot = path.join(root, output.name);
    await page.screenshot({ path: screenshot });
    return screenshot;
  } finally {
    await app.close();
  }
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
    {
      file: path.join(sessionDir, "release-review.jsonl"),
      id: "release-review-session",
      title: "validate the unified Work release.",
      ageMs: 12 * 60 * 1000,
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
  const attachmentFixture = path.join(root, "workspace-reference.png");
  writeAttachmentFixture(attachmentFixture);
  const attachmentImageBase64 = fs.readFileSync(attachmentFixture, "base64");

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
        "--extra-model",
        "--production-shaped",
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

        const review = await api.workspaces.create({
          name: "release-review",
        });
        const reviewWorkspace = review.activeWorkspace;
        if (!reviewWorkspace) {
          throw new Error("Could not create the release-review workspace.");
        }

        for (const [index, sessionFile] of sessionFiles.entries()) {
          await api.workspaces.addSession({
            workspaceId:
              index === sessionFiles.length - 1
                ? reviewWorkspace.id
                : projectWorkspace.id,
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
          reviewWorkspaceId: reviewWorkspace.id,
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
    await page.waitForFunction(
      (workspaceId) =>
        document.querySelector(
          `[data-workspace-id="${workspaceId}"] .workspace-tree-count`,
        )?.textContent === "1",
      workspaceIds.reviewWorkspaceId,
    );
    await page.getByRole("status").waitFor({ state: "hidden" });

    // Fresh launches open at All Work. Capture the workspace shell from the
    // existing session surface before returning to the global Work overview.
    await page
      .locator(".activity-inbox-row")
      .filter({
        hasText: "read this repo and come up with 3 next roadmap items.",
      })
      .click();
    await page.locator('.workspace[data-primary-view="session"]').waitFor();
    await page.getByLabel(/Model and thinking\. Current model:/).click();
    await page
      .getByRole("menu", { name: "Model and thinking options" })
      .waitFor();
    const modelMenuItem = page.getByRole("menuitem", {
      name: "Claude Sonnet 4.5",
      exact: true,
    });
    await modelMenuItem.waitFor();
    await modelMenuItem.hover();
    await page.getByRole("menu", { name: "Available Pi models" }).waitFor();
    const modelOutput = featureOutputs[0];
    await page.setViewportSize({
      width: modelOutput.width,
      height: modelOutput.height,
    });
    const modelScreenshot = path.join(root, modelOutput.name);
    await page.screenshot({ path: modelScreenshot });
    const capturedScreenshots = new Map();
    capturedScreenshots.set(modelOutput.name, modelScreenshot);
    await page
      .getByRole("menuitemradio", { name: "high", exact: true })
      .click();
    await page.getByRole("status").waitFor({ state: "hidden" });

    const appearanceTrigger = page.getByRole("button", {
      name: "Appearance: Dark",
    });
    await appearanceTrigger.click();
    await page.getByRole("menu", { name: "Appearance options" }).waitFor();
    const appearanceOutput = featureOutputs[1];
    await page.setViewportSize({
      width: appearanceOutput.width,
      height: appearanceOutput.height,
    });
    const appearanceScreenshot = path.join(root, appearanceOutput.name);
    await page.screenshot({ path: appearanceScreenshot });
    capturedScreenshots.set(appearanceOutput.name, appearanceScreenshot);
    await page.keyboard.press("Escape");

    const workspaceOutput = siteOutputs[0];
    const workspaceScreenshot = path.join(root, workspaceOutput.name);
    await page.setViewportSize({
      width: workspaceOutput.width,
      height: workspaceOutput.height,
    });
    await page.screenshot({ path: workspaceScreenshot });
    capturedScreenshots.set(workspaceOutput.name, workspaceScreenshot);

    const allWorkOutput = siteOutputs[1];
    await page.getByRole("button", { name: /^All Work/ }).click();
    await page
      .getByRole("heading", { name: "All Work", exact: true })
      .waitFor();
    await page.getByRole("status").waitFor({ state: "hidden" });
    await page
      .getByRole("complementary", { name: "Sessions" })
      .getByLabel("Hide sessions")
      .click();
    await page
      .getByRole("complementary", { name: "Sessions" })
      .waitFor({ state: "detached" });
    await page.setViewportSize({
      width: allWorkOutput.width,
      height: allWorkOutput.height,
    });
    const allWorkScreenshot = path.join(root, allWorkOutput.name);
    await page.screenshot({ path: allWorkScreenshot });
    capturedScreenshots.set(allWorkOutput.name, allWorkScreenshot);

    await page.getByLabel("Show sessions").click();
    await page.getByRole("complementary", { name: "Sessions" }).waitFor();
    await page
      .locator(".activity-inbox-row")
      .filter({
        hasText: "read this repo and come up with 3 next roadmap items.",
      })
      .click();
    await page.locator('.workspace[data-primary-view="session"]').waitFor();
    await page.getByRole("button", { name: "Workspace: pi-deck" }).click();
    await page
      .getByRole("heading", { name: "pi-deck Work", exact: true })
      .waitFor();
    await page.getByRole("status").waitFor({ state: "hidden" });
    const workspaceWorkOutput = additionalOutputs[0];
    const workspaceWorkScreenshot = path.join(root, workspaceWorkOutput.name);
    await page.setViewportSize({
      width: workspaceWorkOutput.width,
      height: workspaceWorkOutput.height,
    });
    await page.screenshot({ path: workspaceWorkScreenshot });
    capturedScreenshots.set(workspaceWorkOutput.name, workspaceWorkScreenshot);

    await page
      .getByRole("complementary", { name: "Sessions" })
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

    const extensionOutput = featureOutputs[2];
    capturedScreenshots.set(
      extensionOutput.name,
      await captureExtensionScreenshot(root, extensionOutput),
    );

    for (const output of [
      ...siteOutputs,
      ...additionalOutputs,
      ...featureOutputs,
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
