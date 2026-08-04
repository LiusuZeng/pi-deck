import { randomUUID } from "node:crypto";
import {
  workflowRunSchema,
  workflowTemplateSchema,
  type WorkflowRouteTarget,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStepDefinition,
  type WorkflowStepRun,
  type WorkflowTemplate,
  type WorkflowTransition,
} from "../../shared/workflowSchemas.js";

export type WorkflowDecision = "yes" | "no" | "unsure";

export function createWorkflowRun(options: {
  template: WorkflowTemplate;
  workspaceId: string;
  inputs: Record<string, string>;
  now?: number;
}): WorkflowRun {
  const now = options.now ?? Date.now();
  const template = workflowTemplateSchema.parse(options.template);
  const inputs = validateRunInputs(template, options.inputs);
  const incoming = new Set(
    template.transitions.flatMap((transition) => transitionTargets(transition)),
  );
  const stepRuns = template.steps.map((step) => ({
    id: randomUUID(),
    templateStepId: step.id,
    name: step.name,
    status: incoming.has(step.id)
      ? ("waiting" as const)
      : step.startPolicy === "manualApproval"
        ? ("needsApproval" as const)
        : ("ready" as const),
    updatedAtMs: now,
  }));

  return workflowRunSchema.parse({
    id: randomUUID(),
    templateId: template.id,
    name: template.name,
    workspaceId: options.workspaceId,
    status: stepRuns.some((step) => step.status === "needsApproval")
      ? "needsAttention"
      : "waiting",
    templateSnapshot: template,
    inputs,
    stepRuns,
    transitionRuns: template.transitions.map((transition) => ({
      id: randomUUID(),
      templateTransitionId: transition.id,
      status: "waiting",
      updatedAtMs: now,
    })),
    createdAtMs: now,
    updatedAtMs: now,
  });
}

export function validateRunInputs(
  template: WorkflowTemplate,
  inputs: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(template.inputs.map((input) => input.id));
  const result: Record<string, string> = {};
  const referencedInputIds = new Set(
    template.steps.flatMap((step) =>
      step.promptParts.flatMap((part) =>
        part.type === "workflowInput" ? [part.inputId] : [],
      ),
    ),
  );
  for (const input of template.inputs) {
    const value = inputs[input.id] ?? input.defaultValue;
    if ((input.required || referencedInputIds.has(input.id)) && (!value || value.trim().length === 0)) {
      throw new Error(`Workflow input is required: ${input.label}`);
    }
    if (value !== undefined) result[input.id] = value;
  }
  for (const key of Object.keys(inputs)) {
    if (!allowed.has(key)) throw new Error(`Unknown workflow input: ${key}`);
  }
  return result;
}

export function markWorkflowStepStarted(
  run: WorkflowRun,
  stepRunId: string,
  now = Date.now(),
  runtimeId?: string,
): WorkflowRun {
  assertRunSchedulable(run);
  const step = requireStepRun(run, stepRunId);
  if (step.status !== "ready" && step.status !== "queued" && step.status !== "starting") {
    throw new Error(`Workflow step is not ready to start: ${step.name}`);
  }
  const next = updateStep(run, stepRunId, {
    status: "running",
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    startedAtMs: step.startedAtMs ?? now,
    updatedAtMs: now,
  });
  return withRunStatus(next, "running", now);
}

export function markWorkflowStepCompleted(
  run: WorkflowRun,
  stepRunId: string,
  output: { finalAnswer?: string; summary?: string; transcript?: string },
  now = Date.now(),
): WorkflowRun {
  const step = requireStepRun(run, stepRunId);
  if (run.status === "stopped") {
    const next = updateStep(run, stepRunId, {
      status: "completed",
      ...(output.finalAnswer !== undefined ? { finalAnswer: output.finalAnswer } : {}),
      ...(output.summary !== undefined ? { summary: output.summary } : {}),
      ...(output.transcript !== undefined ? { transcript: output.transcript } : {}),
      completedAtMs: now,
      updatedAtMs: now,
    });
    return withRunStatus(next, "stopped", now);
  }
  const next = updateStep(run, stepRunId, {
    status: "completed",
    ...(output.finalAnswer !== undefined ? { finalAnswer: output.finalAnswer } : {}),
    ...(output.summary !== undefined ? { summary: output.summary } : {}),
    ...(output.transcript !== undefined ? { transcript: output.transcript } : {}),
    completedAtMs: now,
    updatedAtMs: now,
  });
  return routeCompletedStep(next, step.templateStepId, now);
}

