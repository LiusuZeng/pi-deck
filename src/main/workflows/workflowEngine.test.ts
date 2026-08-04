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
  failWorkflowCondition,
  stopWorkflowRun,
  recoverWorkflowRun,
  approveWorkflowStep,
  retryWorkflowCondition,
  retryWorkflowStep,
  overrideWorkflowCondition,
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
        promptParts: [
          { type: "stepOutput", stepId: "investigate", output: "finalAnswer" },
        ],
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
          unsure: { kind: "stop" },
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
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const transitionRunId = run.transitionRuns[0]!.id;
    expect(() =>
      beginWorkflowConditionEvaluation(run, transitionRunId, 101),
    ).toThrow(/source step/);
    expect(() =>
      resolveWorkflowCondition(run, transitionRunId, "yes", undefined, 101),
    ).toThrow(/evaluating/);
  });

  it("marks a root manual-approval run as needing attention", () => {
    const configured = template({
      transitions: [],
      steps: [{ ...template().steps[0]!, startPolicy: "manualApproval" }],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    expect(run.status).toBe("needsAttention");
    expect(run.stepRuns[0]?.status).toBe("needsApproval");
  });

  it("starts root steps and routes a condition to yes", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    expect(
      run.stepRuns.find((step) => step.templateStepId === "investigate")
        ?.status,
    ).toBe("ready");
    const started = markWorkflowStepStarted(
      run,
      run.stepRuns[0]!.id,
      101,
      "runtime-1",
    );
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "A fix is clear." },
      102,
    );
    expect(completed.transitionRuns[0]?.status).toBe("evaluating");
    expect(completed.status).toBe("running");
    expect(completed.updatedAtMs).toBe(102);
    const resolved = resolveWorkflowCondition(
      completed,
      completed.transitionRuns[0]!.id,
      "yes",
      "A clear fix was identified.",
      103,
    );
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("ready");
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "deeper")
        ?.status,
    ).toBe("skipped");
  });

  it("stops scheduling and terminalizes active child state", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(
      run,
      run.stepRuns[0]!.id,
      101,
      "runtime-1",
    );
    const stopped = stopWorkflowRun(started, 102);
    expect(stopped.updatedAtMs).toBe(102);
    expect(stopped.stepRuns[0]?.status).toBe("skipped");
    expect(readyWorkflowSteps(stopped)).toEqual([]);
    expect(() =>
      markWorkflowStepQueued(stopped, run.stepRuns[0]!.id, 103),
    ).toThrow(/stopped/i);
    expect(() =>
      markWorkflowStepStarted(stopped, run.stepRuns[0]!.id, 103),
    ).toThrow(/stopped/i);
  });

  it("stops evaluating branches and skips future children", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(
      run,
      run.stepRuns[0]!.id,
      101,
      "runtime-1",
    );
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "done" },
      102,
    );
    expect(completed.transitionRuns[0]?.status).toBe("evaluating");
    const stopped = stopWorkflowRun(completed, 103);
    expect(stopped.transitionRuns[0]?.status).toBe("skipped");
    expect(
      stopped.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("skipped");
  });

  it("marks queued scheduling as running and updates the aggregate timestamp", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const queued = markWorkflowStepQueued(run, run.stepRuns[0]!.id, 101);
    expect(queued.status).toBe("running");
    expect(queued.updatedAtMs).toBe(101);
  });

  it("routes a condition to a manual-approval target and supports approve, skip, and stop", () => {
    const configured = template({
      steps: [
        template().steps[0]!,
        { ...template().steps[1]!, startPolicy: "manualApproval" },
        template().steps[2]!,
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "A fix is clear." },
      102,
    );
    const resolved = resolveWorkflowCondition(
      completed,
      completed.transitionRuns[0]!.id,
      "yes",
      "Review this fix.",
      103,
    );
    const branch = resolved.stepRuns.find(
      (step) => step.templateStepId === "act",
    )!;
    expect(resolved.transitionRuns[0]).toMatchObject({
      decision: "yes",
      selectedTarget: { kind: "step", stepId: "act" },
    });
    expect(branch.status).toBe("needsApproval");
    expect(resolved.status).toBe("needsAttention");

    const approved = approveWorkflowStep(resolved, branch.id, "approve", 104);
    expect(approved.status).toBe("waiting");
    expect(
      approved.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("ready");

    const skipped = approveWorkflowStep(resolved, branch.id, "skip", 105);
    expect(skipped.status).toBe("completed");
    expect(
      skipped.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("skipped");

    const stopped = approveWorkflowStep(resolved, branch.id, "stop", 106);
    expect(stopped.status).toBe("stopped");
  });

  it("requires approval before a previewed condition branch starts", () => {
    const configured = template({
      transitions: [
        { ...template().transitions[0]!, previewBeforeStart: true },
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "A fix is clear." },
      102,
    );
    const resolved = resolveWorkflowCondition(
      completed,
      completed.transitionRuns[0]!.id,
      "yes",
      "Review this fix.",
      103,
    );
    const branch = resolved.stepRuns.find(
      (step) => step.templateStepId === "act",
    )!;
    expect(branch.status).toBe("needsApproval");
    expect(resolved.status).toBe("needsAttention");
    const approved = approveWorkflowStep(resolved, branch.id, "approve", 104);
    expect(
      approved.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("ready");
  });

  it("makes malformed condition results retryable or explicitly overridable", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const evaluating = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "unclear" },
      102,
    );
    const failed = failWorkflowCondition(
      evaluating,
      evaluating.transitionRuns[0]!.id,
      "malformed",
      103,
    );
    expect(failed.status).toBe("needsAttention");
    expect(failed.transitionRuns[0]?.decision).toBeUndefined();
    const retried = retryWorkflowCondition(
      failed,
      failed.transitionRuns[0]!.id,
      104,
    );
    expect(retried.transitionRuns[0]?.status).toBe("evaluating");
    const failedAgain = failWorkflowCondition(
      retried,
      retried.transitionRuns[0]!.id,
      "malformed",
      105,
    );
    const overridden = overrideWorkflowCondition(
      failedAgain,
      failedAgain.transitionRuns[0]!.id,
      "no",
      "Manual review selected no.",
      106,
    );
    expect(overridden.transitionRuns[0]).toMatchObject({
      status: "resolved",
      decision: "no",
    });
    expect(
      overridden.stepRuns.find((step) => step.templateStepId === "deeper")
        ?.status,
    ).toBe("ready");
  });

  it("requires attention when unsure has no route and leaves branches untouched", () => {
    const configured = template({
      transitions: [
        {
          ...template().transitions[0]!,
          routes: {
            yes: { kind: "step", stepId: "act" },
            no: { kind: "step", stepId: "deeper" },
          },
        },
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "Unclear." },
      102,
    );
    const attention = resolveWorkflowCondition(
      completed,
      completed.transitionRuns[0]!.id,
      "unsure",
      "The result was ambiguous.",
      103,
    );
    expect(attention.status).toBe("needsAttention");
    expect(attention.transitionRuns[0]).toMatchObject({
      status: "failed",
      decision: "unsure",
      error: expect.stringMatching(/Retry.*override/i),
    });
    expect(
      attention.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("waiting");
    expect(
      attention.stepRuns.find((step) => step.templateStepId === "deeper")
        ?.status,
    ).toBe("waiting");

    const retried = retryWorkflowCondition(
      attention,
      attention.transitionRuns[0]!.id,
      104,
    );
    const failedAgain = failWorkflowCondition(
      retried,
      retried.transitionRuns[0]!.id,
      "UNSURE still has no configured route.",
      105,
    );
    const overridden = overrideWorkflowCondition(
      failedAgain,
      failedAgain.transitionRuns[0]!.id,
      "yes",
      "Explicitly selecting the yes branch.",
      106,
    );
    expect(overridden.transitionRuns[0]?.status).toBe("resolved");
    expect(
      overridden.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("ready");
  });

  it("routes unsure to stop without starting a branch", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "Unclear." },
      102,
    );
    const resolved = resolveWorkflowCondition(
      completed,
      completed.transitionRuns[0]!.id,
      "unsure",
      "The result was ambiguous.",
      103,
    );
    expect(resolved.status).toBe("stopped");
    expect(
      resolved.stepRuns.every(
        (step) =>
          step.templateStepId === "investigate" || step.status === "skipped",
      ),
    ).toBe(true);
  });

  it("fails recovery when unsure has no configured route", () => {
    const configured = template({
      transitions: [
        {
          ...template().transitions[0]!,
          routes: {
            yes: { kind: "step", stepId: "act" },
            no: { kind: "step", stepId: "deeper" },
          },
        },
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const evaluating = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "The result is ambiguous." },
      102,
    );

    const recovered = resolveWorkflowCondition(
      evaluating,
      evaluating.transitionRuns[0]!.id,
      "unsure",
      "No confident answer.",
      103,
    );

    expect(recovered.status).toBe("needsAttention");
    expect(recovered.status).not.toBe("completed");
    expect(recovered.transitionRuns[0]).toMatchObject({
      status: "failed",
      decision: "unsure",
    });
    expect(recovered.stepRuns.some((step) => step.status === "ready")).toBe(
      false,
    );
  });

  it("routes unsure to a manual approval target that supports approve, skip, and stop", () => {
    const configured = template({
      transitions: [
        {
          ...template().transitions[0]!,
          routes: {
            yes: { kind: "step", stepId: "act" },
            no: { kind: "stop" },
            unsure: { kind: "manualGate", toStepId: "deeper" },
          },
        },
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "Unclear." },
      102,
    );
    const resolved = resolveWorkflowCondition(
      completed,
      completed.transitionRuns[0]!.id,
      "unsure",
      "Review needed.",
      103,
    );
    const gate = resolved.stepRuns.find(
      (step) => step.templateStepId === "deeper",
    )!;
    expect(gate.status).toBe("needsApproval");
    expect(resolved.status).toBe("needsAttention");
    expect(
      approveWorkflowStep(resolved, gate.id, "approve", 104).stepRuns.find(
        (step) => step.id === gate.id,
      )?.status,
    ).toBe("ready");
    expect(
      approveWorkflowStep(resolved, gate.id, "skip", 104).stepRuns.find(
        (step) => step.id === gate.id,
      )?.status,
    ).toBe("skipped");
    expect(approveWorkflowStep(resolved, gate.id, "stop", 104).status).toBe(
      "stopped",
    );
  });

  it("routes no to its branch and skips the other condition targets", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "No fix yet." },
      102,
    );
    const resolved = resolveWorkflowCondition(
      completed,
      completed.transitionRuns[0]!.id,
      "no",
      undefined,
      103,
    );
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "deeper")
        ?.status,
    ).toBe("ready");
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("skipped");
  });

  it("completes a selected branch that is intentionally terminal", () => {
    const configured = template({
      steps: [
        template().steps[0]!,
        { ...template().steps[1]!, id: "terminal", name: "Terminal" },
      ],
      transitions: [
        {
          ...template().transitions[0]!,
          routes: { yes: { kind: "step", stepId: "terminal" } },
        },
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const source = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const sourceCompleted = markWorkflowStepCompleted(
      source,
      source.stepRuns[0]!.id,
      { finalAnswer: "done" },
      102,
    );
    const routed = resolveWorkflowCondition(
      sourceCompleted,
      sourceCompleted.transitionRuns[0]!.id,
      "yes",
      undefined,
      103,
    );
    const terminal = routed.stepRuns.find(
      (step) => step.templateStepId === "terminal",
    )!;
    expect(terminal.status).toBe("ready");
    const terminalStarted = markWorkflowStepStarted(routed, terminal.id, 104);
    const finished = markWorkflowStepCompleted(
      terminalStarted,
      terminal.id,
      { finalAnswer: "finished" },
      105,
    );
    expect(finished.status).toBe("completed");
    expect(
      finished.stepRuns.find((step) => step.templateStepId === "terminal"),
    ).toMatchObject({
      status: "completed",
      finalAnswer: "finished",
    });
  });

  it("skips a manual-gate target when a different condition route is selected", () => {
    const configured = template({
      transitions: [
        {
          ...template().transitions[0]!,
          routes: {
            yes: { kind: "manualGate", toStepId: "deeper" },
            no: { kind: "step", stepId: "act" },
            unsure: { kind: "stop" },
          },
        },
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "No fix yet." },
      102,
    );
    const resolved = resolveWorkflowCondition(
      completed,
      completed.transitionRuns[0]!.id,
      "no",
      undefined,
      103,
    );
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("ready");
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "deeper")
        ?.status,
    ).toBe("skipped");
  });

  it("recursively skips nested transitions below an unselected condition branch", () => {
    const base = template();
    const configured = template({
      steps: [
        ...base.steps,
        {
          ...base.steps[2]!,
          id: "nested-source",
          name: "Nested source",
          promptParts: [{ type: "text", text: "nested source" }],
        },
        {
          ...base.steps[2]!,
          id: "nested-result",
          name: "Nested result",
          promptParts: [{ type: "text", text: "nested result" }],
        },
        {
          ...base.steps[2]!,
          id: "nested-gate",
          name: "Nested gate",
          promptParts: [{ type: "text", text: "nested gate" }],
        },
      ],
      transitions: [
        base.transitions[0]!,
        {
          id: "deeper-to-nested",
          fromStepId: "deeper",
          kind: "always",
          toStepId: "nested-source",
        },
        {
          id: "nested-condition",
          fromStepId: "nested-source",
          kind: "condition",
          question: "Continue nested work?",
          routes: {
            yes: { kind: "step", stepId: "nested-result" },
            no: { kind: "manualGate", toStepId: "nested-gate" },
          },
          previewBeforeStart: false,
        },
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const completed = markWorkflowStepCompleted(
      started,
      run.stepRuns[0]!.id,
      { finalAnswer: "A fix is clear." },
      102,
    );
    const resolved = resolveWorkflowCondition(
      completed,
      completed.transitionRuns[0]!.id,
      "yes",
      undefined,
      103,
    );

    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "act")?.status,
    ).toBe("ready");
    expect(
      resolved.stepRuns
        .filter(
          (step) =>
            step.templateStepId !== "investigate" &&
            step.templateStepId !== "act",
        )
        .every(
          (step) => step.status === "skipped" || step.status === "waiting",
        ),
    ).toBe(true);
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "deeper")
        ?.status,
    ).toBe("skipped");
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "nested-source")
        ?.status,
    ).toBe("skipped");
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "nested-result")
        ?.status,
    ).toBe("skipped");
    expect(
      resolved.stepRuns.find((step) => step.templateStepId === "nested-gate")
        ?.status,
    ).toBe("skipped");
    expect(
      resolved.transitionRuns.find(
        (item) => item.templateTransitionId === "deeper-to-nested",
      )?.status,
    ).toBe("skipped");
    expect(
      resolved.transitionRuns.find(
        (item) => item.templateTransitionId === "nested-condition",
      )?.status,
    ).toBe("skipped");
  });

  it.todo(
    "rejects a condition judge result outside yes/no/unsure without mutating the run",
  );

  it("retries a failed step as ready work and clears its error", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const failed = markWorkflowStepFailed(
      started,
      run.stepRuns[0]!.id,
      "worker failed",
      102,
    );
    const retried = retryWorkflowStep(failed, failed.stepRuns[0]!.id, 103);
    expect(retried.status).toBe("waiting");
    expect(retried.stepRuns[0]).toMatchObject({ status: "ready" });
    expect(retried.stepRuns[0]?.error).toBeUndefined();
  });
  it("rejects missing required and referenced inputs before creating a run", () => {
    const configured = template({
      inputs: [{ id: "issue", label: "Issue", type: "text", required: false }],
      steps: [
        {
          ...template().steps[0]!,
          promptParts: [{ type: "workflowInput", inputId: "issue" }],
        },
        ...template().steps.slice(1),
      ],
    });
    expect(() =>
      createWorkflowRun({
        template: configured,
        workspaceId: "ws",
        inputs: {},
      }),
    ).toThrow(/required/);
  });

  it("marks a root manual approval step as needing attention", () => {
    const configured = template({
      steps: [
        { ...template().steps[0]!, startPolicy: "manualApproval" },
        ...template().steps.slice(1),
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    expect(run.stepRuns[0]?.status).toBe("needsApproval");
    expect(run.status).toBe("needsAttention");
  });

  it("marks a failed step as needing attention", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(run, run.stepRuns[0]!.id, 101);
    const failed = markWorkflowStepFailed(
      started,
      run.stepRuns[0]!.id,
      "worker failed",
      102,
    );
    expect(failed.status).toBe("needsAttention");
    expect(failed.stepRuns[0]?.error).toBe("worker failed");
  });

  it("rehydrates running steps as retryable attention and keeps ready work resumable", () => {
    const run = createWorkflowRun({
      template: template(),
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const started = markWorkflowStepStarted(
      run,
      run.stepRuns[0]!.id,
      101,
      "lost-runtime",
    );
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
        {
          ...template().steps[1]!,
          id: "gate",
          promptParts: [{ type: "text", text: "gate" }],
          startPolicy: "manualApproval",
        },
        {
          ...template().steps[2]!,
          id: "after",
          promptParts: [{ type: "text", text: "after" }],
          startPolicy: "auto",
        },
      ],
      transitions: [
        {
          id: "to-gate",
          fromStepId: "first",
          kind: "manualGate",
          toStepId: "gate",
        },
        {
          id: "after-gate",
          fromStepId: "gate",
          kind: "always",
          toStepId: "after",
        },
      ],
    });
    const run = createWorkflowRun({
      template: configured,
      workspaceId: "ws",
      inputs: {},
      now: 100,
    });
    const first = run.stepRuns.find((step) => step.templateStepId === "first")!;
    const started = markWorkflowStepStarted(run, first.id, 101);
    const completed = markWorkflowStepCompleted(
      started,
      first.id,
      { finalAnswer: "done" },
      102,
    );
    const gate = completed.stepRuns.find(
      (step) => step.templateStepId === "gate",
    )!;
    const skipped = approveWorkflowStep(completed, gate.id, "skip", 103);
    expect(
      skipped.stepRuns.find((step) => step.templateStepId === "after")?.status,
    ).toBe("ready");
  });
});
