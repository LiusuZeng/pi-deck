// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TaskSessionPanel } from "./TaskSessionPanel.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("TaskSessionPanel", () => {
  it("shows the safe task projection and remains inert", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        createElement(TaskSessionPanel, {
          activeCount: 1,
          activeLimit: 2,
          tasks: [
            {
              taskNumber: 2,
              generatedName: "Renderer",
              brief: "Build a flat panel",
              lifecycle: "queued",
              attempt: 2,
              elapsedMs: 65_000,
              progress: "Waiting",
              queueReason: "Capacity reached",
            },
          ],
        }),
      ),
    );

    expect(container.textContent).toContain("1 active of 2");
    expect(container.textContent).toContain("#2 Renderer");
    expect(container.textContent).toContain("Attempt 2 · 1m 5s");
    expect(container.textContent).toContain("Capacity reached");
    expect(
      container.querySelectorAll("button, a, input, textarea, select"),
    ).toHaveLength(0);
  });
});
