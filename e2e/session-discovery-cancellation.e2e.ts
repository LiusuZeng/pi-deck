import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");
const heldGetStateMs = 120_000;

interface Harness {
  app: ElectronApplication;
  page: Page;
  root: string;
  projectCwd: string;
  getStateEnabledFile: string;
  getStateBarrierDir: string;
  getStateSignalFile: string;
  exitSignalFile: string;
}

function canonicalSessionIdentity(sessionFile: string): string {
  let candidate = path.resolve(sessionFile);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(candidate), ...missingSegments);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(sessionFile);
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function persistedSessionIdentities(storeFile: string): string[] {
  if (!fs.existsSync(storeFile)) return [];
  const store = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
    sessionRefs?: Array<{ sessionFile: string }>;
  };
  return (store.sessionRefs ?? []).map((ref) =>
    canonicalSessionIdentity(ref.sessionFile),
  );
}

function exitedSessionIdentities(exitSignalFile: string): string[] {
  if (!fs.existsSync(exitSignalFile)) return [];
  return fs
    .readFileSync(exitSignalFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(canonicalSessionIdentity);
}

async function launchHarness(name: string): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-deck-e2e-${name}-`));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const getStateEnabledFile = path.join(root, "delay-get-state-enabled");
  const getStateBarrierDir = path.join(root, "get-state-barrier");
  const getStateSignalFile = path.join(root, "get-state-started");
  const exitSignalFile = path.join(root, "worker-exited");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(getStateBarrierDir, { recursive: true });
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
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) {\n  console.log("v42.5.0");\n  process.exit(0);\n}\nif (process.argv.includes("--list-models")) {\n  console.log("provider model context max-out thinking images");\n  console.log("fake-provider fake-model 128K 32K yes yes");\n  process.exit(0);\n}\nprocess.argv.push("--delay-get-state-ms", ${JSON.stringify(String(heldGetStateMs))}, "--delay-get-state-enabled-file", ${JSON.stringify(getStateEnabledFile)}, "--get-state-barrier-dir", ${JSON.stringify(getStateBarrierDir)}, "--get-state-signal-file", ${JSON.stringify(getStateSignalFile)}, "--exit-signal-file", ${JSON.stringify(exitSignalFile)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
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
      // A transport timeout must not be able to make either cancellation pass.
      PI_DECK_REAL_RPC_TIMEOUT_MS: String(heldGetStateMs),
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
    getStateEnabledFile,
    getStateBarrierDir,
    getStateSignalFile,
    exitSignalFile,
  };
}

async function closeHarness(harness: Harness): Promise<void> {
  // Release only during teardown. A broken reset has already failed its bounded
  // assertion, and can now unwind without a forced process kill or RPC timeout.
  fs.writeFileSync(
    path.join(harness.getStateBarrierDir, "release-get-state"),
    "release\n",
  );
  await harness.app.close().catch(() => undefined);
  fs.rmSync(harness.root, { recursive: true, force: true });
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

async function waitForStartedSession(signalFile: string): Promise<string> {
  await expect
    .poll(
      () =>
        fs.existsSync(signalFile)
          ? fs.readFileSync(signalFile, "utf8").trim()
          : "",
      { timeout: 10_000 },
    )
    .not.toBe("");
  return fs.readFileSync(signalFile, "utf8").trim();
}

test("reset cancels a registered runtime snapshot before waiting for its attachment lease", async () => {
  const harness = await launchHarness("registered-snapshot-reset");
  try {
    const workspaceId = await activeWorkspaceId(harness.page);
    const original = await harness.page.evaluate(
      (id) => window.piDeck.chat.createSession({ workspaceId: id }),
      workspaceId,
    );
    if (original.state.sessionFile === undefined) {
      throw new Error(
        "Expected the registered runtime to have a session file.",
      );
    }
    const originalSession = canonicalSessionIdentity(
      original.state.sessionFile,
    );

    fs.rmSync(harness.getStateSignalFile, { force: true });
    fs.writeFileSync(harness.getStateEnabledFile, "enabled\n");
    await harness.page.evaluate((runtimeId) => {
      type Snapshot = Awaited<
        ReturnType<typeof window.piDeck.chat.getSnapshot>
      >;
      type Outcome =
        | { ok: true; value: Snapshot }
        | { ok: false; error: string };
      const testWindow = window as typeof window & {
        issue140Registered?: {
          snapshotSettled: boolean;
          resetSettled: boolean;
          snapshot: Promise<Outcome>;
          reset?: Promise<Outcome>;
        };
      };
      const state: NonNullable<typeof testWindow.issue140Registered> = {
        snapshotSettled: false,
        resetSettled: false,
        snapshot: Promise.resolve({
          ok: false,
          error: "Snapshot request was not started.",
        }),
      };
      testWindow.issue140Registered = state;
      state.snapshot = window.piDeck.chat
        .getSnapshot({ runtimeId })
        .then((value): Outcome => ({ ok: true, value }))
        .catch(
          (error): Outcome => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          state.snapshotSettled = true;
        });
    }, original.runtimeId);

    const startedSession = await waitForStartedSession(
      harness.getStateSignalFile,
    );
    expect(canonicalSessionIdentity(startedSession)).toBe(originalSession);
    // The old request already latched its barrier. Only replacement workers see
    // this marker removal, so reset can finish solely by closing the old worker.
    fs.rmSync(harness.getStateEnabledFile, { force: true });

    await harness.page.evaluate(() => {
      type Snapshot = Awaited<ReturnType<typeof window.piDeck.chat.reset>>;
      type Outcome =
        | { ok: true; value: Snapshot }
        | { ok: false; error: string };
      const state = (
        window as typeof window & {
          issue140Registered: {
            snapshotSettled: boolean;
            resetSettled: boolean;
            snapshot: Promise<unknown>;
            reset?: Promise<Outcome>;
          };
        }
      ).issue140Registered;
      state.reset = window.piDeck.chat
        .reset()
        .then((value): Outcome => ({ ok: true, value }))
        .catch(
          (error): Outcome => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          state.resetSettled = true;
        });
    });

    await expect
      .poll(
        () =>
          harness.page.evaluate(() => {
            const state = (
              window as typeof window & {
                issue140Registered?: {
                  snapshotSettled: boolean;
                  resetSettled: boolean;
                };
              }
            ).issue140Registered;
            return [state?.snapshotSettled, state?.resetSettled];
          }),
        { timeout: 10_000 },
      )
      .toEqual([true, true]);
    await expect
      .poll(() => exitedSessionIdentities(harness.exitSignalFile), {
        timeout: 10_000,
      })
      .toContain(originalSession);

    const result = await harness.page.evaluate(async () => {
      type Snapshot = Awaited<ReturnType<typeof window.piDeck.chat.reset>>;
      type Outcome =
        | { ok: true; value: Snapshot }
        | { ok: false; error: string };
      const pending = (
        window as typeof window & {
          issue140Registered: {
            snapshot: Promise<Outcome>;
            reset: Promise<Outcome>;
          };
        }
      ).issue140Registered;
      const [snapshot, reset] = await Promise.all([
        pending.snapshot,
        pending.reset,
      ]);
      const current = await window.piDeck.chat.getSnapshot();
      return { snapshot, reset, current };
    });
    expect(result.snapshot.ok).toBe(false);
    if (result.snapshot.ok) {
      throw new Error("The stale registered snapshot unexpectedly resolved.");
    }
    expect(result.snapshot.error).not.toBe("");
    expect(result.reset.ok).toBe(true);
    if (!result.reset.ok) throw new Error(result.reset.error);
    expect(result.reset.value.runtimeId).not.toBe(original.runtimeId);
    expect(result.current.runtimeId).toBe(result.reset.value.runtimeId);
  } finally {
    await closeHarness(harness);
  }
});

test("reset cancels an initial create snapshot without publishing its session identity", async () => {
  const harness = await launchHarness("initial-snapshot-reset");
  try {
    const workspaceId = await activeWorkspaceId(harness.page);
    fs.rmSync(harness.getStateSignalFile, { force: true });
    fs.writeFileSync(harness.getStateEnabledFile, "enabled\n");
    await harness.page.evaluate((id) => {
      type Snapshot = Awaited<
        ReturnType<typeof window.piDeck.chat.createSession>
      >;
      type Outcome =
        | { ok: true; value: Snapshot }
        | { ok: false; error: string };
      const testWindow = window as typeof window & {
        issue140Creation?: {
          createSettled: boolean;
          resetSettled: boolean;
          create: Promise<Outcome>;
          reset?: Promise<Outcome>;
        };
      };
      const state: NonNullable<typeof testWindow.issue140Creation> = {
        createSettled: false,
        resetSettled: false,
        create: Promise.resolve({
          ok: false,
          error: "Session creation was not started.",
        }),
      };
      testWindow.issue140Creation = state;
      state.create = window.piDeck.chat
        .createSession({ workspaceId: id })
        .then((value): Outcome => ({ ok: true, value }))
        .catch(
          (error): Outcome => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          state.createSettled = true;
        });
    }, workspaceId);

    const cancelledTarget = canonicalSessionIdentity(
      await waitForStartedSession(harness.getStateSignalFile),
    );
    fs.rmSync(harness.getStateEnabledFile, { force: true });
    await harness.page.evaluate(() => {
      type Snapshot = Awaited<ReturnType<typeof window.piDeck.chat.reset>>;
      type Outcome =
        | { ok: true; value: Snapshot }
        | { ok: false; error: string };
      const state = (
        window as typeof window & {
          issue140Creation: {
            createSettled: boolean;
            resetSettled: boolean;
            create: Promise<unknown>;
            reset?: Promise<Outcome>;
          };
        }
      ).issue140Creation;
      state.reset = window.piDeck.chat
        .reset()
        .then((value): Outcome => ({ ok: true, value }))
        .catch(
          (error): Outcome => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          state.resetSettled = true;
        });
    });

    await expect
      .poll(
        () =>
          harness.page.evaluate(() => {
            const state = (
              window as typeof window & {
                issue140Creation?: {
                  createSettled: boolean;
                  resetSettled: boolean;
                };
              }
            ).issue140Creation;
            return [state?.createSettled, state?.resetSettled];
          }),
        { timeout: 10_000 },
      )
      .toEqual([true, true]);
    await expect
      .poll(() => exitedSessionIdentities(harness.exitSignalFile), {
        timeout: 10_000,
      })
      .toContain(cancelledTarget);

    const result = await harness.page.evaluate(async (id) => {
      type Snapshot = Awaited<ReturnType<typeof window.piDeck.chat.reset>>;
      type Outcome =
        | { ok: true; value: Snapshot }
        | { ok: false; error: string };
      const pending = (
        window as typeof window & {
          issue140Creation: {
            create: Promise<Outcome>;
            reset: Promise<Outcome>;
          };
        }
      ).issue140Creation;
      const [create, reset] = await Promise.all([
        pending.create,
        pending.reset,
      ]);
      const current = await window.piDeck.chat.getSnapshot();
      const sessions = await window.piDeck.chat.listSessions({
        workspaceId: id,
      });
      return {
        create,
        reset,
        current,
        sessionFiles: sessions.sessions.map((session) => session.sessionFile),
      };
    }, workspaceId);

    expect(result.create.ok).toBe(false);
    if (result.create.ok) {
      throw new Error("The cancelled session creation unexpectedly resolved.");
    }
    expect(result.create.error).toMatch(
      /cancelled by reset or application shutdown/i,
    );
    expect(result.reset.ok).toBe(true);
    if (!result.reset.ok) throw new Error(result.reset.error);
    expect(
      canonicalSessionIdentity(result.reset.value.state.sessionFile!),
    ).not.toBe(cancelledTarget);
    expect(
      canonicalSessionIdentity(result.current.state.sessionFile!),
    ).not.toBe(cancelledTarget);
    expect(result.sessionFiles.map(canonicalSessionIdentity)).not.toContain(
      cancelledTarget,
    );
    expect(
      persistedSessionIdentities(
        path.join(harness.root, "pideck-home", "workspaces.json"),
      ),
    ).not.toContain(cancelledTarget);
    expect(
      persistedSessionIdentities(
        path.join(harness.root, "pideck-home", "projects.json"),
      ),
    ).not.toContain(cancelledTarget);
  } finally {
    await closeHarness(harness);
  }
});
