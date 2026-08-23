// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatModelSummary,
  ParallelWorkerSettings,
} from "../../../shared/types.js";
import {
  ParallelPromptSettings,
  type ParallelPromptSettingsProps,
} from "./ParallelPromptSettings.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const model: ChatModelSummary = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
};
const selectedModel = { provider: model.provider!, modelId: model.id };
const modelWithControlCharacters: ChatModelSummary = {
  provider: 'provider\u0000with"quotes',
  id: "model\u0000with\\slashes",
  name: "Control character model",
};
const selectedModelWithControlCharacters = {
  provider: modelWithControlCharacters.provider!,
  modelId: modelWithControlCharacters.id,
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function renderSettings(initial: Partial<ParallelPromptSettingsProps> = {}) {
  const props: ParallelPromptSettingsProps = {
    destination: "newTaskSession",
    defaults: {},
    models: [],
    thinkingLevels: [],
    overrides: {},
    onSetDestination: vi.fn(),
    onOverrideModel: vi.fn(),
    onOverrideThinking: vi.fn(),
    onUpdateDefaults: vi.fn(),
    ...initial,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const rerender = (next: Partial<ParallelPromptSettingsProps>) => {
    Object.assign(props, next);
    act(() => root?.render(createElement(ParallelPromptSettings, props)));
  };
  rerender({});
  return { props, rerender };
}

function openWorkerSettings() {
  const trigger = container?.querySelector<HTMLButtonElement>(
    '[aria-label="Parallel worker settings"]',
  );
  act(() => trigger?.click());
}

function workerSelect(label: string) {
  const select = document.querySelector<HTMLSelectElement>(
    `[aria-label="${label}"]`,
  );
  if (!select) throw new Error(`${label} missing`);
  return select;
}

function selectValue(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("ParallelPromptSettings", () => {
  it("keeps the parent destination visibly selected", () => {
    renderSettings({ destination: "parent" });
    const destination = container?.querySelector<HTMLSelectElement>(
      '[aria-label="Prompt destination"]',
    );
    expect(destination?.value).toBe("parent");
    expect(destination?.textContent).toContain("Work in parent");
  });

  it("moves keyboard focus into the worker-settings dialog", () => {
    renderSettings();
    openWorkerSettings();
    const dialog = document.querySelector('[role="dialog"]');
    const firstSelect = dialog?.querySelector<HTMLSelectElement>("select");
    expect(dialog?.getAttribute("aria-label")).toBe("Parallel worker settings");
    expect(document.activeElement).toBe(firstSelect);
  });

  it("offers both destinations and reports a destination switch", () => {
    const { props } = renderSettings();
    const destination = container?.querySelector<HTMLSelectElement>(
      '[aria-label="Prompt destination"]',
    );
    if (!destination) throw new Error("destination missing");
    selectValue(destination, "parent");
    expect(props.onSetDestination).toHaveBeenCalledWith("parent");
  });

  it("round-trips a worker model override through DOM-safe option values", () => {
    const { props, rerender } = renderSettings({
      models: [modelWithControlCharacters],
    });
    openWorkerSettings();
    const select = workerSelect("Worker model override");
    const option = select.options[1];
    expect(option.value).not.toContain("\u0000");

    selectValue(select, option.value);
    expect(props.onOverrideModel).toHaveBeenCalledWith(
      selectedModelWithControlCharacters,
    );
    expect(props.onOverrideThinking).toHaveBeenCalledWith(undefined);

    rerender({ overrides: { model: selectedModelWithControlCharacters } });
    expect(workerSelect("Worker model override").value).toBe(option.value);
  });

  it("updates and clears the persistent worker model default", () => {
    const defaults: ParallelWorkerSettings = { thinkingLevel: "high" };
    const { props, rerender } = renderSettings({ defaults, models: [model] });
    openWorkerSettings();
    const select = workerSelect("Persistent worker model");
    const option = select.options[1];

    selectValue(select, option.value);
    const updatedDefaults = { model: selectedModel, thinkingLevel: undefined };
    expect(props.onUpdateDefaults).toHaveBeenCalledWith(updatedDefaults);

    rerender({ defaults: updatedDefaults });
    expect(workerSelect("Persistent worker model").value).toBe(option.value);

    selectValue(workerSelect("Persistent worker model"), "");
    expect(props.onUpdateDefaults).toHaveBeenLastCalledWith({
      model: undefined,
      thinkingLevel: undefined,
    });
  });

  it("treats malformed worker model values as no selection", () => {
    const { props } = renderSettings({ models: [model] });
    openWorkerSettings();
    const select = workerSelect("Worker model override");
    const malformed = document.createElement("option");
    malformed.value = "not a model";
    select.append(malformed);

    selectValue(select, malformed.value);
    expect(props.onOverrideModel).toHaveBeenCalledWith(undefined);
    expect(props.onOverrideThinking).toHaveBeenCalledWith(undefined);

    selectValue(select, "");
    expect(props.onOverrideModel).toHaveBeenLastCalledWith(undefined);
  });
});
