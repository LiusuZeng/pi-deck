import type { CSSProperties, KeyboardEvent, ReactElement } from "react";
import type {
  CanonicalNodeOccurrence,
  WorkflowDefinition,
  WorkflowGraphSnapshot,
} from "../../../shared/agentWorkflowSchemas.js";
import {
  deriveAgentWorkflowGraph,
  layoutAgentWorkflowGraph,
  type AgentWorkflowGraphNode,
  type WorkflowGraphStatus,
} from "../../workflows/agentWorkflowGraph.js";

export interface AgentWorkflowGraphProps {
  definition: WorkflowDefinition;
  /** Supplying occurrences turns the same definition graph into a live run graph. */
  occurrences?: CanonicalNodeOccurrence[];
  /** Authoritative, renderer-safe run projection when monitoring a run. */
  snapshot?: WorkflowGraphSnapshot | undefined;
  selectedNodeId?: string | undefined;
  onSelectNode(nodeId: string): void;
}

const statusLabel: Record<WorkflowGraphStatus, string> = {
  not_started: "Not started",
  queued: "Queued",
  in_progress: "In progress",
  waiting_human: "Waiting for input",
  retrying: "Retrying",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  unknown: "Unavailable",
};

function flattenNodes(
  nodes: AgentWorkflowGraphNode[],
): AgentWorkflowGraphNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.managedNodes)]);
}

function countSummary(node: AgentWorkflowGraphNode): string | undefined {
  if (!node.counts) return undefined;
  const parts = Object.entries(node.counts).map(
    ([status, count]) =>
      `${count} ${statusLabel[status as WorkflowGraphStatus].toLowerCase()}`,
  );
  if (node.retries)
    parts.push(`${node.retries} ${node.retries === 1 ? "retry" : "retries"}`);
  return parts.join(" · ");
}

function RoleNode(props: {
  node: AgentWorkflowGraphNode;
  selectedNodeId?: string | undefined;
  onSelectNode(nodeId: string): void;
}): ReactElement {
  const { node } = props;
  const selected = props.selectedNodeId === node.id;
  const description = [
    node.role,
    node.name,
    node.status && statusLabel[node.status],
    countSummary(node),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <article
      className={`agent-workflow-graph-node agent-workflow-graph-node--${node.role}${node.status ? ` is-${node.status}` : ""}${selected ? " is-selected" : ""}`}
      aria-label={description}
    >
      <h3>
        <button
          type="button"
          className="workflow-run-node-toggle"
          aria-pressed={selected}
          aria-expanded={selected}
          data-workflow-node-id={node.id}
          onClick={() => props.onSelectNode(node.id)}
        >
          {node.name}
        </button>
      </h3>
      <p className="agent-workflow-graph-role">{node.role}</p>
      {node.status ? (
        <p className="agent-workflow-graph-status">
          <strong>Status:</strong> {statusLabel[node.status]}
        </p>
      ) : null}
      {node.counts ? (
        <p className="agent-workflow-graph-counts">{countSummary(node)}</p>
      ) : null}
      <p>{node.detail}</p>
    </article>
  );
}

