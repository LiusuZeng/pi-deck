import { describe, expect, it } from "vitest";
import {
  beginWorkflowConditionEvaluation,
  createWorkflowRun,
  markWorkflowStepCompleted,
  markWorkflowStepFailed,
  markWorkflowStepStarted,
  markWorkflowStepQueued,
  readyWorkflowSteps,
  resolveWorkflowCondition,
  stopWorkflowRun,
  recoverWorkflowRun,
  approveWorkflowStep,
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
          unsure: { kind: "stop" }
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
  it("does not evaluate a condition before its source completes", () => {
    const run = createWorkflowRun({ template: template(), workspaceId: "ws", inputs: {}, now: 100 });
    const transitionRunId = run.transitionRuns[0]!.id;
    expect(() => beginWorkflowConditionEvaluation(run, transitionRunId, 101)).toThrow(/source step/);
    expect(() => resolveWorkflowCondition(run, transitionRunId, "yes", undefined, 101)).toThrow(/evaluating/);
  });

  it("starts root steps and routes a condition to yes", () => {
    const run = createWorkflowRun({ template: template(), workspaceId: "ws", inputs: {}, now: 100 });
    expect(run.stepRuns.find((step) => step.templateStepId === "investigate")?.status).toBe("ready");
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101, "runtime-1");
    const completed = markWorkflowStepCompleted(started, run.stepRuns[0]!.id, { finalAnswer: "A fix is clear." }, 102);
    expect(completed.transitionRuns[0]?.status).toBe("evaluating");
    expect(completed.status).toBe("running");
    expect(completed.updatedAtMs).toBe(102);
    const resolved = resolveWorkflowCondition(completed, completed.transitionRuns[0]!.id, "yes", "A clear fix was identified.", 103);
    expect(resolved.stepRuns.find((step) => step.templateStepId === "act")?.status).toBe("ready");
    expect(resolved.stepRuns.find((step) => step.templateStepId === "deeper")?.status).toBe("skipped");
  });

  it("stops scheduling and hides ready steps", () => {
    const run = createWorkflowRun({ template: template(), workspaceId: "ws", inputs: {}, now: 100 });
    const stopped = stopWorkflowRun(run, 101);
    expect(stopped.updatedAtMs).toBe(101);
    expect(readyWorkflowSteps(stopped)).toEqual([]);
    expect(() => markWorkflowStepQueued(stopped, run.stepRuns[0]!.id, 102)).toThrow(/stopped/i);
    expect(() => markWorkflowStepStarted(stopped, run.stepRuns[0]!.id, 102)).toThrow(/stopped/i);
  });

  it("marks queued scheduling as running and updates the aggregate timestamp", () => {
    const run = createWorkflowRun({ template: template(), workspaceId: "ws", inputs: {}, now: 100 });
    const queued = markWorkflowStepQueued(run, run.stepRuns[0]!.id, 101);
    expect(queued.status).toBe("running");
    expect(queued.updatedAtMs).toBe(101);
  });

  it("routes unsure to stop without starting a branch", () => {
    const run = createWorkflowRun({ template: template(), workspaceId: "ws", inputs: {}, now: 100 });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(started, run.stepRuns[0]!.id, { finalAnswer: "Unclear." }, 102);
    const resolved = resolveWorkflowCondition(completed, completed.transitionRuns[0]!.id, "unsure", "The result was ambiguous.", 103);
    expect(resolved.status).toBe("stopped");
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

  it("rehydrates running steps as retryable attention and keeps ready work resumable", () => {
    const run = createWorkflowRun({ template: template(), workspaceId: "ws", inputs: {}, now: 100 });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101, "lost-runtime");
    const recovered = recoverWorkflowRun(started, 200);
    expect(recovered.status).toBe("needsAttention");
    expect(recovered.stepRuns[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/previous Pi worker/),
      updatedAtMs: 200,
    });
    const ready = recoverWorkflowRun(run, 201);
    expect(ready.status).toBe("waiting");
    expect(ready.stepRuns[0]?.status).toBe("ready");
  });

  it("routes downstream work when an approval step is skipped", () => {
    const configured = template({
      steps: [
        { ...template().steps[0]!, id: "first", startPolicy: "auto" },
        { ...template().steps[1]!, id: "gate", promptParts: [{ type: "text", text: "gate" }], startPolicy: "manualApproval" },
        { ...template().steps[2]!, id: "after", promptParts: [{ type: "text", text: "after" }], startPolicy: "auto" },
      ],
      transitions: [
        { id: "to-gate", fromStepId: "first", kind: "manualGate", toStepId: "gate" },
        { id: "after-gate", fromStepId: "gate", kind: "always", toStepId: "after" },
      ],
    });
    const run = createWorkflowRun({ template: configured, workspaceId: "ws", inputs: {}, now: 100 });
    const first = run.stepRuns.find((step) => step.templateStepId === "first")!;
    const started = markWorkflowStepStarted(run, first.id, 101);
    const completed = markWorkflowStepCompleted(started, first.id, { finalAnswer: "done" }, 102);
    const gate = completed.stepRuns.find((step) => step.templateStepId === "gate")!;
    const skipped = approveWorkflowStep(completed, gate.id, "skip", 103);
    expect(skipped.stepRuns.find((step) => step.templateStepId === "after")?.status).toBe("ready");
  });
});
