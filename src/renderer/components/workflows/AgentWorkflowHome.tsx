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

type AgentWorkflowHomeView = "overview" | "workflows" | "runs";

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
  onShowWorkflows?(): void;
  onShowRuns?(): void;
  onBack?(): void;
  view?: AgentWorkflowHomeView;
  /** Execution capability is supplied by the canonical main/preload seam. */
  startCapability?: AgentWorkflowStartCapability;
}

const roles: AgentWorkflowRole[] = [
  "worker",
  "decider",
  "orchestrator",
  "human",
];
const defaultStartUnavailable = "Starting this workflow is unavailable.";

/** Canonical workflow overview and its focused definitions and runs surfaces. */
export function AgentWorkflowHome(props: AgentWorkflowHomeProps): ReactElement {
  const view = props.view ?? "overview";
  const runs = props.runs ?? [];
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
      setStartError(undefined);
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

  if (view === "overview") {
    return (
      <div className="workflow-home agent-workflow-home">
        <div className="workflow-page-heading">
          <div>
            <span className="workflow-kicker">Orchestration</span>
            <h2>Agent Workflows</h2>
            <p>Coordinate reusable work across people and agents.</p>
          </div>
          <button
            type="button"
            className="workflow-primary-button"
            onClick={props.onCreate}
          >
            New workflow
          </button>
        </div>
        <section
          className="agent-workflow-overview"
          aria-label="Agent Workflow overview"
        >
          <button
            type="button"
            className="agent-workflow-overview-card"
            onClick={props.onShowWorkflows}
          >
            <span className="workflow-kicker">Definitions</span>
            <strong>Workflows</strong>
            <span>{props.workflows.length} saved</span>
            <span className="agent-workflow-overview-link">View workflows</span>
          </button>
          <button
            type="button"
            className="agent-workflow-overview-card"
            onClick={props.onShowRuns}
          >
            <span className="workflow-kicker">Activity</span>
            <strong>Runs</strong>
            <span>{runs.length} in this workspace</span>
            <span className="agent-workflow-overview-link">View runs</span>
          </button>
        </section>
      </div>
    );
  }

  const isWorkflows = view === "workflows";
  return (
    <div className="workflow-home agent-workflow-home">
      <div className="workflow-page-heading">
        <div>
          <button
            type="button"
            className="workflow-back-button"
            onClick={props.onBack}
          >
            Back to overview
          </button>
          <span className="workflow-kicker">Orchestration</span>
          <h2>{isWorkflows ? "Workflows" : "Runs"}</h2>
          <p>
            {isWorkflows
              ? "Build and start reusable Agent Workflows."
              : "Review runs in this workspace."}
          </p>
        </div>
        {isWorkflows ? (
          <button
            type="button"
            className="workflow-primary-button"
            onClick={props.onCreate}
          >
            New workflow
          </button>
        ) : null}
      </div>
      {startError ? (
        <p className="workflow-error" role="alert">
          {startError}
        </p>
      ) : null}
      {isWorkflows ? (
        props.workflows.length === 0 ? (
          <div className="workflow-empty-state">
            <h3>No workflows yet</h3>
            <p>
              Create a workflow to coordinate work across people and agents.
            </p>
          </div>
        ) : (
          <div className="workflow-template-grid" aria-label="Agent Workflows">
            {props.workflows.map((workflow) => {
              const card = agentWorkflowCardViewModel(workflow);
              const titleId = `agent-workflow-${card.id}-title`;
              const unavailableId = `agent-workflow-start-${workflow.id}`;
              const isStarting = startingId === workflow.id;
              return (
                <article
                  className="workflow-card workflow-template-card"
                  key={card.id}
                  aria-labelledby={titleId}
                >
                  <div className="workflow-template-card-heading">
                    <div>
                      <span className="workflow-template-mark">Workflow</span>
                      <h3 id={titleId}>{card.name}</h3>
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
        )
      ) : runs.length === 0 ? (
        <div className="workflow-empty-state">
          <h3>No runs yet</h3>
          <p>Start a workflow to see its progress here.</p>
        </div>
      ) : (
        <div className="workflow-run-list" aria-label="Workflow runs">
          {runs.map((run) => (
            <article className="workflow-run-row" key={run.id}>
              <span className="workflow-status-dot" aria-hidden="true" />
              <span className="workflow-run-row-copy">
                <strong>{run.name}</strong>
                <small>
                  {run.terminalOutcome
                    ? `Outcome: ${run.terminalOutcome}`
                    : `${run.occurrences.length} occurrence${run.occurrences.length === 1 ? "" : "s"}`}
                </small>
              </span>
              <span className="workflow-run-status">{run.status}</span>
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
      )}
      {inputWorkflow ? (
        <div
          className="workflow-input-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="agent-workflow-inputs-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") setInputWorkflow(undefined);
          }}
        >
          <h3 id="agent-workflow-inputs-title">Run inputs</h3>
          {inputWorkflow.inputs.map((input) => {
            const errorId = `agent-workflow-input-${input.id}-error`;
            const invalid =
              input.required && startError === `${input.label} is required.`;
            return (
              <label key={input.id}>
                {input.label}
                <input
                  type="text"
                  required={input.required}
                  aria-invalid={invalid}
                  aria-describedby={invalid ? errorId : undefined}
                  value={inputValues[input.id] ?? ""}
                  onChange={(event) =>
                    setInputValues({
                      ...inputValues,
                      [input.id]: event.target.value,
                    })
                  }
                />
                {invalid ? <span id={errorId}>{startError}</span> : null}
              </label>
            );
          })}
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
