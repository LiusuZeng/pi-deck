import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

async function launchPiDeck(
  env: NodeJS.ProcessEnv = {},
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
  return { app, page };
}

type ThemePreference = "system" | "light" | "dark";

function createThemeUserData(theme: ThemePreference): string {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-theme-e2e-"),
  );
  fs.writeFileSync(
    path.join(userDataDir, "settings.json"),
    `${JSON.stringify(
      {
        theme,
        maxRunningSessions: 4,
        warmWorkerLimit: 1,
        enableLoginShellEnvCapture: true,
      },
      null,
      2,
    )}\n`,
  );
  return userDataDir;
}

function persistedTheme(userDataDir: string): string | undefined {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(userDataDir, "settings.json"), "utf8"),
    ) as { theme?: string };
    return settings.theme;
  } catch {
    return undefined;
  }
}

function createFakePiBinary(root: string, extraArgs: string[] = []): string {
  const fakePiPath = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    fakePiPath,
    `#!/usr/bin/env node\nconst cwdLogPath = process.env.PI_DECK_TEST_FAKE_PI_CWD_LOG;\nif (cwdLogPath) {\n  require("fs").appendFileSync(cwdLogPath, process.cwd() + "\\n");\n}\nif (process.argv.includes("--version")) {\n  console.log("v42.5.0");\n  process.exit(0);\n}\nif (process.argv.includes("--list-models")) {\n  console.log("provider  model       context  max-out  thinking  images");\n  console.log("fake-provider  fake-model  128K     32K      yes       yes");\n  process.exit(0);\n}\nprocess.argv.push(...${JSON.stringify(extraArgs)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return fakePiPath;
}

function fakeRealModeEnv(options: {
  root: string;
  projectCwd?: string;
  agentDir: string;
  userDataDir?: string;
  testPickProjectCwd?: string;
  testPickProjectCwds?: string[];
  fakePiArgs?: string[];
  fakePiCwdLog?: string;
}): NodeJS.ProcessEnv {
  return {
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: createFakePiBinary(options.root, options.fakePiArgs),
    ...(options.projectCwd ? { PI_DECK_PROJECT_CWD: options.projectCwd } : {}),
    PI_CODING_AGENT_DIR: options.agentDir,
    PI_DECK_HOME: path.join(options.root, "pideck-home"),
    PI_DECK_USER_DATA_DIR:
      options.userDataDir ?? path.join(options.root, "user-data"),
    ...(options.testPickProjectCwd
      ? { PI_DECK_TEST_PICK_PROJECT_CWD: options.testPickProjectCwd }
      : {}),
    ...(options.testPickProjectCwds
      ? {
          PI_DECK_TEST_PICK_PROJECT_CWDS: JSON.stringify(
            options.testPickProjectCwds,
          ),
        }
      : {}),
    ...(options.fakePiCwdLog
      ? { PI_DECK_TEST_FAKE_PI_CWD_LOG: options.fakePiCwdLog }
      : {}),
  };
}

interface CachedSessionRef {
  sessionFile: string;
  sessionId?: string;
  title?: string;
  messageCount?: number;
  preview?: string;
}

function cachedSessionRef(home: string, sessionFile: string): CachedSessionRef {
  const store = JSON.parse(
    fs.readFileSync(path.join(home, "projects.json"), "utf8"),
  ) as { sessionRefs?: CachedSessionRef[] };
  const canonicalSessionFile = fs.realpathSync(sessionFile);
  const ref = store.sessionRefs?.find(
    (candidate) => candidate.sessionFile === canonicalSessionFile,
  );
  if (ref === undefined) {
    throw new Error(
      `Missing cached session metadata for ${canonicalSessionFile}`,
    );
  }
  return ref;
}

async function expectHealthyPreload(page: Page): Promise<void> {
  await expect(page.getByText("Preload error")).toHaveCount(0);
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
}

function writePiSessionFixture(options: {
  sessionFile: string;
  sessionId: string;
  projectCwd: string;
}): void {
  fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true });
  fs.writeFileSync(
    options.sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: options.sessionId,
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: options.projectCwd,
    })}\n`,
  );
}

async function createWorkspaceInUi(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New workspace…" }).click();
  const dialog = page.getByTestId("workspace-create-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  const workspace = page.getByRole("button", { name: `Workspace: ${name}` });
  await expect(workspace).toHaveAttribute("aria-current", "page");
  await expect(
    workspace.locator(".workspace-tree-active-indicator"),
  ).toBeVisible();
}

async function openWorkspaceActions(page: Page, name: string): Promise<void> {
  await page
    .getByRole("button", { name: `Workspace actions for ${name}` })
    .click();
}

async function selectWorkspaceInUi(page: Page, name: string): Promise<void> {
  const workspace = page.getByRole("button", { name: `Workspace: ${name}` });
  await workspace.click();
  await expect(workspace).toHaveAttribute("aria-current", "page");
  await expect(
    workspace.locator(".workspace-tree-active-indicator"),
  ).toBeVisible();
}

async function confirmDeleteSessionDialog(page: Page): Promise<void> {
  const dialog = page.getByTestId("session-delete-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete session" }).click();
}

