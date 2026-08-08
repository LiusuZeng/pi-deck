/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WorkflowStepDefinition,
  WorkflowTemplateDefinition,
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

const branchTemplate = {
  id: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
  name: "Branch handoff",
  inputs: [],
  steps: [
    step("source"),
    step("no-branch"),
    {
      ...step("yes-branch"),
      promptParts: [
        {
          type: "stepOutput" as const,
          stepId: "source",
          output: "finalAnswer" as const,
        },
      ],
    },
  ],
  transitions: [
    {
      id: "source-condition",
      fromStepId: "source",
      kind: "condition" as const,
      question: "Should the YES branch run?",
      routes: {
        yes: { kind: "step" as const, stepId: "yes-branch" },
        no: { kind: "step" as const, stepId: "no-branch" },
      },
      previewBeforeStart: false,
    },
  ],
  createdAtMs: 1,
  updatedAtMs: 1,
};

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
          workspaceChoices: [
            { id: "current-workspace", name: "Current workspace" },
          ],
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

  it("offers only graph predecessors for branch handoffs and preserves valid references", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const saved: WorkflowTemplateDefinition[] = [];
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(WorkflowBuilder, {
          initialTemplate: branchTemplate,
          onSave: (definition) => {
            saved.push(definition);
          },
          onCancel: () => undefined,
        }),
      );
    });

    const yesHeading = [
      ...container.querySelectorAll("button.workflow-card-heading"),
    ].find((button) => button.textContent?.includes("yes-branch"));
    expect(yesHeading).toBeDefined();
    act(() => {
      (yesHeading as HTMLButtonElement).click();
    });

    const yesCard = [
      ...container.querySelectorAll("article.workflow-step-card"),
    ].find((card) => card.textContent?.includes("yes-branch"));
    expect(yesCard).toBeDefined();
    expect(
      yesCard?.querySelector('select[aria-label="Add a workflow reference"]'),
    ).toBeNull();
    expect(yesCard?.textContent).not.toContain("Add structured handoff");

    act(() => {
      (
        container?.querySelector(
          "button.workflow-primary-button",
        ) as HTMLButtonElement
      ).click();
    });
    expect(saved).toHaveLength(1);
    expect(
      saved[0]?.steps.find((step) => step.id === "yes-branch")?.promptParts,
    ).toEqual(branchTemplate.steps[2]?.promptParts);
  });
});
