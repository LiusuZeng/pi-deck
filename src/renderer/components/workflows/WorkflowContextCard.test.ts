/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowContext } from "../../../shared/workflowSchemas.js";
import { WorkflowContextCard } from "./WorkflowContextCard.js";

describe("WorkflowContextCard", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("exposes only shared instructions and do-not-do textareas", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const context: WorkflowContext = {
      objective: "Ship the workflow editor",
      constraints: "Keep the UI compact",
      relevantPaths: ["src/renderer"],
      standards: "Run tests",
      doNotDo: "Do not add a canvas",
    };

    act(() => {
      root?.render(
        createElement(WorkflowContextCard, {
          context,
          onChange: () => undefined,
        }),
      );
    });

    expect(
      container.querySelector('textarea[aria-label="Prompt"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('textarea[aria-label="Don\'t do"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll("textarea")).toHaveLength(2);
    expect(
      [...container.querySelectorAll(".workflow-field > span")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["Prompt", "Don't do"]);
  });

  it("migrates all legacy context content into the shared prompt when edited", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onChange = vi.fn();
    const context: WorkflowContext = {
      objective: "Ship the workflow editor",
      constraints: "Keep the UI compact",
      relevantPaths: ["src/renderer", "src/shared"],
      standards: "Run tests",
      doNotDo: "Do not add a canvas",
    };

    act(() => {
      root?.render(createElement(WorkflowContextCard, { context, onChange }));
    });

    const prompt = container.querySelector(
      'textarea[aria-label="Prompt"]',
    ) as HTMLTextAreaElement;
    expect(prompt.value).toBe(
      "Ship the workflow editor\n\nConstraints:\nKeep the UI compact\n\nRelevant paths:\nsrc/renderer\nsrc/shared\n\nStandards:\nRun tests",
    );

    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(prompt, `${prompt.value}\n\nCheck accessibility.`);
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({
      prompt:
        "Ship the workflow editor\n\nConstraints:\nKeep the UI compact\n\nRelevant paths:\nsrc/renderer\nsrc/shared\n\nStandards:\nRun tests\n\nCheck accessibility.",
      doNotDo: "Do not add a canvas",
      relevantPaths: [],
    });
  });
});
