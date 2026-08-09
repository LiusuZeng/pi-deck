import type { ReactElement } from "react";
import type {
  CanonicalNodeOccurrence,
  WorkflowDefinition,
} from "../../../shared/agentWorkflowSchemas.js";
import {
  deriveAgentWorkflowGraph,
  type AgentWorkflowGraphNode,
  type WorkflowGraphStatus,
} from "../../workflows/agentWorkflowGraph.js";

export interface AgentWorkflowGraphProps {
  definition: WorkflowDefinition;
  /** Supplying occurrences turns the same definition graph into a live run graph. */
  occurrences?: CanonicalNodeOccurrence[];
  selectedNodeId?: string | undefined;
  onSelectNode(nodeId: string): void;
}

const statusLabel: Record<WorkflowGraphStatus, string> = {
  not_started: "Not started", queued: "Queued", in_progress: "In progress",
  waiting_human: "Waiting for input", retrying: "Retrying", completed: "Completed",
  failed: "Failed", skipped: "Skipped", cancelled: "Cancelled",
};

function countSummary(node: AgentWorkflowGraphNode): string | undefined {
  if (!node.counts) return undefined;
  const parts = Object.entries(node.counts).map(([status, count]) =>
    `${count} ${statusLabel[status as WorkflowGraphStatus].toLowerCase()}`,
  );
  if (node.retries) parts.push(`${node.retries} ${node.retries === 1 ? "retry" : "retries"}`);
  return parts.join(" · ");
}

function RoleNode(props: {
  node: AgentWorkflowGraphNode;
  selectedNodeId?: string | undefined;
  onSelectNode(nodeId: string): void;
  managed?: boolean;
}): ReactElement {
  const { node } = props;
  const selected = props.selectedNodeId === node.id;
  const description = [node.role, node.name, node.status && statusLabel[node.status], countSummary(node)].filter(Boolean).join(" · ");
  return (
    <article
      className={`agent-workflow-graph-node agent-workflow-graph-node--${node.role}${node.status ? ` is-${node.status}` : ""}`}
      aria-label={description}
    >
      <h3>
        <button
          type="button"
          className="workflow-run-node-toggle"
          aria-pressed={selected}
          aria-expanded={selected}
          onClick={() => props.onSelectNode(node.id)}
        >
          {node.name}
        </button>
      </h3>
      <p className="agent-workflow-graph-role">{node.role}</p>
      {node.status ? <p className="agent-workflow-graph-status"><strong>Status:</strong> {statusLabel[node.status]}</p> : null}
      {node.counts ? <p className="agent-workflow-graph-counts">{countSummary(node)}</p> : null}
      <p>{node.detail}</p>
      {node.role === "orchestrator" && (
        <section className="agent-workflow-graph-managed" aria-label={`Managed roles for ${node.name}`}>
          <h4>Managed roles</h4>
          <ol>{node.managedNodes.map((managedNode) => (
            <li key={managedNode.id}><RoleNode node={managedNode} selectedNodeId={props.selectedNodeId} onSelectNode={props.onSelectNode} managed /></li>
          ))}</ol>
        </section>
      )}
      {props.managed && <span className="agent-workflow-graph-managed-label">Managed</span>}
    </article>
  );
}

/** Shared accessible definition/live execution graph. The ordered list is its text alternative. */
export function AgentWorkflowGraph(props: AgentWorkflowGraphProps): ReactElement {
  const model = deriveAgentWorkflowGraph(props.definition, props.occurrences);
  const names = new Map(props.definition.nodes.map((node) => [node.id, node.name]));
  const live = props.occurrences !== undefined;
  return (
    <section className={`agent-workflow-graph${live ? " agent-workflow-graph--live" : ""}`} aria-label={live ? "Live workflow execution graph" : "Read-only workflow graph"}>
      <header>
        <h2>{live ? "Execution graph" : "Workflow graph"}</h2>
        <p>{live ? "Live scheduler state is shown on the canonical workflow definition. Select a node for details." : "Derived and read-only. Select a role to focus it in Build."}</p>
      </header>
      <ol className="agent-workflow-graph-flow" aria-label="Top-level workflow flow">
        {model.topLevelNodes.map((node) => (
          <li key={node.id}>
            <RoleNode node={node} selectedNodeId={props.selectedNodeId} onSelectNode={props.onSelectNode} />
            <ul aria-label={`Routes from ${node.name}`}>
              {model.routes.filter((route) => route.from === node.id).map((route) => (
                <li key={route.id} className={route.status ? `is-${route.status}` : ""}>
                  <span>{route.label}</span>{route.status ? <span> · {route.status.replace("_", " ")}</span> : null} → {route.terminal ? "End workflow: " : ""}<strong>{route.terminal ? route.to : (names.get(route.to) ?? route.to)}</strong>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {model.terminalOutcomes.length > 0 && <section aria-label="Terminal outcomes"><h3>Terminal outcomes</h3><ul>{model.terminalOutcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul></section>}
    </section>
  );
}
