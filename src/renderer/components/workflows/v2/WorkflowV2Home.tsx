import { useRef, useState, type ReactElement } from "react";
import type { WorkflowDefinition } from "../../../../shared/workflowV2Schemas.js";
import {
  workflowV2CardViewModel,
  workflowV2RoleLabel,
  type WorkflowV2Role,
} from "../../../workflows/workflowV2ViewModels.js";

export interface WorkflowV2StartCapability {
  enabled: boolean;
  /** Explains why occurrence execution cannot be started from this surface. */
  unavailableReason?: string;
}

export interface WorkflowV2HomeProps {
  workflows: WorkflowDefinition[];
  onCreate(): void;
  onEdit(workflow: WorkflowDefinition): void;
  onStart(workflow: WorkflowDefinition): Promise<void> | void;
  /** Defaults to disabled until occurrence execution is wired end to end. */
  startCapability?: WorkflowV2StartCapability;
  /** Omits the page-level heading when composed into the legacy-compatible home. */
  embedded?: boolean;
}

const roles: WorkflowV2Role[] = ["worker", "decider", "orchestrator", "human"];
const defaultStartUnavailable =
  "Starting v2 workflows is unavailable until occurrence execution is connected.";

/** A v2-native workflow list; it intentionally never converts documents to legacy templates. */
export function WorkflowV2Home(props: WorkflowV2HomeProps): ReactElement {
  const [startingId, setStartingId] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const starting = useRef(new Set<string>());
  const startCapability = props.startCapability ?? { enabled: false };
  const unavailableReason =
    startCapability.unavailableReason ?? defaultStartUnavailable;

  const start = async (workflow: WorkflowDefinition) => {
    if (!startCapability.enabled || starting.current.has(workflow.id)) return;
    starting.current.add(workflow.id);
    setStartingId(workflow.id);
    setStartError(undefined);
    try {
      await props.onStart(workflow);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      starting.current.delete(workflow.id);
      setStartingId((current) =>
        current === workflow.id ? undefined : current,
      );
    }
  };

  return (
    <div className="workflow-home workflow-v2-home">
      {!props.embedded ? (
        <div className="workflow-page-heading">
          <div>
            <span className="workflow-kicker">Orchestration</span>
            <h2>Agent Workflows</h2>
            <p>Build reusable role-based workflows with explicit handoffs.</p>
          </div>
          <button
            type="button"
            className="workflow-primary-button"
            onClick={props.onCreate}
          >
            New workflow
          </button>
        </div>
      ) : null}
      <section aria-labelledby="workflow-v2-list-title">
        <div className="workflow-section-heading">
          <div>
            <span className="workflow-kicker">Role-based workflows</span>
            <h3 id="workflow-v2-list-title">
              {props.embedded
                ? "Role-based definitions"
                : "Your agent workflows"}
            </h3>
          </div>
          <span
            className="workflow-count"
            aria-label={`${props.workflows.length} workflows`}
          >
            {props.workflows.length}
          </span>
        </div>
        {startError ? (
          <p className="workflow-error" role="alert">
            {startError}
          </p>
        ) : null}
        {props.workflows.length === 0 ? (
          <div className="workflow-empty-state">
            <h3>Create a role-based workflow</h3>
            <p>
              Add Workers, Deciders, Orchestrators, and Human checkpoints to
              coordinate a reusable workflow.
            </p>
          </div>
        ) : (
          <div className="workflow-template-grid">
            {props.workflows.map((workflow) => {
              const card = workflowV2CardViewModel(workflow);
              const unavailableId = `workflow-v2-start-${workflow.id}`;
              const isStarting = startingId === workflow.id;
              return (
                <article
                  className="workflow-card workflow-template-card"
                  key={card.id}
                  aria-label={`${card.name}, role-based workflow`}
                >
                  <div className="workflow-template-card-heading">
                    <div>
                      <span className="workflow-template-mark">
                        V2 workflow
                      </span>
                      <h3>{card.name}</h3>
                    </div>
                    <span className="workflow-step-count">
                      {card.nodeCount} role{card.nodeCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p>{card.description ?? "A reusable role-based workflow."}</p>
                  <ul aria-label="Role summary">
                    {roles.map((role) => (
                      <li key={role}>
                        {workflowV2RoleLabel[role]}: {card.roleCounts[role]}
                      </li>
                    ))}
                  </ul>
                  <p className="workflow-help">{card.roleSummary}</p>
                  <div className="workflow-card-facts">
                    <span>
                      {card.relationshipCount} relationship
                      {card.relationshipCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  {!startCapability.enabled ? (
                    <p id={unavailableId} className="workflow-help">
                      {unavailableReason}
                    </p>
                  ) : null}
                  <div className="workflow-card-actions">
                    <button
                      type="button"
                      className="workflow-primary-button"
                      disabled={!startCapability.enabled || isStarting}
                      aria-describedby={
                        !startCapability.enabled ? unavailableId : undefined
                      }
                      onClick={() => void start(workflow)}
                    >
                      {isStarting ? "Starting…" : "Start run"}
                    </button>
                    <button
                      type="button"
                      className="workflow-secondary-button"
                      onClick={() => props.onEdit(workflow)}
                    >
                      Edit
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