test("workspace management UI keeps Pi JSONL membership reversible and deletion explicit", async () => {
  // The fixture JSONL is written directly to the deterministic fake-real-mode
  // repository, then discovered and managed exclusively through visible app
  // controls. No native picker, prompt, or confirmation dialog is invoked.
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-management-ui-"),
  );
  const projectCwd = path.join(root, "authorized-project");
  const agentDir = path.join(root, "agent");
  const sessionFile = path.join(
    agentDir,
    "sessions",
    "--workspace-ui--",
    "ui-membership.jsonl",
  );
  fs.mkdirSync(projectCwd, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "20000"],
    }),
  );
  try {
    await expectHealthyPreload(page);

    // A busy runtime is a workspace-level archival guard. Runtime shutdown is
    // otherwise internal, so users do not need a separate close affordance.
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await page.getByLabel("Prompt text").fill("keep archive disabled");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Close runtime/i }),
    ).toHaveCount(0);
    const busyRuntimeId = await page.evaluate(
      async () => (await window.piDeck.chat.getSnapshot()).runtimeId,
    );
    const busyCloseError = await page.evaluate(async (runtimeId) => {
      try {
        await window.piDeck.chat.closeSession({ runtimeId });
        return "unexpected success";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, busyRuntimeId);
    expect(busyCloseError).toMatch(/finish the active turn/i);
    await openWorkspaceActions(page, "authorized-project");
    await expect(
      page.getByRole("menuitem", { name: "Archive workspace" }),
    ).toHaveCSS("justify-content", "flex-start");
    await page.getByRole("menuitem", { name: "Archive workspace" }).click();
    const blockedArchiveDialog = page.getByTestId("workspace-archive-dialog");
    await expect(
      blockedArchiveDialog.getByRole("button", { name: "Archive workspace" }),
    ).toBeDisabled();
    await expect(blockedArchiveDialog).toContainText(
      "Finish active sessions before archiving this workspace.",
    );
    await blockedArchiveDialog.getByRole("button", { name: "Cancel" }).click();

    await createWorkspaceInUi(page, "UI source");
    await openWorkspaceActions(page, "UI source");
    await page.getByRole("menuitem", { name: "Rename workspace" }).click();
    const renameDialog = page.getByTestId("workspace-rename-dialog");
    await expect(renameDialog).toBeVisible();
    await renameDialog.getByLabel("Workspace name").fill("UI source renamed");
    await renameDialog.getByRole("button", { name: "Save name" }).click();
    await expect(
      page.getByRole("button", {
        name: "Workspace: UI source renamed",
      }),
    ).toHaveAttribute("aria-current", "page");

    // Seed after startup so this file has no pre-existing workspace owner.
    writePiSessionFixture({
      sessionFile,
      sessionId: "workspace-ui-membership",
      projectCwd,
    });
    const canonicalSessionFile = fs.realpathSync(sessionFile);
    await page.getByRole("button", { name: "Add existing session…" }).click();
    const unassignedDialog = page.getByTestId("unassigned-sessions");
    await expect(unassignedDialog).toBeVisible();
    await expect(unassignedDialog.getByText("ui-membership")).toBeVisible();
    await unassignedDialog.getByRole("checkbox").check();
    await unassignedDialog
      .getByRole("button", { name: "Add selected sessions" })
      .click();
    const sessionRow = page.getByRole("button", {
      name: "Session: ui-membership",
    });
    await expect(sessionRow).toBeVisible();

    await createWorkspaceInUi(page, "UI destination");
    await selectWorkspaceInUi(page, "UI source renamed");
    const sessionActions = page.getByRole("button", {
      name: "Session actions for ui-membership",
    });
    await sessionActions.click();
    await page.getByRole("menuitem", { name: "Move to workspace…" }).click();
    const moveDialog = page.getByTestId("session-move-dialog");
    await expect(moveDialog).toBeVisible();
    await moveDialog
      .getByLabel("Destination workspace")
      .selectOption({ label: "UI destination" });
    await moveDialog.getByRole("button", { name: "Move session" }).click();
    // The sidebar now keeps destination workspaces browseable in place. Scope
    // the source assertion to the active workspace tree instead of assuming
    // a moved row disappears from the entire sidebar.
    await expect(
      page
        .locator(".workspace-tree-item.active")
        .getByRole("button", { name: "Session: ui-membership" }),
    ).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);

    // The source is empty after move. Archiving changes only workspace
    // metadata, which is intentionally independent from the Pi JSONL file.
    await openWorkspaceActions(page, "UI source renamed");
    await page.getByRole("menuitem", { name: "Archive workspace" }).click();
    const archiveDialog = page.getByTestId("workspace-archive-dialog");
    await expect(archiveDialog).toBeVisible();
    await archiveDialog
      .getByRole("button", { name: "Archive workspace" })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Workspace: UI source renamed",
      }),
    ).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);

    await selectWorkspaceInUi(page, "UI destination");
    await expect(sessionRow).toBeVisible();
    await page
      .getByRole("button", { name: "Session actions for ui-membership" })
      .click();
    await page.getByRole("menuitem", { name: "Archive session" }).click();
    await expect(sessionRow).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);
    await page.getByRole("button", { name: /Archived/ }).click();
    await expect(page.getByTestId("archived-tree")).toContainText(
      "ui-membership",
    );
    await page.getByRole("button", { name: "Restore session" }).click();
    await expect(sessionRow).toBeVisible();

    await createWorkspaceInUi(page, "Cascade workspace");
    await selectWorkspaceInUi(page, "UI destination");
    await page
      .getByRole("button", { name: "Session actions for ui-membership" })
      .click();
    await page.getByRole("menuitem", { name: "Move to workspace…" }).click();
    const cascadeMoveDialog = page.getByTestId("session-move-dialog");
    await cascadeMoveDialog
      .getByLabel("Destination workspace")
      .selectOption({ label: "Cascade workspace" });
    await cascadeMoveDialog
      .getByRole("button", { name: "Move session" })
      .click();
    await selectWorkspaceInUi(page, "Cascade workspace");
    await expect(sessionRow).toBeVisible();
    await openWorkspaceActions(page, "Cascade workspace");
    await page.getByRole("menuitem", { name: "Archive workspace" }).click();
    await page
      .getByTestId("workspace-archive-dialog")
      .getByRole("button", { name: "Archive workspace" })
      .click();
    await expect(
      page.getByRole("button", { name: "Workspace: Cascade workspace" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("archived-tree")).toContainText(
      "Cascade workspace",
    );
    await expect(
      page
        .locator(".archived-tree-workspace")
        .filter({ hasText: "Cascade workspace" })
        .getByRole("button", { name: "Restore session" }),
    ).toBeDisabled();
    await page
      .locator(".archived-tree-workspace")
      .filter({ hasText: "Cascade workspace" })
      .getByRole("button", { name: "Restore workspace" })
      .click();
    await expect(
      page.getByRole("button", { name: "Workspace: Cascade workspace" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(sessionRow).toBeVisible();

    await page
      .getByRole("button", { name: "Session actions for ui-membership" })
      .click();
    await page.getByRole("menuitem", { name: "Remove from workspace" }).click();
    const removeDialog = page.getByTestId("session-remove-dialog");
    await expect(removeDialog).toBeVisible();
    await removeDialog
      .getByRole("button", { name: "Remove from workspace" })
      .click();
    await expect(sessionRow).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);

    // Re-importing the now-unassigned file makes the destructive action an
    // explicit, separately confirmed operation rather than a side effect of
    // removing workspace membership.
    await page.getByRole("button", { name: "Add existing session…" }).click();
    await expect(unassignedDialog).toBeVisible();
    await expect(unassignedDialog.getByText("ui-membership")).toBeVisible();
    await unassignedDialog.getByRole("checkbox").check();
    await unassignedDialog
      .getByRole("button", { name: "Add selected sessions" })
      .click();
    await expect(sessionRow).toBeVisible();
    await page
      .getByRole("button", { name: "Session actions for ui-membership" })
      .click();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);
    await expect(sessionRow).toHaveCount(0);
    expect(fs.existsSync(canonicalSessionFile)).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new workspaces send with managed context and model defaults without a folder picker", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-managed-workspace-"),
  );
  const bootstrapCwd = path.join(root, "bootstrap-project");
  const agentDir = path.join(root, "agent");
  const fakePiCwdLog = path.join(root, "fake-pi-cwds.log");
  const piDeckHome = path.join(root, "pideck-home");
  const managedCwd = path.join(piDeckHome, "runtime-context");
  fs.mkdirSync(bootstrapCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd: bootstrapCwd,
      agentDir,
      fakePiCwdLog,
      // If first send regresses to the project picker, it consumes this
      // cancellation and cannot produce the response asserted below.
      testPickProjectCwds: ["__cancel__"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await createWorkspaceInUi(page, "Managed topic");

    await expect(
      page.getByRole("button", { name: /working folder/i }),
    ).toHaveCount(0);
    const configuration = page.locator(".pi-configuration-trigger");
    await expect(configuration).toHaveAttribute("data-model-id", "fake-model");
    await expect(configuration).toHaveAttribute(
      "data-model-provider",
      "fake-provider",
    );
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );

    const beforeSend = await page.evaluate(async () => {
      const result = await window.piDeck.workspaces.getActive();
      return result.activeWorkspace;
    });
    expect(beforeSend?.name).toBe("Managed topic");
    expect(beforeSend?.defaultProjectId).toBeUndefined();

    await configuration.click();
    await page.getByRole("menuitemradio", { name: "max", exact: true }).click();
    await expect(configuration).toHaveAttribute("data-thinking-level", "max");

    const composer = page.getByLabel("Prompt text");
    await composer.fill("managed context first prompt");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: managed context first prompt/),
    ).toBeVisible({ timeout: 20_000 });

    const created = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      const workspaces = await window.piDeck.workspaces.getActive();
      return {
        cwd: snapshot.state.cwd,
        sessionFile: snapshot.state.sessionFile,
        thinkingLevel: snapshot.state.thinkingLevel,
        workspace: workspaces.activeWorkspace,
      };
    });
    expect(created.cwd).toBe(fs.realpathSync(managedCwd));
    expect(created.thinkingLevel).toBe("max");
    expect(created.workspace?.defaultProjectId).toBeUndefined();
    expect(created.sessionFile).toEqual(expect.any(String));
    const sessionFile = fs.realpathSync(created.sessionFile as string);

    const loggedCwds = fs.readFileSync(fakePiCwdLog, "utf8").trim().split("\n");
    expect(loggedCwds.at(-1)).toBe(fs.realpathSync(managedCwd));

    await expect(
      page.getByRole("button", { name: /Close runtime/i }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Session actions for managed context first prompt",
      })
      .click();
    await page.getByRole("menuitem", { name: "Archive session" }).click();
    await expect(page.getByText(/Archived session/)).toBeVisible();
    await page.getByRole("button", { name: /Archived/ }).click();
    await expect(page.getByTestId("archived-tree")).toContainText(
      "managed context first prompt",
    );
    await page.getByRole("button", { name: "Restore session" }).click();
    await page
      .getByRole("button", { name: "Session: managed context first prompt" })
      .click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();
    const resumedCwd = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      return snapshot.state.cwd;
    });
    expect(resumedCwd).toBe(fs.realpathSync(managedCwd));

    await page
      .locator(".session-list .session-item.active")
      .locator("..")
      .getByRole("button", { name: /^Session actions for / })
      .click();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);
    await expect(page.getByText("Deleted Pi session.")).toBeVisible();
    expect(fs.existsSync(sessionFile)).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real-mode workspace membership lifecycle stays explicit and reversible", async () => {
  // This deliberately calls preload APIs from the hidden Electron window. It
  // never invokes a native dialog or file picker, so it is safe for CI and
  // other headless desktop environments.
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-lifecycle-"),
  );
  const projectCwd = path.join(root, "authorized-project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--workspace-e2e--");
  const sessionFile = path.join(sessionDir, "move-me.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "workspace-lifecycle-session",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  const canonicalSessionFile = fs.realpathSync(sessionFile);
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    const outcome = await page.evaluate(async (sessionFile) => {
      const api = window.piDeck;
      const projects = await api.projects.getActive();
      const defaultProjectId = projects.activeProject?.id;
      if (defaultProjectId === undefined) {
        throw new Error("Expected an authorized default project.");
      }

      const first = await api.workspaces.create({
        name: "Lifecycle source",
        defaultProjectId,
      });
      const source = first.activeWorkspace;
      if (source === undefined)
        throw new Error("Source workspace was not selected.");
      const second = await api.workspaces.create({
        name: "Lifecycle destination",
        defaultProjectId,
      });
      const destination = second.activeWorkspace;
      if (destination === undefined) {
        throw new Error("Destination workspace was not selected.");
      }

      const added = await api.workspaces.addSession({
        workspaceId: source.id,
        sessionFile,
      });
      const sourceAfterAdd = await api.chat.listSessions({
        workspaceId: source.id,
      });
      const destinationBeforeMove = await api.chat.listSessions({
        workspaceId: destination.id,
      });

      const moved = await api.workspaces.moveSession({
        sessionFile,
        toWorkspaceId: destination.id,
      });
      const sourceAfterMove = await api.chat.listSessions({
        workspaceId: source.id,
      });
      const destinationAfterMove = await api.chat.listSessions({
        workspaceId: destination.id,
      });

      const archivedSession = await api.workspaces.archiveSession({
        workspaceId: destination.id,
        sessionFile,
      });
      const hiddenAfterSessionArchive = await api.chat.listSessions({
        workspaceId: destination.id,
      });
      const archivedSessionList = await api.workspaces.listSessions({
        workspaceId: destination.id,
        includeArchived: true,
      });
      const restoredSession = await api.workspaces.restoreSession({
        workspaceId: destination.id,
        sessionFile,
      });
      const visibleAfterSessionRestore = await api.chat.listSessions({
        workspaceId: destination.id,
      });

      // Source is now empty, so archiving it must affect metadata only.
      const archivedSource = await api.workspaces.archive({
        workspaceId: source.id,
      });
      const archived = await api.workspaces.archive({
        workspaceId: destination.id,
      });
      const archivedWorkspaceSessions = await api.workspaces.listSessions({
        workspaceId: destination.id,
        includeArchived: true,
      });
      const restoredWorkspace = await api.workspaces.restore({
        workspaceId: destination.id,
      });
      const visibleAfterWorkspaceRestore = await api.chat.listSessions({
        workspaceId: destination.id,
      });
      const removed = await api.workspaces.removeSession({
        workspaceId: destination.id,
        sessionFile,
      });
      const destinationAfterRemove = await api.chat.listSessions({
        workspaceId: destination.id,
      });
      const unassigned = await api.workspaces.listUnassignedSessions();

      return {
        sourceId: source.id,
        destinationId: destination.id,
        added,
        moved,
        removed,
        sourceAfterAdd: sourceAfterAdd.sessions,
        destinationBeforeMove: destinationBeforeMove.sessions,
        sourceAfterMove: sourceAfterMove.sessions,
        destinationAfterMove: destinationAfterMove.sessions,
        archivedSession,
        hiddenAfterSessionArchive: hiddenAfterSessionArchive.sessions,
        archivedSessionList: archivedSessionList.sessions,
        restoredSession,
        visibleAfterSessionRestore: visibleAfterSessionRestore.sessions,
        archivedSourceWorkspaceIds: archivedSource.archivedWorkspaces?.map(
          (workspace) => workspace.id,
        ),
        archivedWorkspaceSessions: archivedWorkspaceSessions.sessions,
        restoredWorkspaceId: restoredWorkspace.activeWorkspaceId,
        visibleAfterWorkspaceRestore: visibleAfterWorkspaceRestore.sessions,
        destinationAfterRemove: destinationAfterRemove.sessions,
        unassigned: unassigned.sessions,
        activeWorkspaceId: archived.activeWorkspaceId,
        remainingWorkspaceIds: archived.workspaces.map(
          (workspace) => workspace.id,
        ),
      };
    }, canonicalSessionFile);

    expect(outcome.added).toMatchObject({
      workspaceId: outcome.sourceId,
      sessionFile: canonicalSessionFile,
    });
    expect(
      outcome.sourceAfterAdd.map((session) => session.sessionFile),
    ).toEqual([canonicalSessionFile]);
    expect(outcome.destinationBeforeMove).toEqual([]);
    expect(outcome.moved).toMatchObject({
      workspaceId: outcome.destinationId,
      sessionFile: canonicalSessionFile,
    });
    expect(outcome.sourceAfterMove).toEqual([]);
    expect(
      outcome.destinationAfterMove.map((session) => session.sessionFile),
    ).toEqual([canonicalSessionFile]);
    expect(outcome.archivedSession).toMatchObject({
      workspaceId: outcome.destinationId,
      sessionFile: canonicalSessionFile,
    });
    expect(outcome.hiddenAfterSessionArchive).toEqual([]);
    expect(outcome.archivedSessionList[0]).toMatchObject({
      sessionFile: canonicalSessionFile,
      archivedAtMs: expect.any(Number),
    });
    expect(outcome.restoredSession).toMatchObject({
      workspaceId: outcome.destinationId,
      sessionFile: canonicalSessionFile,
    });
    expect(
      outcome.visibleAfterSessionRestore.map((session) => session.sessionFile),
    ).toEqual([canonicalSessionFile]);
    expect(outcome.archivedSourceWorkspaceIds).toContain(outcome.sourceId);
    expect(outcome.archivedWorkspaceSessions[0]).toMatchObject({
      sessionFile: canonicalSessionFile,
      archivedAtMs: expect.any(Number),
    });
    expect(outcome.restoredWorkspaceId).toBe(outcome.destinationId);
    expect(
      outcome.visibleAfterWorkspaceRestore.map(
        (session) => session.sessionFile,
      ),
    ).toEqual([canonicalSessionFile]);
    expect(outcome.remainingWorkspaceIds).not.toContain(outcome.sourceId);
    expect(outcome.activeWorkspaceId).not.toBe(outcome.sourceId);
    expect(outcome.removed).toMatchObject({
      workspaceId: outcome.destinationId,
      sessionFile: canonicalSessionFile,
    });
    expect(outcome.destinationAfterRemove).toEqual([]);
    expect(outcome.unassigned.map((session) => session.sessionFile)).toContain(
      canonicalSessionFile,
    );
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace and session archive state persists across relaunch", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-archive-relaunch-"),
  );
  const projectCwd = path.join(root, "authorized-project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const sessionDir = path.join(agentDir, "sessions", "--archive-relaunch--");
  const independentlyArchivedFile = path.join(sessionDir, "independent.jsonl");
  const cascadeArchivedFile = path.join(sessionDir, "cascade.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    independentlyArchivedFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "independent-archive",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  fs.writeFileSync(
    cascadeArchivedFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "cascade-archive",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  const env = fakeRealModeEnv({
    root,
    projectCwd,
    agentDir,
    userDataDir,
  });
  const firstLaunch = await launchPiDeck(env);
  let workspaceId: string | undefined;
  try {
    await expectHealthyPreload(firstLaunch.page);
    workspaceId = await firstLaunch.page.evaluate(
      async ({ independentlyArchivedFile, cascadeArchivedFile }) => {
        const api = window.piDeck;
        const created = await api.workspaces.create({
          name: "Persistent archive topic",
        });
        const workspace = created.activeWorkspace;
        if (workspace === undefined) {
          throw new Error("Expected the archive workspace to be active.");
        }
        await api.workspaces.addSession({
          workspaceId: workspace.id,
          sessionFile: independentlyArchivedFile,
        });
        await api.workspaces.addSession({
          workspaceId: workspace.id,
          sessionFile: cascadeArchivedFile,
        });
        await api.workspaces.archiveSession({
          workspaceId: workspace.id,
          sessionFile: independentlyArchivedFile,
        });
        await api.workspaces.archive({ workspaceId: workspace.id });
        return workspace.id;
      },
      { independentlyArchivedFile, cascadeArchivedFile },
    );
  } finally {
    await firstLaunch.app.close().catch(() => undefined);
  }

  const secondLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(secondLaunch.page);
    const persisted = await secondLaunch.page.evaluate(async (workspaceId) => {
      const api = window.piDeck;
      const listed = await api.workspaces.getActive();
      const archivedWorkspace = listed.archivedWorkspaces?.find(
        (workspace) => workspace.id === workspaceId,
      );
      const beforeRestore = await api.workspaces.listSessions({
        workspaceId,
        includeArchived: true,
      });
      const restored = await api.workspaces.restore({ workspaceId });
      const afterRestore = await api.chat.listSessions({ workspaceId });
      const allAfterRestore = await api.workspaces.listSessions({
        workspaceId,
        includeArchived: true,
      });
      return {
        archivedWorkspaceName: archivedWorkspace?.name,
        archivedSessionFiles: beforeRestore.sessions
          .filter((session) => session.archivedAtMs !== undefined)
          .map((session) => session.sessionFile),
        restoredWorkspaceId: restored.activeWorkspaceId,
        visibleAfterRestore: afterRestore.sessions.map(
          (session) => session.sessionFile,
        ),
        stillArchivedAfterRestore: allAfterRestore.sessions
          .filter((session) => session.archivedAtMs !== undefined)
          .map((session) => session.sessionFile),
      };
    }, workspaceId);

    expect(persisted.archivedWorkspaceName).toBe("Persistent archive topic");
    expect(persisted.archivedSessionFiles).toEqual(
      expect.arrayContaining([
        fs.realpathSync(independentlyArchivedFile),
        fs.realpathSync(cascadeArchivedFile),
      ]),
    );
    expect(persisted.restoredWorkspaceId).toBe(workspaceId);
    expect(persisted.visibleAfterRestore).toEqual([
      fs.realpathSync(cascadeArchivedFile),
    ]);
    expect(persisted.stillArchivedAfterRestore).toEqual([
      fs.realpathSync(independentlyArchivedFile),
    ]);
  } finally {
    await secondLaunch.app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removed legacy workspace sessions stay excluded and survive bulk delete", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-exclusion-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--workspace-exclusion--");
  const sessionFile = path.join(sessionDir, "keep-on-disk.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "keep-on-disk",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  const canonicalSessionFile = fs.realpathSync(sessionFile);
  const env = fakeRealModeEnv({ root, projectCwd, agentDir });

  const firstLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(firstLaunch.page);
    const outcome = await firstLaunch.page.evaluate(async (sessionFile) => {
      const api = window.piDeck;
      const listedWorkspaces = await api.workspaces.getActive();
      const workspace = listedWorkspaces.workspaces.find(
        (candidate) => candidate.defaultProjectId !== undefined,
      );
      if (workspace === undefined) {
        throw new Error("Expected a migrated project workspace.");
      }
      await api.workspaces.select({ workspaceId: workspace.id });
      const before = await api.chat.listSessions({
        workspaceId: workspace.id,
      });
      await api.workspaces.removeSession({
        workspaceId: workspace.id,
        sessionFile,
      });
      const afterRemove = await api.chat.listSessions({
        workspaceId: workspace.id,
      });
      const deleted = await api.chat.deleteAllSessions({
        workspaceId: workspace.id,
      });
      return {
        workspaceId: workspace.id,
        before: before.sessions,
        afterRemove: afterRemove.sessions,
        deleted,
      };
    }, canonicalSessionFile);

    expect(outcome.before.map((session) => session.sessionFile)).toContain(
      canonicalSessionFile,
    );
    expect(outcome.afterRemove).toEqual([]);
    expect(outcome.deleted).toMatchObject({
      deletedCount: 0,
      deletedSessionFiles: [],
    });
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);
  } finally {
    await firstLaunch.app.close().catch(() => undefined);
  }

  const secondLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(secondLaunch.page);
    const sessions = await secondLaunch.page.evaluate(async () => {
      const api = window.piDeck;
      const listedWorkspaces = await api.workspaces.getActive();
      const workspace = listedWorkspaces.workspaces.find(
        (candidate) => candidate.defaultProjectId !== undefined,
      );
      if (workspace === undefined) {
        throw new Error("Expected a migrated project workspace.");
      }
      await api.workspaces.select({ workspaceId: workspace.id });
      return api.chat.listSessions({ workspaceId: workspace.id });
    });
    expect(sessions.sessions).toEqual([]);
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);
  } finally {
    await secondLaunch.app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function startRuntimeExitTracking(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __piDeckRuntimeExitTracker?: {
        runtimeIds: string[];
        unsubscribe: () => void;
      };
    };
    testWindow.__piDeckRuntimeExitTracker?.unsubscribe();
    const runtimeIds: string[] = [];
    testWindow.__piDeckRuntimeExitTracker = {
      runtimeIds,
      unsubscribe: window.piDeck.chat.onEvent((event) => {
        if (event.type === "worker_exit") {
          runtimeIds.push(event.runtimeId);
        }
      }),
    };
  });
}

