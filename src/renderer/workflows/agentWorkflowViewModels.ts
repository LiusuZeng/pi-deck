import type {
  WorkflowDefinition,
  WorkflowNode,
} from "../../shared/agentWorkflowSchemas.js";

export type AgentWorkflowRole = WorkflowNode["role"];

export const agentWorkflowRoleLabel: Record<AgentWorkflowRole, string> = {
  worker: "Worker",
  decider: "Decider",
  orchestrator: "Orchestrator",
  human: "Human",
};

export interface AgentWorkflowCardViewModel {
  id: string;
  name: string;
  description: string | undefined;
  nodeCount: number;
  relationshipCount: number;
  roleCounts: Record<AgentWorkflowRole, number>;
  roleSummary: string;
}

export function agentWorkflowRoleSummary(node: WorkflowNode): string {
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

export function agentWorkflowCardViewModel(
  definition: WorkflowDefinition,
): AgentWorkflowCardViewModel {
  const roleCounts: Record<AgentWorkflowRole, number> = {
    worker: 0,
    decider: 0,
    orchestrator: 0,
    human: 0,
  };
  for (const node of definition.nodes) roleCounts[node.role] += 1;

  const summaries = definition.nodes.map(agentWorkflowRoleSummary);
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