export function markWorkflowStepFailed(
  run: WorkflowRun,
  stepRunId: string,
  error: string,
  now = Date.now(),
): WorkflowRun {
  const step = requireStepRun(run, stepRunId);
  const next = updateStep(run, stepRunId, {
    status: "failed",
    error,
    updatedAtMs: now,
  });
  return withRunStatus(next, run.status === "stopped" ? "stopped" : "needsAttention", now);
}

export function markWorkflowStepQueued(
  run: WorkflowRun,
  stepRunId: string,
  now = Date.now(),
): WorkflowRun {
  assertRunSchedulable(run);
  const next = updateStep(run, stepRunId, { status: "queued", updatedAtMs: now });
  return withRunStatus(next, undefined, now);
}

export function resolveWorkflowCondition(
  run: WorkflowRun,
  transitionRunId: string,
  decision: WorkflowDecision,
  rationale?: string,
  now = Date.now(),
): WorkflowRun {
  assertRunSchedulable(run);
  const transitionRun = run.transitionRuns.find((item) => item.id === transitionRunId);
  if (transitionRun === undefined) throw new Error(`Unknown workflow transition run: ${transitionRunId}`);
  const transition = requireTransition(run, transitionRun.templateTransitionId);
  if (transition.kind !== "condition") throw new Error("Workflow transition is not a condition.");
  if (transitionRun.status !== "evaluating") {
    throw new Error("Workflow condition is not evaluating.");
  }
  const source = requireStepByTemplateId(run, transition.fromStepId);
  if (source.status !== "completed") {
    throw new Error("Workflow condition source step must be completed before resolution.");
  }

  const target = transition.routes[decision];
  let next = updateTransition(run, transitionRunId, {
    status: "resolved",
    decision,
    ...(rationale !== undefined ? { rationale } : {}),
    ...(target !== undefined ? { selectedTarget: target } : {}),
    updatedAtMs: now,
  });

  const allTargets = [transition.routes.yes, transition.routes.no, transition.routes.unsure]
    .filter((item): item is WorkflowRouteTarget => item !== undefined)
    .flatMap((item) =>
      item.kind === "step"
        ? [item.stepId]
        : item.kind === "manualGate"
          ? [item.toStepId]
          : [],
    );
  const selectedStepId = target?.kind === "step"
    ? target.stepId
    : target?.kind === "manualGate"
      ? target.toStepId
      : undefined;
  for (const candidateStepId of allTargets) {
    if (candidateStepId !== selectedStepId) {
      next = updateStepByTemplateId(next, candidateStepId, {
        status: "skipped",
        updatedAtMs: now,
      });
    }
  }

  if (target?.kind === "step" || target?.kind === "manualGate") {
    const targetStepId = target.kind === "step" ? target.stepId : target.toStepId;
    const definition = requireStepDefinition(next, targetStepId);
    next = updateStepByTemplateId(next, targetStepId, {
      status: target.kind === "manualGate" || transition.previewBeforeStart || definition.startPolicy === "manualApproval"
        ? "needsApproval"
        : "ready",
      updatedAtMs: now,
    });
  }
  if (target?.kind === "manualGate") return withRunStatus(next, "needsAttention", now);
  if (target?.kind === "stop") return withRunStatus(next, "stopped", now);
  return withRunStatus(next, undefined, now);
}

export function failWorkflowCondition(
  run: WorkflowRun,
  transitionRunId: string,
  error: string,
  now = Date.now(),
): WorkflowRun {
  assertRunSchedulable(run);
  const transitionRun = run.transitionRuns.find((item) => item.id === transitionRunId);
  if (transitionRun === undefined) throw new Error(`Unknown workflow transition run: ${transitionRunId}`);
  if (transitionRun.status !== "evaluating") throw new Error("Workflow condition is not evaluating.");
  const next = updateTransition(run, transitionRunId, {
    status: "failed",
    error,
    rationale: "The condition judge returned an invalid result; no branch was selected. Retry the judge or explicitly override the decision.",
    updatedAtMs: now,
  });
  return withRunStatus(next, "needsAttention", now);
}

