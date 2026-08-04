import { describe, expect, it } from "vitest";
import { renderStepOutput, renderWorkflowPrompt } from "./workflowPromptRenderer.js";
import type { WorkflowRun, WorkflowStepDefinition, WorkflowTemplate } from "../../shared/workflowSchemas.js";

const step: WorkflowStepDefinition = {
  id: "implement",
  name: "Implement",
  kind: "agent",
  promptParts: [
    { type: "text", text: "Implement this issue:\n" },
    { type: "workflowInput", inputId: "issue" },
    { type: "text", text: "\nPrevious findings:\n" },
    { type: "stepOutput", stepId: "investigate", output: "finalAnswer" },
  ],
  inputPolicy: {
    includeWorkflowContext: true,
    includeParentFinalAnswer: true,
    includeParentSummary: false,
    includeParentTranscript: false,
  },
  startPolicy: "auto",
};

const template: WorkflowTemplate = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test",
  inputs: [{ id: "issue", label: "Issue", type: "text", required: true }],
  context: {
    objective: "Keep the fix small.",
    relevantPaths: ["src/example.ts"],
  },
  steps: [step, { ...step, id: "investigate", name: "Investigate", promptParts: [{ type: "text", text: "Investigate" }] }],
  transitions: [],
  createdAtMs: 1,
  updatedAtMs: 1,
};

const run: WorkflowRun = {
  id: "22222222-2222-4222-8222-222222222222",
  templateId: template.id,
  name: template.name,
  workspaceId: "workspace",
  status: "waiting",
  templateSnapshot: template,
  inputs: { issue: "Fix the flaky test" },
  stepRuns: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      templateStepId: "investigate",
      name: "Investigate",
      status: "completed",
      finalAnswer: "The fixture is shared across tests.",
      updatedAtMs: 1,
    },
  ],
  transitionRuns: [],
  createdAtMs: 1,
  updatedAtMs: 1,
};

describe("renderWorkflowPrompt", () => {
  it("honors parent input policy and keeps transcript distinct from answer", () => {
    const prompt = renderWorkflowPrompt({
      workflowContext: template.context,
      step: {
        ...step,
        promptParts: [{ type: "text", text: "Do it" }],
        inputPolicy: { ...step.inputPolicy, includeParentTranscript: true },
      },
      run: {
        ...run,
        parentFinalAnswer: "Parent answer",
        parentTranscript: "Parent transcript",
      },
    });
    expect(prompt).toContain("Parent final answer:\nParent answer");
    expect(prompt).toContain("Parent transcript:\nParent transcript");
    expect(() => renderStepOutput(run.stepRuns[0], "transcript")).toThrow(
      /transcript.*unavailable/i,
    );
  });

  it("blocks prompts when a referenced parent result is unavailable", () => {
    expect(() => renderWorkflowPrompt({
      workflowContext: template.context,
      step: {
        ...step,
        promptParts: [{ type: "text", text: "Do it" }],
        inputPolicy: { ...step.inputPolicy, includeParentFinalAnswer: true },
      },
      run,
    })).toThrow(/Parent final answer.*unavailable/i);
  });

  it("renders workflow context, inputs, and upstream output", () => {
    const availableRun = { ...run, parentFinalAnswer: "Parent answer" };
    expect(renderWorkflowPrompt({ workflowContext: template.context, step, run: availableRun })).toContain(
      "Keep the fix small.",
    );
    expect(renderWorkflowPrompt({ workflowContext: template.context, step, run: availableRun })).toContain(
      "Fix the flaky test",
    );
    expect(renderWorkflowPrompt({ workflowContext: template.context, step, run: availableRun })).toContain(
      "The fixture is shared across tests.",
    );
  });
});
