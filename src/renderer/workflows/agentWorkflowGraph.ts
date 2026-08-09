import type {
  CanonicalNodeOccurrence,
  WorkflowDefinition,
  WorkflowNode,
} from "../../shared/agentWorkflowSchemas.js";

export type WorkflowGraphStatus =
  | "not_started"
  | "queued"
  | "in_progress"
  | "waiting_human"
  | "retrying"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export interface AgentWorkflowGraphRoute {
  id: string;
  from: string;
  to: string;
  label: string;
  terminal: boolean;
  status?: "pending" | "active" | "taken" | "not_taken" | "blocked" | undefined;
}

export interface AgentWorkflowGraphNode {
  id: string;
  name: string;
  role: WorkflowNode["role"];
  detail: string;
  managedNodes: AgentWorkflowGraphNode[];
  status?: WorkflowGraphStatus;
  counts?: Partial<Record<WorkflowGraphStatus, number>>;
  occurrenceCount?: number;
  retries?: number;
}

export interface AgentWorkflowGraphModel {
  topLevelNodes: AgentWorkflowGraphNode[];
  routes: AgentWorkflowGraphRoute[];
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
      return node.execution?.maxAttempts
        ? `Worker · up to ${node.execution.maxAttempts} attempts`
        : "Worker · no retry";
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

const occurrenceStatus: Record<CanonicalNodeOccurrence["status"], WorkflowGraphStatus> = {
  ready: "queued",
  queued: "queued",
  running: "in_progress",
  waitingHuman: "waiting_human",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
};

/** Projects many runtime occurrences onto one stable configured node. */
export function aggregateWorkflowNode(
  occurrences: CanonicalNodeOccurrence[],
): Pick<AgentWorkflowGraphNode, "status" | "counts" | "occurrenceCount" | "retries"> {
  if (!occurrences.length) return { status: "not_started", occurrenceCount: 0, retries: 0 };
  const counts: Partial<Record<WorkflowGraphStatus, number>> = {};
  for (const occurrence of occurrences) {
    const status = occurrenceStatus[occurrence.status];
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const hasRetry = occurrences.some((item) => item.attempt > 1) &&
    occurrences.some((item) => ["queued", "running", "failed"].includes(item.status));
  const precedence: WorkflowGraphStatus[] = [
    "waiting_human", "in_progress", "retrying", "queued", "failed", "cancelled", "completed", "skipped",
  ];
  const status = precedence.find((candidate) =>
    candidate === "retrying" ? hasRetry : (counts[candidate] ?? 0) > 0,
  )!;
  return {
    status,
    counts,
    occurrenceCount: occurrences.length,
    retries: Math.max(0, ...occurrences.map((item) => item.attempt - 1)),
  };
}

function routeStatus(
  route: AgentWorkflowGraphRoute,
  relationship: WorkflowDefinition["relationships"][number],
  occurrences: CanonicalNodeOccurrence[],
): AgentWorkflowGraphRoute["status"] {
  const source = occurrences.filter((item) => item.nodeId === route.from);
  if (!source.length) return "pending";
  if (source.some((item) => ["failed", "cancelled"].includes(item.status))) return "blocked";
  if (source.some((item) => ["running", "waitingHuman", "queued", "ready"].includes(item.status))) return "active";
  if (!relationship.when) return "taken";
  const selected = source.some((item) => item.status === "completed" && item.output === relationship.when?.equals);
  return selected ? "taken" : "not_taken";
}

/**
 * Produces a stable, read-only graph projection. Source document order is used
 * as the tie-breaker after routing outward from the entry node.
 */
export function deriveAgentWorkflowGraph(
  definition: WorkflowDefinition,
  occurrences: CanonicalNodeOccurrence[] = [],
): AgentWorkflowGraphModel {
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const topLevel = definition.nodes.filter((node) => !node.managedBy);
  const routes = definition.relationships.map((relationship) => {
    const route = {
      id: relationship.id,
      from: relationship.from,
      to: "nodeId" in relationship.to ? relationship.to.nodeId : relationship.to.end,
      label: routeLabel(nodesById.get(relationship.from)!, relationship.when?.equals),
      terminal: "end" in relationship.to,
    };
    return occurrences.length ? { ...route, status: routeStatus(route, relationship, occurrences) } : route;
  });
  const orderedIds: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id) || !nodesById.get(id) || nodesById.get(id)?.managedBy) return;
    visited.add(id);
    orderedIds.push(id);
    routes.filter((route) => route.from === id && !route.terminal).forEach((route) => visit(route.to));
  };
  visit(definition.entryNodeId);
  topLevel.forEach((node) => visit(node.id));
  const project = (node: WorkflowNode): AgentWorkflowGraphNode => {
    const managed = node.role === "orchestrator"
      ? definition.nodes.filter((candidate) => candidate.managedBy === node.id).sort((left, right) => {
          if (node.config.mode === "loop") {
            if (left.id === node.config.decider) return 1;
            if (right.id === node.config.decider) return -1;
          }
          return node.config.agents.indexOf(left.id) - node.config.agents.indexOf(right.id);
        }).map(project)
      : [];
    return { id: node.id, name: node.name, role: node.role, detail: nodeDetail(node), managedNodes: managed, ...(occurrences.length ? aggregateWorkflowNode(occurrences.filter((item) => item.nodeId === node.id)) : {}) };
  };
  return {
    topLevelNodes: orderedIds.map((id) => project(nodesById.get(id)!)),
    routes,
    terminalOutcomes: [...new Set(routes.filter((route) => route.terminal).map((route) => route.to))],
  };
}
