/// <reference path="../src/renderer/global.d.ts" />

import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");
const heldDiscoveryTimeoutMs = 120_000;

type DiscoveryMode =
  | "success"
  | "hold"
  | "fail"
  | "model-fail"
  | "thinking-fail"
  | "state-model-fail";

interface HarnessOptions {
  name: string;
  discoveryMode?: DiscoveryMode;
  holdListModels?: boolean;
  failListModels?: boolean;
  ignoreDiscoverySigterm?: boolean;
}

interface Harness {
  app: ElectronApplication;
  page: Page;
  root: string;
  projectCwd: string;
  rpcPidFile: string;
  rpcRequestFile: string;
  rpcReleaseFile: string;
  listPidFile: string;
  listReadyFile: string;
  listReleaseFile: string;
}

function pids(file: string): number[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function lastPid(file: string): number {
  return pids(file).at(-1) ?? 0;
}

function pidCount(file: string): number {
  return pids(file).length;
}

function expectAllExited(file: string): void {
  expect(pids(file).filter(isPidAlive)).toEqual([]);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForPid(file: string): Promise<number> {
  await expect
    .poll(() => lastPid(file), { timeout: 10_000 })
    .toBeGreaterThan(0);
  const pid = lastPid(file);
  expect(isPidAlive(pid)).toBe(true);
  return pid;
}

async function activeWorkspaceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const active = await window.piDeck.workspaces.getActive();
    if (active.activeWorkspace === undefined) {
      throw new Error("Expected an active workspace.");
    }
    return active.activeWorkspace.id;
  });
}

