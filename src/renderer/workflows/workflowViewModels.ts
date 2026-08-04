import type {
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepStatus,
  WorkflowTemplate,
} from "../../shared/workflowSchemas.js";

export function workflowRunStatusLabel(status: WorkflowRunStatus): string {
  switch (status) {
    case "needsAttention":
      return "Needs attention";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "waiting":
      return "Waiting";
  }
}

export function workflowStepStatusLabel(status: WorkflowStepStatus): string {
  switch (status) {
    case "needsApproval":
      return "Needs approval";
    case "starting":
      return "Starting";
    case "running":
      return "In progress";
    case "queued":
      return "Queued";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "blocked":
      return "Blocked";
    case "ready":
      return "Ready";
    case "waiting":
      return "Waiting";
  }
}

export function workflowRunStatusTone(
  status: WorkflowRunStatus,
): "neutral" | "active" | "success" | "danger" | "warning" {
  if (status === "running" || status === "waiting") return "active";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "needsAttention") return "warning";
  return "neutral";
}

export function workflowStepStatusTone(
  status: WorkflowStepStatus,
): "neutral" | "active" | "success" | "danger" | "warning" {
  if (status === "running" || status === "starting" || status === "queued")
    return "active";
  if (status === "completed") return "success";
  if (status === "failed" || status === "blocked") return "danger";
  if (status === "needsApproval") return "warning";
  return "neutral";
}

export function templateValidationErrors(template: WorkflowTemplate): string[] {
  const errors: string[] = [];
  if (template.steps.length === 0) errors.push("Add at least one agent step.");
  for (const step of template.steps) {
    if (
      step.promptParts.every(
        (part) => part.type === "text" && part.text.trim().length === 0,
      )
    ) {
      errors.push(`${step.name} needs a prompt.`);
    }
  }
  return errors;
}

export function runProgress(run: WorkflowRun): {
  completed: number;
  total: number;
} {
  return {
    completed: run.stepRuns.filter(
      (step) => step.status === "completed" || step.status === "skipped",
    ).length,
    total: run.stepRuns.length,
  };
}
