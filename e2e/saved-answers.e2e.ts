import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

function createFakePiBinary(root: string): string {
  const fakePiPath = path.join(root, "fake-pi.js");
  fs.writeFileSync(
    fakePiPath,
    `#!${process.execPath}\nif (process.argv.includes("--version")) {\n  console.log("v42.5.0");\n  process.exit(0);\n}\nif (process.argv.includes("--list-models")) {\n  console.log("provider  model       context  max-out  thinking  images");\n  console.log("fake-provider  fake-model  128K     32K      yes       yes");\n  process.exit(0);\n}\nrequire(${JSON.stringify(path.join(repoRoot, "dist/main/pi/fakeRpc/fakeRpcServer.js"))});\n`,
    { mode: 0o755 },
  );
  return fakePiPath;
}

async function launch(env: NodeJS.ProcessEnv): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(
    page.locator('.workspace[data-load-state="ready"]'),
  ).toBeVisible();
  return { app, page };
}

test("a completed answer can be saved and reopened after app restart", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-deck-saved-answer-e2e-"),
  );
  const home = path.join(root, "pideck-home");
  const userData = path.join(root, "user-data");
  const projectCwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  for (const directory of [home, userData, projectCwd, agentDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(userData, "settings.json"),
    `${JSON.stringify({
      theme: "system",
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: false,
    })}\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_DECK_E2E_TEST: "1",
    PI_DECK_E2E_HIDE_WINDOWS: "1",
    // Real mode is required to exercise main's native session-file resume.
    // The checked-in RPC fixture is a credential-free Pi CLI transport.
    PI_DECK_BACKEND: "real",
    PI_DECK_PI_BINARY: createFakePiBinary(root),
    PI_DECK_PROJECT_CWD: projectCwd,
    PI_CODING_AGENT_DIR: agentDir,
    PI_DECK_HOME: home,
    PI_DECK_USER_DATA_DIR: userData,
  };

  let first: Awaited<ReturnType<typeof launch>> | undefined;
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  let third: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    first = await launch(env);
    await expect(
      first.page.evaluate(async () => {
        try {
          await window.piDeck.savedAnswers.save({
            requestId: "00000000-0000-4000-8000-000000000001",
            runtimeId: "private-or-unattached-runtime",
            assistantText: "not authorized",
            title: "Must not save",
          });
          return "unexpected success";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }),
    ).resolves.toMatch(/no longer attached|unknown/i);
    await first.page.getByRole("button", { name: "New session" }).click();
    await first.page.getByLabel("Prompt text").fill("Answer worth keeping");
    await first.page.getByRole("button", { name: "Send" }).click();
    const answer = first.page.getByText(
      "Fake response to: Answer worth keeping",
    );
    await expect(answer).toBeVisible();
    await expect(
      first.page.evaluate(async () => {
        const snapshot = await window.piDeck.chat.getSnapshot();
        const assistant = [...snapshot.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (assistant === undefined)
          throw new Error("Missing assistant message");
        try {
          await window.piDeck.savedAnswers.save({
            requestId: "00000000-0000-4000-8000-000000000005",
            runtimeId: snapshot.runtimeId,
            assistantText: `${assistant.content ?? ""} altered`,
            ...(assistant.id === undefined
              ? {}
              : { assistantMessageId: assistant.id }),
            title: "Must not save altered renderer text",
          });
          return "unexpected success";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }),
    ).resolves.toMatch(/no longer present/);

    const assistantRow = answer.locator(
      "xpath=ancestor::article[contains(@class, 'assistant-row')]",
    );
    await assistantRow.hover();
    const saveButton = assistantRow.getByRole("button", {
      name: "Save as output",
    });
    await saveButton.click();
    const dialog = first.page.getByRole("dialog", { name: "Save as output" });
    await expect(dialog).toBeVisible();
    await first.page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(saveButton).toBeFocused();
    await saveButton.click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Title").fill("Kept answer");
    await dialog.getByRole("button", { name: "Save output" }).click();

    await expect(
      first.page.getByRole("heading", { name: "Kept answer" }),
    ).toBeVisible();
    await expect(
      first.page.getByText("Fake response to: Answer worth keeping", {
        exact: true,
      }),
    ).toBeVisible();
    await first.page
      .getByLabel("Review feedback")
      .fill("Add a rollback section with concrete steps.");
    await first.page.getByRole("button", { name: "Request changes" }).click();
    await expect(
      first.page.getByText("Changes requested", { exact: true }).first(),
    ).toBeVisible();
    await first.page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      await window.piDeck.chat.closeSession({ runtimeId: snapshot.runtimeId });
    });
    await first.page
      .getByRole("button", { name: "Revise in new session" })
      .click();
    await expect(
      first.page.getByText(/Revising Kept answer, revision 1/),
    ).toBeVisible();
    await expect(first.page.getByLabel("Prompt text")).toHaveValue(
      /Add a rollback section/,
    );
    await first.page.getByRole("button", { name: "Send" }).click();
    const revisedRow = first.page.locator("article.assistant-row").last();
    await expect(
      revisedRow.getByRole("button", { name: "Save as output" }),
    ).toBeVisible();
    const closedRevision = await first.page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      const [status, workspace] = await Promise.all([
        window.piDeck.chat.getRuntimeStatus({ runtimeId: snapshot.runtimeId }),
        window.piDeck.workspaces.getActive(),
      ]);
      if (
        status.state.sessionFile === undefined ||
        workspace.activeWorkspace === undefined
      ) {
        throw new Error("Missing durable revision session identity");
      }
      await window.piDeck.chat.closeSession({ runtimeId: snapshot.runtimeId });
      return {
        runtimeId: snapshot.runtimeId,
        sessionFile: status.state.sessionFile,
        workspaceId: workspace.activeWorkspace.id,
      };
    });
    // Intentional close leaves a completed saved session idle, not failed. Go
    // through Work and reopen its durable Activity row, which calls the real
    // resume path instead of exposing an error-only recovery control.
    await first.page.getByTestId("session-origin-back").click();
    const closedRevisionRow = first.page
      .locator(".activity-inbox-row")
      .filter({ hasText: "Revise Kept answer" });
    await expect(closedRevisionRow).toHaveCount(1);
    await expect(closedRevisionRow).toHaveAttribute(
      "data-activity-item-id",
      `activity:${closedRevision.workspaceId}:${closedRevision.sessionFile}`,
    );
    await closedRevisionRow.click();
    await expect(
      first.page.getByText("Resumed saved Pi session."),
    ).toBeVisible();
    const resumedRevision = await first.page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      const status = await window.piDeck.chat.getRuntimeStatus({
        runtimeId: snapshot.runtimeId,
      });
      return {
        runtimeId: snapshot.runtimeId,
        sessionFile: status.state.sessionFile,
      };
    });
    expect(resumedRevision.runtimeId).not.toBe(closedRevision.runtimeId);
    expect(resumedRevision.sessionFile).toBe(closedRevision.sessionFile);
    await first.page
      .locator("article.assistant-row")
      .last()
      .getByRole("button", { name: "Save as output" })
      .click();
    const firstRevisionDialog = first.page.getByRole("dialog", {
      name: "Save as next revision",
    });
    await expect(firstRevisionDialog).toBeVisible();
    await firstRevisionDialog
      .getByRole("button", { name: "Save revision" })
      .click();
    await expect(first.page.getByText("Revision 2 of 2")).toBeVisible();

    // Create another revision, then prove the target also survives a full
    // application restart before that completed response is saved.
    await first.page
      .getByLabel("Review feedback")
      .fill("Add an incident-owner checklist.");
    await first.page.getByRole("button", { name: "Request changes" }).click();
    await expect(
      first.page.getByText("Changes requested", { exact: true }).first(),
    ).toBeVisible();
    await first.page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      await window.piDeck.chat.closeSession({ runtimeId: snapshot.runtimeId });
    });
    await first.page
      .getByRole("button", { name: "Revise in new session" })
      .click();
    await expect(
      first.page.getByText(/Revising Kept answer, revision 2/),
    ).toBeVisible();
    await first.page.getByRole("button", { name: "Send" }).click();
    await expect(
      first.page
        .locator("article.assistant-row")
        .last()
        .getByRole("button", { name: "Save as output" }),
    ).toBeVisible();
    const restartRevision = await first.page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      const [status, workspace] = await Promise.all([
        window.piDeck.chat.getRuntimeStatus({ runtimeId: snapshot.runtimeId }),
        window.piDeck.workspaces.getActive(),
      ]);
      if (
        status.state.sessionFile === undefined ||
        workspace.activeWorkspace === undefined
      ) {
        throw new Error("Missing durable revision session identity");
      }
      await window.piDeck.chat.closeSession({ runtimeId: snapshot.runtimeId });
      return {
        runtimeId: snapshot.runtimeId,
        sessionFile: status.state.sessionFile,
        workspaceId: workspace.activeWorkspace.id,
      };
    });
    await first.app.close();
    first = undefined;

    second = await launch(env);
    const restartedRevisionRow = second.page.locator(
      `.activity-inbox-row[data-activity-item-id=${JSON.stringify(
        `activity:${restartRevision.workspaceId}:${restartRevision.sessionFile}`,
      )}]`,
    );
    await expect(restartedRevisionRow).toHaveCount(1);
    await restartedRevisionRow.click();
    await expect(
      second.page.getByText("Resumed saved Pi session."),
    ).toBeVisible();
    await expect(
      second.page.getByText(/Revising Kept answer, revision 2/),
    ).toBeVisible();
    const restartedRevision = await second.page.evaluate(async () => {
      const snapshot = await window.piDeck.chat.getSnapshot();
      const [status, workspace] = await Promise.all([
        window.piDeck.chat.getRuntimeStatus({ runtimeId: snapshot.runtimeId }),
        window.piDeck.workspaces.getActive(),
      ]);
      if (
        status.state.sessionFile === undefined ||
        workspace.activeWorkspace === undefined
      ) {
        throw new Error("Missing resumed revision session identity");
      }
      return {
        runtimeId: snapshot.runtimeId,
        sessionFile: status.state.sessionFile,
        workspaceId: workspace.activeWorkspace.id,
      };
    });
    expect(restartedRevision.runtimeId).not.toBe(restartRevision.runtimeId);
    expect(restartedRevision.sessionFile).toBe(restartRevision.sessionFile);
    expect(restartedRevision.workspaceId).toBe(restartRevision.workspaceId);
    const resumedRevisionRow = second.page
      .locator("article.assistant-row")
      .last();
    await resumedRevisionRow
      .getByRole("button", { name: "Save as output" })
      .click();
    const revisionDialog = second.page.getByRole("dialog", {
      name: "Save as next revision",
    });
    await expect(revisionDialog).toBeVisible();
    await revisionDialog.getByRole("button", { name: "Save revision" }).click();
    await expect(second.page.getByText("Revision 3 of 3")).toBeVisible();
    await second.page.getByRole("button", { name: /Revision 2/ }).click();
    await expect(
      second.page.getByText("Add an incident-owner checklist."),
    ).toBeVisible();
    await second.page.getByRole("button", { name: "Outputs" }).click();
    await expect(
      second.page.getByRole("heading", { name: "Outputs" }),
    ).toBeVisible();
    await second.page.getByLabel("Search outputs").fill("rollback concrete");
    await second.page.getByRole("button", { name: "Search" }).click();
    await second.page.getByRole("button", { name: /Kept answer/ }).click();
    await expect(
      second.page.getByRole("heading", { name: "Kept answer" }),
    ).toBeVisible();
    await expect(second.page.locator(".saved-answer-content")).toContainText(
      "Add a rollback section with concrete steps.",
    );
    await expect(second.page.getByText("Revision 3 of 3")).toBeVisible();
    const savedIdentity = await second.page.evaluate(async () => {
      const workspace = await window.piDeck.workspaces.getActive();
      if (workspace.activeWorkspace === undefined) {
        throw new Error("Missing active workspace");
      }
      const listed = await window.piDeck.savedAnswers.list({
        workspaceId: workspace.activeWorkspace.id,
      });
      const item = listed.items[0];
      if (item === undefined) throw new Error("Missing saved answer");
      return item;
    });
    await second.app.close();
    second = undefined;

    fs.writeFileSync(
      path.join(
        home,
        "saved-answers",
        "outputs",
        savedIdentity.outputId,
        "revisions",
        savedIdentity.revisionId,
        "files",
        "answer.md",
      ),
      "externally changed",
    );
    third = await launch(env);
    await third.page.getByRole("button", { name: "Outputs" }).click();
    await expect(third.page.getByText(/could not be verified/)).toBeVisible();
    await expect(
      third.page.getByRole("button", { name: /Kept answer/ }),
    ).toHaveCount(0);
  } finally {
    await first?.app.close().catch(() => undefined);
    await second?.app.close().catch(() => undefined);
    await third?.app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
