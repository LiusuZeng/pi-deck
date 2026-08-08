/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowPromptEditor } from "./WorkflowPromptEditor.js";

describe("WorkflowPromptEditor", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("keeps the agent editor to one instructions prompt", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(WorkflowPromptEditor, {
          parts: [{ type: "text", text: "" }],
          inputs: [],
          previousSteps: [],
          onChange: () => undefined,
        }),
      );
    });

    expect(
      container.querySelector('textarea[aria-label="Instructions"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('select[aria-label="Add a workflow reference"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("structured handoff");
  });
});