async function launchHarness(options: HarnessOptions): Promise<Harness> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-deck-e2e-model-lifecycle-${options.name}-`),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const rpcPidFile = path.join(root, "rpc-discovery-pids");
  const rpcRequestFile = path.join(root, "rpc-discovery-requested");
  const rpcReleaseFile = path.join(root, "release-rpc-discovery");
  const listPidFile = path.join(root, "list-models-pids");
  const listReadyFile = path.join(root, "list-models-ready");
  const listReleaseFile = path.join(root, "release-list-models");
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

  const fakePi = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    fakePi,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const append = (file, value) => fs.appendFileSync(file, value + "\\n");
const write = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const waitForRelease = (file) => setInterval(() => {
  if (fs.existsSync(file)) process.exit(0);
}, 10);
if (argv.includes("--version")) {
  console.log("v42.5.0");
  process.exit(0);
}
if (argv.includes("--list-models")) {
  if (process.env.MODEL_LIFECYCLE_IGNORE_DISCOVERY_SIGTERM === "1") {
    process.on("SIGTERM", () => {});
  }
  append(process.env.MODEL_LIFECYCLE_LIST_PID_FILE, String(process.pid));
  append(process.env.MODEL_LIFECYCLE_LIST_READY_FILE, String(process.pid));
  if (process.env.MODEL_LIFECYCLE_FAIL_LIST === "1") {
    process.stderr.write("intentional list-models failure\\n");
    process.exit(43);
  }
  if (process.env.MODEL_LIFECYCLE_HOLD_LIST === "1") {
    waitForRelease(process.env.MODEL_LIFECYCLE_LIST_RELEASE_FILE);
    setInterval(() => undefined, 1 << 30);
    return;
  }
  console.log("provider  model          context  max-out  thinking  images");
  console.log("fallback  fallback-one   64K      16K      yes       no");
  console.log("runtime   runtime-one    128K     32K      yes       no");
  process.exit(0);
}
if (argv.includes("--mode") && argv.includes("rpc") && argv.includes("--no-session")) {
  append(process.env.MODEL_LIFECYCLE_RPC_PID_FILE, String(process.pid));
  if (process.env.MODEL_LIFECYCLE_IGNORE_DISCOVERY_SIGTERM === "1") {
    process.on("SIGTERM", () => {});
  }
  if (process.env.MODEL_LIFECYCLE_DISCOVERY_MODE === "fail") {
    process.stderr.write("intentional runtime discovery failure\\n");
    process.exit(42);
  }
  let buffer = "";
  let heldStateRequest;
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\\n");
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      if (request.type === "get_state") {
        append(process.env.MODEL_LIFECYCLE_RPC_REQUEST_FILE, String(process.pid));
        if (process.env.MODEL_LIFECYCLE_DISCOVERY_MODE === "hold") continue;
        if (process.env.MODEL_LIFECYCLE_DISCOVERY_MODE === "model-fail") {
          heldStateRequest = request;
          continue;
        }
        if (process.env.MODEL_LIFECYCLE_DISCOVERY_MODE === "state-model-fail") {
          write({ type: "response", id: request.id, command: "get_state", success: false, error: "intentional state failure" });
          continue;
        }
        write({ type: "response", id: request.id, command: "get_state", success: true, data: { model: "runtime-one", provider: "runtime", thinkingLevel: "medium" } });
      } else if (request.type === "get_available_models") {
        if (process.env.MODEL_LIFECYCLE_DISCOVERY_MODE === "model-fail") {
          write({ type: "response", id: request.id, command: "get_available_models", success: false, error: "intentional model inventory failure" });
          write({ type: "response", id: heldStateRequest.id, command: "get_state", success: true, data: { model: "runtime-one", provider: "runtime", thinkingLevel: "medium" } });
          heldStateRequest = undefined;
        } else if (process.env.MODEL_LIFECYCLE_DISCOVERY_MODE === "state-model-fail") {
          write({ type: "response", id: request.id, command: "get_available_models", success: false, error: "intentional model inventory failure" });
        } else {
          write({ type: "response", id: request.id, command: "get_available_models", success: true, data: { models: [{ id: "runtime-one", name: "Runtime One", provider: "runtime", reasoning: true, input: ["text"] }] } });
        }
      } else if (request.type === "get_available_thinking_levels") {
        if (process.env.MODEL_LIFECYCLE_DISCOVERY_MODE === "thinking-fail") {
          write({ type: "response", id: request.id, command: "get_available_thinking_levels", success: false, error: "intentional thinking-level failure" });
        } else {
          write({ type: "response", id: request.id, command: "get_available_thinking_levels", success: true, data: { levels: ["off", "medium", "high"] } });
        }
      } else {
        write({ type: "response", id: request.id, command: request.type, success: true });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  waitForRelease(process.env.MODEL_LIFECYCLE_RPC_RELEASE_FILE);
  return;
}
process.argv.push("--extra-model");
require(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});
`,
    { mode: 0o755 },
  );

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_E2E_TEST: "1",
      PI_DECK_E2E_HIDE_WINDOWS: process.env.PI_DECK_E2E_HIDE_WINDOWS ?? "1",
      PI_DECK_BACKEND: "real",
      PI_DECK_PI_BINARY: fakePi,
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_DECK_HOME: path.join(root, "pideck-home"),
      PI_DECK_USER_DATA_DIR: userDataDir,
      PI_DECK_REAL_RPC_TIMEOUT_MS: String(heldDiscoveryTimeoutMs),
      MODEL_LIFECYCLE_DISCOVERY_MODE: options.discoveryMode ?? "success",
      MODEL_LIFECYCLE_HOLD_LIST: options.holdListModels ? "1" : "0",
      MODEL_LIFECYCLE_FAIL_LIST: options.failListModels ? "1" : "0",
      MODEL_LIFECYCLE_IGNORE_DISCOVERY_SIGTERM: options.ignoreDiscoverySigterm
        ? "1"
        : "0",
      MODEL_LIFECYCLE_RPC_PID_FILE: rpcPidFile,
      MODEL_LIFECYCLE_RPC_REQUEST_FILE: rpcRequestFile,
      MODEL_LIFECYCLE_RPC_RELEASE_FILE: rpcReleaseFile,
      MODEL_LIFECYCLE_LIST_PID_FILE: listPidFile,
      MODEL_LIFECYCLE_LIST_READY_FILE: listReadyFile,
      MODEL_LIFECYCLE_LIST_RELEASE_FILE: listReleaseFile,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("Preload error")).toHaveCount(0);
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();

  return {
    app,
    page,
    root,
    projectCwd,
    rpcPidFile,
    rpcRequestFile,
    rpcReleaseFile,
    listPidFile,
    listReadyFile,
    listReleaseFile,
  };
}

