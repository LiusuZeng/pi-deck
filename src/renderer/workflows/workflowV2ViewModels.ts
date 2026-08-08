import type {
  WorkflowDefinition,
  WorkflowNode,
} from "../../shared/workflowV2Schemas.js";

export type WorkflowV2Role = WorkflowNode["role"];

export const workflowV2RoleLabel: Record<WorkflowV2Role, string> = {
  worker: "Worker",
  decider: "Decider",
  orchestrator: "Orchestrator",
  human: "Human",
};

export interface WorkflowV2CardViewModel {
  id: string;
  name: string;
  description: string | undefined;
  nodeCount: number;
  relationshipCount: number;
  roleCounts: Record<WorkflowV2Role, number>;
  roleSummary: string;
}

export function workflowV2RoleSummary(node: WorkflowNode): string {
  switch (node.role) {
    case "worker":
      return node.config.expectedOutput
        ? `Produces: ${node.config.expectedOutput}`
        : "Performs a configured task.";
    case "decider":
      return `Decides: ${node.config.question}`;
    case "orchestrator":
      if (node.config.mode === "loop") {
        return `Loop: ${node.config.agents.length} managed worker${plural(node.config.agents.length)}, up to ${node.config.maxIterations} iteration${plural(node.config.maxIterations)}.`;
      }
      return `Fan-out: ${node.config.agents.length} managed worker${plural(node.config.agents.length)}, ${node.config.maxConcurrency} concurrent, completes when ${node.config.completion}.`;
    case "human":
      return `Human ${node.config.interaction}: ${node.config.prompt}`;
  }
}

export function workflowV2CardViewModel(
  definition: WorkflowDefinition,
): WorkflowV2CardViewModel {
  const roleCounts: Record<WorkflowV2Role, number> = {
    worker: 0,
    decider: 0,
    orchestrator: 0,
    human: 0,
  };
  for (const node of definition.nodes) roleCounts[node.role] += 1;

  const summaries = definition.nodes.map(workflowV2RoleSummary);
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    nodeCount: definition.nodes.length,
    relationshipCount: definition.relationships.length,
    roleCounts,
    roleSummary: summaries.join(" "),
  };
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
