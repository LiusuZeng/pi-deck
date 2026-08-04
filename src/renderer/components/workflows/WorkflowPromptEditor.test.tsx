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

  it("explains when no upstream agent result can be selected", () => {
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

    expect(container.textContent).toContain(
      "No upstream agent results are available for this step.",
    );
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});