async function closeHarness(harness: Harness): Promise<void> {
  fs.writeFileSync(harness.rpcReleaseFile, "release\n");
  fs.writeFileSync(harness.listReleaseFile, "release\n");
  await closeAppWithBound(harness.app).catch(() => "timeout" as const);
  for (const file of [harness.rpcPidFile, harness.listPidFile]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const pid = Number(line.trim());
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Best-effort orphan cleanup for failing regression runs.
        }
      }
    }
  }
  fs.rmSync(harness.root, { recursive: true, force: true });
}

function startRendererModelDiscovery(
  page: Page,
  workspaceId: string,
): Promise<void> {
  return page.evaluate((id) => {
    type Models = Awaited<ReturnType<typeof window.piDeck.chat.listModels>>;
    type Outcome = { ok: true; value: Models } | { ok: false; error: string };
    const target = window as typeof window & {
      issue144Discovery?: { settled: boolean; outcome?: Outcome };
    };
    target.issue144Discovery = { settled: false };
    void window.piDeck.chat
      .listModels({ workspaceId: id })
      .then((value): Outcome => ({ ok: true, value }))
      .catch(
        (error): Outcome => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((outcome) => {
        target.issue144Discovery = { settled: true, outcome };
      });
  }, workspaceId);
}

async function discoveryOutcome(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          issue144Discovery?: { settled: boolean; outcome?: unknown };
        }
      ).issue144Discovery,
  );
}

async function closeAppWithBound(
  app: ElectronApplication,
): Promise<"closed" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      app.close().then(() => "closed" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function startRendererReset(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Snapshot = Awaited<ReturnType<typeof window.piDeck.chat.reset>>;
    type Outcome =
      | {
          ok: true;
          runtimeId: string;
          currentRuntimeId: string;
          replacementUsable: boolean;
        }
      | { ok: false; error: string };
    const target = window as typeof window & {
      issue144Reset?: { settled: boolean; outcome?: Outcome };
    };
    target.issue144Reset = { settled: false };
    void window.piDeck.chat
      .reset()
      .then(async (value: Snapshot): Promise<Outcome> => {
        const current = await window.piDeck.chat.getSnapshot();
        return {
          ok: true,
          runtimeId: value.runtimeId,
          currentRuntimeId: current.runtimeId,
          replacementUsable: current.runtimeId === value.runtimeId,
        };
      })
      .catch(
        (error): Outcome => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((outcome) => {
        target.issue144Reset = { settled: true, outcome };
      });
  });
}

async function resetOutcome(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          issue144Reset?: { settled: boolean; outcome?: unknown };
        }
      ).issue144Reset,
  );
}

test("quit kills held RPC model discovery before temp cleanup and does not spawn --list-models fallback", async () => {
  const harness = await launchHarness({
    name: "quit-rpc",
    discoveryMode: "hold",
    ignoreDiscoverySigterm: true,
  });
  try {
    // Bootstrap alone must be owned even though no session has been attached.
    const pid = await waitForPid(harness.rpcRequestFile);
    expect(pidCount(harness.listPidFile)).toBe(0);

    const closeResult = await closeAppWithBound(harness.app);
    const aliveAfterClose = isPidAlive(pid);
    expect.soft(closeResult).toBe("closed");
    expect(aliveAfterClose).toBe(false);
    expect(pidCount(harness.listPidFile)).toBe(0);
  } finally {
    await closeHarness(harness);
  }
});

