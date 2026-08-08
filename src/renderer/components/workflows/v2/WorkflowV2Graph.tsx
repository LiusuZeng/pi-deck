import type { ReactElement } from "react";
import type { WorkflowDefinition } from "../../../../shared/workflowV2Schemas.js";
import {
  deriveWorkflowV2Graph,
  type WorkflowV2GraphNode,
} from "../../../workflows/workflowV2Graph.js";

export interface WorkflowV2GraphProps {
  definition: WorkflowDefinition;
  selectedNodeId?: string;
  onSelectNode(nodeId: string): void;
}

function RoleNode(props: {
  node: WorkflowV2GraphNode;
  selectedNodeId?: string;
  onSelectNode(nodeId: string): void;
  managed?: boolean;
}): ReactElement {
  const { node } = props;
  return (
    <article
      className={`workflow-v2-graph-node workflow-v2-graph-node--${node.role}`}
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
          className="workflow-v2-graph-managed"
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
        <span className="workflow-v2-graph-managed-label">Managed</span>
      )}
    </article>
  );
}

/** Read-only semantic projection of a canonical v2 workflow definition. */
export function WorkflowV2Graph(props: WorkflowV2GraphProps): ReactElement {
  const model = deriveWorkflowV2Graph(props.definition);
  const names = new Map(
    props.definition.nodes.map((node) => [node.id, node.name]),
  );
  return (
    <section
      className="workflow-v2-graph"
      aria-label="Read-only workflow graph"
    >
      <header>
        <h2>Workflow graph</h2>
        <p>Derived and read-only. Select a role to focus it in Build.</p>
      </header>
      <ol
        className="workflow-v2-graph-flow"
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
                    {route.terminal ? "Terminal outcome: " : ""}
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
