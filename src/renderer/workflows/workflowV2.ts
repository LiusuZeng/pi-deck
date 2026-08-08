import type {
  WorkflowStepDefinition,
  WorkflowTemplate,
  WorkflowTemplateDefinition,
  WorkflowTransition,
} from "../../shared/workflowSchemas.js";
import { workflowTemplateDefinitionSchema } from "../../shared/workflowSchemas.js";

/** UI-only role metadata. The v1 transport deliberately remains unchanged. */
export const workflowRoleTemplates = [
  { id: "researcher", label: "Researcher", prompt: "Investigate the problem, collect evidence, and report findings. Do not change code." },
  { id: "planner", label: "Planner", prompt: "Create a small, actionable plan. State assumptions and risks." },
  { id: "implementer", label: "Implementer", prompt: "Implement the smallest safe change and explain what changed." },
  { id: "reviewer", label: "Reviewer", prompt: "Review the result for correctness, regressions, and missing tests." },
] as const;
export type WorkflowRole = (typeof workflowRoleTemplates)[number]["id"];

export interface WorkflowV2Card {
  step: WorkflowStepDefinition;
  role: WorkflowRole;
}

const roles = new Set<WorkflowRole>(workflowRoleTemplates.map(({ id }) => id));
export function roleForStep(step: WorkflowStepDefinition): WorkflowRole {
  const candidate = step.name.toLowerCase().replace(/\s+/g, "") as WorkflowRole;
  return roles.has(candidate) ? candidate : "implementer";
}

export function roleTemplate(role: WorkflowRole) {
  return workflowRoleTemplates.find((item) => item.id === role)!;
}

/** Converts the v1 persisted shape into the v2 renderer projection. */
export function v2Cards(template: WorkflowTemplateDefinition | WorkflowTemplate): WorkflowV2Card[] {
  return template.steps.map((step) => ({ step, role: roleForStep(step) }));
}

export function graphEdges(template: WorkflowTemplateDefinition | WorkflowTemplate): Array<{ from: string; to: string; label: string }> {
  const edges: Array<{ from: string; to: string; label: string }> = [];
  for (const transition of template.transitions) {
    if (transition.kind === "always" || transition.kind === "manualGate") {
      edges.push({ from: transition.fromStepId, to: transition.toStepId, label: transition.kind === "always" ? "then" : "approval" });
    } else {
      for (const [outcome, target] of Object.entries(transition.routes)) {
        if (target?.kind === "step") edges.push({ from: transition.fromStepId, to: target.stepId, label: outcome });
        if (target?.kind === "manualGate") edges.push({ from: transition.fromStepId, to: target.toStepId, label: `${outcome} · approval` });
      }
    }
  }
  return edges;
}

export function validateJsonDraft(value: string): { definition?: WorkflowTemplateDefinition; error?: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) {
    return { error: error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON." };
  }
  const result = workflowTemplateDefinitionSchema.safeParse(parsed);
  if (!result.success) return { error: result.error.issues[0]?.message ?? "Invalid workflow definition." };
  return { definition: result.data };
}

export function definitionJson(definition: WorkflowTemplateDefinition): string {
  return JSON.stringify(definition, null, 2);
}

export function defaultV2Definition(): WorkflowTemplateDefinition {
  return {
    name: "New agent workflow", inputs: [], context: { prompt: "", relevantPaths: [] },
    steps: [{ id: "step-1", name: "Implementer", kind: "agent", promptParts: [{ type: "text", text: roleTemplate("implementer").prompt }], inputPolicy: { includeWorkflowContext: true, includeParentFinalAnswer: false, includeParentSummary: false, includeParentTranscript: false }, startPolicy: "auto" }],
    transitions: [],
  };
}

export function withRole(step: WorkflowStepDefinition, role: WorkflowRole): WorkflowStepDefinition {
  return { ...step, name: roleTemplate(role).label, promptParts: [{ type: "text", text: roleTemplate(role).prompt }] };
}

export type { WorkflowTransition };