test("reset cancels held RPC model discovery without fallback and replacement worker remains usable", async () => {
  const harness = await launchHarness({
    name: "reset-rpc",
    discoveryMode: "hold",
  });
  try {
    const workspaceId = await activeWorkspaceId(harness.page);
    await startRendererModelDiscovery(harness.page, workspaceId);
    await expect.poll(() => pidCount(harness.rpcRequestFile)).toBe(2);
    expect(pids(harness.rpcPidFile).every(isPidAlive)).toBe(true);
    expect(pidCount(harness.listPidFile)).toBe(0);

    await startRendererReset(harness.page);
    await expect
      .poll(() => resetOutcome(harness.page), { timeout: 10_000 })
      .toMatchObject({ settled: true });
    const reset = await resetOutcome(harness.page);

    expect(reset).toMatchObject({
      settled: true,
      outcome: { ok: true, replacementUsable: true },
    });
    expect(reset).toEqual(
      expect.objectContaining({
        outcome: expect.objectContaining({
          currentRuntimeId: expect.any(String),
          runtimeId: expect.any(String),
        }),
      }),
    );
    // No eventual-exit polling: reset must already have awaited every child.
    expectAllExited(harness.rpcPidFile);
    expect(pidCount(harness.listPidFile)).toBe(0);
    await expect
      .poll(() => discoveryOutcome(harness.page))
      .toMatchObject({
        settled: true,
        outcome: { ok: false },
      });
  } finally {
    await closeHarness(harness);
  }
});

test("quit kills held --list-models fallback after RPC discovery failure", async () => {
  const harness = await launchHarness({
    name: "quit-fallback",
    discoveryMode: "fail",
    holdListModels: true,
    ignoreDiscoverySigterm: true,
  });
  try {
    const pid = await waitForPid(harness.listReadyFile);
    expect(pidCount(harness.rpcPidFile)).toBe(1);

    const closeResult = await closeAppWithBound(harness.app);
    const aliveAfterClose = isPidAlive(pid);
    expect.soft(closeResult).toBe("closed");
    expect(aliveAfterClose).toBe(false);
  } finally {
    await closeHarness(harness);
  }
});

test("reset cancels held --list-models fallback and replacement worker remains usable", async () => {
  const harness = await launchHarness({
    name: "reset-fallback",
    discoveryMode: "fail",
    holdListModels: true,
  });
  try {
    const workspaceId = await activeWorkspaceId(harness.page);
    await startRendererModelDiscovery(harness.page, workspaceId);
    await expect.poll(() => pidCount(harness.listReadyFile)).toBe(2);
    expect(pids(harness.listPidFile).every(isPidAlive)).toBe(true);

    await startRendererReset(harness.page);
    await expect
      .poll(() => resetOutcome(harness.page), { timeout: 10_000 })
      .toMatchObject({ settled: true });
    const reset = await resetOutcome(harness.page);

    expect(reset).toMatchObject({
      settled: true,
      outcome: { ok: true, replacementUsable: true },
    });
    expect(reset).toEqual(
      expect.objectContaining({
        outcome: expect.objectContaining({
          currentRuntimeId: expect.any(String),
          runtimeId: expect.any(String),
        }),
      }),
    );
    expectAllExited(harness.rpcPidFile);
    expectAllExited(harness.listPidFile);
    await expect
      .poll(() => discoveryOutcome(harness.page))
      .toMatchObject({
        settled: true,
        outcome: { ok: false },
      });
  } finally {
    await closeHarness(harness);
  }
});