async function trackedRuntimeExitIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const testWindow = window as typeof window & {
      __piDeckRuntimeExitTracker?: { runtimeIds: string[] };
    };
    return [...(testWindow.__piDeckRuntimeExitTracker?.runtimeIds ?? [])];
  });
}

async function waitForRuntimeExitCount(
  page: Page,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await trackedRuntimeExitIds(page)).length, {
      timeout: 5_000,
    })
    .toBe(count);
}

async function stopRuntimeExitTracking(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __piDeckRuntimeExitTracker?: { unsubscribe: () => void };
    };
    testWindow.__piDeckRuntimeExitTracker?.unsubscribe();
    delete testWindow.__piDeckRuntimeExitTracker;
  });
}

function tinyPngBase64(): string {
  const data = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(1, 16);
  data.writeUInt32BE(1, 20);
  return data.toString("base64");
}

test("fake mode launches with backend runtime and send enabled", async () => {
  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "fake",
  });
  try {
    await expectHealthyPreload(page);
    await expect(page.getByText(/Local demo mode active/i)).toBeVisible();
    await expect(page.getByTestId("workspace-tree")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Workspace: Default workspace" }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByLabel("Prompt text").fill("fake e2e prompt");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
  }
});

test("attachment selections release and revoke through preload/main IPC", async () => {
  const { app, page } = await launchPiDeck({ PI_DECK_BACKEND: "fake" });
  try {
    await expectHealthyPreload(page);
    const result = await page.evaluate(async (dataBase64) => {
      const api = (
        window as unknown as {
          piDeck: typeof window.piDeck;
        }
      ).piDeck.attachments;
      const ownerId = "attachment-e2e-owner-generation";
      const sessionId = "attachment-e2e-session";
      const request = (fileName: string) => ({
        ownerId,
        sessionId,
        images: [
          {
            fileName,
            mimeType: "image/png",
            size: 24,
            dataBase64,
          },
        ],
      });
      const first = await api.importImages(request("first.png"));
      if (!first.selected) {
        throw new Error("Expected image import to create a selection.");
      }
      await api.release({
        ownerId,
        selectedPathTokens: first.attachments.map(
          (attachment) => attachment.selectedPathToken,
        ),
      });
      const second = await api.importImages(request("second.png"));
      if (!second.selected) {
        throw new Error("Expected release to allow a replacement selection.");
      }
      await api.releaseOwner({ ownerId });
      try {
        await api.importImages(request("late.png"));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("Discarded attachment owner was unexpectedly reusable.");
    }, tinyPngBase64());
    expect(result).toMatch(/owner is no longer active/i);
  } finally {
    await app.close();
  }
});

test("icon controls retain names, neutral styles, and fit a 900×600 viewport", async () => {
  const userDataDir = createThemeUserData("light");
  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "fake",
    PI_DECK_USER_DATA_DIR: userDataDir,
  });
  try {
    await page.setViewportSize({ width: 900, height: 600 });
    await expectHealthyPreload(page);

    const send = page.getByRole("button", { name: "Send" });
    await page.getByLabel("Prompt text").fill("style check");
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
    await expect(send).toHaveText("");
    const sendBox = await send.boundingBox();
    expect(sendBox).not.toBeNull();
    expect(
      (sendBox?.y ?? Infinity) + (sendBox?.height ?? 0),
    ).toBeLessThanOrEqual(600);
    await expect
      .poll(() =>
        send.evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgb(32, 33, 36)");
    await expect(
      page.getByRole("button", { name: "Add attachments" }),
    ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    await send.click();
    const userBubble = page.locator(".user-bubble").last();
    await expect(userBubble).toHaveCSS(
      "background-color",
      "rgb(244, 244, 244)",
    );
    await expect(userBubble).toHaveCSS("color", "rgb(47, 47, 47)");
    await expect(userBubble).toHaveCSS("box-shadow", "none");

    const sessionList = page.locator(".session-list");
    const firstSessionRow = sessionList.locator(".session-item").first();
    await expect(firstSessionRow).toHaveCSS("display", "grid");
    const sessionListBox = await sessionList.boundingBox();
    const firstSessionRowBox = await firstSessionRow.boundingBox();
    expect(firstSessionRowBox?.width).toBeGreaterThanOrEqual(
      (sessionListBox?.width ?? 0) - 1,
    );

    const sidebarToggle = page.locator(".topbar .sidebar-toggle");
    await expect(sidebarToggle).not.toHaveAttribute("aria-describedby");
    await sidebarToggle.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/sessions/);
    await expect(sidebarToggle).toHaveAttribute("aria-describedby");
    await page.getByLabel("Prompt text").hover();
    await expect(sidebarToggle).not.toHaveAttribute("aria-describedby");

    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({ path: "test-results/ui-controls-900x600.png" });
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("appearance preference switches themes and persists across relaunch", async () => {
  const userDataDir = createThemeUserData("dark");
  const env = {
    PI_DECK_BACKEND: "fake",
    PI_DECK_USER_DATA_DIR: userDataDir,
  };
  let launched = await launchPiDeck(env);

  try {
    await launched.page.setViewportSize({ width: 900, height: 600 });
    await expectHealthyPreload(launched.page);
    const darkTrigger = launched.page.getByRole("button", {
      name: "Appearance: Dark",
    });
    await expect(darkTrigger).toBeVisible();
    await expect(launched.page.locator("html")).toHaveCSS(
      "color-scheme",
      "dark",
    );
    await expect(launched.page.locator(".app-shell")).toHaveCSS(
      "background-color",
      "rgb(23, 26, 31)",
    );
    await expect(launched.page.locator(".composer-input-wrap")).toHaveCSS(
      "background-color",
      "rgb(56, 56, 56)",
    );
    await expect
      .poll(() =>
        launched.app.evaluate(({ BrowserWindow, nativeTheme }) => ({
          background:
            BrowserWindow.getAllWindows()[0]
              ?.getBackgroundColor()
              .toLowerCase() ?? "",
          source: nativeTheme.themeSource,
        })),
      )
      .toEqual({ background: "#171a1f", source: "dark" });
    await launched.page.screenshot({
      path: "test-results/ui-controls-dark-900x600.png",
    });

    await darkTrigger.click();
    const appearanceMenu = launched.page.getByRole("menu", {
      name: "Appearance options",
    });
    await expect(appearanceMenu).toBeVisible();
    const systemOption = launched.page.getByRole("menuitemradio", {
      name: "System",
      exact: true,
    });
    const lightOption = launched.page.getByRole("menuitemradio", {
      name: "Light",
      exact: true,
    });
    const darkOption = launched.page.getByRole("menuitemradio", {
      name: "Dark",
      exact: true,
    });
    await expect(darkOption).toHaveAttribute("aria-checked", "true");
    await expect(lightOption).toHaveAttribute("aria-checked", "false");
    await expect(systemOption).toBeFocused();
    await launched.page.keyboard.press("ArrowDown");
    await expect(lightOption).toBeFocused();
    await launched.page.keyboard.press("Escape");
    await expect(darkTrigger).toBeFocused();
    await expect(appearanceMenu).toHaveCount(0);

    await darkTrigger.click();
    await expect(systemOption).toBeFocused();
    await launched.page.keyboard.press("ArrowDown");
    await launched.page.keyboard.press("Enter");
    await expect(
      launched.page.getByRole("button", { name: "Appearance: Light" }),
    ).toBeVisible();
    await expect(launched.page.locator("html")).toHaveCSS(
      "color-scheme",
      "light",
    );
    await expect(launched.page.locator(".app-shell")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await expect
      .poll(() =>
        launched.app.evaluate(({ BrowserWindow, nativeTheme }) => ({
          background:
            BrowserWindow.getAllWindows()[0]
              ?.getBackgroundColor()
              .toLowerCase() ?? "",
          source: nativeTheme.themeSource,
        })),
      )
      .toEqual({ background: "#ffffff", source: "light" });
    await expect.poll(() => persistedTheme(userDataDir)).toBe("light");

    await launched.app.close();
    launched = await launchPiDeck(env);
    await launched.page.setViewportSize({ width: 900, height: 600 });
    await expectHealthyPreload(launched.page);
    const lightTrigger = launched.page.getByRole("button", {
      name: "Appearance: Light",
    });
    await expect(lightTrigger).toBeVisible();

    await lightTrigger.click();
    const relaunchedSystemOption = launched.page.getByRole("menuitemradio", {
      name: "System",
      exact: true,
    });
    const relaunchedDarkOption = launched.page.getByRole("menuitemradio", {
      name: "Dark",
      exact: true,
    });
    await expect(relaunchedSystemOption).toBeFocused();
    await launched.page.keyboard.press("End");
    await expect(relaunchedDarkOption).toBeFocused();
    await launched.page.keyboard.press("Enter");
    await expect(
      launched.page.getByRole("button", { name: "Appearance: Dark" }),
    ).toBeVisible();
    await expect.poll(() => persistedTheme(userDataDir)).toBe("dark");

    await launched.page
      .getByRole("button", { name: "Appearance: Dark" })
      .click();
    const finalSystemOption = launched.page.getByRole("menuitemradio", {
      name: "System",
      exact: true,
    });
    await expect(finalSystemOption).toBeFocused();
    await launched.page.keyboard.press("Enter");
    await expect(
      launched.page.getByRole("button", { name: "Appearance: System" }),
    ).toBeVisible();
    await expect.poll(() => persistedTheme(userDataDir)).toBe("system");
    await expect
      .poll(() =>
        launched.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
      )
      .toBe("system");
  } finally {
    await launched.app.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("working sessions expose steer, follow-up, extension, and abort interventions", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-intervention-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "400"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    const composer = page.getByLabel("Prompt text");
    await composer.fill("start intervention fixture");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Follow-up" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

    await composer.fill("focus on focused tests");
    await page.getByRole("button", { name: "Steer" }).click();
    await expect(
      page.getByText("Steering instruction queued in Pi."),
    ).toBeVisible();

    await composer.fill("summarize afterward");
    await page.getByRole("button", { name: "Follow-up" }).click();
    await expect(
      page.getByText("Follow-up queued in Pi after current work."),
    ).toBeVisible();

    await composer.fill("/fake-worker-command now");
    await expect(page.getByRole("button", { name: "Steer" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Run command now" }),
    ).toBeEnabled();

    await page.getByRole("button", { name: "Abort" }).click();
    await expect(
      page.getByText("Abort requested; waiting for Pi to confirm completion.", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension UI confirm request completes through renderer, IPC, and fake Pi", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-extension-ui-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: [
        "--prompt-scenario",
        "extension-ui",
        "--stream-delay-ms",
        "1",
      ],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await page.getByLabel("Prompt text").fill("confirm extension request");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Fake confirm", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Approve fake extension UI request?"),
    ).toBeVisible();

    // A waiting worker remains in the sidebar after the user moves elsewhere;
    // receiving extension input never steals foreground selection.
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: /Untitled new session/ }),
    ).toBeVisible();
    await expect(
      page.locator(".session-item", {
        hasText: "Waiting · extension input required",
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /Session: confirm extension request/ })
      .click();
    await expect(
      page.getByRole("button", { name: "Confirm", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(
      page.getByText("Extension UI response delivered to Pi."),
    ).toBeVisible();
    await expect(
      page.getByText(/Fake response to: confirm extension request/),
    ).toBeVisible();
    await expect(page.getByText("Needs input", { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode renders a draft shell before an unavailable backend is touched", async () => {
  const piBinary = process.env.PI_DECK_PI_BINARY || "/usr/local/bin/pi";
  test.skip(!fs.existsSync(piBinary), `Pi binary not found at ${piBinary}`);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-startup-fail-"),
  );

  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_PROJECT_CWD: path.join(repoRoot, "missing-e2e-project"),
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
  });
  try {
    await expectHealthyPreload(page);
    await expect(
      page.getByRole("heading", { name: /Untitled new session/ }),
    ).toBeVisible();
    await expect(page.getByText("Startup error", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText(/backend fake RPC active/i)).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap creates no saved session and the first draft send creates one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-lazy-new-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    const configuration = page.locator(".pi-configuration-trigger");
    await expect(configuration).toHaveAttribute("data-model-id", "fake-model");
    await expect(configuration).toHaveAttribute(
      "data-model-provider",
      "fake-provider",
    );
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );
    await expect(configuration).toHaveCSS("width", "90px");
    await configuration.click();
    const maxThinking = page.getByRole("menuitemradio", {
      name: "max",
      exact: true,
    });
    await expect(maxThinking).toBeVisible();
    const firstThinking = page.getByRole("menuitemradio", {
      name: "off",
      exact: true,
    });
    await expect(firstThinking).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitemradio", { name: "minimal", exact: true }),
    ).toBeFocused();
    const modelMenuTrigger = page.getByRole("menuitem", {
      name: /Fake model/,
    });
    await expect(modelMenuTrigger).toBeVisible();
    await page.keyboard.press("End");
    await expect(modelMenuTrigger).toBeFocused();
    await modelMenuTrigger.press("ArrowRight");
    const modelMenu = page.getByRole("menu", { name: "Available Pi models" });
    await expect(modelMenu).toBeVisible();
    await expect(modelMenu.getByRole("menuitemradio").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modelMenuTrigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(configuration).toBeFocused();
    await configuration.click();
    await expect(maxThinking).toBeVisible();
    await maxThinking.click();
    await expect(configuration).toHaveAttribute("data-thinking-level", "max");
    // fakeRpc writes its session record synchronously for persistent workers.
    // Waiting through the background refresh proves the no-session defaults
    // probe did not create an eager saved conversation.
    await page.waitForTimeout(150);
    const fakeSessionRoot = path.join(agentDir, "sessions");
    expect(fs.existsSync(fakeSessionRoot)).toBe(false);
    const newSession = page.getByRole("button", {
      name: "New session",
      exact: true,
    });
    for (let index = 0; index < 5; index += 1) {
      await newSession.click();
    }
    await expect(configuration).toHaveAttribute("data-model-id", "fake-model");
    await expect(configuration).toHaveAttribute(
      "data-thinking-level",
      "medium",
    );
    await expect(
      page
        .getByLabel("Sessions")
        .getByText("Untitled new session", { exact: true }),
    ).toHaveCount(0);

    const prompt = page.getByLabel("Prompt text");
    await prompt.fill("lazy first prompt");
    await prompt.press("Enter");
    await expect(page.getByText("Fake response").first()).toBeVisible();
    expect(fs.existsSync(fakeSessionRoot)).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed draft setup releases its worker before the next retry", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-draft-setup-cleanup-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--fail-command", "set_model", "--no-session"],
    }),
  );
  let trackingStarted = false;
  try {
    await expectHealthyPreload(page);
    await expect(page.locator(".pi-configuration-trigger")).toHaveAttribute(
      "data-model-id",
      "fake-model",
    );
    await page.evaluate(async () => {
      await window.piDeck.settings.update({ maxRunningSessions: 1 });
    });
    await startRuntimeExitTracking(page);
    trackingStarted = true;

    const composer = page.getByLabel("Prompt text");
    const send = page.getByRole("button", { name: "Send" });
    await composer.fill("retry model setup");
    for (let index = 0; index < 5; index += 1) {
      await expect(send).toBeEnabled();
      await send.click();
      await waitForRuntimeExitCount(page, index + 1);
      await expect(page.locator(".composer-error")).toHaveText(
        "Fake RPC configured to fail command: set_model",
      );
    }

    const failedRuntimeIds = await trackedRuntimeExitIds(page);
    expect(failedRuntimeIds).toHaveLength(5);
    expect(new Set(failedRuntimeIds).size).toBe(5);
    const staleRuntimeMessages = await page.evaluate(
      async (runtimeIds) =>
        Promise.all(
          runtimeIds.map(async (runtimeId) => {
            try {
              await window.piDeck.chat.getRuntimeStatus({ runtimeId });
              return "still attached";
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          }),
        ),
      failedRuntimeIds,
    );
    for (const message of staleRuntimeMessages) {
      expect(message).toMatch(/Chat runtime is no longer attached/);
    }

    // A sixth allocation under the one-worker limit proves the failed draft
    // workers no longer occupy adapter capacity.
    const recoveredSnapshot = await page.evaluate(() =>
      window.piDeck.chat.createSession(),
    );
    expect(recoveredSnapshot.runtimeId.length).toBeGreaterThan(0);
    await page.evaluate(
      (runtimeId) => window.piDeck.chat.closeSession({ runtimeId }),
      recoveredSnapshot.runtimeId,
    );
    await waitForRuntimeExitCount(page, 6);
  } finally {
    if (trackingStarted) {
      await stopRuntimeExitTracking(page).catch(() => undefined);
    }
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed initial snapshots release runtime maps and capacity", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-snapshot-cleanup-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--fail-command", "get_state", "--no-session"],
    }),
  );
  let trackingStarted = false;
  try {
    await expectHealthyPreload(page);
    await page.evaluate(async () => {
      await window.piDeck.settings.update({ maxRunningSessions: 1 });
    });
    await startRuntimeExitTracking(page);
    trackingStarted = true;

    const failureMessages = await page.evaluate(async () => {
      const messages: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        try {
          await window.piDeck.chat.createSession();
          messages.push("unexpected successful snapshot");
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }
      return messages;
    });
    expect(failureMessages).toHaveLength(5);
    for (const message of failureMessages) {
      // The original get_state failure must survive cleanup rather than being
      // replaced by a close failure or a later capacity error.
      expect(message).toBe("Fake RPC configured to fail command: get_state");
    }

    await waitForRuntimeExitCount(page, 5);
    const failedRuntimeIds = await trackedRuntimeExitIds(page);
    expect(new Set(failedRuntimeIds).size).toBe(5);
    const staleRuntimeMessages = await page.evaluate(
      async (runtimeIds) =>
        Promise.all(
          runtimeIds.map(async (runtimeId) => {
            try {
              await window.piDeck.chat.getRuntimeStatus({ runtimeId });
              return "still attached";
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          }),
        ),
      failedRuntimeIds,
    );
    for (const message of staleRuntimeMessages) {
      expect(message).toMatch(/Chat runtime is no longer attached/);
    }
  } finally {
    if (trackingStarted) {
      await stopRuntimeExitTracking(page).catch(() => undefined);
    }
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metadata-only model and thinking changes preserve session title, transcript, and cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-metadata-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const piDeckHome = path.join(root, "pideck-home");
  const prompt = "keep this title";
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--extra-model"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await page.getByLabel("Prompt text").fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(`Fake response to: ${prompt}`, { exact: true }),
    ).toBeVisible();

    // A full snapshot establishes the cache before the following RPC calls
    // return their intentionally metadata-only snapshots.
    const snapshot = await page.evaluate(() =>
      window.piDeck.chat.getSnapshot(),
    );
    const sessionFile = snapshot.state.sessionFile;
    if (sessionFile === undefined) {
      throw new Error("Fake Pi did not report a session file");
    }
    const cachedBefore = cachedSessionRef(piDeckHome, sessionFile);
    expect(cachedBefore.title).toBe(prompt);
    expect(cachedBefore.messageCount).toBeGreaterThan(0);

    const configuration = page.locator(".pi-configuration-trigger");
    await configuration.click();
    await page
      .getByRole("menuitemradio", { name: "high", exact: true })
      .click();
    await expect(page.getByText("Switched thinking to high.")).toBeVisible();
    await expect(page.getByRole("heading", { name: prompt })).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Session: ${prompt}` }),
    ).toBeVisible();
    await expect(
      page.getByText(`Fake response to: ${prompt}`, { exact: true }),
    ).toBeVisible();
    expect(cachedSessionRef(piDeckHome, sessionFile)).toMatchObject({
      sessionId: cachedBefore.sessionId,
      title: cachedBefore.title,
      messageCount: cachedBefore.messageCount,
      preview: cachedBefore.preview,
    });

    await configuration.click();
    await page
      .getByRole("menuitem", { name: "Fake model", exact: true })
      .click();
    await page
      .getByRole("menuitemradio", { name: "Fake model 2", exact: true })
      .click();
    await expect(
      page.getByText("Switched model to fake-provider/fake-model-2."),
    ).toBeVisible();
    await expect(configuration).toHaveAttribute(
      "data-model-id",
      "fake-model-2",
    );
    await expect(page.getByRole("heading", { name: prompt })).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Session: ${prompt}` }),
    ).toBeVisible();
    await expect(
      page.getByText(`Fake response to: ${prompt}`, { exact: true }),
    ).toBeVisible();
    expect(cachedSessionRef(piDeckHome, sessionFile)).toMatchObject({
      sessionId: cachedBefore.sessionId,
      title: cachedBefore.title,
      messageCount: cachedBefore.messageCount,
      preview: cachedBefore.preview,
    });
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("idle runtime shutdown stays internal during session archive and restore", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-archive-runtime-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await page.getByLabel("Prompt text").fill("archive runtime recovery");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: archive runtime recovery/),
    ).toBeVisible();

    const sessionRow = page.getByRole("button", {
      name: /Session: archive runtime recovery/,
    });
    await expect(
      page.getByRole("button", { name: /Close runtime/i }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Session actions for archive runtime recovery",
      })
      .click();
    await page.getByRole("menuitem", { name: "Archive session" }).click();
    await expect(page.getByText(/Archived session/)).toBeVisible();
    await page.getByRole("button", { name: /Archived/ }).click();
    await page
      .getByTestId("archived-tree")
      .getByRole("button", { name: "Restore session" })
      .click();
    const restoredRow = page.getByRole("button", {
      name: "Session: archive runtime recovery",
    });
    await expect(restoredRow).toBeVisible();
    await restoredRow.click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed saved-session deletion preserves the composer draft and attachment owner", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-delete-preserve-"),
  );
  const projectCwd = path.join(root, "project");
  const unrelatedProjectCwd = path.join(root, "other-project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-delete-preserve--");
  const sessionFile = path.join(sessionDir, "preserve-draft.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(unrelatedProjectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "preserve-draft",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "20000"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await page.getByRole("button", { name: "Session: preserve-draft" }).click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();

    const composer = page.getByLabel("Prompt text");
    await composer.fill("preserve this unsent draft");
    await page.evaluate((dataBase64) => {
      const bytes = Uint8Array.from(atob(dataBase64), (character) =>
        character.charCodeAt(0),
      );
      const image = new File([bytes], "keep-after-delete-failure.png", {
        type: "image/png",
      });
      const clipboard = new DataTransfer();
      clipboard.items.add(image);
      const textarea = document.querySelector<HTMLTextAreaElement>(
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
    }, tinyPngBase64());
    await expect(
      page
        .locator(".composer .attachment-chip")
        .getByText("keep-after-delete-failure.png"),
    ).toBeVisible();

    // Simulate an independent active turn without sending the displayed
    // composer draft. The busy runtime exposes Delete instead of Close while
    // leaving this intact draft/owner available for the failure path below.
    await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      await window.piDeck.chat.prompt({
        runtimeId: snapshot.runtimeId,
        text: "make deletion control active",
        attachments: [],
      });
    });
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

    // A mismatched Pi header fails main-side validation before close/trash
    // work. Read the active runtime's reported file so this mutation targets
    // the same canonical path the renderer will submit for deletion.
    const runtimeSessionFile = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      return snapshot.state.sessionFile;
    });
    expect(runtimeSessionFile).toEqual(expect.any(String));
    fs.writeFileSync(
      runtimeSessionFile as string,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "preserve-draft",
        timestamp: "2026-07-02T00:00:00.000Z",
        cwd: unrelatedProjectCwd,
      })}\n`,
    );
    const validationError = await page.evaluate(async (file) => {
      const project = await window.piDeck.projects.getActive();
      try {
        await window.piDeck.chat.resumeSession({
          projectId: project.activeProject?.id,
          sessionFile: file,
        });
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, runtimeSessionFile as string);
    expect(validationError).toMatch(/belongs to a different project/i);

    const sessionActions = page
      .locator(".session-list .session-item.active")
      .locator("..")
      .getByRole("button", { name: /^Session actions for / });
    await sessionActions.click();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);

    await expect(page.locator(".ui-status-message")).toHaveText(
      /Failed to delete session:/,
    );
    await expect(composer).toHaveValue("preserve this unsent draft");
    await expect(
      page
        .locator(".composer .attachment-chip")
        .getByText("keep-after-delete-failure.png"),
    ).toBeVisible();
    await page
      .getByTestId("session-delete-dialog")
      .getByRole("button", { name: "Cancel" })
      .click();

    // Stop the unrelated active turn, then prove the retained owner still
    // authorizes delivery. A blanket release would reject this prompt before
    // the fake backend could respond.
    await page.getByRole("button", { name: "Abort" }).click();
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(page.locator(".composer .attachment-chip")).toHaveCount(0);
    await page.getByRole("button", { name: "Abort" }).click();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post-close delete failure keeps the saved file and composer generation resumable", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-delete-post-close-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(
    agentDir,
    "sessions",
    "--e2e-delete-post-close--",
  );
  const sessionFile = path.join(sessionDir, "post-close-delete.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "post-close-delete",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );
  const canonicalSessionFile = fs.realpathSync(sessionFile);

  const { app, page } = await launchPiDeck({
    ...fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "5000"],
    }),
    PI_DECK_TEST_FAIL_SESSION_DELETE_PATH: canonicalSessionFile,
  });
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await page
      .getByRole("button", { name: "Session: post-close-delete" })
      .click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();

    const composer = page.getByLabel("Prompt text");
    await composer.fill("retain after post-close failure");
    await page.evaluate((dataBase64) => {
      const bytes = Uint8Array.from(atob(dataBase64), (character) =>
        character.charCodeAt(0),
      );
      const clipboard = new DataTransfer();
      clipboard.items.add(
        new File([bytes], "post-close-retained.png", { type: "image/png" }),
      );
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Prompt text"]',
      );
      if (textarea === null) throw new Error("Prompt textarea is unavailable.");
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }, tinyPngBase64());
    await expect(page.getByText("post-close-retained.png")).toBeVisible();

    // Keep Pi active without consuming the displayed composer. Active saved
    // rows expose Delete (which closes transactionally) rather than Detach.
    await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      await window.piDeck.chat.prompt({
        runtimeId: snapshot.runtimeId,
        text: "keep runtime active for forced delete failure",
        attachments: [],
      });
    });
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();

    const sessionActions = page
      .locator(".session-list .session-item.active")
      .locator("..")
      .getByRole("button", { name: /^Session actions for / });
    await sessionActions.click();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);

    await expect(page.locator(".ui-status-message")).toHaveText(
      /Failed to delete session after closing its runtime/,
    );
    expect(fs.existsSync(canonicalSessionFile)).toBe(true);
    await expect(composer).toHaveValue("retain after post-close failure");
    await expect(page.getByText("post-close-retained.png")).toBeVisible();
    await page
      .getByTestId("session-delete-dialog")
      .getByRole("button", { name: "Cancel" })
      .click();

    // The detached row keeps its old composer generation. Resume transfers it
    // to a fresh runtime generation, and successful delivery proves main did
    // not revoke the token during the failed delete transaction.
    await page.locator(".session-list .session-item.active").click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: retain after post-close failure/),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".composer .attachment-chip")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bulk deletion reports exact removals and releases only deleted saved-session owners", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-bulk-delete-owners-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-bulk-delete--");
  const attachedFile = path.join(sessionDir, "attached.jsonl");
  const deletedFile = path.join(sessionDir, "delete-me.jsonl");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const [file, id] of [
    [attachedFile, "attached"],
    [deletedFile, "delete-me"],
  ]) {
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-07-02T00:00:00.000Z",
        cwd: projectCwd,
      })}\n`,
    );
  }

  const canonicalAttachedFile = fs.realpathSync(attachedFile);
  const canonicalDeletedFile = fs.realpathSync(deletedFile);
  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    const outcome = await page.evaluate(
      async ({ attachedFile, deletedFile, dataBase64 }) => {
        const api = window.piDeck;
        const project = await api.projects.getActive();
        const projectId = project.activeProject?.id;
        if (projectId === undefined) {
          throw new Error("Expected an active project.");
        }
        const imageRequest = (ownerId: string, sessionId: string) => ({
          ownerId,
          sessionId,
          images: [
            {
              fileName: "owner-check.png",
              mimeType: "image/png",
              size: 24,
              dataBase64,
            },
          ],
        });
        const attachedOwnerId = "attached-owner-generation";
        const deletedOwnerId = "deleted-owner-generation";
        await api.attachments.importImages(
          imageRequest(attachedOwnerId, attachedFile),
        );
        await api.attachments.importImages(
          imageRequest(deletedOwnerId, deletedFile),
        );
        await api.chat.resumeSession({ projectId, sessionFile: attachedFile });
        const result = await api.chat.deleteAllSessions({ projectId });
        let deletedOwnerError: string | undefined;
        try {
          await api.attachments.importImages(
            imageRequest(deletedOwnerId, deletedFile),
          );
        } catch (error) {
          deletedOwnerError =
            error instanceof Error ? error.message : String(error);
        }
        const retainedOwner = await api.attachments.importImages(
          imageRequest(attachedOwnerId, attachedFile),
        );
        return { result, deletedOwnerError, retainedOwner };
      },
      {
        attachedFile: canonicalAttachedFile,
        deletedFile: canonicalDeletedFile,
        dataBase64: tinyPngBase64(),
      },
    );

    expect(outcome.result).toMatchObject({
      deleted: true,
      deletedCount: 1,
      skippedCount: 1,
      deletedSessionFiles: [canonicalDeletedFile],
    });
    expect(outcome.deletedOwnerError).toMatch(/owner is no longer active/i);
    expect(outcome.retainedOwner).toMatchObject({ selected: true });
    expect(fs.existsSync(canonicalAttachedFile)).toBe(true);
    expect(fs.existsSync(canonicalDeletedFile)).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("saved session deletion control is reachable and activated with the keyboard", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-delete-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-delete--");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "keyboard-delete.jsonl"),
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "keyboard-delete",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await expect(
      page.getByRole("button", { name: "Delete saved sessions", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".sidebar .ui-menu-popover")).toHaveCount(0);
    const sessionRow = page.getByRole("button", {
      name: "Session: keyboard-delete",
    });
    const sessionActions = page.getByRole("button", {
      name: "Session actions for keyboard-delete",
    });
    await expect(sessionRow).toBeVisible();

    await sessionRow.focus();
    await page.keyboard.press("Tab");
    await expect(sessionActions).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Delete session…" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Delete session…" }).click();
    await confirmDeleteSessionDialog(page);

    await expect(page.getByText("Deleted Pi session.")).toBeVisible();
    await expect(sessionRow).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode can show and resume a saved project session with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-resume-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const sessionDir = path.join(agentDir, "sessions", "--e2e--");
  fs.mkdirSync(sessionDir, { recursive: true });
  for (let index = 0; index < 7; index += 1) {
    fs.writeFileSync(
      path.join(sessionDir, `manual-e2e-session-${index}.jsonl`),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: `manual-e2e-session-${index}`,
        timestamp: `2026-07-02T00:0${index}:00.000Z`,
        cwd: projectCwd,
      })}\n`,
    );
  }

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await expect(page.getByText(/Real Pi mode active/i)).toBeVisible();
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await expect(
      page.getByRole("button", { name: "Session: manual-e2e-session-0" }),
    ).toBeVisible();
    const savedSession = page
      .getByRole("button", { name: /Session: manual-e2e-session-/ })
      .first();
    await expect(savedSession).toBeVisible();
    await savedSession.click();
    await expect(page.getByText("Resumed saved Pi session.")).toBeVisible();
    await page
      .getByLabel("Prompt text")
      .fill("resume e2e prompt without sending");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode keeps attention sessions visible, labels queues, searches, and refreshes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-inbox-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-inbox--");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const writeSavedSession = (name: string, timestamp: string): void => {
    fs.writeFileSync(
      path.join(sessionDir, `${name}.jsonl`),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: name,
        timestamp,
        cwd: projectCwd,
      })}\n`,
    );
  };
  for (let index = 0; index < 7; index += 1) {
    writeSavedSession(
      `saved-inbox-${index}`,
      `2026-07-02T00:0${index}:00.000Z`,
    );
  }

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "10000", "--prompt-scenario", "queue"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await page.getByLabel("Prompt text").fill("attention stays visible");
    await page.getByRole("button", { name: "Send" }).click();
    const sidebar = page.getByLabel("Sessions");
    await expect(
      sidebar.getByRole("button", { name: "Session: attention stays visible" }),
    ).toBeVisible();
    await expect(sidebar.getByText("Steer 1")).toBeVisible();
    await expect(sidebar.getByText("Follow-up 2")).toBeVisible();
    await expect(sidebar.getByText("1 working", { exact: true })).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "Session: saved-inbox-0" }),
    ).toBeVisible();

    await sidebar.getByLabel("Search sessions").fill("saved-inbox-6");
    await expect(
      sidebar.getByRole("button", { name: "Session: saved-inbox-6" }),
    ).toBeVisible();

    writeSavedSession("refreshed-inbox-target", "2026-07-03T00:00:00.000Z");
    await sidebar.getByRole("button", { name: "Refresh sessions" }).click();
    await sidebar.getByLabel("Search sessions").fill("refreshed-inbox-target");
    await expect(
      sidebar.getByRole("button", { name: "Session: refreshed-inbox-target" }),
    ).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode concurrent duplicate resume reuses one runtime with fake Pi", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-duplicate-resume-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-duplicate--");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "duplicate-resume.jsonl");
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "duplicate-resume",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    await expect(
      page.getByRole("button", { name: "Session: duplicate-resume" }),
    ).toBeVisible();
    const runtimeIds = await page.evaluate(async (file) => {
      const api = window.piDeck;
      const [first, second] = await Promise.all([
        api.chat.resumeSession({ sessionFile: file }),
        api.chat.resumeSession({ sessionFile: file }),
      ]);
      return [first.runtimeId, second.runtimeId];
    }, sessionFile);

    expect(runtimeIds[0]).toBe(runtimeIds[1]);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode removes missing saved session after resume failure with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-missing-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "--e2e-missing--");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "missing-before-resume.jsonl");
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "missing-before-resume",
      timestamp: "2026-07-02T00:00:00.000Z",
      cwd: projectCwd,
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, path.basename(projectCwd));
    const missingSession = page.getByRole("button", {
      name: "Session: missing-before-resume",
    });
    await expect(missingSession).toBeVisible();
    fs.rmSync(sessionFile, { force: true });
    await missingSession.click();
    await expect(
      page.getByText(
        "Saved session file is missing or unreadable. Removed it from the list.",
      ),
    ).toBeVisible();
    await expect(missingSession).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode lists a newly prompted session after restart with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-persist-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const env = fakeRealModeEnv({ root, projectCwd, agentDir });

  const firstLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(firstLaunch.page);
    await selectWorkspaceInUi(firstLaunch.page, path.basename(projectCwd));
    await firstLaunch.page
      .getByLabel("Prompt text")
      .fill("persisted restart session");
    await firstLaunch.page.getByRole("button", { name: "Send" }).click();
    await expect(
      firstLaunch.page.getByText(/Fake response to: persisted restart session/),
    ).toBeVisible();
  } finally {
    await firstLaunch.app.close();
  }

  const secondLaunch = await launchPiDeck(env);
  try {
    await expectHealthyPreload(secondLaunch.page);
    await selectWorkspaceInUi(secondLaunch.page, path.basename(projectCwd));
    const persistedSession = secondLaunch.page.getByRole("button", {
      name: "Session: persisted restart session",
    });
    await expect(persistedSession).toBeVisible();
    await persistedSession.click();
    await expect(
      secondLaunch.page.getByText("Resumed saved Pi session."),
    ).toBeVisible();
  } finally {
    await secondLaunch.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode authorizes opaque project IDs before any project-scoped Pi work", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-project-authority-"),
  );
  const selectedDir = path.join(root, "selected-project");
  const unselectedDir = path.join(root, "unselected-project");
  const agentDir = path.join(root, "agent");
  const piDeckHome = path.join(root, "pideck-home");
  const fakePiCwdLog = path.join(root, "fake-pi-cwds.log");
  fs.mkdirSync(selectedDir, { recursive: true });
  fs.mkdirSync(unselectedDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(piDeckHome, { recursive: true });
  const selectedProject = fs.realpathSync(selectedDir);
  const unselectedProject = fs.realpathSync(unselectedDir);
  const selectedProjectId = "opaque-selected-project-id";
  const now = Date.now();
  fs.writeFileSync(
    path.join(piDeckHome, "projects.json"),
    `${JSON.stringify({
      version: 1,
      activeProjectId: selectedProjectId,
      projects: [
        {
          id: selectedProjectId,
          rootPath: selectedProject,
          displayName: "selected-project",
          createdAtMs: now,
          updatedAtMs: now,
          lastOpenedAtMs: now,
        },
      ],
      sessionRefs: [],
    })}\n`,
  );

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, agentDir, fakePiCwdLog }),
  );
  try {
    await expectHealthyPreload(page);
    await selectWorkspaceInUi(page, "selected-project");

    const rejectionMessages = await page.evaluate(
      async ({ projectId, sessionFile }) => {
        const reject = async (operation: Promise<unknown>) => {
          try {
            await operation;
            return "unexpected success";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        };
        const api = window.piDeck;
        return {
          create: await reject(api.chat.createSession({ projectId })),
          listModels: await reject(api.chat.listModels({ projectId })),
          listSessions: await reject(api.chat.listSessions({ projectId })),
          resume: await reject(
            api.chat.resumeSession({ projectId, sessionFile }),
          ),
          delete: await reject(
            api.chat.deleteSession({ projectId, sessionFile }),
          ),
          deleteAll: await reject(api.chat.deleteAllSessions({ projectId })),
        };
      },
      {
        projectId: unselectedProject,
        sessionFile: path.join(unselectedProject, "unregistered.jsonl"),
      },
    );
    for (const message of Object.values(rejectionMessages)) {
      expect(message).toMatch(/unknown project/i);
    }

    const positive = await page.evaluate(async (projectId) => {
      const api = window.piDeck;
      const [models, sessions] = await Promise.all([
        api.chat.listModels({ projectId }),
        api.chat.listSessions({ projectId }),
      ]);
      return {
        modelCount: models.models.length,
        projectId: sessions.projectId,
        projectCwd: sessions.projectCwd,
      };
    }, selectedProjectId);
    expect(positive.modelCount).toBeGreaterThan(0);
    expect(positive.projectId).toBe(selectedProjectId);
    expect(positive.projectCwd).toBe(selectedProject);

    await page.getByLabel("Prompt text").fill("opaque project authority");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: opaque project authority/),
    ).toBeVisible();
    const snapshot = await page.evaluate(() =>
      window.piDeck.chat.getSnapshot(),
    );
    expect(snapshot.projectId).toBe(selectedProjectId);
    expect(snapshot.state.cwd).toBe(selectedProject);
    await expect(
      page.getByRole("button", { name: "Workspace: selected-project" }),
    ).toHaveAttribute("aria-current", "page");

    const runtimeProjectRejection = await page.evaluate(
      async ({ runtimeId, projectId }) => {
        try {
          await window.piDeck.chat.listModels({ runtimeId, projectId });
          return "unexpected success";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      { runtimeId: snapshot.runtimeId, projectId: unselectedProject },
    );
    expect(runtimeProjectRejection).toMatch(/unknown project/i);

    const launchedCwds = fs.existsSync(fakePiCwdLog)
      ? fs
          .readFileSync(fakePiCwdLog, "utf8")
          .split("\n")
          .filter((cwd) => cwd.length > 0)
      : [];
    expect(launchedCwds).toContain(selectedProject);
    expect(launchedCwds).not.toContain(unselectedProject);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background worker continues while a directory-independent workspace is created", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-workspace-background-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "500"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await page.getByLabel("Prompt text").fill("workspace background worker");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
    const runtimeId = await page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      return snapshot.runtimeId;
    });

    await createWorkspaceInUi(page, "Background topic");
    const activeWorkspace = await page.evaluate(async () => {
      const result = await window.piDeck.workspaces.getActive();
      return result.activeWorkspace;
    });
    expect(activeWorkspace?.name).toBe("Background topic");
    expect(activeWorkspace?.defaultProjectId).toBeUndefined();
    await expect(
      page.getByRole("button", { name: /working folder/i }),
    ).toHaveCount(0);

    await expect
      .poll(async () =>
        page.evaluate(async (id) => {
          const status = await window.piDeck.chat.getRuntimeStatus({
            runtimeId: id,
          });
          return status.state.isAgentActive;
        }, runtimeId),
      )
      .toBe(false);
    await selectWorkspaceInUi(page, "Default workspace");
    await expect(
      page.getByText(/Fake response to: workspace background worker/),
    ).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed workspace context persists across relaunch", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-managed-relaunch-"),
  );
  const bootstrapCwd = path.join(root, "bootstrap-project");
  const agentDir = path.join(root, "agent");
  const userDataDir = path.join(root, "user-data");
  const managedCwd = path.join(root, "pideck-home", "runtime-context");
  fs.mkdirSync(bootstrapCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const firstLaunch = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd: bootstrapCwd,
      agentDir,
      userDataDir,
      testPickProjectCwds: ["__cancel__"],
    }),
  );
  let sessionFile: string | undefined;
  try {
    await expectHealthyPreload(firstLaunch.page);
    await createWorkspaceInUi(firstLaunch.page, "Persistent topic");
    await expect(
      firstLaunch.page.locator(".pi-configuration-trigger"),
    ).toHaveAttribute("data-model-id", "fake-model");
    await firstLaunch.page
      .getByLabel("Prompt text")
      .fill("managed relaunch prompt");
    await firstLaunch.page.getByRole("button", { name: "Send" }).click();
    await expect(
      firstLaunch.page.getByText(/Fake response to: managed relaunch prompt/),
    ).toBeVisible();
    const snapshot = await firstLaunch.page.evaluate(() =>
      window.piDeck.chat.getSnapshot(),
    );
    expect(snapshot.state.cwd).toBe(fs.realpathSync(managedCwd));
    sessionFile = snapshot.state.sessionFile;
    expect(sessionFile).toEqual(expect.any(String));
  } finally {
    await firstLaunch.app.close();
  }

  // Simulate a process exit that happened before the final metadata snapshot
  // reached the workspace cache. The JSONL remains authoritative and contains
  // the prompt, so relaunch must repair this filename fallback.
  const workspaceStorePath = path.join(root, "pideck-home", "workspaces.json");
  const workspaceStore = JSON.parse(
    fs.readFileSync(workspaceStorePath, "utf8"),
  ) as {
    sessionRefs?: Array<{
      sessionFile: string;
      title?: string;
      messageCount?: number;
      preview?: string;
    }>;
  };
  const cachedRef = workspaceStore.sessionRefs?.find(
    (ref) => ref.sessionFile === fs.realpathSync(sessionFile as string),
  );
  if (cachedRef === undefined) {
    throw new Error("Missing managed workspace session cache entry");
  }
  cachedRef.title = path.basename(sessionFile as string, ".jsonl");
  cachedRef.messageCount = 0;
  delete cachedRef.preview;
  fs.writeFileSync(workspaceStorePath, `${JSON.stringify(workspaceStore)}\n`);

  const secondLaunch = await launchPiDeck(
    fakeRealModeEnv({ root, agentDir, userDataDir }),
  );
  try {
    await expectHealthyPreload(secondLaunch.page);
    await expect(
      secondLaunch.page.getByRole("button", {
        name: "Workspace: Persistent topic",
      }),
    ).toHaveAttribute("aria-current", "page");
    const activeWorkspace = await secondLaunch.page.evaluate(async () => {
      const result = await window.piDeck.workspaces.getActive();
      return result.activeWorkspace;
    });
    expect(activeWorkspace?.defaultProjectId).toBeUndefined();
    await secondLaunch.page
      .getByRole("button", { name: "Session: managed relaunch prompt" })
      .click();
    await expect(
      secondLaunch.page.getByText("Resumed saved Pi session."),
    ).toBeVisible();
    const resumed = await secondLaunch.page.evaluate(() =>
      window.piDeck.chat.getSnapshot(),
    );
    expect(resumed.state.cwd).toBe(fs.realpathSync(managedCwd));
    expect(fs.realpathSync(resumed.state.sessionFile as string)).toBe(
      fs.realpathSync(sessionFile as string),
    );
  } finally {
    await secondLaunch.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode explains long no-output active work with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-no-output-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "10000"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await page.getByLabel("Prompt text").fill("slow first output");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Agent is working… \d+s elapsed\./),
    ).toBeVisible();
    await expect(page.getByText("Pi agent started")).toBeVisible();
    await expect(page.getByText(/No visible output yet/)).toBeVisible({
      timeout: 8_000,
    });
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode surfaces asynchronous provider errors with fake Pi", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-e2e-provider-error-"),
  );
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--prompt-scenario", "error"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await page.getByLabel("Prompt text").fill("trigger usage limit");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.locator('[role="alert"]').filter({
        hasText: "Usage limit reached for fake provider.",
      }),
    ).toBeVisible();
    await expect(page.getByText("Agent is working…")).toHaveCount(0);
    await expect(page.getByText("Error").first()).toBeVisible();
    await page.getByLabel("Prompt text").fill("can edit after error");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode reconciles a working session when completion event is missed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-reconcile-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--drop-completion-events"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await page.getByLabel("Prompt text").fill("missed completion event");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(
        "Reconciled from Pi runtime status because the live completion event was not observed.",
      ),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Agent is working…")).toHaveCount(0);
    await expect(
      page.getByText(/Fake response to: missed completion event/),
    ).toBeVisible();
    await page.getByLabel("Prompt text").fill("can send after reconcile");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode routes background session events to the right session with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-routing-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({
      root,
      projectCwd,
      agentDir,
      fakePiArgs: ["--stream-delay-ms", "150"],
    }),
  );
  try {
    await expectHealthyPreload(page);
    await page.getByLabel("Prompt text").fill("background route one");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.locator(".session-item", { hasText: "background route one" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Prompt text").fill("foreground route two");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: foreground route two/),
    ).toBeVisible();

    await page
      .locator(".session-item", { hasText: "background route one" })
      .click();
    await expect(
      page.getByText(/Fake response to: background route one/),
    ).toBeVisible();
    await expect(
      page.getByText(/Fake response to: foreground route two/),
    ).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode compact plus creates another attached session with fake Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-new-"));
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { app, page } = await launchPiDeck(
    fakeRealModeEnv({ root, projectCwd, agentDir }),
  );
  try {
    await expectHealthyPreload(page);
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Prompt text").fill("start draft session");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: start draft session/),
    ).toBeVisible();
    const composer = page.getByLabel("Prompt text");
    await composer.fill("/");
    await expect(composer).toHaveAttribute("role", "combobox");
    await expect(composer).toHaveAttribute("aria-expanded", "true");
    const workerCommand = page.getByRole("option", {
      name: /\/fake-worker-command/,
    });
    await expect(workerCommand).toBeVisible();
    await composer.press("End");
    await expect(workerCommand).toHaveAttribute("aria-selected", "true");
    await composer.press("Enter");
    await expect(composer).toHaveValue("/fake-worker-command ");
    await expect(composer).toHaveAttribute("aria-expanded", "false");
    await page
      .getByLabel("Prompt text")
      .fill("new session e2e prompt without sending");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real mode does not fall back to fake/local UI and can send from active runtime", async () => {
  const piBinary = process.env.PI_DECK_PI_BINARY || "/usr/local/bin/pi";
  test.skip(!fs.existsSync(piBinary), `Pi binary not found at ${piBinary}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-e2e-real-ui-"));
  const projectCwd = path.join(root, "project");
  fs.mkdirSync(projectCwd, { recursive: true });

  const { app, page } = await launchPiDeck({
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: piBinary,
    PI_DECK_PROJECT_CWD: projectCwd,
    PI_DECK_HOME: path.join(root, "pideck-home"),
    PI_DECK_USER_DATA_DIR: path.join(root, "user-data"),
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
  });
  try {
    await expectHealthyPreload(page);
    await expect(page.getByTestId("workspace-tree")).toBeVisible();
    await expect(page.getByText(/Real Pi mode active/i)).toBeVisible();
    await expect(page.getByText("Local projects")).toHaveCount(0);
    await expect(page.getByText(/backend fake RPC active/i)).toHaveCount(0);
    await expect(page.getByText(/claude/i)).toHaveCount(0);
    await expect(page.locator(".pi-configuration-trigger")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /New real session/i }),
    ).toHaveCount(0);

    await page
      .getByLabel("Prompt text")
      .fill("real e2e prompt without sending");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
