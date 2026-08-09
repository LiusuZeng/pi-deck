import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowNode,
} from "../../shared/agentWorkflowSchemas.js";

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
export const agentWorkflowDefinitionSchema = workflowDefinitionSchema;
export type AgentWorkflowDefinition = WorkflowDefinition;
export type AgentWorkflowNode = WorkflowNode;

/** Produces an unused, stable-looking ID even after imports or deletions. */
export function uniqueNodeId(
  definition: AgentWorkflowDefinition,
  prefix: string,
): string {
  const ids = new Set(definition.nodes.map((node) => node.id));
  let number = 1;
  while (ids.has(`${prefix}-${number}`)) number += 1;
  return `${prefix}-${number}`;
}
export function defaultAgentWorkflowDefinition(): AgentWorkflowDefinition {
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
export function definitionJson(definition: AgentWorkflowDefinition): string {
  return JSON.stringify(definition, null, 2);
}
export function validateJsonDraft(value: string): {
  definition?: AgentWorkflowDefinition;
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
export function graphEdges(definition: AgentWorkflowDefinition) {
  return definition.relationships.map((edge) => ({
    from: edge.from,
    to: "nodeId" in edge.to ? edge.to.nodeId : undefined,
    end: "end" in edge.to ? edge.to.end : undefined,
    label: edge.when ? String(edge.when.equals) : "then",
  }));
}
const nodeFor = (
  role: Exclude<WorkflowRole, "orchestrator">,
  id: string,
): AgentWorkflowNode => {
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
  definition: AgentWorkflowDefinition,
  role: WorkflowRole,
): { definition: AgentWorkflowDefinition; selectedId: string } {
  if (role !== "orchestrator") {
    const node = nodeFor(role, uniqueNodeId(definition, role));
    return {
      definition: { ...definition, nodes: [...definition.nodes, node] },
      selectedId: node.id,
    };
  }
  const id = uniqueNodeId(definition, "orchestrator");
  const workerId = uniqueNodeId(
    {
      ...definition,
      nodes: [...definition.nodes, { id } as AgentWorkflowNode],
    },
    "worker",
  );
  const worker = {
    ...nodeFor("worker", workerId),
    name: "Managed worker",
    managedBy: id,
  } as AgentWorkflowNode;
  const orchestrator: AgentWorkflowNode = {
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
const withoutNodes = (
  definition: AgentWorkflowDefinition,
  ids: Set<string>,
): AgentWorkflowDefinition => ({
  ...definition,
  nodes: definition.nodes.filter((node) => !ids.has(node.id)),
  relationships: definition.relationships.filter(
    (edge) =>
      !ids.has(edge.from) && !("nodeId" in edge.to && ids.has(edge.to.nodeId)),
  ),
});
/**
 * Ownership policy: assigning removes a worker's top-level routes; unassigning
 * deletes that managed worker and its routes rather than creating an unreachable
 * top-level node. The UI keeps at least one worker assigned.
 */
export function setManagedWorkers(
  definition: AgentWorkflowDefinition,
  ownerId: string,
  agentIds: string[],
): AgentWorkflowDefinition {
  const selected = new Set(agentIds);
  const released = new Set(
    definition.nodes
      .filter(
        (node) =>
          node.role === "worker" &&
          node.managedBy === ownerId &&
          !selected.has(node.id),
      )
      .map((node) => node.id),
  );
  const base = withoutNodes(definition, released);
  return {
    ...base,
    nodes: base.nodes.map((node) => {
      if (node.id === ownerId && node.role === "orchestrator")
        return {
          ...node,
          config: { ...node.config, agents: agentIds },
        } as AgentWorkflowNode;
      if (node.role === "worker" && selected.has(node.id))
        return { ...node, managedBy: ownerId } as AgentWorkflowNode;
      return node;
    }),
    relationships: base.relationships.filter(
      (edge) =>
        !selected.has(edge.from) &&
        !("nodeId" in edge.to && selected.has(edge.to.nodeId)),
    ),
  };
}
/** Assigning a loop decider deletes its old owner decider and incompatible routes. */
export function setLoopDecider(
  definition: AgentWorkflowDefinition,
  ownerId: string,
  deciderId: string,
): AgentWorkflowDefinition {
  const loopOwner = definition.nodes.find(
    (node) => node.role === "orchestrator" && node.id === ownerId,
  ) as Extract<AgentWorkflowNode, { role: "orchestrator" }> | undefined;
  const old =
    loopOwner?.config.mode === "loop" ? loopOwner.config.decider : undefined;
  const base =
    old && old !== deciderId
      ? withoutNodes(definition, new Set([old]))
      : definition;
  return {
    ...base,
    nodes: base.nodes.map((node) => {
      if (
        node.id === ownerId &&
        node.role === "orchestrator" &&
        node.config.mode === "loop"
      )
        return {
          ...node,
          config: { ...node.config, decider: deciderId },
        } as AgentWorkflowNode;
      if (node.id === deciderId && node.role === "decider")
        return { ...node, managedBy: ownerId } as AgentWorkflowNode;
      return node;
    }),
    relationships: base.relationships.filter(
      (edge) =>
        edge.from !== deciderId &&
        !("nodeId" in edge.to && edge.to.nodeId === deciderId),
    ),
  };
}
/** Switches modes while retaining optional input and deleting the loop-only decider. */
export function setOrchestratorMode(
  definition: AgentWorkflowDefinition,
  ownerId: string,
  mode: "loop" | "fanout",
): AgentWorkflowDefinition {
  const owner = definition.nodes.find(
    (node) => node.id === ownerId && node.role === "orchestrator",
  ) as Extract<AgentWorkflowNode, { role: "orchestrator" }> | undefined;
  if (!owner || owner.config.mode === mode) return definition;
  if (mode === "fanout") {
    const base = withoutNodes(
      definition,
      new Set([
        (owner.config as Extract<typeof owner.config, { mode: "loop" }>)
          .decider,
      ]),
    );
    return {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === ownerId && node.role === "orchestrator"
          ? ({
              ...node,
              config: {
                mode,
                agents: node.config.agents,
                ...(owner.config.input ? { input: owner.config.input } : {}),
                maxConcurrency: 1,
                completion: "all",
              },
            } as AgentWorkflowNode)
          : node,
      ),
    };
  }
  const deciderId = uniqueNodeId(definition, "decider");
  const decider = {
    ...nodeFor("decider", deciderId),
    name: "Loop completion",
    managedBy: ownerId,
  } as AgentWorkflowNode;
  return {
    ...definition,
    nodes: [
      ...definition.nodes.map((node) =>
        node.id === ownerId && node.role === "orchestrator"
          ? ({
              ...node,
              config: {
                mode,
                agents: node.config.agents,
                ...(node.config.input ? { input: node.config.input } : {}),
                decider: deciderId,
                maxIterations: 1,
              },
            } as AgentWorkflowNode)
          : node,
      ),
      decider,
    ],
  };
}
