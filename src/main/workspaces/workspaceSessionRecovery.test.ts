import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import type { ChatSessionSummary } from "../../shared/types.js";
import { ForkCleanupJournal } from "../forkCleanupJournal.js";
import { readPiSessionSummary } from "../pi/sessionRepository.js";
import { ProjectStore } from "../projects/projectStore.js";
import { SettingsStore } from "../settings/settingsStore.js";
import { WorkspaceStore } from "./workspaceStore.js";
import { recoverMissingWorkspaceSessionRefs } from "./workspaceSessionRecovery.js";
import { WorkspaceUsageStore } from "./workspaceUsage.js";

vi.mock("electron", () => ({
  app: {
    dock: undefined,
    getPath: vi.fn(() => os.tmpdir()),
    on: vi.fn(),
    quit: vi.fn(),
    setPath: vi.fn(),
    whenReady: vi.fn(async () => undefined),
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return [];
    }
  },
  dialog: {},
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  nativeTheme: {},
  session: {},
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn(() => undefined) },
}));

async function temporaryFixture(): Promise<{
  root: string;
  home: string;
  project: string;
  sessionDir: string;
  sessionFile: string;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-workspace-recovery-"),
  );
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "recoverable.jsonl");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  return { root, home, project, sessionDir, sessionFile };
}

async function writePiSession(
  sessionFile: string,
  project: string,
  sessionId: string,
  prompt = "Recovered prompt title",
): Promise<void> {
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-09-01T00:00:00.000Z",
        cwd: project,
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-09-01T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      }),
    ].join("\n"),
  );
}

function cachedSummary(
  sessionFile: string,
  sessionId = "recoverable-session",
): ChatSessionSummary {
  return {
    id: sessionFile,
    sessionFile,
    sessionId,
    title: "Cached before outage",
    updatedAtMs: 123,
    messageCount: 1,
  };
}

test("recovers an explicit missing workspace session after the original file returns", async () => {
  const { home, project, sessionDir, sessionFile } = await temporaryFixture();
  await writePiSession(sessionFile, project, "recoverable-session");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Recover missing" });
  await store.upsertSessionRef(workspace.id, cachedSummary(sessionFile));

  const movedAside = `${sessionFile}.tmp`;
  await fs.rename(sessionFile, movedAside);
  await store.markSessionMissing(workspace.id, sessionFile);
  assert.deepEqual(await store.getCachedSessionSummaries(workspace.id), []);

  await fs.rename(movedAside, sessionFile);
  const reloaded = new WorkspaceStore(home);
  const diagnostics: string[] = [];
  const recovered = await recoverMissingWorkspaceSessionRefs({
    store: reloaded,
    workspace,
    includeArchived: false,
    sessionDir,
    diagnostics,
    assertActive: () => {},
  });

  assert.equal(recovered, 1);
  const [visible] = await reloaded.getCachedSessionSummaries(workspace.id);
  assert.equal(visible?.sessionFile, await fs.realpath(sessionFile));
  assert.equal(visible?.title, "Recovered prompt title");
  const [ref] = await reloaded.getSessionRefs(workspace.id);
  assert.equal(ref?.missingSinceMs, undefined);
});

