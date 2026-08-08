import type {
  WorkflowDefinition,
  WorkflowNode,
} from "../../shared/workflowV2Schemas.js";

export interface WorkflowV2GraphRoute {
  /** Canonical relationship ID, retained for stable rendering identity. */
  id: string;
  from: string;
  to: string;
  label: string;
  terminal: boolean;
}

export interface WorkflowV2GraphNode {
  id: string;
  name: string;
  role: WorkflowNode["role"];
  detail: string;
  managedNodes: WorkflowV2GraphNode[];
}

export interface WorkflowV2GraphModel {
  topLevelNodes: WorkflowV2GraphNode[];
  routes: WorkflowV2GraphRoute[];
  terminalOutcomes: string[];
}

function routeLabel(node: WorkflowNode, value: boolean | string | undefined) {
  if (value === undefined) return "then";
  if (typeof value === "string") return value;
  if (node.role === "decider") {
    const display = value
      ? (node.config.trueLabel ?? "Yes")
      : (node.config.falseLabel ?? "No");
    return `${value ? "true" : "false"} (${display})`;
  }
  return value ? "true" : "false";
}

function nodeDetail(node: WorkflowNode): string {
  switch (node.role) {
    case "worker":
      return "Worker";
    case "decider":
      return `Decider: ${node.config.question}`;
    case "human":
      return `Human interaction: ${node.config.interaction}`;
    case "orchestrator":
      return node.config.mode === "loop"
        ? `Loop · maximum ${node.config.maxIterations} iterations · completion Decider ${node.config.decider}`
        : `Fan-out · ${node.config.agents.length} Workers · maximum concurrency ${node.config.maxConcurrency} · completes when ${node.config.completion}`;
  }
}

/**
 * Produces a stable, read-only graph projection. Source document order is used
 * as the tie-breaker after routing outward from the entry node.
 */
export function deriveWorkflowV2Graph(
  definition: WorkflowDefinition,
): WorkflowV2GraphModel {
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const topLevel = definition.nodes.filter((node) => !node.managedBy);
  const routes = definition.relationships.map((relationship) => ({
    id: relationship.id,
    from: relationship.from,
    to:
      "nodeId" in relationship.to
        ? relationship.to.nodeId
        : relationship.to.end,
    label: routeLabel(
      nodesById.get(relationship.from)!,
      relationship.when?.equals,
    ),
    terminal: "end" in relationship.to,
  }));
  const orderedIds: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id) || !nodesById.get(id) || nodesById.get(id)?.managedBy)
      return;
    visited.add(id);
    orderedIds.push(id);
    routes
      .filter((route) => route.from === id && !route.terminal)
      .forEach((route) => visit(route.to));
  };
  visit(definition.entryNodeId);
  topLevel.forEach((node) => visit(node.id));

  const project = (node: WorkflowNode): WorkflowV2GraphNode => {
    const managed =
      node.role === "orchestrator"
        ? definition.nodes
            .filter((candidate) => candidate.managedBy === node.id)
            .sort((left, right) => {
              if (node.config.mode === "loop") {
                if (left.id === node.config.decider) return 1;
                if (right.id === node.config.decider) return -1;
              }
              const order =
                node.config.agents.indexOf(left.id) -
                node.config.agents.indexOf(right.id);
              if (order !== 0) return order;
              return left.id.localeCompare(right.id);
            })
            .map(project)
        : [];
    return {
      id: node.id,
      name: node.name,
      role: node.role,
      detail: nodeDetail(node),
      managedNodes: managed,
    };
  };

  return {
    topLevelNodes: orderedIds.map((id) => project(nodesById.get(id)!)),
    routes,
    terminalOutcomes: [
      ...new Set(
        routes.filter((route) => route.terminal).map((route) => route.to),
      ),
    ],
  };
}