export function retryWorkflowCondition(
  run: WorkflowRun,
  transitionRunId: string,
  now = Date.now(),
): WorkflowRun {
  assertRunSchedulable(run);
  const transition = run.transitionRuns.find((item) => item.id === transitionRunId);
  if (transition === undefined) throw new Error(`Unknown workflow transition run: ${transitionRunId}`);
  if (transition.status !== "failed") throw new Error("Only failed workflow conditions can be retried.");
  const next = updateTransition(run, transitionRunId, {
    status: "evaluating",
    decision: undefined,
    rationale: undefined,
    error: undefined,
    updatedAtMs: now,
  });
  return withRunStatus(next, "running", now);
}

export function overrideWorkflowCondition(
  run: WorkflowRun,
  transitionRunId: string,
  decision: WorkflowDecision,
  rationale: string,
  now = Date.now(),
): WorkflowRun {
  assertRunSchedulable(run);
  const transition = run.transitionRuns.find((item) => item.id === transitionRunId);
  if (transition === undefined) throw new Error(`Unknown workflow transition run: ${transitionRunId}`);
  if (transition.status !== "failed") throw new Error("Only failed workflow conditions can be overridden.");
  const evaluating = updateTransition(run, transitionRunId, {
    status: "evaluating",
    decision: undefined,
    rationale: undefined,
    error: undefined,
    updatedAtMs: now,
  });
  return resolveWorkflowCondition(evaluating, transitionRunId, decision, rationale, now);
}

export function beginWorkflowConditionEvaluation(
  run: WorkflowRun,
  transitionRunId: string,
  now = Date.now(),
): WorkflowRun {
  assertRunSchedulable(run);
  const transition = run.transitionRuns.find((item) => item.id === transitionRunId);
  if (transition === undefined) throw new Error(`Unknown workflow transition run: ${transitionRunId}`);
  if (transition.status !== "waiting") throw new Error("Workflow condition is not waiting.");
  const definition = requireTransition(run, transition.templateTransitionId);
  if (definition.kind !== "condition") throw new Error("Workflow transition is not a condition.");
  const source = requireStepByTemplateId(run, definition.fromStepId);
  if (source.status !== "completed") {
    throw new Error("Workflow condition source step must be completed before evaluation.");
  }
  const next = updateTransition(run, transitionRunId, { status: "evaluating", updatedAtMs: now });
  return withRunStatus(next, undefined, now);
}

export function approveWorkflowStep(
  run: WorkflowRun,
  stepRunId: string,
  action: "approve" | "skip" | "stop",
  now = Date.now(),
): WorkflowRun {
  assertRunSchedulable(run);
  const step = requireStepRun(run, stepRunId);
  if (step.status !== "needsApproval") throw new Error("Workflow step is not awaiting approval.");
  if (action === "stop") return stopWorkflowRun(run, now);
  const next = updateStep(run, stepRunId, {
    status: action === "approve" ? "ready" : "skipped",
    updatedAtMs: now,
  });
  // A skipped approval is still a deliberate terminal choice. Resolve its
  // outgoing always edges so a gate cannot leave the graph permanently
  // waiting on a step that will never produce an answer.
  return action === "skip"
    ? routeSkippedStep(next, step.templateStepId, now)
    : withRunStatus(next, undefined, now);
}

export function stopWorkflowRun(run: WorkflowRun, now = Date.now()): WorkflowRun {
  const stepRuns = run.stepRuns.map((step) =>
    ["completed", "failed", "skipped"].includes(step.status)
      ? step
      : {
          ...step,
          status: "skipped" as const,
          runtimeId: undefined,
          updatedAtMs: now,
        },
  );
  const transitionRuns = run.transitionRuns.map((transition) =>
    transition.status === "evaluating"
      ? {
          ...transition,
          status: "skipped" as const,
          decision: undefined,
          rationale: undefined,
          selectedTarget: undefined,
          error: undefined,
          updatedAtMs: now,
        }
      : transition,
  );
  return withRunStatus({ ...run, stepRuns, transitionRuns }, "stopped", now);
}

