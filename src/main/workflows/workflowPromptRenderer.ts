import type {
  WorkflowContext,
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowStepRun,
} from "../../shared/workflowSchemas.js";

export interface RenderWorkflowPromptOptions {
  workflowContext?: WorkflowContext;
  step: WorkflowStepDefinition;
  run: WorkflowRun;
}

export function renderWorkflowPrompt({
  workflowContext,
  step,
  run,
}: RenderWorkflowPromptOptions): string {
  const sections: string[] = [];
  if (step.inputPolicy.includeWorkflowContext && workflowContext !== undefined) {
    const context = renderWorkflowContext(workflowContext, run.inputs);
    if (context.length > 0) sections.push(`Workflow context:\n${context}`);
  }
  if (step.inputPolicy.includeParentFinalAnswer) {
    sections.push(`Parent final answer:\n${run.parentFinalAnswer ?? "[Parent final answer unavailable]"}`);
  }
  if (step.inputPolicy.includeParentSummary) {
    sections.push(`Parent summary:\n${run.parentSummary ?? "[Parent summary unavailable]"}`);
  }
  if (step.inputPolicy.includeParentTranscript) {
    sections.push(`Parent transcript:\n${run.parentTranscript ?? "[Parent transcript unavailable]"}`);
  }

  const prompt = step.promptParts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "workflowInput") {
        return run.inputs[part.inputId] ?? `[Missing workflow input: ${part.inputId}]`;
      }
      const source = run.stepRuns.find((item) => item.templateStepId === part.stepId);
      return renderStepOutput(source, part.output);
    })
    .join("");
  sections.push(prompt);
  return sections.filter((section) => section.trim().length > 0).join("\n\n").trim();
}

export function renderStepOutput(
  step: WorkflowStepRun | undefined,
  output: "finalAnswer" | "summary" | "transcript",
): string {
  if (step === undefined) return "[Missing upstream step output]";
  if (output === "finalAnswer") {
    return step.finalAnswer ?? "[Upstream step has no final answer yet]";
  }
  if (output === "summary") {
    return step.summary ?? step.finalAnswer ?? "[Upstream step has no summary yet]";
  }
  return step.transcript ?? "[Upstream transcript is unavailable]";
}

function renderWorkflowContext(
  context: WorkflowContext,
  inputs: Record<string, string>,
): string {
  const lines: string[] = [];
  addLine(lines, "Objective", context.objective);
  addLine(lines, "Constraints", context.constraints);
  addLine(lines, "Relevant paths", context.relevantPaths.join("\n"));
  addLine(lines, "Standards", context.standards);
  addLine(lines, "Do not do", context.doNotDo);
  const runInputs = Object.entries(inputs)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  addLine(lines, "Run inputs", runInputs);
  return lines.join("\n");
}

function addLine(lines: string[], label: string, value: string | undefined): void {
  if (value === undefined || value.trim().length === 0) return;
  lines.push(`${label}:\n${value}`);
}
