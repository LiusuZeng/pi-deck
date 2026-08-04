/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WorkflowStepDefinition,
  WorkflowTransition,
} from "../../../shared/workflowSchemas.js";
import { WorkflowTransitionCard } from "./WorkflowTransitionCard.js";

const steps: WorkflowStepDefinition[] = [
  {
    id: "source",
    name: "Source",
    kind: "agent",
    promptParts: [{ type: "text", text: "Source" }],
    inputPolicy: {
      includeWorkflowContext: false,
      includeParentFinalAnswer: false,
      includeParentSummary: false,
      includeParentTranscript: false,
    },
    startPolicy: "auto",
  },
  {
    id: "terminal",
    name: "Terminal",
    kind: "agent",
    promptParts: [{ type: "text", text: "Terminal" }],
    inputPolicy: {
      includeWorkflowContext: false,
      includeParentFinalAnswer: false,
      includeParentSummary: false,
      includeParentTranscript: false,
    },
    startPolicy: "auto",
  },
];

const always: WorkflowTransition = {
  id: "source-transition",
  fromStepId: "source",
  kind: "always",
  toStepId: "terminal",
};

function render(transition: WorkflowTransition) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const changes: WorkflowTransition[] = [];
  act(() => {
    root.render(
      createElement(WorkflowTransitionCard, {
        transition,
        steps,
        fromStepId: "source",
        onChange: (next) => changes.push(next),
      }),
    );
  });
  return { container, root, changes };
}

describe("WorkflowTransitionCard condition preview", () => {
  let mounted: { container: HTMLDivElement; root: Root }[] = [];

  afterEach(() => {
    for (const { container, root } of mounted) {
      act(() => root.unmount());
      container.remove();
    }
    mounted = [];
  });

  it("defaults a newly selected condition to automatic branch start", () => {
    const fixture = render(always);
    mounted.push(fixture);
    const select = fixture.container.querySelector(
      "select",
    ) as HTMLSelectElement;
    act(() => {
      select.value = "condition";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fixture.changes.at(-1)).toMatchObject({
      kind: "condition",
      previewBeforeStart: false,
    });
  });

  it("persists an explicit preview toggle without changing branch targets", () => {
    const condition: WorkflowTransition = {
      id: "source-condition",
      fromStepId: "source",
      kind: "condition",
      question: "Continue?",
      routes: { yes: { kind: "step", stepId: "terminal" } },
      previewBeforeStart: false,
    };
    const fixture = render(condition);
    mounted.push(fixture);
    const checkbox = fixture.container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    act(() => {
      checkbox.click();
    });
    expect(fixture.changes.at(-1)).toMatchObject({
      previewBeforeStart: true,
      routes: condition.routes,
    });
  });
});
