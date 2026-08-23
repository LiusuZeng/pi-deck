// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSessionPanel } from "./TaskSessionPanel.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
});

describe("TaskSessionPanel", () => {
  it("is absent when the backend has no tasks", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        createElement(TaskSessionPanel, {
          activeCount: 0,
          activeLimit: 10,
          tasks: [],
        }),
      ),
    );

    expect(container.querySelector(".task-session-panel")).toBeNull();
  });

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
    expect(container.textContent).toContain("Waiting");
    expect(
      container.querySelectorAll("button, a, input, textarea, select"),
    ).toHaveLength(0);
  });

  it("ticks active elapsed time from its stable start timestamp and freezes terminal elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const tasks = [
      {
        taskNumber: 1,
        generatedName: "Active",
        brief: "Safe brief",
        lifecycle: "running" as const,
        attempt: 1,
        elapsedMs: 0,
        startedAtMs: Date.now() - 5_000,
        progress: "Using a tool",
      },
      {
        taskNumber: 2,
        generatedName: "Finished",
        brief: "Safe brief",
        lifecycle: "failed" as const,
        attempt: 1,
        elapsedMs: 7_000,
        // Defend against malformed IPC that incorrectly includes a start time.
        startedAtMs: Date.now() - 100_000,
        progress: "Preparing result",
      },
    ];
    act(() =>
      root?.render(
        createElement(TaskSessionPanel, {
          activeCount: 1,
          activeLimit: 2,
          tasks,
        }),
      ),
    );

    const rows = container.querySelectorAll('[role="listitem"]');
    expect(rows[0].textContent).toContain("Attempt 1 · 5s");
    expect(rows[1].textContent).toContain("Attempt 1 · 7s");
    act(() => vi.advanceTimersByTime(1_000));
    expect(rows[0].textContent).toContain("Attempt 1 · 6s");
    expect(rows[1].textContent).toContain("Attempt 1 · 7s");
  });
});
