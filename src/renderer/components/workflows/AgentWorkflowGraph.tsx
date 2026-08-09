import type { ReactElement } from "react";
import type { WorkflowDefinition } from "../../../shared/agentWorkflowSchemas.js";
import {
  deriveAgentWorkflowGraph,
  type AgentWorkflowGraphNode,
} from "../../workflows/agentWorkflowGraph.js";

export interface AgentWorkflowGraphProps {
  definition: WorkflowDefinition;
  selectedNodeId?: string;
  onSelectNode(nodeId: string): void;
}

function RoleNode(props: {
  node: AgentWorkflowGraphNode;
  selectedNodeId?: string;
  onSelectNode(nodeId: string): void;
  managed?: boolean;
}): ReactElement {
  const { node } = props;
  return (
    <article
      className={`agent-workflow-graph-node agent-workflow-graph-node--${node.role}`}
      aria-label={`${node.role}: ${node.name}`}
    >
      <h3>
        <button
          type="button"
          aria-pressed={props.selectedNodeId === node.id}
          onClick={() => props.onSelectNode(node.id)}
        >
          {node.name}
        </button>
      </h3>
      <p>{node.detail}</p>
      {node.role === "orchestrator" && (
        <section
          className="agent-workflow-graph-managed"
          aria-label={`Managed roles for ${node.name}`}
        >
          <h4>Managed roles</h4>
          <ol>
            {node.managedNodes.map((managedNode) => (
              <li key={managedNode.id}>
                <RoleNode
                  node={managedNode}
                  {...(props.selectedNodeId === undefined
                    ? {}
                    : { selectedNodeId: props.selectedNodeId })}
                  onSelectNode={props.onSelectNode}
                  managed
                />
              </li>
            ))}
          </ol>
        </section>
      )}
      {props.managed && (
        <span className="agent-workflow-graph-managed-label">Managed</span>
      )}
    </article>
  );
}

/** Read-only semantic projection of the canonical workflow definition. */
export function AgentWorkflowGraph(
  props: AgentWorkflowGraphProps,
): ReactElement {
  const model = deriveAgentWorkflowGraph(props.definition);
  const names = new Map(
    props.definition.nodes.map((node) => [node.id, node.name]),
  );
  return (
    <section
      className="agent-workflow-graph"
      aria-label="Read-only workflow graph"
    >
      <header>
        <h2>Workflow graph</h2>
        <p>Derived and read-only. Select a role to focus it in Build.</p>
      </header>
      <ol
        className="agent-workflow-graph-flow"
        aria-label="Top-level workflow flow"
      >
        {model.topLevelNodes.map((node) => (
          <li key={node.id}>
            <RoleNode
              node={node}
              {...(props.selectedNodeId === undefined
                ? {}
                : { selectedNodeId: props.selectedNodeId })}
              onSelectNode={props.onSelectNode}
            />
            <ul aria-label={`Routes from ${node.name}`}>
              {model.routes
                .filter((route) => route.from === node.id)
                .map((route) => (
                  <li key={route.id}>
                    <span>{route.label}</span> →{" "}
                    {route.terminal ? "End workflow: " : ""}
                    <strong>
                      {route.terminal
                        ? route.to
                        : (names.get(route.to) ?? route.to)}
                    </strong>
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ol>
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
