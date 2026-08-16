import { describe, expect, it } from "vitest";
import {
  renderStepOutput,
  renderWorkflowPrompt,
} from "./workflowPromptRenderer.js";
import type {
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowTemplate,
} from "../../shared/workflowSchemas.js";

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
    constraints: "Preserve existing behavior.",
    relevantPaths: ["src/example.ts"],
    standards: "Use the existing test conventions.",
    doNotDo: "Do not broaden the scope.",
  },
  steps: [
    step,
    {
      ...step,
      id: "investigate",
      name: "Investigate",
      promptParts: [{ type: "text", text: "Investigate" }],
    },
  ],
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
  it("renders prompt-first context without requiring relevant paths", () => {
    const prompt = renderWorkflowPrompt({
      workflowContext: {
        prompt: "Implement the requested change and keep the diff focused.",
        doNotDo: "Do not modify generated files.",
      },
      step: {
        ...step,
        promptParts: [{ type: "text", text: "Proceed." }],
        inputPolicy: { ...step.inputPolicy, includeParentFinalAnswer: false },
      },
      run,
    });

    expect(prompt).toContain(
      "Prompt:\nImplement the requested change and keep the diff focused.",
    );
    expect(prompt).toContain("Don't do:\nDo not modify generated files.");
    expect(prompt).not.toContain("Objective:");
    expect(prompt).not.toContain("Relevant paths:");
  });

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
    expect(() =>
      renderWorkflowPrompt({
        workflowContext: template.context,
        step: {
          ...step,
          promptParts: [{ type: "text", text: "Do it" }],
          inputPolicy: { ...step.inputPolicy, includeParentFinalAnswer: true },
        },
        run,
      }),
    ).toThrow(/Parent final answer.*unavailable/i);
  });

  it("renders workflow context, inputs, and upstream output", () => {
    const availableRun = { ...run, parentFinalAnswer: "Parent answer" };
    const prompt = renderWorkflowPrompt({
      workflowContext: template.context,
      step,
      run: availableRun,
    });
    expect(prompt).toContain("Keep the fix small.");
    expect(prompt).toContain("Constraints:\nPreserve existing behavior.");
    expect(prompt).toContain("Relevant paths:\nsrc/example.ts");
    expect(prompt).toContain("Standards:\nUse the existing test conventions.");
    expect(prompt).toContain("Do not do:\nDo not broaden the scope.");
    expect(prompt).toContain("Fix the flaky test");
    expect(
      renderWorkflowPrompt({
        workflowContext: template.context,
        step,
        run: availableRun,
      }),
    ).toContain("The fixture is shared across tests.");
  });

  it("preserves an upstream transcript when transcript output is referenced", () => {
    const transcript =
      "user: inspect the fixture\\nassistant: the fixture is shared";
    const availableRun = {
      ...run,
      stepRuns: [{ ...run.stepRuns[0]!, transcript }],
    };
    const prompt = renderWorkflowPrompt({
      workflowContext: template.context,
      step: {
        ...step,
        promptParts: [
          { type: "stepOutput", stepId: "investigate", output: "transcript" },
        ],
        inputPolicy: { ...step.inputPolicy, includeParentFinalAnswer: false },
      },
      run: availableRun,
    });
    expect(prompt).toContain(transcript);
  });
});