test("optional thinking-level RPC failure keeps valid state and inventory without CLI fallback", async () => {
  const harness = await launchHarness({
    name: "thinking-level-rpc-failure",
    discoveryMode: "thinking-fail",
    failListModels: true,
  });
  try {
    await expect.poll(() => pidCount(harness.rpcPidFile)).toBe(1);
    await expect
      .poll(() => pids(harness.rpcPidFile).filter(isPidAlive))
      .toEqual([]);
    expect(pidCount(harness.listPidFile)).toBe(0);

    await harness.page
      .getByLabel("Sessions", { exact: true })
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const configuration = harness.page.locator(".pi-configuration-trigger");
    await expect(configuration).toHaveAttribute("data-model-id", "runtime-one");
    await expect(configuration).toHaveAttribute(
      "data-model-provider",
      "runtime",
    );
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );

    const result = await harness.page.evaluate(
      (workspaceId) => window.piDeck.chat.listModels({ workspaceId }),
      await activeWorkspaceId(harness.page),
    );
    expect(result).toMatchObject({
      models: [
        expect.objectContaining({ id: "runtime-one", provider: "runtime" }),
      ],
      activeModel: { id: "runtime-one", provider: "runtime" },
      thinkingLevel: "medium",
      thinkingLevels: [],
    });
    expect(pidCount(harness.rpcPidFile)).toBe(2);
    expect(pidCount(harness.listPidFile)).toBe(0);
    expectAllExited(harness.rpcPidFile);
  } finally {
    await closeHarness(harness);
  }
});

test("failed CLI inventory preserves usable authoritative RPC state", async () => {
  const harness = await launchHarness({
    name: "rpc-state-cli-failure",
    discoveryMode: "model-fail",
    failListModels: true,
  });
  try {
    await expect.poll(() => pidCount(harness.rpcPidFile)).toBe(1);
    await expect.poll(() => pidCount(harness.listPidFile)).toBe(1);
    await expect
      .poll(() => pids(harness.rpcPidFile).filter(isPidAlive))
      .toEqual([]);
    await expect
      .poll(() => pids(harness.listPidFile).filter(isPidAlive))
      .toEqual([]);

    await harness.page
      .getByLabel("Sessions", { exact: true })
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const configuration = harness.page.locator(".pi-configuration-trigger");
    await expect(configuration).toHaveAttribute("data-model-id", "runtime-one");
    await expect(configuration).toHaveAttribute(
      "data-model-provider",
      "runtime",
    );
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );

    const result = await harness.page.evaluate(
      (workspaceId) => window.piDeck.chat.listModels({ workspaceId }),
      await activeWorkspaceId(harness.page),
    );
    expect(result).toEqual({
      models: [],
      activeModel: {
        id: "runtime-one",
        name: "runtime-one",
        provider: "runtime",
      },
      thinkingLevel: "medium",
      thinkingLevels: ["off", "medium", "high"],
    });
    expect(pidCount(harness.rpcPidFile)).toBe(2);
    expect(pidCount(harness.listPidFile)).toBe(2);
    expectAllExited(harness.rpcPidFile);
    expectAllExited(harness.listPidFile);
  } finally {
    await closeHarness(harness);
  }
});