export function retryWorkflowStep(run: WorkflowRun, stepRunId: string, now = Date.now()): WorkflowRun {
  assertRunSchedulable(run);
  const step = requireStepRun(run, stepRunId);
  if (step.status !== "failed" && step.status !== "blocked") {
    throw new Error("Only failed or blocked workflow steps can be retried.");
  }
  const next = updateStep(run, stepRunId, {
    status: "ready",
    error: undefined,
    updatedAtMs: now,
  });
  return withRunStatus(next, "waiting", now);
}

export function readyWorkflowSteps(run: WorkflowRun): WorkflowStepRun[] {
  if (run.status === "stopped") return [];
  return run.stepRuns.filter((step) => step.status === "ready").map((step) => ({ ...step }));
}

/** Convert in-flight state from a previous main-process lifetime into state
 * that can safely be resumed. RPC workers cannot be reattached after a crash. */
export function recoverWorkflowRun(run: WorkflowRun, now = Date.now()): WorkflowRun {
  if (["completed", "failed", "stopped"].includes(run.status)) return run;
  const stepRuns = run.stepRuns.map((step) =>
    step.status === "running" || step.status === "starting"
      ? {
          ...step,
          status: "failed" as const,
          error: "The previous Pi worker was lost when the app restarted; retry this step.",
          runtimeId: undefined,
          updatedAtMs: now,
        }
      : step.status === "queued"
        ? { ...step, status: "ready" as const, runtimeId: undefined, updatedAtMs: now }
        : step,
  );
  const transitionRuns = run.transitionRuns.map((transition) =>
    transition.status === "evaluating"
      ? {
          ...transition,
          status: "failed" as const,
          decision: "unsure" as const,
          error: "The previous condition judge was lost when the app restarted; review and retry the workflow.",
          updatedAtMs: now,
        }
      : transition,
  );
  return workflowRunSchema.parse({
    ...run,
    stepRuns,
    transitionRuns,
    status:
      stepRuns.some((step) => step.status === "failed") ||
      transitionRuns.some((transition) => transition.status === "failed")
        ? "needsAttention"
        : "waiting",
    updatedAtMs: now,
  });
}

function routeCompletedStep(run: WorkflowRun, templateStepId: string, now: number): WorkflowRun {
  if (run.status === "stopped") return withRunStatus(run, "stopped", now);
  return routeTerminalStep(run, templateStepId, now, true);
}

function routeSkippedStep(run: WorkflowRun, templateStepId: string, now: number): WorkflowRun {
  if (run.status === "stopped") return withRunStatus(run, "stopped", now);
  return routeTerminalStep(run, templateStepId, now, false);
}

function routeTerminalStep(
  run: WorkflowRun,
  templateStepId: string,
  now: number,
  completed: boolean,
): WorkflowRun {
  let next = run;
  const outgoing = run.templateSnapshot.transitions.filter(
    (transition) => transition.fromStepId === templateStepId,
  );
  for (const transition of outgoing) {
    const transitionRun = next.transitionRuns.find(
      (item) => item.templateTransitionId === transition.id,
    );
    if (transitionRun === undefined) continue;
    if (transition.kind === "condition") {
      if (completed) {
        next = updateTransition(next, transitionRun.id, { status: "evaluating", updatedAtMs: now });
      } else {
        next = updateTransition(next, transitionRun.id, { status: "skipped", updatedAtMs: now });
        for (const target of Object.values(transition.routes)) {
          const targetStepId =
            target?.kind === "step"
              ? target.stepId
              : target?.kind === "manualGate"
                ? target.toStepId
                : undefined;
          if (targetStepId !== undefined) {
            next = updateStepByTemplateId(next, targetStepId, {
              status: "skipped",
              updatedAtMs: now,
            });
          }
        }
      }
      continue;
    }
    if (transition.kind === "manualGate") {
      next = updateStepByTemplateId(next, transition.toStepId, {
        status: "needsApproval",
        updatedAtMs: now,
      });
      next = updateTransition(next, transitionRun.id, {
        status: "resolved",
        selectedTarget: { kind: "step", stepId: transition.toStepId },
        updatedAtMs: now,
      });
      continue;
    }
    next = updateStepByTemplateId(next, transition.toStepId, {
      status: stepStartStatus(next, transition.toStepId),
      updatedAtMs: now,
    });
    next = updateTransition(next, transitionRun.id, {
      status: "resolved",
      selectedTarget: { kind: "step", stepId: transition.toStepId },
      updatedAtMs: now,
    });
  }
  return withRunStatus(next, undefined, now);
}

