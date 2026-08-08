/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkflowStepDefinition,
  WorkflowStepRun,
} from "../../../shared/workflowSchemas.js";
import { WorkflowStepCard } from "./WorkflowStepCard.js";

const step: WorkflowStepDefinition = {
  id: "investigate",
  name: "Investigate",
  promptParts: [{ type: "text", text: "Investigate the issue." }],
  startPolicy: "auto",
};

const runtimeOnlyRun: WorkflowStepRun = {
  id: "11111111-1111-4111-8111-111111111111",
  templateStepId: step.id,
  name: step.name,
  status: "running",
  runtimeId: "runtime-1",
  updatedAtMs: 1,
};

describe("WorkflowStepCard", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("uses accessible dropdowns for model and thinking overrides", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onChange = vi.fn();
    const editableStep = {
      ...step,
      inputPolicy: {
        includeWorkflowContext: true,
        includeParentFinalAnswer: false,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
    };

    act(() => {
      root?.render(
        createElement(WorkflowStepCard, {
          step: editableStep,
          index: 0,
          expanded: true,
          onToggle: () => undefined,
          onChange,
          modelChoices: [
            { provider: "anthropic", modelId: "claude-sonnet" },
            { provider: "openai", modelId: "gpt-codex" },
          ],
          thinkingChoices: ["low", "high"],
        }),
      );
    });

    const model = container.querySelector(
      'select[aria-label="Model override"]',
    ) as HTMLSelectElement;
    const thinking = container.querySelector(
      'select[aria-label="Thinking level"]',
    ) as HTMLSelectElement;
    expect(model.options[0]?.textContent).toBe("Inherit from Pi Deck");
    expect(thinking.options[0]?.textContent).toBe("Inherit from Pi Deck");
    expect(model.options).toHaveLength(3);
    expect(thinking.options).toHaveLength(3);
    expect(
      container.querySelector('input[aria-label="Model override"]'),
    ).toBeNull();
    expect(
      container.querySelector('input[aria-label="Thinking level"]'),
    ).toBeNull();
  });

  it("offers the Pi session action for a runtime-only running step", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onOpenSession = vi.fn();

    act(() => {
      root?.render(
        createElement(WorkflowStepCard, {
          step,
          run: runtimeOnlyRun,
          index: 0,
          expanded: true,
          onToggle: () => undefined,
          onOpenSession,
        }),
      );
    });

    const openButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Open Pi session"),
    );
    expect(openButton).not.toBeUndefined();
    openButton?.click();
    expect(onOpenSession).toHaveBeenCalledWith(runtimeOnlyRun);
  });
});