test("workspace listing recovers a restored explicit session through the main refresh path", async () => {
  const { root, home, project, sessionDir, sessionFile } =
    await temporaryFixture();
  await writePiSession(sessionFile, project, "main-list-session");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Main list recovery" });
  await store.upsertSessionRef(
    workspace.id,
    cachedSummary(sessionFile, "main-list-session"),
  );
  const settings = new SettingsStore(path.join(root, "user-data"));
  await settings.update({
    enableLoginShellEnvCapture: false,
    sessionDir,
  });
  const projectStore = new ProjectStore(home);
  const usageStore = new WorkspaceUsageStore(home);
  const forkCleanupJournal = new ForkCleanupJournal(home);
  const previousEnv = {
    PI_DECK_BACKEND: process.env.PI_DECK_BACKEND,
    PI_DECK_HOME: process.env.PI_DECK_HOME,
    PI_DECK_MAIN_TEST_IMPORT: process.env.PI_DECK_MAIN_TEST_IMPORT,
  };
  process.env.PI_DECK_BACKEND = "real";
  process.env.PI_DECK_HOME = home;
  process.env.PI_DECK_MAIN_TEST_IMPORT = "1";
  const { __testing } = await import("../main.js");
  let restoreStores = __testing.configureWorkspaceListing({
    projectStore,
    workspaceStore: store,
    workspaceUsageStore: usageStore,
    forkCleanupJournal,
  });
  try {
    const movedAside = `${sessionFile}.tmp`;
    await fs.rename(sessionFile, movedAside);
    const hidden = await __testing.listWorkspaceChatSessions(
      settings,
      workspace.id,
      { discoverLegacySessions: false },
    );
    assert.deepEqual(hidden.sessions, []);
    assert.equal(
      (await store.getSessionRefs(workspace.id))[0]?.missingSinceMs !==
        undefined,
      true,
    );

    await fs.rename(movedAside, sessionFile);
    restoreStores();
    const reloadedStore = new WorkspaceStore(home);
    restoreStores = __testing.configureWorkspaceListing({
      projectStore,
      workspaceStore: reloadedStore,
      workspaceUsageStore: usageStore,
      forkCleanupJournal,
    });
    const recovered = await __testing.listWorkspaceChatSessions(
      settings,
      workspace.id,
      { discoverLegacySessions: false },
    );

    assert.equal(recovered.sessions.length, 1);
    assert.equal(
      recovered.sessions[0]?.sessionFile,
      await fs.realpath(sessionFile),
    );
    assert.equal(recovered.sessions[0]?.title, "Recovered prompt title");
    assert.equal(
      (await reloadedStore.getSessionRefs(workspace.id))[0]?.missingSinceMs,
      undefined,
    );
  } finally {
    restoreStores();
    if (previousEnv.PI_DECK_BACKEND === undefined) {
      delete process.env.PI_DECK_BACKEND;
    } else {
      process.env.PI_DECK_BACKEND = previousEnv.PI_DECK_BACKEND;
    }
    if (previousEnv.PI_DECK_HOME === undefined) {
      delete process.env.PI_DECK_HOME;
    } else {
      process.env.PI_DECK_HOME = previousEnv.PI_DECK_HOME;
    }
    if (previousEnv.PI_DECK_MAIN_TEST_IMPORT === undefined) {
      delete process.env.PI_DECK_MAIN_TEST_IMPORT;
    } else {
      process.env.PI_DECK_MAIN_TEST_IMPORT =
        previousEnv.PI_DECK_MAIN_TEST_IMPORT;
    }
  }
});

test("recovers after a transient realpath error without rewriting the unchanged missing marker", async () => {
  const { home, project, sessionDir, sessionFile } = await temporaryFixture();
  await writePiSession(sessionFile, project, "transient-session");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Transient outage" });
  await store.upsertSessionRef(
    workspace.id,
    cachedSummary(sessionFile, "transient-session"),
  );
  await store.markSessionMissing(workspace.id, sessionFile);
  const [missingBefore] = await store.getSessionRefs(workspace.id);
  let failSessionRead = true;
  const writeFile = vi.spyOn(fs, "writeFile");
  try {
    const firstDiagnostics: string[] = [];
    const firstAttempt = await recoverMissingWorkspaceSessionRefs({
      store,
      workspace,
      includeArchived: false,
      sessionDir,
      diagnostics: firstDiagnostics,
      assertActive: () => {},
      readSessionSummary: async (options) => {
        if (failSessionRead) {
          failSessionRead = false;
          return {
            diagnostics: [
              `Could not inspect session file ${options.sessionFile}: transient realpath failure`,
            ],
          };
        }
        return readPiSessionSummary(options);
      },
    });

    assert.equal(firstAttempt, 0);
    assert.match(firstDiagnostics.join("\n"), /transient realpath failure/);
    assert.equal(writeFile.mock.calls.length, 0);
    assert.equal(
      (await store.getSessionRefs(workspace.id))[0]?.missingSinceMs,
      missingBefore?.missingSinceMs,
    );

    const recovered = await recoverMissingWorkspaceSessionRefs({
      store,
      workspace,
      includeArchived: false,
      sessionDir,
      diagnostics: [],
      assertActive: () => {},
    });

    assert.equal(recovered, 1);
    assert.equal(
      (await store.getSessionRefs(workspace.id))[0]?.missingSinceMs,
      undefined,
    );
    assert.equal(
      (await store.getCachedSessionSummaries(workspace.id))[0]?.sessionFile,
      await fs.realpath(sessionFile),
    );
  } finally {
    writeFile.mockRestore();
  }
});

