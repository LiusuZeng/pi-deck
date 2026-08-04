import { describe, expect, it } from "vitest";
import {
  createWorkflowRun,
  markWorkflowStepCompleted,
  markWorkflowStepFailed,
  markWorkflowStepStarted,
  resolveWorkflowCondition,
} from "./workflowEngine.js";
import type { WorkflowTemplate } from "../../shared/workflowSchemas.js";

const policy = {
  includeWorkflowContext: true,
  includeParentFinalAnswer: true,
  includeParentSummary: false,
  includeParentTranscript: false,
};

function template(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  const now = 100;
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Investigate then act",
    inputs: [],
    steps: [
      {
        id: "investigate",
        name: "Investigate",
        kind: "agent",
        promptParts: [{ type: "text", text: "Investigate." }],
        inputPolicy: policy,
        startPolicy: "auto",
      },
      {
        id: "act",
        name: "Act",
        kind: "agent",
        promptParts: [{ type: "stepOutput", stepId: "investigate", output: "finalAnswer" }],
        inputPolicy: policy,
        startPolicy: "auto",
      },
      {
        id: "deeper",
        name: "Investigate deeper",
        kind: "agent",
        promptParts: [{ type: "text", text: "Investigate more." }],
        inputPolicy: policy,
        startPolicy: "auto",
      },
    ],
    transitions: [
      {
        id: "branch",
        fromStepId: "investigate",
        kind: "condition",
        question: "Did it find a concrete fix?",
        routes: {
          yes: { kind: "step", stepId: "act" },
          no: { kind: "step", stepId: "deeper" },
          unsure: { kind: "manualGate" },
        },
        previewBeforeStart: false,
      },
    ],
    createdAtMs: now,
    updatedAtMs: now,
    ...overrides,
  };
}

describe("workflowEngine", () => {
  it("starts root steps and routes a condition to yes", () => {
    const run = createWorkflowRun({ template: template(), workspaceId: "ws", inputs: {}, now: 100 });
    expect(run.stepRuns.find((step) => step.templateStepId === "investigate")?.status).toBe("ready");
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101, "runtime-1");
    const completed = markWorkflowStepCompleted(started, run.stepRuns[0]!.id, { finalAnswer: "A fix is clear." }, 102);
    expect(completed.transitionRuns[0]?.status).toBe("evaluating");
    const resolved = resolveWorkflowCondition(completed, completed.transitionRuns[0]!.id, "yes", "A clear fix was identified.", 103);
    expect(resolved.stepRuns.find((step) => step.templateStepId === "act")?.status).toBe("ready");
    expect(resolved.stepRuns.find((step) => step.templateStepId === "deeper")?.status).toBe("skipped");
  });

  it("routes unsure to attention without starting a branch", () => {
    const run = createWorkflowRun({ template: template(), workspaceId: "ws", inputs: {}, now: 100 });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(started, run.stepRuns[0]!.id, { finalAnswer: "Unclear." }, 102);
    const resolved = resolveWorkflowCondition(completed, completed.transitionRuns[0]!.id, "unsure", "The result was ambiguous.", 103);
    expect(resolved.status).toBe("needsAttention");
    expect(resolved.stepRuns.every((step) => step.templateStepId === "investigate" || step.status === "skipped")).toBe(true);
  });

  it("rejects missing required inputs before creating a run", () => {
    const configured = template({
      inputs: [{ id: "issue", label: "Issue", type: "text", required: true }],
    });
    expect(() => createWorkflowRun({ template: configured, workspaceId: "ws", inputs: {} })).toThrow(/required/);
  });

  it("marks a failed step as needing attention", () => {
    const run = createWorkflowRun({ template: template(), workspaceId: "ws", inputs: {}, now: 100 });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const failed = markWorkflowStepFailed(started, run.stepRuns[0]!.id, "worker failed", 102);
    expect(failed.status).toBe("needsAttention");
    expect(failed.stepRuns[0]?.error).toBe("worker failed");
  });
});
