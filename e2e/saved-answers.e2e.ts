import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

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
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_DECK_E2E_TEST: "1",
    PI_DECK_E2E_HIDE_WINDOWS: "1",
    PI_DECK_BACKEND: "fake",
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
    await revisedRow.getByRole("button", { name: "Save as output" }).click();
    const revisionDialog = first.page.getByRole("dialog", {
      name: "Save as next revision",
    });
    await expect(revisionDialog).toBeVisible();
    await revisionDialog.getByRole("button", { name: "Save revision" }).click();
    await expect(first.page.getByText("Revision 2 of 2")).toBeVisible();
    await first.page.getByRole("button", { name: /Revision 1/ }).click();
    await expect(
      first.page.getByText("Add a rollback section with concrete steps."),
    ).toBeVisible();
    await first.app.close();
    first = undefined;

    second = await launch(env);
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
    await expect(second.page.getByText("Revision 2 of 2")).toBeVisible();
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
