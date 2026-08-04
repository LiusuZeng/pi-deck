import { useState, type ReactElement } from "react";
import type {
  WorkflowRun,
  WorkflowStepRun,
} from "../../../shared/workflowSchemas.js";
import {
  runProgress,
  workflowRunStatusLabel,
} from "../../workflows/workflowViewModels.js";
import { WorkflowContextCard } from "./WorkflowContextCard.js";
import { WorkflowStepCard } from "./WorkflowStepCard.js";

export function WorkflowRunView(props: {
  run: WorkflowRun;
  onBack(): void;
  onStop(): Promise<void> | void;
  onRetryStep?(step: WorkflowStepRun): Promise<void> | void;
  onApproveGate?(
    step: WorkflowStepRun,
    action: "approve" | "skip" | "stop",
  ): Promise<void> | void;
  onOpenSession?(step: WorkflowStepRun): void;
}): ReactElement {
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>(
    {},
  );
  const [busyAction, setBusyAction] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const progress = runProgress(props.run);
  const template = props.run.templateSnapshot;

  const perform = async (
    action: string,
    callback: () => Promise<void> | void,
  ) => {
    setBusyAction(action);
    try {
      setActionError(undefined);
      await callback();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(undefined);
    }
  };

  return (
    <div className="workflow-run-view">
      <div className="workflow-page-heading">
        <div>
          <button
            type="button"
            className="workflow-back-button"
            onClick={props.onBack}
          >
            ← Agent Workflows
          </button>
          <span className="workflow-kicker">Workflow run</span>
          <h2>{props.run.name}</h2>
          <p aria-live="polite">
            {workflowRunStatusLabel(props.run.status)} · {progress.completed} of{" "}
            {progress.total} agents complete
          </p>
        </div>
        <div className="workflow-heading-actions">
          {props.run.status !== "completed" &&
          props.run.status !== "stopped" ? (
            <button
              type="button"
              className="workflow-danger-button"
              disabled={busyAction !== undefined}
              onClick={() => void perform("stop", props.onStop)}
            >
              Stop run
            </button>
          ) : null}
          <span className="workflow-run-status-badge">
            {workflowRunStatusLabel(props.run.status)}
          </span>
        </div>
        {actionError ? (
          <p className="workflow-error workflow-run-action-error" role="alert" aria-live="assertive">
            {actionError}
          </p>
        ) : null}
      </div>
      <div className="workflow-run-layout">
        <main>
          <section
            className="workflow-card workflow-progress-card"
            aria-label="Workflow progress"
          >
            <div className="workflow-progress-heading">
              <strong>Agent progress</strong>
              <span>
                {progress.completed}/{progress.total}
              </span>
            </div>
            <div
              className="workflow-progress-track"
              aria-label={`${progress.completed} of ${progress.total} agents complete`}
              aria-live="polite"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.completed}
            >
              <span
                style={{
                  width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
            <p className="workflow-help">
              Each card is a separate Pi session. Expand a card to inspect its
              handoff and output.
            </p>
          </section>
          <section
            className="workflow-run-steps"
            aria-label="Agent step statuses"
          >
            {template.steps.map((step, index) => {
              const stepRun = props.run.stepRuns.find(
                (candidate) => candidate.templateStepId === step.id,
              );
              return (
                <div className="workflow-flow-item" key={step.id}>
                  <WorkflowStepCard
                    step={step}
                    {...(stepRun ? { run: stepRun } : {})}
                    index={index}
                    expanded={expandedSteps[step.id] === true}
                    inputs={template.inputs}
                    previousSteps={template.steps.slice(0, index)}
                    onToggle={() =>
                      setExpandedSteps((current) => ({
                        ...current,
                        [step.id]: !current[step.id],
                      }))
                    }
                    {...(props.onOpenSession
                      ? { onOpenSession: props.onOpenSession }
                      : {})}
                  />
                  {stepRun?.status === "needsApproval" &&
                  props.onApproveGate ? (
                    <div
                      className="workflow-gate-actions"
                      role="group"
                      aria-label={`Approval actions for ${step.name}`}
                    >
                      <span>This agent is waiting for your decision.</span>
                      <button
                        type="button"
                        className="workflow-primary-button"
                        disabled={busyAction !== undefined}
                        onClick={() =>
                          void perform(`approve:${stepRun.id}`, () =>
                            props.onApproveGate!(stepRun, "approve"),
                          )
                        }
                      >
                        Approve next
                      </button>
                      <button
                        type="button"
                        className="workflow-secondary-button"
                        disabled={busyAction !== undefined}
                        onClick={() =>
                          void perform(`skip:${stepRun.id}`, () =>
                            props.onApproveGate!(stepRun, "skip"),
                          )
                        }
                      >
                        Skip step
                      </button>
                      <button
                        type="button"
                        className="workflow-danger-button"
                        disabled={busyAction !== undefined}
                        onClick={() =>
                          void perform(`stop:${stepRun.id}`, () =>
                            props.onApproveGate!(stepRun, "stop"),
                          )
                        }
                      >
                        Stop
                      </button>
                    </div>
                  ) : null}
                  {stepRun?.status === "failed" && props.onRetryStep ? (
                    <div className="workflow-gate-actions">
                      <span>Agent failed. Retry this session when ready.</span>
                      <button
                        type="button"
                        className="workflow-secondary-button"
                        disabled={busyAction !== undefined}
                        onClick={() =>
                          void perform(`retry:${stepRun.id}`, () =>
                            props.onRetryStep!(stepRun),
                          )
                        }
                      >
                        Retry agent
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
          {props.run.transitionRuns.length > 0 ? (
            <section className="workflow-card workflow-transition-history">
              <div className="workflow-section-heading">
                <div>
                  <span className="workflow-kicker">Handoffs</span>
                  <h3>Transition decisions</h3>
                </div>
              </div>
              <ul>
                {props.run.transitionRuns.map((transition) => (
                  <li key={transition.id}>
                    <strong>
                      {transition.status === "resolved"
                        ? "Resolved"
                        : transition.status}
                    </strong>
                    {transition.decision
                      ? ` · ${transition.decision.toUpperCase()}`
                      : ""}
                    {transition.rationale ? ` · ${transition.rationale}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </main>
        <aside className="workflow-run-sidebar">
          <section className="workflow-card">
            <div className="workflow-section-heading">
              <div>
                <span className="workflow-kicker">Run inputs</span>
                <h3>This run</h3>
              </div>
            </div>
            {template.inputs.length === 0 ? (
              <p className="workflow-empty-inline">No inputs were requested.</p>
            ) : (
              <dl className="workflow-run-input-list">
                {template.inputs.map((input) => (
                  <div key={input.id}>
                    <dt>{input.label}</dt>
                    <dd>{props.run.inputs[input.id] || "Not provided"}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          {template.context ? (
            <WorkflowContextCard
              context={template.context}
              onChange={() => undefined}
              readOnly
            />
          ) : null}
          <section className="workflow-card workflow-skills-note">
            <span className="workflow-kicker">Pi-native boundary</span>
            <h3>Skills stay with the agent</h3>
            <p>
              This run orchestrates sessions and handoffs. It does not turn Pi
              skills into workflow steps; each active agent can use its normal
              Pi capabilities.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
