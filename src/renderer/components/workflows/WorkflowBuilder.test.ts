/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WorkflowStepDefinition,
  WorkflowTransition,
} from "../../../shared/workflowSchemas.js";
import {
  materializeWorkflowTransitions,
  missingWorkflowTransitionStepIds,
  WorkflowBuilder,
} from "./WorkflowBuilder.js";

const step = (id: string): WorkflowStepDefinition => ({
  id,
  name: id,
  kind: "agent",
  promptParts: [{ type: "text", text: id }],
  inputPolicy: {
    includeWorkflowContext: true,
    includeParentFinalAnswer: false,
    includeParentSummary: false,
    includeParentTranscript: false,
  },
  startPolicy: "auto",
});

describe("workflow builder transition validation", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("starts new templates global and scopes them only after explicit selection", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(WorkflowBuilder, {
          workspaceId: "current-workspace",
          workspaceName: "Current workspace",
          onSave: () => undefined,
          onCancel: () => undefined,
        }),
      );
    });

    const scope = container.querySelector(
      'select[aria-label="Workflow scope"]',
    ) as HTMLSelectElement;
    expect(scope.value).toBe("");
    expect(container.textContent).toContain("All workspaces (global)");

    act(() => {
      scope.value = "current-workspace";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(scope.value).toBe("current-workspace");
    expect(container.textContent).toContain("Current workspace");
  });

  it("keeps ordinary linear missing-transition validation", () => {
    expect(
      missingWorkflowTransitionStepIds(
        [step("first"), step("missing"), step("last")],
        [],
      ),
    ).toEqual(["first", "missing"]);
  });

  it("does not synthesize a transition after a terminal branch target", () => {
    const transitions: WorkflowTransition[] = [
      {
        id: "condition",
        fromStepId: "first",
        kind: "condition",
        question: "Continue?",
        routes: { yes: { kind: "step", stepId: "terminal" } },
        previewBeforeStart: false,
      },
    ];
    expect(
      materializeWorkflowTransitions(
        [step("first"), step("terminal"), step("unrelated")],
        transitions,
      ),
    ).toEqual(transitions);
  });

  it("allows a condition or manual branch target to be terminal", () => {
    const transitions: WorkflowTransition[] = [
      {
        id: "condition",
        fromStepId: "first",
        kind: "condition",
        question: "Continue?",
        routes: {
          yes: { kind: "step", stepId: "terminal" },
          unsure: { kind: "manualGate", toStepId: "terminal" },
        },
        previewBeforeStart: false,
      },
    ];
    expect(
      missingWorkflowTransitionStepIds(
        [step("first"), step("terminal"), step("unrelated")],
        transitions,
      ),
    ).toEqual([]);
  });
});
