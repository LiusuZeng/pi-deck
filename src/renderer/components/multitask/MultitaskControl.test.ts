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
  { number: 4, name: "Build the renderer", status: "working" },
  { number: 8, name: "Run focused tests", status: "queued" },
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
      "#4 Build the renderer — working#8 Run focused tests — queued",
    );
    expect(list?.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(
      list?.querySelectorAll("button, a, input, textarea, select"),
    ).toHaveLength(0);
  });
});

describe("MultitaskControl", () => {
  it("is an accessible icon control and exposes task status on keyboard focus", () => {
    const view = render(
      createElement(MultitaskControl, { onClick: () => {}, tasks }),
    );
    const button = view.querySelector("button");

    expect(button?.getAttribute("aria-label")).toBe("Multitasking: 2 tasks");
    expect(button?.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(button?.getAttribute("aria-expanded")).toBeNull();

    act(() => button?.focus());

    expect(button?.getAttribute("aria-describedby")).toBeTruthy();
    expect(view.querySelector('[role="tooltip"]')?.textContent).toBe(
      "#4 Build the renderer — working#8 Run focused tests — queued",
    );
  });

  it("represents unavailable, loading, and error states without enabling activation", () => {
    const unavailable = render(
      createElement(MultitaskControl, { enabled: false, tasks }),
    ).querySelector("button");

    expect(unavailable?.disabled).toBe(true);
    expect(unavailable?.getAttribute("aria-label")).toBe(
      "Multitasking unavailable",
    );

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
      "Loading multitasking status",
    );
  });
});
