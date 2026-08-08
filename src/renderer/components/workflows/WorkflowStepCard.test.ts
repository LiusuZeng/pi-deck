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
            {
              provider: "anthropic",
              id: "claude-sonnet",
              label: "Claude Sonnet",
            },
            {
              provider: "openai",
              id: "gpt-codex",
              label: "GPT Codex",
              disabled: true,
              note: "Authentication required",
            },
          ],
          thinkingChoices: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
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
    expect(model.options[2]?.disabled).toBe(true);
    expect(model.options[2]?.textContent).toBe(
      "GPT Codex — Authentication required",
    );
    expect(thinking.options).toHaveLength(3);
    expect(
      container.querySelector('input[aria-label="Model override"]'),
    ).toBeNull();
    expect(
      container.querySelector('input[aria-label="Thinking level"]'),
    ).toBeNull();
  });

  it("clears a thinking override that the newly selected model cannot use", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onChange = vi.fn();
    const editableStep: WorkflowStepDefinition = {
      ...step,
      modelOverride: { provider: "provider", modelId: "reasoning" },
      thinkingOverride: "high",
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
            {
              provider: "provider",
              id: "reasoning",
              label: "Reasoning model",
              thinkingChoices: [{ id: "high", label: "High" }],
            },
            {
              provider: "provider",
              id: "basic",
              label: "Basic model",
              thinkingChoices: [{ id: "off", label: "Off" }],
            },
          ],
          thinkingChoices: [
            { id: "off", label: "Off" },
            { id: "high", label: "High" },
          ],
        }),
      );
    });

    const thinking = container.querySelector(
      'select[aria-label="Thinking level"]',
    ) as HTMLSelectElement;
    expect([...thinking.options].map((option) => option.value)).toEqual([
      "",
      "high",
    ]);

    const model = container.querySelector(
      'select[aria-label="Model override"]',
    ) as HTMLSelectElement;
    act(() => {
      model.value = "provider\u0000basic";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({
      modelOverride: { provider: "provider", modelId: "basic" },
      thinkingOverride: undefined,
    });
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