test("leaves permanently missing refs marked missing without rewriting metadata", async () => {
  const { home, project, sessionDir, sessionFile } = await temporaryFixture();
  await writePiSession(sessionFile, project, "permanent-missing-session");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Still missing" });
  await store.upsertSessionRef(
    workspace.id,
    cachedSummary(sessionFile, "permanent-missing-session"),
  );
  await fs.rename(sessionFile, `${sessionFile}.gone`);
  await store.markSessionMissing(workspace.id, sessionFile);
  const [missingBefore] = await store.getSessionRefs(workspace.id);

  const writeFile = vi.spyOn(fs, "writeFile");
  try {
    const diagnostics: string[] = [];
    const recovered = await recoverMissingWorkspaceSessionRefs({
      store,
      workspace,
      includeArchived: false,
      sessionDir,
      diagnostics,
      assertActive: () => {},
    });

    assert.equal(recovered, 0);
    assert.deepEqual(await store.getCachedSessionSummaries(workspace.id), []);
    const [missingAfter] = await store.getSessionRefs(workspace.id);
    assert.equal(missingAfter?.missingSinceMs, missingBefore?.missingSinceMs);
    assert.equal(writeFile.mock.calls.length, 0);
  } finally {
    writeFile.mockRestore();
  }
});

test("rejects recovered files with changed durable session identity", async () => {
  const { home, project, sessionDir, sessionFile } = await temporaryFixture();
  await writePiSession(sessionFile, project, "original-session");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Reject replacement" });
  await store.upsertSessionRef(
    workspace.id,
    cachedSummary(sessionFile, "original-session"),
  );
  await fs.rename(sessionFile, `${sessionFile}.original`);
  await store.markSessionMissing(workspace.id, sessionFile);
  await writePiSession(sessionFile, project, "replacement-session");

  const diagnostics: string[] = [];
  const recovered = await recoverMissingWorkspaceSessionRefs({
    store,
    workspace,
    includeArchived: false,
    sessionDir,
    diagnostics,
    assertActive: () => {},
  });

  assert.equal(recovered, 0);
  assert.deepEqual(await store.getCachedSessionSummaries(workspace.id), []);
  assert.match(diagnostics.join("\n"), /changed session identity/);
});

test("does not resurrect a ref removed while recovery is in flight", async () => {
  const { home, project, sessionDir, sessionFile } = await temporaryFixture();
  await writePiSession(sessionFile, project, "removed-session");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Concurrent removal" });
  await store.upsertSessionRef(
    workspace.id,
    cachedSummary(sessionFile, "removed-session"),
  );
  await store.markSessionMissing(workspace.id, sessionFile);

  const recovered = await recoverMissingWorkspaceSessionRefs({
    store,
    workspace,
    includeArchived: false,
    sessionDir,
    diagnostics: [],
    assertActive: () => {},
    readSessionSummary: async (options) => {
      const result = await readPiSessionSummary(options);
      assert.equal(await store.removeSession(workspace.id, sessionFile), true);
      return result;
    },
  });

  assert.equal(recovered, 0);
  assert.deepEqual(await store.getSessionRefs(workspace.id), []);
});

test("recovers archived refs only into archived listings", async () => {
  const { home, project, sessionDir, sessionFile } = await temporaryFixture();
  await writePiSession(sessionFile, project, "archived-session");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Archived recovery" });
  await store.upsertSessionRef(
    workspace.id,
    cachedSummary(sessionFile, "archived-session"),
  );
  await store.archiveSession(workspace.id, sessionFile);
  await store.markSessionMissing(workspace.id, sessionFile);

  const diagnostics: string[] = [];
  const recovered = await recoverMissingWorkspaceSessionRefs({
    store,
    workspace,
    includeArchived: true,
    sessionDir,
    diagnostics,
    assertActive: () => {},
  });

  assert.equal(recovered, 1);
  assert.deepEqual(await store.getCachedSessionSummaries(workspace.id), []);
  const archived = await store.getCachedSessionSummaries(workspace.id, {
    includeArchived: true,
  });
  assert.equal(archived[0]?.archivedAtMs !== undefined, true);
});

test("does not recover fork-cleanup blocked refs", async () => {
  const { home, project, sessionDir, sessionFile } = await temporaryFixture();
  await writePiSession(sessionFile, project, "blocked-session");
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Blocked recovery" });
  await store.upsertSessionRef(
    workspace.id,
    cachedSummary(sessionFile, "blocked-session"),
  );
  await store.markSessionMissing(workspace.id, sessionFile);

  const diagnostics: string[] = [];
  const recovered = await recoverMissingWorkspaceSessionRefs({
    store,
    workspace,
    includeArchived: false,
    sessionDir,
    diagnostics,
    assertActive: () => {},
    isSessionBlocked: async () => true,
  });

  assert.equal(recovered, 0);
  assert.deepEqual(await store.getCachedSessionSummaries(workspace.id), []);
  assert.match(diagnostics.join("\n"), /Fork cleanup blocks/);
});
