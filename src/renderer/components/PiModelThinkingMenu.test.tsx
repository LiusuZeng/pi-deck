// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatModelSummary } from "../../shared/types.js";
import { PiModelThinkingMenu } from "./PiModelThinkingMenu.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const collidingCatalog: ChatModelSummary[] = [
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
  },
  {
    id: "global.anthropic.claude-opus-4-5-20251101-v1:0",
    name: "Claude Opus 4.5",
    provider: "llm-gateway-bedrock",
  },
  {
    id: "claude-opus-4-5-20251101",
    name: "claude-opus-4-5-20251101",
    provider: "anthropic",
  },
];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function renderMenu(
  initial: {
    models?: ChatModelSummary[];
    selectedModel?: ChatModelSummary;
    onSelectModel?: (provider: string, modelId: string) => void;
  } = {},
) {
  const props = {
    models: initial.models ?? collidingCatalog,
    selectedModel: initial.selectedModel ?? collidingCatalog[0],
    thinkingLevels: ["off", "high"],
    selectedThinking: "high",
    disabled: false,
    onSelectModel: initial.onSelectModel ?? vi.fn(),
    onSelectThinking: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(PiModelThinkingMenu, props)));
  return props;
}

function openModelSubmenu() {
  const trigger = container?.querySelector<HTMLButtonElement>(
    '[aria-label^="Model and thinking"]',
  );
  act(() => trigger?.click());
  const modelTrigger = document.querySelector<HTMLButtonElement>(
    ".pi-configuration-option.model",
  );
  act(() => modelTrigger?.click());
}

describe("PiModelThinkingMenu", () => {
  it("shows selected model identity in accessible and open-menu labels", () => {
    renderMenu();

    const trigger = container?.querySelector<HTMLButtonElement>(
      '[aria-label^="Model and thinking"]',
    );
    expect(trigger?.getAttribute("aria-label")).toContain(
      "Claude Opus 4.5 — claude-opus-4-5 [anthropic]",
    );

    act(() => trigger?.click());
    const modelTrigger = document.querySelector<HTMLButtonElement>(
      ".pi-configuration-option.model",
    );
    expect(modelTrigger?.textContent).toContain(
      "Claude Opus 4.5 — claude-opus-4-5 [anthropic]",
    );
  });

  it("renders same-named models with distinct id and provider labels", () => {
    renderMenu();
    openModelSubmenu();

    const labels = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".pi-model-submenu .model-choice",
      ),
      (option) => option.getAttribute("aria-label"),
    );

    expect(labels).toEqual([
      "Claude Opus 4.5 — claude-opus-4-5 [anthropic]",
      "Claude Opus 4.5 — global.anthropic.claude-opus-4-5-20251101-v1:0 [llm-gateway-bedrock]",
      "claude-opus-4-5-20251101 [anthropic]",
    ]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("selects the provider and model id for the clicked row, never the display name", () => {
    const onSelectModel = vi.fn();
    renderMenu({ onSelectModel });
    openModelSubmenu();

    const options = document.querySelectorAll<HTMLButtonElement>(
      ".pi-model-submenu .model-choice",
    );
    act(() => options[1]?.click());

    expect(onSelectModel).toHaveBeenCalledTimes(1);
    expect(onSelectModel).toHaveBeenCalledWith(
      "llm-gateway-bedrock",
      "global.anthropic.claude-opus-4-5-20251101-v1:0",
    );
  });
});
