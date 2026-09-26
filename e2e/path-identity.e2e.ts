import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function createFakePi(root: string, reportedCwd: string): string {
  const binary = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("v42.5.0"); process.exit(0); }\nif (process.argv.includes("--list-models")) { console.log("provider  model       context  max-out  thinking  images"); console.log("fake-provider  fake-model  128K     32K      yes       yes"); process.exit(0); }\nprocess.argv.push("--get-state-cwd", ${JSON.stringify(reportedCwd)});\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return binary;
}

async function launch(
  root: string,
  projectCwd: string,
  projectAlias: string,
): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const userData = path.join(root, "user-data");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, "settings.json"),
    `${JSON.stringify({
      theme: "system",
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: false,
    })}\n`,
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
      PI_DECK_PI_BINARY: createFakePi(root, projectAlias),
      PI_DECK_PROJECT_CWD: projectCwd,
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
      PI_DECK_HOME: path.join(root, "pideck-home"),
      PI_DECK_USER_DATA_DIR: userData,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
  return { app, page };
}

test("symlink cwd keeps workspace ownership through resume and delete", async () => {
  test.skip(process.platform === "win32", "requires unprivileged symlinks");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deck-path-identity-"));
  const project = path.join(root, "project");
  const projectAlias = path.join(root, "project-alias");
  const sessionDir = path.join(root, "agent", "sessions", "--identity--");
  const sessionFile = path.join(sessionDir, "owned.jsonl");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.symlinkSync(project, projectAlias, "dir");
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "path-identity-session",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: fs.realpathSync(project),
    })}\n`,
  );
  const canonicalSessionFile = fs.realpathSync(sessionFile);
  const canonicalProject = fs.realpathSync(project);
  const { app, page } = await launch(root, project, projectAlias);

  try {
    const result = await page.evaluate(async (ownedSessionFile) => {
      const api = window.piDeck;
      const projects = await api.projects.getActive();
      const projectId = projects.activeProject?.id;
      if (projectId === undefined)
        throw new Error("Missing registered project");
      const created = await api.workspaces.create({
        name: "Path identity",
        defaultProjectId: projectId,
      });
      const workspaceId = created.activeWorkspace?.id;
      if (workspaceId === undefined) throw new Error("Missing workspace");
      await api.workspaces.addSession({
        workspaceId,
        sessionFile: ownedSessionFile,
      });

      const first = await api.chat.resumeSession({
        workspaceId,
        sessionFile: ownedSessionFile,
      });
      await api.chat.closeSession({ runtimeId: first.runtimeId });
      const second = await api.chat.resumeSession({
        workspaceId,
        sessionFile: ownedSessionFile,
      });
      const deleted = await api.chat.deleteSession({
        workspaceId,
        sessionFile: ownedSessionFile,
      });
      return {
        firstCwd: first.state.cwd,
        secondCwd: second.state.cwd,
        deleted,
      };
    }, canonicalSessionFile);

    expect(result.firstCwd).toBe(projectAlias);
    expect(result.secondCwd).toBe(projectAlias);
    expect(result.deleted).toEqual({
      deleted: true,
      sessionFile: canonicalSessionFile,
    });
    expect(fs.existsSync(sessionFile)).toBe(false);

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(root, "pideck-home", "workspaces.json"),
        "utf8",
      ),
    ) as { sessionRefs: Array<{ cwd?: string; canonicalCwd?: string }> };
    // Deletion removes membership; project identity remains canonical in its store.
    expect(persisted.sessionRefs).toEqual([]);
    const projects = JSON.parse(
      fs.readFileSync(path.join(root, "pideck-home", "projects.json"), "utf8"),
    ) as { projects: Array<{ rootPath: string }> };
    expect(projects.projects[0]?.rootPath).toBe(canonicalProject);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
