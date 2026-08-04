import { describe, expect, it } from "vitest";
import {
  runProgress,
  templateValidationErrors,
  workflowRunStatusLabel,
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
    expect(workflowStepStatusTone("running")).toBe("active");
    expect(workflowStepStatusTone("failed")).toBe("danger");
  });

  it("counts completed and skipped steps for progress", () => {
    expect(runProgress(run("running"))).toEqual({ completed: 2, total: 2 });
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
