import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { _electron as electron } from "playwright";
import gifenc from "gifenc";
import { PNG } from "pngjs";

const { applyPalette, GIFEncoder, quantize } = gifenc;
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const mainEntry = path.join(repoRoot, "dist/main/main.js");
const outputs = [
  { name: "pi-deck-workflow-builder.png", width: 1193, height: 776 },
  { name: "pi-deck-workflow-run.png", width: 1193, height: 776 },
  { name: "pi-deck-multitasking.png", width: 1193, height: 776 },
  { name: "pi-deck-workflow-run.gif", width: 896, height: 582 },
];

function resolvePiBinary() {
  const candidate = process.env.PI_DECK_PI_BINARY || "/usr/local/bin/pi";
  if (!fs.existsSync(candidate)) {
    throw new Error(`Pi executable not found: ${candidate}`);
  }
  return candidate;
}

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

async function waitForReady(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector('.workspace[data-load-state="ready"]');
  await page.getByTestId("workspace-tree").waitFor();
}

async function createCaptureWorkflow(page) {
  const ids = {
    workflow: crypto.randomUUID(),
    worker: crypto.randomUUID(),
    checkpoint: crypto.randomUUID(),
    workerRoute: crypto.randomUUID(),
    approvedRoute: crypto.randomUUID(),
    rejectedRoute: crypto.randomUUID(),
  };
  await page.evaluate(
    async (definition) => {
      const active = await window.piDeck.workspaces.getActive();
      if (!active.activeWorkspace) throw new Error("No active workspace");
      await window.piDeck.workflows.createWorkflow({
        workspaceId: active.activeWorkspace.id,
        scopeWorkspaceId: null,
        workflow: definition,
      });
    },
    {
      format: "pi-deck.agent-workflow",
      schemaVersion: 2,
      id: ids.workflow,
      revision: 1,
      name: "Real Pi release review",
      description: "Use a Pi worker, then pause for a human release decision.",
      inputs: [],
      entryNodeId: ids.worker,
      nodes: [
        {
          id: ids.worker,
          name: "Summarize the release",
          role: "worker",
          config: {
            instructions:
              "Reply with exactly: The release review is ready for approval.",
            expectedOutput: "A concise release-review handoff.",
          },
        },
        {
          id: ids.checkpoint,
          name: "Approve the release",
          role: "human",
          config: {
            interaction: "approval",
            prompt: "Should this release move forward?",
          },
        },
      ],
      relationships: [
        {
          id: ids.workerRoute,
          from: ids.worker,
          to: { nodeId: ids.checkpoint },
        },
        {
          id: ids.approvedRoute,
          from: ids.checkpoint,
          when: { equals: true },
          to: { end: "approved" },
        },
        {
          id: ids.rejectedRoute,
          from: ids.checkpoint,
          when: { equals: false },
          to: { end: "rejected" },
        },
      ],
    },
  );
  return ids;
}

async function copyOutputs(captured) {
  for (const output of outputs) {
    const source = captured.get(output.name);
    if (!source) throw new Error(`Missing capture: ${output.name}`);
    for (const directory of [
      path.join(repoRoot, "docs/assets"),
      path.join(repoRoot, "site/assets"),
    ]) {
      fs.copyFileSync(source, path.join(directory, output.name));
    }
    console.log(`${output.name}: ${source}`);
  }
}

