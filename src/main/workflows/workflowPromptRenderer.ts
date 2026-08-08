import type {
  WorkflowContext,
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowStepRun,
} from "../../shared/workflowSchemas.js";
import type {
  WorkflowOccurrence,
  WorkflowRoleRun,
} from "./workflowV2Runtime.js";

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
  if (
    step.inputPolicy.includeWorkflowContext &&
    workflowContext !== undefined
  ) {
    const context = renderWorkflowContext(workflowContext, run.inputs);
    if (context.length > 0) sections.push(`Workflow context:\n${context}`);
  }
  if (step.inputPolicy.includeParentFinalAnswer) {
    sections.push(
      `Parent final answer:\n${requireAvailable(run.parentFinalAnswer, "Parent final answer")}`,
    );
  }
  if (step.inputPolicy.includeParentSummary) {
    sections.push(
      `Parent summary:\n${requireAvailable(run.parentSummary, "Parent summary")}`,
    );
  }
  if (step.inputPolicy.includeParentTranscript) {
    sections.push(
      `Parent transcript:\n${requireAvailable(run.parentTranscript, "Parent transcript")}`,
    );
  }

  const prompt = step.promptParts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "workflowInput") {
        return requireAvailable(
          run.inputs[part.inputId],
          `Workflow input ${part.inputId}`,
        );
      }
      const source = run.stepRuns.find(
        (item) => item.templateStepId === part.stepId,
      );
      return renderStepOutput(source, part.output);
    })
    .join("");
  sections.push(prompt);
  return sections
    .filter((section) => section.trim().length > 0)
    .join("\n\n")
    .trim();
}

/** Render a role-node prompt against its particular occurrence lineage.
 * `{{parent.finalAnswer}}` is intentionally singular: fan-out/loop work has
 * no globally unambiguous "step output". `{{parents.finalAnswer}}` provides
 * a stable, creation-order joined handoff when a node has multiple parents. */
export function renderWorkflowOccurrencePrompt(
  run: WorkflowRoleRun,
  occurrence: WorkflowOccurrence,
): string {
  const node = run.definition.nodes.find((item) => item.id === occurrence.nodeId);
  if (node === undefined) throw new Error(`Unknown role node: ${occurrence.nodeId}`);
  const source = node.role === "worker"
    ? node.prompt
    : node.role === "decider"
      ? [
          node.prompt ?? "You are a workflow decision maker.",
          `Question: ${node.question}`,
          'Return exactly one JSON object: {"decision":"yes"|"no"|"unsure","rationale":"brief explanation"}.',
          "Do not include markdown or other text.",
        ].join("\n")
      : (node.prompt ?? "");
  const parents = occurrence.parentOccurrenceIds.map((id) => {
    const parent = run.occurrences.find((item) => item.id === id);
    if (parent === undefined) throw new Error("Workflow prompt is blocked: parent occurrence is unavailable.");
    return parent;
  });
  const parentOutput = (parent: WorkflowOccurrence): string =>
    requireAvailable(parent.finalAnswer ?? parent.summary ?? parent.transcript, `Parent output for ${parent.nodeId}`);
  return source.replace(/{{\s*(input\.[\w.-]+|parent\.finalAnswer|parents\.finalAnswer)\s*}}/g, (_token, reference: string) => {
    if (reference.startsWith("input.")) return requireAvailable(run.inputs[reference.slice(6)], `Workflow input ${reference.slice(6)}`);
    if (reference === "parent.finalAnswer") {
      if (parents.length !== 1) throw new Error("Workflow prompt is blocked: parent.finalAnswer requires exactly one parent occurrence.");
      return parentOutput(parents[0]!);
    }
    return requireAvailable(parents.map(parentOutput).join("\n\n"), "Parent outputs");
  }).trim();
}

export function renderStepOutput(
  step: WorkflowStepRun | undefined,
  output: "finalAnswer" | "summary" | "transcript",
): string {
  if (step === undefined)
    throw new Error(
      "Workflow prompt is blocked: referenced upstream step is unavailable.",
    );
  if (output === "finalAnswer") {
    return requireAvailable(
      step.finalAnswer,
      `Upstream final answer for ${step.templateStepId}`,
    );
  }
  if (output === "summary") {
    return requireAvailable(
      step.summary ?? step.finalAnswer,
      `Upstream summary for ${step.templateStepId}`,
    );
  }
  return requireAvailable(
    step.transcript,
    `Upstream transcript for ${step.templateStepId}`,
  );
}

function requireAvailable(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Workflow prompt is blocked: ${label} is unavailable.`);
  }
  return value;
}

function renderWorkflowContext(
  context: WorkflowContext,
  inputs: Record<string, string>,
): string {
  const lines: string[] = [];
  if (context.prompt !== undefined) {
    addLine(lines, "Prompt", context.prompt);
    addLine(lines, "Don't do", context.doNotDo);
  } else {
    // Older persisted templates use the structured context fields. Keep their
    // rendering intact when no prompt-first context is present.
    addLine(lines, "Objective", context.objective);
    addLine(lines, "Constraints", context.constraints);
    addLine(lines, "Relevant paths", context.relevantPaths?.join("\n"));
    addLine(lines, "Standards", context.standards);
    addLine(lines, "Do not do", context.doNotDo);
  }
  const runInputs = Object.entries(inputs)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  addLine(lines, "Run inputs", runInputs);
  return lines.join("\n");
}

function addLine(
  lines: string[],
  label: string,
  value: string | undefined,
): void {
  if (value === undefined || value.trim().length === 0) return;
  lines.push(`${label}:\n${value}`);
}