function stepStartStatus(run: WorkflowRun, stepId: string): "ready" | "needsApproval" {
  return requireStepDefinition(run, stepId).startPolicy === "manualApproval"
    ? "needsApproval"
    : "ready";
}

function transitionTargets(transition: WorkflowTransition): string[] {
  if (transition.kind === "always" || transition.kind === "manualGate") return [transition.toStepId];
  return Object.values(transition.routes).flatMap((target) =>
    target?.kind === "step"
      ? [target.stepId]
      : target?.kind === "manualGate"
        ? [target.toStepId]
        : [],
  );
}

function assertRunSchedulable(run: WorkflowRun): void {
  if (run.status === "stopped") throw new Error("Stopped workflow runs cannot be scheduled.");
}

function requireStepRun(run: WorkflowRun, stepRunId: string): WorkflowStepRun {
  const step = run.stepRuns.find((item) => item.id === stepRunId);
  if (step === undefined) throw new Error(`Unknown workflow step run: ${stepRunId}`);
  return step;
}

function requireStepByTemplateId(run: WorkflowRun, templateStepId: string): WorkflowStepRun {
  const step = run.stepRuns.find((item) => item.templateStepId === templateStepId);
  if (step === undefined) throw new Error(`Unknown workflow step: ${templateStepId}`);
  return step;
}

function requireStepDefinition(run: WorkflowRun, stepId: string): WorkflowStepDefinition {
  const step = run.templateSnapshot.steps.find((item) => item.id === stepId);
  if (step === undefined) throw new Error(`Unknown workflow step: ${stepId}`);
  return step;
}

function requireTransition(run: WorkflowRun, transitionId: string): WorkflowTransition {
  const transition = run.templateSnapshot.transitions.find((item) => item.id === transitionId);
  if (transition === undefined) throw new Error(`Unknown workflow transition: ${transitionId}`);
  return transition;
}

function updateStep(
  run: WorkflowRun,
  stepRunId: string,
  patch: Partial<WorkflowStepRun>,
): WorkflowRun {
  return {
    ...run,
    stepRuns: run.stepRuns.map((step) =>
      step.id === stepRunId ? { ...step, ...patch } : step,
    ),
  };
}

function updateStepByTemplateId(
  run: WorkflowRun,
  templateStepId: string,
  patch: Partial<WorkflowStepRun>,
): WorkflowRun {
  return {
    ...run,
    stepRuns: run.stepRuns.map((step) =>
      step.templateStepId === templateStepId ? { ...step, ...patch } : step,
    ),
  };
}

function updateTransition(
  run: WorkflowRun,
  transitionRunId: string,
  patch: Partial<WorkflowRun["transitionRuns"][number]>,
): WorkflowRun {
  return {
    ...run,
    transitionRuns: run.transitionRuns.map((transition) =>
      transition.id === transitionRunId ? { ...transition, ...patch } : transition,
    ),
  };
}

function withRunStatus(
  run: WorkflowRun,
  explicitStatus: WorkflowRunStatus | undefined,
  now: number,
): WorkflowRun {
  if (explicitStatus !== undefined) {
    return workflowRunSchema.parse({ ...run, status: explicitStatus, updatedAtMs: now });
  }
  if (run.stepRuns.some((step) => step.status === "needsApproval")) {
    return workflowRunSchema.parse({ ...run, status: "needsAttention", updatedAtMs: now });
  }
  if (run.stepRuns.some((step) => step.status === "failed" || step.status === "blocked")) {
    return workflowRunSchema.parse({ ...run, status: "needsAttention", updatedAtMs: now });
  }
  const active =
    run.stepRuns.some((step) => ["starting", "running", "queued"].includes(step.status)) ||
    run.transitionRuns.some((transition) => transition.status === "evaluating");
  const allTerminal = run.stepRuns.every((step) => step.status === "completed" || step.status === "skipped");
  if (allTerminal && !active) {
    return workflowRunSchema.parse({
      ...run,
      status: "completed",
      completedAtMs: run.completedAtMs ?? now,
      updatedAtMs: now,
    });
  }
  return workflowRunSchema.parse({
    ...run,
    status: active ? "running" : "waiting",
    updatedAtMs: now,
  });
}
