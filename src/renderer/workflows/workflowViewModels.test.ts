import { describe, expect, it } from "vitest";
import {
  runProgress,
  templateValidationErrors,
  workflowPredecessorSteps,
  workflowRunStatusLabel,
  workflowStepStatusLabel,
  workflowStepStatusTone,
} from "./workflowViewModels.js";
import type {
  WorkflowRun,
  WorkflowTemplate,
} from "../../shared/workflowSchemas.js";

const template = {
  id: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
  name: "Review and fix",
  inputs: [],
  steps: [
    {
      id: "review",
      name: "Review",
      kind: "agent" as const,
      promptParts: [{ type: "text" as const, text: "Review the change." }],
      inputPolicy: {
        includeWorkflowContext: true,
        includeParentFinalAnswer: false,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
      startPolicy: "auto" as const,
    },
  ],
  transitions: [],
  createdAtMs: 1,
  updatedAtMs: 1,
} satisfies WorkflowTemplate;

function run(status: WorkflowRun["status"]): WorkflowRun {
  return {
    id: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1",
    templateId: template.id,
    name: template.name,
    workspaceId: "workspace",
    status,
    templateSnapshot: template,
    inputs: {},
    stepRuns: [
      {
        id: "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1",
        templateStepId: "review",
        name: "Review",
        status: "completed",
        updatedAtMs: 1,
      },
      {
        id: "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
        templateStepId: "review",
        name: "Extra",
        status: "skipped",
        updatedAtMs: 1,
      },
    ],
    transitionRuns: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("workflow view models", () => {
  it("labels run states and maps step states to visual tones", () => {
    expect(workflowRunStatusLabel("needsAttention")).toBe("Needs attention");
    expect(workflowRunStatusLabel("waiting")).toBe("Waiting");
    expect(workflowRunStatusLabel("running")).toBe("Running");
    expect(workflowRunStatusLabel("completed")).toBe("Completed");
    expect(workflowRunStatusLabel("failed")).toBe("Failed");
    expect(workflowRunStatusLabel("stopped")).toBe("Stopped");
    expect(workflowStepStatusTone("running")).toBe("active");
    expect(workflowStepStatusTone("failed")).toBe("danger");
    expect(workflowStepStatusTone("needsApproval")).toBe("warning");
    expect(workflowStepStatusTone("completed")).toBe("success");
    expect(workflowStepStatusTone("waiting")).toBe("neutral");
  });

  it("maps every persisted step status to a user-facing label", () => {
    expect(workflowStepStatusLabel("waiting")).toBe("Waiting");
    expect(workflowStepStatusLabel("ready")).toBe("Ready");
    expect(workflowStepStatusLabel("queued")).toBe("Queued");
    expect(workflowStepStatusLabel("starting")).toBe("Starting");
    expect(workflowStepStatusLabel("running")).toBe("In progress");
    expect(workflowStepStatusLabel("completed")).toBe("Completed");
    expect(workflowStepStatusLabel("failed")).toBe("Failed");
    expect(workflowStepStatusLabel("skipped")).toBe("Skipped");
    expect(workflowStepStatusLabel("blocked")).toBe("Blocked");
    expect(workflowStepStatusLabel("needsApproval")).toBe("Needs approval");
  });

  it("counts completed and skipped steps for progress", () => {
    expect(runProgress(run("running"))).toEqual({ completed: 2, total: 2 });
  });

  it("follows persisted transition routes for valid upstream results", () => {
    const steps = [
      { ...template.steps[0], id: "always-source", name: "Always source" },
      { ...template.steps[0], id: "manual-source", name: "Manual source" },
      {
        ...template.steps[0],
        id: "condition-source",
        name: "Condition source",
      },
      { ...template.steps[0], id: "sibling", name: "Skipped sibling" },
      { ...template.steps[0], id: "target", name: "Target" },
    ];
    const transitions = [
      {
        id: "always",
        fromStepId: "always-source",
        kind: "always" as const,
        toStepId: "target",
      },
      {
        id: "manual",
        fromStepId: "manual-source",
        kind: "manualGate" as const,
        toStepId: "target",
      },
      {
        id: "condition",
        fromStepId: "condition-source",
        kind: "condition" as const,
        question: "Continue?",
        routes: {
          yes: { kind: "step" as const, stepId: "target" },
          no: { kind: "step" as const, stepId: "sibling" },
          unsure: { kind: "manualGate" as const, toStepId: "target" },
        },
        previewBeforeStart: false,
      },
    ];

    expect(
      workflowPredecessorSteps(steps, transitions, "target").map(
        (step) => step.id,
      ),
    ).toEqual(["always-source", "manual-source", "condition-source"]);
    expect(
      workflowPredecessorSteps(steps, transitions, "sibling").map(
        (step) => step.id,
      ),
    ).toEqual(["condition-source"]);
  });

  it("reports missing prompts before saving a template", () => {
    expect(
      templateValidationErrors({
        ...template,
        steps: [
          {
            ...template.steps[0],
            name: "Empty",
            promptParts: [{ type: "text", text: " " }],
          },
        ],
      }),
    ).toEqual(["Empty needs a prompt."]);
  });
});
