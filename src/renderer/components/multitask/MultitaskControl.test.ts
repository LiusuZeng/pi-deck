// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MultitaskControl } from "./MultitaskControl.js";
import { MultitaskStatusPopover } from "./MultitaskStatusPopover.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tasks = [
  {
    taskNumber: 4,
    generatedName: "Build the renderer",
    brief: "Render the task panel",
    lifecycle: "running" as const,
    attempt: 1,
    elapsedMs: 1_000,
  },
  {
    taskNumber: 8,
    generatedName: "Run focused tests",
    brief: "Verify the renderer",
    lifecycle: "queued" as const,
    attempt: 1,
    elapsedMs: 0,
  },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(node: ReturnType<typeof createElement>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("MultitaskStatusPopover", () => {
  it("renders only renderer-safe task summary lines, including queued tasks", () => {
    const view = render(createElement(MultitaskStatusPopover, { tasks }));
    const list = view.querySelector('[role="list"]');

    expect(list?.textContent).toBe(
      "#4 Build the renderer — running#8 Run focused tests — queued",
    );
    expect(list?.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(
      list?.querySelectorAll("button, a, input, textarea, select"),
    ).toHaveLength(0);
  });
});

describe("MultitaskControl", () => {
  it("states the parallel mode explicitly and exposes separate task status on focus", () => {
    const view = render(
      createElement(MultitaskControl, {
        mode: "parallel",
        onClick: () => {},
        tasks,
      }),
    );
    const button = view.querySelector("button");

    expect(button?.textContent).toBe("Parallel: On");
    expect(button?.getAttribute("aria-label")).toBe(
      "Parallel multitasking: On",
    );
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(button?.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(button?.getAttribute("aria-expanded")).toBeNull();

    act(() => button?.focus());

    expect(button?.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Task status#4 Build the renderer — running#8 Run focused tests — queued",
    );
  });

  it("explains the current mode when no tasks have been delegated", () => {
    const view = render(
      createElement(MultitaskControl, {
        mode: "sequential",
        onClick: () => {},
        tasks: [],
      }),
    );
    const button = view.querySelector("button");

    act(() => button?.focus());

    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Parallel multitasking is off. Enable it to let Pi delegate independent work.",
    );
  });

  it("keeps existing action labels compatible while callers migrate to mode", () => {
    const button = render(
      createElement(MultitaskControl, {
        label: "Turn off parallel multitasking",
        tasks,
      }),
    ).querySelector("button");

    expect(button?.textContent).toBe("Parallel: On");
    expect(button?.getAttribute("aria-label")).toBe(
      "Parallel multitasking: On",
    );
    expect(button?.getAttribute("aria-pressed")).toBe("true");
  });

  it("represents unavailable, loading, and error states without enabling activation", () => {
    const unavailable = render(
      createElement(MultitaskControl, {
        enabled: false,
        tasks,
        unavailableMessage: "Send a message to enable multitasking",
      }),
    ).querySelector("button");

    expect(unavailable?.disabled).toBe(true);
    expect(unavailable?.textContent).toBe("Parallel: Off");
    expect(unavailable?.getAttribute("aria-label")).toBe(
      "Parallel multitasking: Off",
    );
    expect(unavailable?.getAttribute("aria-pressed")).toBe("false");

    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;

    const loading = render(
      createElement(MultitaskControl, { error: true, loading: true, tasks }),
    ).querySelector("button");

    expect(loading?.disabled).toBe(true);
    expect(loading?.getAttribute("aria-busy")).toBe("true");
    expect(loading?.getAttribute("aria-invalid")).toBe("true");
    expect(loading?.getAttribute("aria-label")).toBe(
      "Parallel multitasking: Off",
    );
  });
});
