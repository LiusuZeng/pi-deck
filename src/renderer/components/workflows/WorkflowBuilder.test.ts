import { describe, expect, it } from "vitest";
import type {
  WorkflowStepDefinition,
  WorkflowTransition,
} from "../../../shared/workflowSchemas.js";
import {
  materializeWorkflowTransitions,
  missingWorkflowTransitionStepIds,
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