function GraphCanvas(props: {
  definition: WorkflowDefinition;
  occurrences?: CanonicalNodeOccurrence[] | undefined;
  snapshot?: WorkflowGraphSnapshot | undefined;
  selectedNodeId?: string | undefined;
  onSelectNode(nodeId: string): void;
}): ReactElement {
  const graph = layoutAgentWorkflowGraph(
    props.definition,
    props.occurrences,
    props.snapshot,
  );
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !(
        ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"] as string[]
      ).includes(event.key)
    )
      return;
    const currentId =
      (event.target as HTMLElement).closest<HTMLButtonElement>(
        "[data-workflow-node-id]",
      )?.dataset.workflowNodeId ??
      props.selectedNodeId ??
      graph.nodes[0]?.id;
    if (!currentId) return;
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const connected = graph.edges
      .filter((edge) =>
        forward ? edge.from === currentId : edge.to === currentId,
      )
      .map((edge) => (forward ? edge.to : edge.from));
    const nextId = connected.find((id) =>
      graph.nodes.some((node) => node.id === id),
    );
    if (!nextId) return;
    event.preventDefault();
    props.onSelectNode(nextId);
    const next = event.currentTarget.querySelector<HTMLButtonElement>(
      `[data-workflow-node-id="${nextId}"]`,
    );
    next?.focus();
  };
  return (
    <div
      className="agent-workflow-graph-viewport"
      tabIndex={0}
      aria-label="Workflow graph canvas. Use Right or Down for an outgoing connection and Left or Up for an incoming connection."
      onKeyDown={navigate}
    >
      <div
        className="agent-workflow-graph-canvas"
        style={
          {
            "--graph-width": `${graph.width}px`,
            "--graph-height": `${graph.height}px`,
          } as CSSProperties
        }
      >
        <svg
          className="agent-workflow-graph-links"
          width={graph.width}
          height={graph.height}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="workflow-graph-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const points = edge.points
              .map((point) => `${point.x},${point.y}`)
              .join(" ");
            const midpoint = edge.points[Math.floor(edge.points.length / 2)];
            return (
              <g
                key={edge.id}
                className={`${edge.status ? `is-${edge.status}` : ""}${edge.ownership ? " is-ownership" : ""}${edge.feedback ? " is-feedback" : ""}`}
              >
                <polyline
                  points={points}
                  markerEnd="url(#workflow-graph-arrow)"
                />
                {midpoint && (
                  <text x={midpoint.x} y={midpoint.y - 8} textAnchor="middle">
                    {edge.label}
                    {edge.status ? ` · ${edge.status.replace("_", " ")}` : ""}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {graph.nodes.map((node) => (
          <div
            key={node.id}
            className="agent-workflow-graph-canvas-node"
            style={{
              left: node.x - node.width / 2,
              top: node.y - node.height / 2,
              width: node.width,
            }}
          >
            <RoleNode
              node={node}
              selectedNodeId={props.selectedNodeId}
              onSelectNode={props.onSelectNode}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shared positioned definition/live execution graph with a structured text alternative. */
export function AgentWorkflowGraph(
  props: AgentWorkflowGraphProps,
): ReactElement {
  const model = deriveAgentWorkflowGraph(
    props.definition,
    props.occurrences,
    props.snapshot,
  );
  const names = new Map(
    props.definition.nodes.map((node) => [node.id, node.name]),
  );
  const ownership = new Map(
    props.definition.nodes
      .filter((node) => node.managedBy)
      .map((node) => [node.id, node.managedBy!] as const),
  );
  const allNodes = flattenNodes(model.topLevelNodes);
  const live = props.occurrences !== undefined || props.snapshot !== undefined;
  return (
    <section
      className={`agent-workflow-graph${live ? " agent-workflow-graph--live" : ""}`}
      aria-label={
        live ? "Live workflow execution graph" : "Read-only workflow graph"
      }
    >
      <header>
        <h2>{live ? "Execution graph" : "Workflow graph"}</h2>
        <p>
          {live
            ? "Live scheduler state is shown on the canonical workflow definition. Select a node for details."
            : "Derived and read-only. Select a role to focus it in Build."}
        </p>
      </header>
      <GraphCanvas
        definition={props.definition}
        occurrences={props.occurrences}
        snapshot={props.snapshot}
        selectedNodeId={props.selectedNodeId}
        onSelectNode={props.onSelectNode}
      />
      <details className="agent-workflow-graph-text-alternative">
        <summary>Text alternative: nodes, ownership, and routes</summary>
        <ol className="agent-workflow-graph-flow" aria-label="Workflow nodes">
          {allNodes.map((node) => {
            const selected = node.id === props.selectedNodeId;
            const managerId = ownership.get(node.id);
            return (
              <li key={node.id} aria-current={selected ? "true" : undefined}>
                <strong>{node.name}</strong>
                {selected ? " — Selected node" : ""}
                {node.status ? ` — Status: ${statusLabel[node.status]}` : ""}
                {managerId
                  ? ` — Managed by ${names.get(managerId) ?? managerId}`
                  : ""}
                {node.occurrenceCount !== undefined
                  ? ` — ${node.occurrenceCount} occurrence${node.occurrenceCount === 1 ? "" : "s"}`
                  : ""}
                {node.occurrences?.length ? (
                  <ul aria-label={`Occurrences for ${node.name}`}>
                    {node.occurrences.map((occurrence) => (
                      <li key={occurrence.id}>
                        Occurrence {occurrence.id}: {occurrence.status},
                        iteration {occurrence.iteration}, attempt{" "}
                        {occurrence.attempt}
                        {occurrence.parentOrchestratorRunId
                          ? `, parent orchestrator occurrence ${occurrence.parentOrchestratorRunId}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
        <h3>Routes</h3>
        <ul aria-label="Workflow routes">
          {model.routes.map((route) => {
            const selected =
              route.from === props.selectedNodeId ||
              route.to === props.selectedNodeId;
            return (
              <li
                key={route.id}
                className={route.status ? `is-${route.status}` : ""}
                aria-current={selected ? "true" : undefined}
              >
                {selected ? "Selected route — " : ""}
                <strong>{names.get(route.from) ?? route.from}</strong> —{" "}
                {route.label}
                {route.status
                  ? ` · State: ${route.status.replace("_", " ")}`
                  : ""}{" "}
                →{" "}
                <strong>
                  {route.terminal
                    ? `End workflow: ${route.to}`
                    : (names.get(route.to) ?? route.to)}
                </strong>
              </li>
            );
          })}
          {model.feedbackRoutes.map((route) => (
            <li key={route.id}>
              <strong>{names.get(route.from) ?? route.from}</strong> —{" "}
              {route.label} → <strong>{names.get(route.to) ?? route.to}</strong>
            </li>
          ))}
          {Array.from(ownership.entries()).map(([nodeId, managerId]) => (
            <li key={`ownership:${managerId}:${nodeId}`}>
              <strong>{names.get(managerId) ?? managerId}</strong> — manages →{" "}
              <strong>{names.get(nodeId) ?? nodeId}</strong>
            </li>
          ))}
        </ul>
      </details>
      {model.terminalOutcomes.length > 0 && (
        <section aria-label="Terminal outcomes">
          <h3>Terminal outcomes</h3>
          <ul>
            {model.terminalOutcomes.map((outcome) => (
              <li key={outcome}>{outcome}</li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