async function main() {
  if (process.env.PI_DECK_CAPTURE_REAL_PI !== "1") {
    throw new Error(
      "Refusing to contact a model provider. Re-run with PI_DECK_CAPTURE_REAL_PI=1.",
    );
  }
  if (!fs.existsSync(mainEntry)) {
    throw new Error("Build Pi Deck first with: npm run build");
  }

  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-real-doc-capture-"),
  );
  const projectCwd = path.join(root, "project");
  const userDataDir = path.join(root, "user-data");
  const piDeckHome = path.join(root, "pideck-home");
  const sessionDir = path.join(root, "sessions");
  for (const directory of [projectCwd, userDataDir, piDeckHome, sessionDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const app = await electron.launch({
    executablePath: electronPath,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_BACKEND: "real",
      PI_DECK_E2E_HIDE_WINDOWS: "1",
      // Explicitly clear compatibility switches so inherited shell state
      // cannot redirect this capture away from the shipped planner.
      PI_DECK_E2E_DELEGATE_HARNESS: "",
      PI_DECK_ENABLE_LEGACY_DELEGATE_BRIDGE: "",
      PI_DECK_E2E_TASK_SESSION_ACCEPTANCE: "",
      PI_DECK_TEST_TASK_ROUTING_FIXTURE: "",
      PI_DECK_PI_BINARY: resolvePiBinary(),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_DECK_USER_DATA_DIR: userDataDir,
      PI_DECK_HOME: piDeckHome,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
    },
  });

  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    const ids = await createCaptureWorkflow(page);
    const captured = new Map();

    await page.getByRole("button", { name: "Agent Workflows" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Workflow name").waitFor();
    const builder = outputs[0];
    await page.setViewportSize({
      width: builder.width,
      height: builder.height,
    });
    const builderPath = path.join(root, builder.name);
    await page.screenshot({ path: builderPath });
    captured.set(builder.name, builderPath);

    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Start run" }).click();
    const liveRun = page.getByRole("region", { name: "Workflow run" });
    await liveRun.waitFor();

    const gifOutput = outputs[3];
    await page.setViewportSize({
      width: gifOutput.width,
      height: gifOutput.height,
    });
    const gifFrames = [];
    const captureFrame = async (delay) => {
      gifFrames.push({ screenshot: await page.screenshot(), delay });
    };
    await captureFrame(900);
    await page.waitForTimeout(1_500);
    await captureFrame(1_000);
    await page
      .getByRole("heading", { name: "Waiting for your input" })
      .waitFor({
        timeout: Number(process.env.PI_DECK_REAL_PROMPT_TIMEOUT_MS ?? 180_000),
      });
    await captureFrame(1_700);
    const gifPath = path.join(root, gifOutput.name);
    fs.writeFileSync(
      gifPath,
      encodeGif(gifFrames, gifOutput.width, gifOutput.height),
    );
    captured.set(gifOutput.name, gifPath);

    const run = outputs[1];
    await page.setViewportSize({ width: run.width, height: run.height });
    const runPath = path.join(root, run.name);
    await page.screenshot({ path: runPath });
    captured.set(run.name, runPath);

    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: /^All Work/ }).click();
    await page
      .getByRole("heading", { name: "All Work", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Close All Work", exact: true })
      .click();
    await page.getByLabel("Prompt text").waitFor();
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await page
      .getByLabel("Prompt text")
      .fill("Reply with exactly: Parent session ready.");
    await page.getByRole("button", { name: "Send" }).click();
    await page
      .getByText("Parent session ready.")
      .first()
      .waitFor({
        timeout: Number(process.env.PI_DECK_REAL_PROMPT_TIMEOUT_MS ?? 180_000),
      });

    const multitaskControl = page.locator(".multitask-control");
    await multitaskControl.click();
    await page.evaluate(() => {
      const captureWindow = window;
      captureWindow.__piDeckCapturePlannerStates = [];
      captureWindow.__piDeckCapturePlannerUnsubscribe?.();
      captureWindow.__piDeckCapturePlannerUnsubscribe =
        window.piDeck.multitask.onState((state) =>
          captureWindow.__piDeckCapturePlannerStates.push(state),
        );
    });
    await page
      .getByLabel("Prompt text")
      .fill(
        "Run exactly three independent release checks in parallel: the first replies with exactly ALPHA, the second replies with exactly BETA, and the third replies with exactly GAMMA. Then report their combined result.",
      );
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForFunction(
      () =>
        window.__piDeckCapturePlannerStates?.some(
          (state) => state.tasks?.length === 3,
        ),
      undefined,
      {
        timeout: Number(process.env.PI_DECK_REAL_PLANNER_TIMEOUT_MS ?? 180_000),
      },
    );
    await multitaskControl.focus();
    await page.getByRole("list", { name: "Task statuses" }).waitFor();
    const multitask = outputs[2];
    await page.setViewportSize({
      width: multitask.width,
      height: multitask.height,
    });
    const multitaskPath = path.join(root, multitask.name);
    await page.screenshot({ path: multitaskPath });
    captured.set(multitask.name, multitaskPath);

    await copyOutputs(captured);
    console.log(`Real Pi sessions were isolated under ${root}.`);
  } finally {
    await app.close();
    if (process.env.PI_DECK_CAPTURE_KEEP_ARTIFACTS !== "1") {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      console.log(`Capture artifacts retained at ${root}.`);
    }
  }
}

await main();
