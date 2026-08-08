/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("keeps legacy references unchanged until an explicit prompt-only migration", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onChange = vi.fn();
    act(() => {
      root?.render(
        createElement(WorkflowPromptEditor, {
          parts: [
            { type: "text", text: "Review " },
            { type: "workflowInput", inputId: "issue" },
            { type: "text", text: " carefully, then compare " },
            {
              type: "stepOutput",
              stepId: "investigate",
              output: "finalAnswer",
            },
            { type: "text", text: "." },
          ],
          inputs: [],
          previousSteps: [],
          onChange,
        }),
      );
    });

    const prompt = container.querySelector(
      'textarea[aria-label="Instructions"]',
    ) as HTMLTextAreaElement;
    expect(prompt.readOnly).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "will run unchanged until you replace them",
    );

    const replace = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Replace with prompt-only instructions"),
    );
    act(() => replace?.click());

    expect(onChange).toHaveBeenCalledWith([
      {
        type: "text",
        text: "Review \n\n carefully, then compare \n\n.",
      },
    ]);
  });
});
