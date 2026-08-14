import { Graph, layout } from "@dagrejs/dagre";
import type {
  CanonicalNodeOccurrence,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowGraphSnapshot,
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
  | "cancelled"
  | "unknown";

export interface AgentWorkflowGraphRoute {
  id: string;
  from: string;
  to: string;
  label: string;
  terminal: boolean;
  status?:
    | "pending"
    | "active"
    | "taken"
    | "not_taken"
    | "blocked"
    | "unknown"
    | undefined;
}

export interface AgentWorkflowGraphOccurrence {
  id: string;
  status: CanonicalNodeOccurrence["status"];
  attempt: number;
  iteration: number;
  parentOrchestratorRunId?: string;
  outputSummary?: string;
  errorSummary?: string;
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
  occurrences?: AgentWorkflowGraphOccurrence[];
}

export interface AgentWorkflowGraphModel {
  topLevelNodes: AgentWorkflowGraphNode[];
  routes: AgentWorkflowGraphRoute[];
  feedbackRoutes: AgentWorkflowGraphRoute[];
  terminalOutcomes: string[];
}

export interface WorkflowGraphLayoutNode extends AgentWorkflowGraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
  containerId?: string;
}
export interface WorkflowGraphLayoutEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  status?: AgentWorkflowGraphRoute["status"];
  ownership?: boolean;
  feedback?: boolean;
  points: Array<{ x: number; y: number }>;
}
export interface WorkflowGraphLayout {
  width: number;
  height: number;
  nodes: WorkflowGraphLayoutNode[];
  edges: WorkflowGraphLayoutEdge[];
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

const occurrenceStatus: Record<
  CanonicalNodeOccurrence["status"],
  WorkflowGraphStatus
> = {
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
): Pick<
  AgentWorkflowGraphNode,
  "status" | "counts" | "occurrenceCount" | "retries"
> {
  if (!occurrences.length)
    return { status: "not_started", occurrenceCount: 0, retries: 0 };
  const counts: Partial<Record<WorkflowGraphStatus, number>> = {};
  for (const occurrence of occurrences) {
    const status = occurrenceStatus[occurrence.status];
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const hasRetry =
    occurrences.some((item) => item.attempt > 1) &&
    occurrences.some((item) =>
      ["queued", "running", "failed"].includes(item.status),
    );
  const precedence: WorkflowGraphStatus[] = [
    "waiting_human",
    "in_progress",
    "retrying",
    "queued",
    "failed",
    "cancelled",
    "completed",
    "skipped",
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
  if (source.some((item) => ["failed", "cancelled"].includes(item.status)))
    return "blocked";
  if (
    source.some((item) =>
      ["running", "waitingHuman", "queued", "ready"].includes(item.status),
    )
  )
    return "active";
  if (!relationship.when) return "taken";
  const selected = source.some(
    (item) =>
      item.status === "completed" && item.output === relationship.when?.equals,
  );
  return selected ? "taken" : "not_taken";
}

/**
 * Produces a stable, read-only graph projection. Source document order is used
 * as the tie-breaker after routing outward from the entry node.
 */
export function deriveAgentWorkflowGraph(
  definition: WorkflowDefinition,
  occurrences: CanonicalNodeOccurrence[] = [],
  snapshot?: WorkflowGraphSnapshot,
): AgentWorkflowGraphModel {
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const topLevel = definition.nodes.filter((node) => !node.managedBy);
  const routes = definition.relationships.map((relationship) => {
    const route = {
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
    };
    const snapshotState = snapshot?.edges.find(
      (edge) => edge.relationshipId === relationship.id,
    )?.status;
    return snapshotState
      ? { ...route, status: snapshotState }
      : occurrences.length
        ? { ...route, status: routeStatus(route, relationship, occurrences) }
        : route;
  });
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
  const project = (node: WorkflowNode): AgentWorkflowGraphNode => {
    const managed =
      node.role === "orchestrator"
        ? definition.nodes
            .filter((candidate) => candidate.managedBy === node.id)
            .sort((left, right) => {
              if (node.config.mode === "loop") {
                if (left.id === node.config.decider) return 1;
                if (right.id === node.config.decider) return -1;
              }
              return (
                node.config.agents.indexOf(left.id) -
                node.config.agents.indexOf(right.id)
              );
            })
            .map(project)
        : [];
    const graphNode = snapshot?.nodes.find((item) => item.nodeId === node.id);
    const nodeOccurrences = occurrences.filter(
      (item) => item.nodeId === node.id,
    );
    const occurrenceDetails: AgentWorkflowGraphOccurrence[] | undefined =
      graphNode?.occurrences?.map((item) => ({
        id: item.occurrenceId,
        status: item.status,
        attempt: item.attempt,
        iteration: item.iteration,
        ...(item.parentOrchestratorRunId
          ? { parentOrchestratorRunId: item.parentOrchestratorRunId }
          : {}),
        ...(item.outputSummary ? { outputSummary: item.outputSummary } : {}),
        ...(item.errorSummary ? { errorSummary: item.errorSummary } : {}),
      })) ??
      (occurrences.length
        ? nodeOccurrences.map((item) => ({
            id: item.id,
            status: item.status,
            attempt: item.attempt,
            iteration: item.iteration,
            ...(item.parentOrchestratorRunId
              ? { parentOrchestratorRunId: item.parentOrchestratorRunId }
              : {}),
            ...(typeof item.output === "string"
              ? { outputSummary: item.output }
              : {}),
            ...(item.error ? { errorSummary: item.error } : {}),
          }))
        : undefined);
    return {
      id: node.id,
      name: node.name,
      role: node.role,
      detail: nodeDetail(node),
      managedNodes: managed,
      ...(graphNode?.aggregateStatus
        ? {
            status: graphNode.aggregateStatus as WorkflowGraphStatus,
            ...(graphNode.counts
              ? {
                  counts: graphNode.counts as Partial<
                    Record<WorkflowGraphStatus, number>
                  >,
                }
              : {}),
            ...(graphNode.occurrences
              ? {
                  occurrenceCount: graphNode.occurrences.length,
                  retries: Math.max(
                    0,
                    ...graphNode.occurrences.map((item) => item.attempt - 1),
                  ),
                }
              : {}),
          }
        : occurrences.length
          ? aggregateWorkflowNode(nodeOccurrences)
          : {}),
      ...(occurrenceDetails ? { occurrences: occurrenceDetails } : {}),
    };
  };
  return {
    topLevelNodes: orderedIds.map((id) => project(nodesById.get(id)!)),
    routes,
    feedbackRoutes: definition.nodes.flatMap((node) =>
      node.role === "orchestrator" && node.config.mode === "loop"
        ? [
            {
              id: `feedback:${node.config.decider}:${node.id}`,
              from: node.config.decider,
              to: node.id,
              label: "next iteration",
              terminal: false,
            },
          ]
        : [],
    ),
    terminalOutcomes: [
      ...new Set(
        routes.filter((route) => route.terminal).map((route) => route.to),
      ),
    ],
  };
}

/** Deterministic compound-node layout used by both definition and live graphs. */
export function layoutAgentWorkflowGraph(
  definition: WorkflowDefinition,
  occurrences: CanonicalNodeOccurrence[] = [],
  snapshot?: WorkflowGraphSnapshot,
): WorkflowGraphLayout {
  const model = deriveAgentWorkflowGraph(definition, occurrences, snapshot);
  const projected = new Map<string, AgentWorkflowGraphNode>();
  const collect = (node: AgentWorkflowGraphNode): void => {
    projected.set(node.id, node);
    node.managedNodes.forEach(collect);
  };
  model.topLevelNodes.forEach(collect);
  const graph = new Graph({ multigraph: true });
  graph.setGraph({
    rankdir: "LR",
    ranksep: 100,
    nodesep: 54,
    marginx: 36,
    marginy: 36,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of definition.nodes) {
    graph.setNode(node.id, {
      width: 240,
      height: node.role === "orchestrator" ? 280 : 190,
    });
  }
  const edges: Omit<WorkflowGraphLayoutEdge, "points">[] = [];
  for (const route of model.routes) {
    if (route.terminal) continue;
    graph.setEdge(route.from, route.to, { weight: 3 }, route.id);
    edges.push({
      id: route.id,
      from: route.from,
      to: route.to,
      label: route.label,
      status: route.status,
    });
  }
  for (const node of definition.nodes) {
    if (!node.managedBy) continue;
    const ownershipId = `ownership:${node.managedBy}:${node.id}`;
    graph.setEdge(
      node.managedBy,
      node.id,
      { weight: 1, minlen: 1 },
      ownershipId,
    );
    edges.push({
      id: ownershipId,
      from: node.managedBy,
      to: node.id,
      label: "manages",
      ownership: true,
    });
  }
  for (const node of definition.nodes) {
    if (node.role !== "orchestrator" || node.config.mode !== "loop") continue;
    const id = `feedback:${node.config.decider}:${node.id}`;
    graph.setEdge(node.config.decider, node.id, { weight: 0, minlen: 2 }, id);
    edges.push({
      id,
      from: node.config.decider,
      to: node.id,
      label: "next iteration",
      feedback: true,
    });
  }
  layout(graph);
  const nodes = definition.nodes.map((node) => {
    const positioned = graph.node(node.id) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    return {
      ...projected.get(node.id)!,
      x: positioned.x,
      y: positioned.y,
      width: positioned.width,
      height: positioned.height,
      ...(node.managedBy ? { containerId: node.managedBy } : {}),
    };
  });
  return {
    width: graph.graph().width,
    height: graph.graph().height,
    nodes,
    edges: edges.map((edge) => ({
      ...edge,
      points: (
        graph.edge({ v: edge.from, w: edge.to, name: edge.id }) as {
          points: Array<{ x: number; y: number }>;
        }
      ).points,
    })),
  };
}
