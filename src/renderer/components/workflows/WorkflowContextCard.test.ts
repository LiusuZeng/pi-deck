/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
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
      container.querySelector('textarea[aria-label="Shared instructions"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('textarea[aria-label="Don't do"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll("textarea")).toHaveLength(2);
    expect(container.textContent).not.toContain("Objective");
    expect(container.textContent).not.toContain("Constraints");
    expect(container.textContent).not.toContain("Relevant paths");
    expect(container.textContent).not.toContain("Standards");
  });
});
