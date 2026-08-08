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

const inputTemplate: WorkflowTemplate = {
  ...template,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Input workflow",
  inputs: [
    {
      id: "goal",
      label: "Goal",
      type: "text",
      required: false,
    },
  ],
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

  it("starts a workflow directly when it has no inputs", async () => {
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
    await act(async () => start.click());

    expect(onStart).toHaveBeenCalledWith(template, {});
    expect(container.querySelector(".workflow-start-form")).toBeNull();
  });

  it("prevents duplicate no-input starts while launch is pending", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    let finishStart: (() => void) | undefined;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );

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
    act(() => {
      start.click();
      start.click();
    });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(start.disabled).toBe(true);
    expect(start.textContent).toContain("Starting…");

    await act(async () => finishStart?.());
    expect(start.disabled).toBe(false);
  });

  it("locks input-form navigation while a launch is pending", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    let finishStart: (() => void) | undefined;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );

    act(() => {
      root?.render(
        createElement(WorkflowHome, {
          templates: [inputTemplate],
          onCreate: () => undefined,
          onEdit: () => undefined,
          onStart,
          onOpenRun: () => undefined,
        }),
      );
    });

    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Start run",
    ) as HTMLButtonElement;
    act(() => open.click());

    const form = container.querySelector("form") as HTMLFormElement;
    act(() => {
      form.requestSubmit();
      form.requestSubmit();
    });

    const back = container.querySelector(
      ".workflow-back-button",
    ) as HTMLButtonElement;
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Cancel",
    ) as HTMLButtonElement;
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(back.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);

    act(() => {
      back.click();
      cancel.click();
    });
    expect(container.querySelector("form")).not.toBeNull();

    await act(async () => finishStart?.());
    expect(back.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
  });

  it("reports a failed no-input start and allows retry", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onStart = vi.fn().mockRejectedValue(new Error("Worker unavailable"));

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
    await act(async () => start.click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Worker unavailable",
    );
    expect(start.disabled).toBe(false);
  });
});
