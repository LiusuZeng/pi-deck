import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowNode,
} from "../../shared/workflowV2Schemas.js";

export const workflowRoles = [
  "worker",
  "decider",
  "orchestrator",
  "human",
] as const;
export type WorkflowRole = (typeof workflowRoles)[number];
export const workflowRoleTemplates: ReadonlyArray<{
  id: WorkflowRole;
  label: string;
}> = [
  { id: "worker", label: "Worker" },
  { id: "decider", label: "Decider" },
  { id: "orchestrator", label: "Orchestrator" },
  { id: "human", label: "Human" },
];

/** Renderer aliases intentionally use the shared canonical v2 contract. */
export const workflowV2DefinitionSchema = workflowDefinitionSchema;
export type WorkflowV2Definition = WorkflowDefinition;
export type WorkflowV2Node = WorkflowNode;

export function defaultV2Definition(): WorkflowV2Definition {
  return {
    format: "pi-deck.agent-workflow",
    schemaVersion: 2,
    id: `workflow-${crypto.randomUUID()}`,
    revision: 1,
    name: "New agent workflow",
    inputs: [],
    entryNodeId: "worker-1",
    nodes: [
      {
        id: "worker-1",
        name: "Do the work",
        role: "worker",
        config: { instructions: "Describe the work to perform." },
      },
    ],
    relationships: [],
  };
}
export function roleTemplate(role: WorkflowRole) {
  return workflowRoleTemplates.find((item) => item.id === role)!;
}
export function definitionJson(definition: WorkflowV2Definition): string {
  return JSON.stringify(definition, null, 2);
}
export function validateJsonDraft(value: string): {
  definition?: WorkflowV2Definition;
  error?: string;
} {
  try {
    const result = workflowDefinitionSchema.safeParse(JSON.parse(value));
    if (result.success) return { definition: result.data };
    const issue = result.error.issues[0];
    return {
      error: `${issue?.path.length ? `/${issue.path.join("/")}: ` : ""}${issue?.message ?? "Invalid workflow definition."}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    const at = /position (\d+)/.exec(message);
    return {
      error: `Invalid JSON${at ? ` near character ${at[1]}` : ""}: ${message}`,
    };
  }
}
export function graphEdges(definition: WorkflowV2Definition) {
  return definition.relationships.map((edge) => ({
    from: edge.from,
    to: "nodeId" in edge.to ? edge.to.nodeId : undefined,
    label: edge.when ? String(edge.when.equals) : "then",
  }));
}
