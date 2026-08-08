/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowTemplateDefinition } from "../../../shared/workflowSchemas.js";
import { WorkflowBuilder } from "./WorkflowBuilder.js";

describe("WorkflowBuilder template scope", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("saves a new template as global even when opened in a workspace", async () => {
    let saved: WorkflowTemplateDefinition | undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(WorkflowBuilder, {
          workspaceId: "workspace-that-is-currently-open",
          workspaceName: "Current workspace",
          onSave: (definition) => {
            saved = definition;
          },
          onCancel: () => undefined,
        }),
      );
    });

    const prompt = container.querySelector(
      'textarea[aria-label="Instructions"]',
    ) as HTMLTextAreaElement;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setValue.call(prompt, "Run the terminal check.");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const save = [...container!.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save workflow",
      ) as HTMLButtonElement;
      save.click();
    });

    expect(saved).toBeDefined();
    expect(saved?.workspaceId).toBeUndefined();
  });
});
