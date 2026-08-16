import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type {
  WorkflowDefinition,
  WorkflowRunEnvelope,
} from "../../../shared/agentWorkflowSchemas.js";
import type { WorkflowRun } from "../../../shared/workflowSchemas.js";
import {
  agentWorkflowCardViewModel,
  agentWorkflowRoleLabel,
  type AgentWorkflowRole,
} from "../../workflows/agentWorkflowViewModels.js";
import { deriveAgentWorkflowGraph } from "../../workflows/agentWorkflowGraph.js";

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
  /** Runs retained from the pre-occurrence store format. */
  legacyRuns?: WorkflowRun[];
  onOpenRun?(run: WorkflowRunEnvelope): void;
  onOpenLegacyRun?(run: WorkflowRun): void;
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

function runStatusLabel(status: WorkflowRunEnvelope["status"]): string {
  return {
    waiting: "Waiting to start",
    running: "Running",
    needsAttention: "Needs attention",
    completed: "Completed",
    failed: "Failed",
    stopped: "Stopped",
  }[status];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function runIdentity(
  run: Pick<WorkflowRunEnvelope, "id" | "updatedAtMs">,
): string {
  return `Updated ${new Date(run.updatedAtMs).toLocaleString()} · ID ${run.id.slice(-8)}`;
}

function openRunLabel(
  run: Pick<WorkflowRunEnvelope, "id" | "name" | "status" | "updatedAtMs">,
): string {
  return `Open run ${run.name}: ${runStatusLabel(run.status)}, updated ${new Date(run.updatedAtMs).toISOString()}, ID ${run.id}`;
}

/** Canonical workflow overview and its focused definitions and runs surfaces. */
export function AgentWorkflowHome(props: AgentWorkflowHomeProps): ReactElement {
  const view = props.view ?? "overview";
  const runs = props.runs ?? [];
  const legacyRuns = props.legacyRuns ?? [];
  const [startingId, setStartingId] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const [inputWorkflow, setInputWorkflow] = useState<WorkflowDefinition>();
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const starting = useRef(new Set<string>());
  const inputDialogRef = useRef<HTMLDivElement>(null);
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

  useLayoutEffect(() => {
    if (!inputWorkflow) return;
    const opener = document.activeElement as HTMLElement | null;
    const initialFocus = inputDialogRef.current?.querySelector<HTMLElement>(
      "[data-dialog-initial-focus], input:not([disabled]), button:not([disabled])",
    );
    initialFocus?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [inputWorkflow?.id]);

  const inputDialog = inputWorkflow ? (
    <div
      ref={inputDialogRef}
      className="workflow-input-dialog"
      role="dialog"
      aria-labelledby="agent-workflow-inputs-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setInputWorkflow(undefined);
        }
      }}
    >
      <h3 id="agent-workflow-inputs-title">Run inputs</h3>
      {inputWorkflow.inputs.map((input, index) => {
        const errorId = `agent-workflow-input-${input.id}-error`;
        const invalid =
          input.required && startError === `${input.label} is required.`;
        return (
          <label key={input.id}>
            {input.label}
            <input
              data-dialog-initial-focus={index === 0 ? true : undefined}
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
  ) : null;

  const isFocusedSingleWorkflow =
    view === "workflows" && props.workflows.length === 1;

  if (view === "overview" || isFocusedSingleWorkflow) {
    const onlyWorkflow =
      props.workflows.length === 1 ? props.workflows[0] : undefined;
    const workflowRuns = onlyWorkflow
      ? [
          ...runs.filter((run) => run.definition.id === onlyWorkflow.id),
          ...legacyRuns.filter(
            (run) => run.templateSnapshot.id === onlyWorkflow.id,
          ),
        ]
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
          .slice(0, 3)
      : [];
    const card = onlyWorkflow
      ? agentWorkflowCardViewModel(onlyWorkflow)
      : undefined;
    const graph = onlyWorkflow
      ? deriveAgentWorkflowGraph(onlyWorkflow)
      : undefined;
    const isStarting = onlyWorkflow ? startingId === onlyWorkflow.id : false;
    const unavailableId = onlyWorkflow
      ? `agent-workflow-start-${onlyWorkflow.id}`
      : undefined;

    return (
      <div className="workflow-home agent-workflow-home">
        <div className="workflow-page-heading">
          <div>
            {isFocusedSingleWorkflow ? (
              <button
                type="button"
                className="workflow-back-button"
                onClick={props.onBack}
              >
                Back to overview
              </button>
            ) : null}
            <span className="workflow-kicker">Orchestration</span>
            <h2>{isFocusedSingleWorkflow ? "Workflows" : "Agent Workflows"}</h2>
            <p>
              {isFocusedSingleWorkflow
                ? "1 saved workflow in this collection. Build and start reusable Agent Workflows."
                : "Coordinate reusable work across people and agents."}
            </p>
          </div>
          <button
            type="button"
            className="workflow-primary-button"
            onClick={props.onCreate}
          >
            New workflow
          </button>
        </div>
        {startError ? (
          <p className="workflow-error" role="alert">
            {startError}
          </p>
        ) : null}
        {onlyWorkflow && card && graph ? (
          <article
            className="agent-workflow-summary"
            aria-labelledby={`agent-workflow-${card.id}-summary-title`}
          >
            <header className="agent-workflow-summary-header">
              <div>
                <span className="workflow-template-mark">Workflow</span>
                <h3 id={`agent-workflow-${card.id}-summary-title`}>
                  {card.name}
                </h3>
                <p>{card.description ?? "A reusable Agent Workflow."}</p>
                <div
                  className="agent-workflow-role-badges"
                  aria-label="Workflow role summary"
                >
                  {roles
                    .filter((role) => card.roleCounts[role] > 0)
                    .map((role) => (
                      <span key={role}>
                        {plural(
                          card.roleCounts[role],
                          agentWorkflowRoleLabel[role],
                        )}
                      </span>
                    ))}
                  <span>{plural(card.relationshipCount, "route")}</span>
                  {onlyWorkflow.inputs.length > 0 ? (
                    <span>{plural(onlyWorkflow.inputs.length, "input")}</span>
                  ) : null}
                </div>
              </div>
              <div className="agent-workflow-summary-actions">
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
                    onClick={() => requestStart(onlyWorkflow)}
                  >
                    {isStarting ? "Starting…" : "Start run"}
                  </button>
                  <button
                    type="button"
                    className="workflow-secondary-button"
                    onClick={() => props.onEdit(onlyWorkflow)}
                  >
                    Edit
                  </button>
                </div>
              </div>
            </header>
            <div className="agent-workflow-summary-content">
              <section
                className="agent-workflow-flow-preview"
                aria-labelledby={`agent-workflow-${card.id}-flow-title`}
              >
                <div>
                  <span className="workflow-kicker">
                    Read-only roles and routes
                  </span>
                  <h4 id={`agent-workflow-${card.id}-flow-title`}>
                    Workflow structure
                  </h4>
                </div>
                <ul
                  className="agent-workflow-role-preview"
                  aria-label="Workflow roles"
                >
                  {graph.topLevelNodes.map((node) => (
                    <li key={node.id}>
                      <strong>{node.name}</strong>
                      <span>{agentWorkflowRoleLabel[node.role]}</span>
                      <small>{node.detail}</small>
                      {node.managedNodes.length > 0 ? (
                        <small>
                          Manages{" "}
                          {node.managedNodes
                            .map((managed) => managed.name)
                            .join(", ")}
                        </small>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {graph.routes.length > 0 ? (
                  <section
                    className="agent-workflow-route-preview"
                    aria-label="Configured routes"
                  >
                    <h5>Configured routes</h5>
                    <ul>
                      {graph.routes.map((route) => {
                        const from = onlyWorkflow.nodes.find(
                          (node) => node.id === route.from,
                        );
                        const to = onlyWorkflow.nodes.find(
                          (node) => node.id === route.to,
                        );
                        return (
                          <li key={route.id}>
                            <strong>{from?.name ?? route.from}</strong>:{" "}
                            {route.label} →{" "}
                            {route.terminal
                              ? `End workflow: ${route.to}`
                              : (to?.name ?? route.to)}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
              </section>
              <section
                className="agent-workflow-activity"
                aria-labelledby={`agent-workflow-${card.id}-activity-title`}
              >
                <div className="agent-workflow-activity-heading">
                  <div>
                    <span className="workflow-kicker">Activity</span>
                    <h4 id={`agent-workflow-${card.id}-activity-title`}>
                      Recent runs
                    </h4>
                  </div>
                  {props.onShowRuns ? (
                    <button
                      type="button"
                      className="workflow-back-button"
                      onClick={props.onShowRuns}
                    >
                      View all runs
                    </button>
                  ) : null}
                </div>
                {workflowRuns.length === 0 ? (
                  <div className="agent-workflow-activity-empty">
                    <strong>No activity yet</strong>
                    <p>
                      This workflow has not been run. Start a run when it is
                      ready.
                    </p>
                  </div>
                ) : (
                  <ol className="agent-workflow-activity-list">
                    {workflowRuns.map((run) => (
                      <li key={run.id}>
                        <span>
                          <strong>{run.name}</strong>
                          <small>{runIdentity(run)}</small>
                          <span>
                            {runStatusLabel(run.status)}
                            {"terminalOutcome" in run && run.terminalOutcome
                              ? ` · ${run.terminalOutcome}`
                              : "occurrences" in run
                                ? ` · ${plural(run.occurrences.length, "occurrence")}`
                                : " · Legacy run"}
                          </span>
                        </span>
                        {props.onOpenRun || props.onOpenLegacyRun ? (
                          <button
                            type="button"
                            className="workflow-secondary-button"
                            aria-label={openRunLabel(run)}
                            onClick={() =>
                              "occurrences" in run
                                ? props.onOpenRun?.(run)
                                : props.onOpenLegacyRun?.(run)
                            }
                          >
                            Open run
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </article>
        ) : (
          <section
            className="agent-workflow-overview"
            aria-label="Agent Workflow overview"
          >
            <button
              type="button"
              className="agent-workflow-overview-card"
              disabled={!props.onShowWorkflows}
              onClick={props.onShowWorkflows}
            >
              <span className="workflow-kicker">Definitions</span>
              <strong>Workflows</strong>
              <span>{props.workflows.length} saved</span>
              <span className="agent-workflow-overview-link">
                Browse definitions
              </span>
            </button>
            <button
              type="button"
              className="agent-workflow-overview-card"
              disabled={!props.onShowRuns}
              onClick={props.onShowRuns}
            >
              <span className="workflow-kicker">Activity</span>
              <strong>Runs</strong>
              <span>{runs.length + legacyRuns.length} in this workspace</span>
              <span className="agent-workflow-overview-link">View runs</span>
            </button>
          </section>
        )}
        {inputDialog}
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
      ) : runs.length + legacyRuns.length === 0 ? (
        <div className="workflow-empty-state">
          <h3>No runs yet</h3>
          <p>Start a workflow to see its progress here.</p>
        </div>
      ) : (
        <div className="workflow-run-list" aria-label="Workflow runs">
          {[...runs, ...legacyRuns].map((run) => (
            <article className="workflow-run-row" key={run.id}>
              <span className="workflow-status-dot" aria-hidden="true" />
              <span className="workflow-run-row-copy">
                <strong>{run.name}</strong>
                <small>
                  {"terminalOutcome" in run && run.terminalOutcome
                    ? `Outcome: ${run.terminalOutcome}`
                    : "occurrences" in run
                      ? `${run.occurrences.length} occurrence${run.occurrences.length === 1 ? "" : "s"}`
                      : "Legacy run"}
                </small>
              </span>
              <span className="workflow-run-status">
                {runStatusLabel(run.status)}
              </span>
              <button
                type="button"
                className="workflow-secondary-button"
                aria-label={openRunLabel(run)}
                onClick={() =>
                  "occurrences" in run
                    ? props.onOpenRun?.(run)
                    : props.onOpenLegacyRun?.(run)
                }
              >
                Open run
              </button>
            </article>
          ))}
        </div>
      )}
      {inputDialog}
    </div>
  );
}
