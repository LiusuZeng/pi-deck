/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTemplate } from "../../../shared/workflowSchemas.js";
import { WorkflowHome } from "./WorkflowHome.js";

const template: WorkflowTemplate = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "No-input workflow",
  inputs: [],
  steps: [],
  transitions: [],
  createdAtMs: 1,
  updatedAtMs: 1,
};

describe("WorkflowHome start flow", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("starts a workflow directly when it has no inputs", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onStart = vi.fn();

    act(() => {
      root?.render(
        createElement(WorkflowHome, {
          templates: [template],
          onCreate: () => undefined,
          onEdit: () => undefined,
          onStart,
          onOpenRun: () => undefined,
        }),
      );
    });

    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Start run",
    ) as HTMLButtonElement;
    act(() => start.click());

    expect(onStart).toHaveBeenCalledWith(template, {});
    expect(container.querySelector(".workflow-start-form")).toBeNull();
  });
});