test("state and inventory plus CLI failure surfaces an explicit discovery error", async () => {
  const harness = await launchHarness({
    name: "all-model-discovery-failed",
    discoveryMode: "state-model-fail",
    failListModels: true,
  });
  try {
    await expect.poll(() => pidCount(harness.rpcPidFile)).toBe(1);
    await expect.poll(() => pidCount(harness.listPidFile)).toBe(1);
    await expect
      .poll(() => pids(harness.rpcPidFile).filter(isPidAlive))
      .toEqual([]);
    await expect
      .poll(() => pids(harness.listPidFile).filter(isPidAlive))
      .toEqual([]);

    const outcome = await harness.page.evaluate(
      async (workspaceId) => {
        try {
          const result = await window.piDeck.chat.listModels({ workspaceId });
          return { ok: true as const, result };
        } catch (error) {
          return {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      await activeWorkspaceId(harness.page),
    );
    expect(outcome).toEqual({
      ok: false,
      error: expect.stringContaining(
        "runtime RPC returned no usable inventory or authoritative state",
      ),
    });
    expect(pidCount(harness.rpcPidFile)).toBe(2);
    expect(pidCount(harness.listPidFile)).toBe(2);
    expectAllExited(harness.rpcPidFile);
    expectAllExited(harness.listPidFile);
  } finally {
    await closeHarness(harness);
  }
});

test("partial RPC discovery keeps state defaults while CLI supplies failed inventory", async () => {
  const harness = await launchHarness({
    name: "partial-rpc-fallback",
    discoveryMode: "model-fail",
  });
  try {
    await expect.poll(() => pidCount(harness.rpcPidFile)).toBe(1);
    await expect.poll(() => pidCount(harness.listPidFile)).toBe(1);
    await expect
      .poll(() => pids(harness.rpcPidFile).filter(isPidAlive))
      .toEqual([]);
    await expect
      .poll(() => pids(harness.listPidFile).filter(isPidAlive))
      .toEqual([]);

    await harness.page
      .getByLabel("Sessions", { exact: true })
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const configuration = harness.page.locator(".pi-configuration-trigger");
    await expect(configuration).toHaveAttribute("data-model-id", "runtime-one");
    await expect(configuration).toHaveAttribute(
      "data-model-provider",
      "runtime",
    );
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );

    const result = await harness.page.evaluate(
      (workspaceId) => window.piDeck.chat.listModels({ workspaceId }),
      await activeWorkspaceId(harness.page),
    );
    expect(result.models.map((model) => model.id)).toContain("fallback-one");
    expect(result.activeModel).toMatchObject({
      id: "runtime-one",
      provider: "runtime",
    });
    expect(result.thinkingLevel).toBe("medium");
    expect(result.thinkingLevels).toEqual(["off", "medium", "high"]);
    expect(pidCount(harness.rpcPidFile)).toBe(2);
    expect(pidCount(harness.listPidFile)).toBe(2);
    expectAllExited(harness.rpcPidFile);
    expectAllExited(harness.listPidFile);
  } finally {
    await closeHarness(harness);
  }
});

test("model discovery succeeds through RPC and falls back to --list-models after RPC failure", async () => {
  const rpcHarness = await launchHarness({ name: "success-rpc" });
  try {
    await expect.poll(() => pidCount(rpcHarness.rpcPidFile)).toBe(1);
    await expect
      .poll(() => pids(rpcHarness.rpcPidFile).filter(isPidAlive))
      .toEqual([]);
    const result = await rpcHarness.page.evaluate(
      (workspaceId) => window.piDeck.chat.listModels({ workspaceId }),
      await activeWorkspaceId(rpcHarness.page),
    );
    expect(result.models.map((model) => model.id)).toContain("runtime-one");
    expect(result.activeModel?.id).toBe("runtime-one");
    expect(pidCount(rpcHarness.rpcPidFile)).toBe(2);
    expectAllExited(rpcHarness.rpcPidFile);
    expect(pidCount(rpcHarness.listPidFile)).toBe(0);
  } finally {
    await closeHarness(rpcHarness);
  }

  const fallbackHarness = await launchHarness({
    name: "success-fallback",
    discoveryMode: "fail",
  });
  try {
    await expect.poll(() => pidCount(fallbackHarness.listPidFile)).toBe(1);
    await expect
      .poll(() => pids(fallbackHarness.listPidFile).filter(isPidAlive))
      .toEqual([]);
    const result = await fallbackHarness.page.evaluate(
      (workspaceId) => window.piDeck.chat.listModels({ workspaceId }),
      await activeWorkspaceId(fallbackHarness.page),
    );
    expect(result.models.map((model) => model.id)).toContain("fallback-one");
    expect(pidCount(fallbackHarness.listPidFile)).toBe(2);
    expectAllExited(fallbackHarness.rpcPidFile);
    expectAllExited(fallbackHarness.listPidFile);
  } finally {
    await closeHarness(fallbackHarness);
  }
});
