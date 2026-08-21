// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParallelPromptSettings } from "./ParallelPromptSettings.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function render(
  destination: "parent" | "newTaskSession",
  onSetDestination = vi.fn(),
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(ParallelPromptSettings, {
        destination,
        defaults: {},
        models: [],
        thinkingLevels: [],
        overrides: {},
        onSetDestination,
        onOverrideModel: vi.fn(),
        onOverrideThinking: vi.fn(),
        onUpdateDefaults: vi.fn(),
      }),
    ),
  );
  return onSetDestination;
}

describe("ParallelPromptSettings", () => {
  it("keeps the parent destination visibly selected", () => {
    render("parent");
    const destination = container?.querySelector<HTMLSelectElement>(
      '[aria-label="Prompt destination"]',
    );
    expect(destination?.value).toBe("parent");
    expect(destination?.textContent).toContain("Work in parent");
  });

  it("moves keyboard focus into the worker-settings dialog", () => {
    render("newTaskSession");
    const trigger = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Parallel worker settings"]',
    );
    act(() => trigger?.click());
    const dialog = document.querySelector('[role="dialog"]');
    const firstSelect = dialog?.querySelector<HTMLSelectElement>("select");
    expect(dialog?.getAttribute("aria-label")).toBe("Parallel worker settings");
    expect(document.activeElement).toBe(firstSelect);
  });

  it("offers both destinations and reports a destination switch", () => {
    const onSetDestination = render("newTaskSession");
    const destination = container?.querySelector<HTMLSelectElement>(
      '[aria-label="Prompt destination"]',
    );
    expect(destination?.options).toHaveLength(2);
    act(() => {
      if (destination === undefined) throw new Error("destination missing");
      destination.value = "parent";
      destination.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSetDestination).toHaveBeenCalledWith("parent");
  });
});
