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

const nodeFor = (
  role: Exclude<WorkflowRole, "orchestrator">,
  id: string,
): WorkflowV2Node => {
  if (role === "worker")
    return {
      id,
      name: "New worker",
      role,
      config: { instructions: "Describe the work to perform." },
    };
  if (role === "decider")
    return {
      id,
      name: "New decision",
      role,
      config: { question: "Is this ready?" },
    };
  return {
    id,
    name: "Checkpoint",
    role,
    config: { interaction: "approval", prompt: "Approve this result?" },
  };
};
/** Adds roles with valid reciprocal ownership. An Orchestrator starts as a fixed-list Fan-out. */
export function addRole(
  definition: WorkflowV2Definition,
  role: WorkflowRole,
): { definition: WorkflowV2Definition; selectedId: string } {
  const number = definition.nodes.length + 1;
  if (role !== "orchestrator") {
    const node = nodeFor(role, `${role}-${number}`);
    return {
      definition: { ...definition, nodes: [...definition.nodes, node] },
      selectedId: node.id,
    };
  }
  const id = `orchestrator-${number}`;
  const workerId = `worker-${number + 1}`;
  const worker = {
    ...nodeFor("worker", workerId),
    name: "Managed worker",
    managedBy: id,
  } as WorkflowV2Node;
  const orchestrator: WorkflowV2Node = {
    id,
    name: "New orchestration",
    role: "orchestrator",
    config: {
      mode: "fanout",
      agents: [workerId],
      maxConcurrency: 1,
      completion: "all",
    },
  };
  return {
    definition: {
      ...definition,
      nodes: [...definition.nodes, orchestrator, worker],
    },
    selectedId: id,
  };
}
/** Sets an owner's worker batch while maintaining both sides of ownership. */
export function setManagedWorkers(
  definition: WorkflowV2Definition,
  ownerId: string,
  agentIds: string[],
): WorkflowV2Definition {
  const selected = new Set(agentIds);
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.id === ownerId && node.role === "orchestrator")
        return {
          ...node,
          config: { ...node.config, agents: agentIds },
        } as WorkflowV2Node;
      if (
        node.role === "worker" &&
        (node.managedBy === ownerId || selected.has(node.id))
      )
        return {
          ...node,
          ...(selected.has(node.id)
            ? { managedBy: ownerId }
            : { managedBy: undefined }),
        } as WorkflowV2Node;
      return node;
    }),
    relationships: definition.relationships.filter(
      (edge) =>
        !selected.has(edge.from) &&
        !selected.has("nodeId" in edge.to ? edge.to.nodeId : ""),
    ),
  };
}
/** Sets/clears a loop decider and preserves reciprocal ownership. */
export function setLoopDecider(
  definition: WorkflowV2Definition,
  ownerId: string,
  deciderId?: string,
): WorkflowV2Definition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (
        node.id === ownerId &&
        node.role === "orchestrator" &&
        node.config.mode === "loop"
      )
        return {
          ...node,
          config: { ...node.config, decider: deciderId ?? node.config.decider },
        } as WorkflowV2Node;
      if (
        node.role === "decider" &&
        (node.managedBy === ownerId || node.id === deciderId)
      )
        return {
          ...node,
          ...(node.id === deciderId
            ? { managedBy: ownerId }
            : { managedBy: undefined }),
        } as WorkflowV2Node;
      return node;
    }),
  };
}
