import { useRef, useState, type ReactElement } from "react";
import type {
  WorkflowDefinition,
  WorkflowRunEnvelope,
} from "../../../shared/agentWorkflowSchemas.js";
import {
  agentWorkflowCardViewModel,
  agentWorkflowRoleLabel,
  type AgentWorkflowRole,
} from "../../workflows/agentWorkflowViewModels.js";

export interface AgentWorkflowStartCapability {
  enabled: boolean;
  /** Explains why occurrence execution cannot be started from this surface. */
  unavailableReason?: string;
}

export interface AgentWorkflowHomeProps {
  workflows: WorkflowDefinition[];
  onCreate(): void;
  onEdit(workflow: WorkflowDefinition): void;
  onStart(
    workflow: WorkflowDefinition,
    inputs: Record<string, string>,
  ): Promise<void> | void;
  runs?: WorkflowRunEnvelope[];
  onOpenRun?(run: WorkflowRunEnvelope): void;
  /** Execution capability is supplied by the canonical main/preload seam. */
  startCapability?: AgentWorkflowStartCapability;
  /** Omits the page-level heading when composed into the legacy-compatible home. */
  embedded?: boolean;
}

const roles: AgentWorkflowRole[] = [
  "worker",
  "decider",
  "orchestrator",
  "human",
];
const defaultStartUnavailable = "Starting this workflow is unavailable.";

/** Canonical Agent Workflow list; compatibility conversion stays outside this surface. */
export function AgentWorkflowHome(props: AgentWorkflowHomeProps): ReactElement {
  const [startingId, setStartingId] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const [inputWorkflow, setInputWorkflow] = useState<WorkflowDefinition>();
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const starting = useRef(new Set<string>());
  const startCapability = props.startCapability ?? { enabled: true };
  const unavailableReason =
    startCapability.unavailableReason ?? defaultStartUnavailable;

  const start = async (
    workflow: WorkflowDefinition,
    inputs: Record<string, string>,
  ) => {
    if (!startCapability.enabled || starting.current.has(workflow.id)) return;
    starting.current.add(workflow.id);
    setStartingId(workflow.id);
    setStartError(undefined);
    try {
      await props.onStart(workflow, inputs);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      starting.current.delete(workflow.id);
      setStartingId((current) =>
        current === workflow.id ? undefined : current,
      );
    }
  };

  const requestStart = (workflow: WorkflowDefinition) => {
    if (workflow.inputs.length === 0) void start(workflow, {});
    else {
      setInputWorkflow(workflow);
      setInputValues({});
    }
  };
  const submitInputs = () => {
    if (!inputWorkflow) return;
    for (const input of inputWorkflow.inputs)
      if (input.required && !inputValues[input.id]?.trim()) {
        setStartError(`${input.label} is required.`);
        return;
      }
    setInputWorkflow(undefined);
    void start(inputWorkflow, inputValues);
  };
  return (
    <div className="workflow-home agent-workflow-home">
      {!props.embedded ? (
        <div className="workflow-page-heading">
          <div>
            <span className="workflow-kicker">Orchestration</span>
            <h2>Agent Workflows</h2>
            <p>Build reusable Agent Workflows with explicit handoffs.</p>
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
      <section
        {...(props.embedded
          ? { "aria-label": "Agent Workflow definitions" }
          : { "aria-labelledby": "workflow-role-list-title" })}
      >
        {!props.embedded ? (
          <div className="workflow-section-heading">
            <div>
              <span className="workflow-kicker">Workflow definitions</span>
              <h3 id="workflow-role-list-title">Your agent workflows</h3>
            </div>
            <span
              className="workflow-count"
              aria-label={`${props.workflows.length} workflows`}
            >
              {props.workflows.length}
            </span>
          </div>
        ) : null}
        {startError ? (
          <p className="workflow-error" role="alert">
            {startError}
          </p>
        ) : null}
        {props.workflows.length === 0 && !props.embedded ? (
          <div className="workflow-empty-state">
            <h3>Create an Agent Workflow</h3>
            <p>
              Add Workers, Deciders, Orchestrators, and Human checkpoints to
              coordinate a reusable workflow.
            </p>
          </div>
        ) : (
          <div className="workflow-template-grid">
            {props.workflows.map((workflow) => {
              const card = agentWorkflowCardViewModel(workflow);
              const unavailableId = `agent-workflow-start-${workflow.id}`;
              const isStarting = startingId === workflow.id;
              return (
                <article
                  className="workflow-card workflow-template-card"
                  key={card.id}
                  aria-label={`${card.name}, Agent Workflow`}
                >
                  <div className="workflow-template-card-heading">
                    <div>
                      <span className="workflow-template-mark">Workflow</span>
                      <h3>{card.name}</h3>
                    </div>
                    <span className="workflow-step-count">
                      {card.nodeCount} role{card.nodeCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p>{card.description ?? "A reusable Agent Workflow."}</p>
                  <ul aria-label="Role summary">
                    {roles.map((role) => (
                      <li key={role}>
                        {agentWorkflowRoleLabel[role]}: {card.roleCounts[role]}
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
                      onClick={() => requestStart(workflow)}
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
      {(props.runs?.length ?? 0) > 0 ? (
        <section aria-labelledby="workflow-runs-title">
          <div className="workflow-section-heading">
            <div>
              <span className="workflow-kicker">Runs</span>
              <h3 id="workflow-runs-title">Recent runs</h3>
            </div>
          </div>
          <div className="workflow-template-grid">
            {props.runs!.map((run) => (
              <article
                className="workflow-card workflow-template-card"
                key={run.id}
              >
                <div className="workflow-template-card-heading">
                  <div>
                    <span className="workflow-template-mark">Run</span>
                    <h3>{run.name}</h3>
                  </div>
                  <span className="workflow-step-status">{run.status}</span>
                </div>
                <p>
                  {run.terminalOutcome
                    ? `Outcome: ${run.terminalOutcome}`
                    : `${run.occurrences.length} occurrence${run.occurrences.length === 1 ? "" : "s"}`}
                </p>
                <button
                  type="button"
                  className="workflow-secondary-button"
                  onClick={() => props.onOpenRun?.(run)}
                >
                  Open run
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {inputWorkflow ? (
        <div
          className="workflow-input-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={`Start ${inputWorkflow.name}`}
        >
          <h3>Run inputs</h3>
          {inputWorkflow.inputs.map((input) => (
            <label key={input.id}>
              {input.label}
              <input
                type={input.type === "path" ? "text" : "text"}
                required={input.required}
                value={inputValues[input.id] ?? ""}
                onChange={(event) =>
                  setInputValues({
                    ...inputValues,
                    [input.id]: event.target.value,
                  })
                }
              />
            </label>
          ))}
          <div className="workflow-card-actions">
            <button
              type="button"
              className="workflow-secondary-button"
              onClick={() => setInputWorkflow(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="workflow-primary-button"
              onClick={submitInputs}
            >
              Start run
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
