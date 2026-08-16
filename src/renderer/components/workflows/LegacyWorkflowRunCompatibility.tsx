import { useState, type ReactElement } from "react";
import type {
  WorkflowRun,
  WorkflowStepRun,
  WorkflowTransitionRun,
} from "../../../shared/workflowSchemas.js";
import { workflowRunStatusLabel } from "../../workflows/workflowViewModels.js";

/**
 * Bounded control surface for runs persisted before occurrence-based workflows.
 * New workflows always use WorkflowOccurrenceRunView; this is intentionally not
 * the retired v1 workflow detail composition.
 */
export function LegacyWorkflowRunCompatibility(props: {
  run: WorkflowRun;
  onBack(): void;
  onStop(): Promise<void> | void;
  onRetryStep(step: WorkflowStepRun): Promise<void> | void;
  onRetryCondition(transition: WorkflowTransitionRun): Promise<void> | void;
  onOverrideCondition(
    transition: WorkflowTransitionRun,
    decision: "yes" | "no",
    rationale: string,
  ): Promise<void> | void;
  onApproveGate(
    step: WorkflowStepRun,
    action: "approve" | "skip" | "stop",
  ): Promise<void> | void;
  onOpenSession(step: WorkflowStepRun): void;
}): ReactElement {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const perform = async (id: string, action: () => Promise<void> | void) => {
    setBusy(id);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };
  const disabled = busy !== undefined;

  return (
    <section
      className="workflow-run-view legacy-workflow-run-compatibility"
      aria-label="Legacy workflow run"
    >
      <header className="workflow-page-heading">
        <div>
          <span className="workflow-kicker">Legacy run compatibility</span>
          <h2>{props.run.name}</h2>
          <p>{workflowRunStatusLabel(props.run.status)}</p>
          <p className="workflow-help">
            This saved run uses the pre-occurrence format. New runs use Agent
            Workflow runs.
          </p>
        </div>
        <div className="workflow-card-actions">
          <button
            type="button"
            className="workflow-secondary-button"
            onClick={props.onBack}
          >
            Back
          </button>
          {!["completed", "stopped"].includes(props.run.status) ? (
            <button
              type="button"
              className="workflow-danger-button"
              disabled={disabled}
              onClick={() => void perform("stop", props.onStop)}
            >
              Stop run
            </button>
          ) : null}
        </div>
      </header>
      {error ? (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      ) : null}
      <section
        className="legacy-workflow-run-items"
        aria-label="Saved run steps"
      >
        {props.run.stepRuns.map((step) => (
          <article key={step.id} className="workflow-card">
            <strong>{step.name}</strong>
            <p>{step.status}</p>
            {step.error ? <p className="workflow-error">{step.error}</p> : null}
            <div className="workflow-card-actions">
              {step.runtimeId || step.sessionFile ? (
                <button
                  type="button"
                  className="workflow-secondary-button"
                  onClick={() => props.onOpenSession(step)}
                >
                  Open Pi session
                </button>
              ) : null}
              {step.status === "failed" ? (
                <button
                  type="button"
                  className="workflow-secondary-button"
                  disabled={disabled}
                  onClick={() =>
                    void perform(`retry:${step.id}`, () =>
                      props.onRetryStep(step),
                    )
                  }
                >
                  Retry agent
                </button>
              ) : null}
              {step.status === "needsApproval" ? (
                <>
                  <button
                    type="button"
                    className="workflow-primary-button"
                    disabled={disabled}
                    onClick={() =>
                      void perform(`approve:${step.id}`, () =>
                        props.onApproveGate(step, "approve"),
                      )
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="workflow-secondary-button"
                    disabled={disabled}
                    onClick={() =>
                      void perform(`skip:${step.id}`, () =>
                        props.onApproveGate(step, "skip"),
                      )
                    }
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    className="workflow-danger-button"
                    disabled={disabled}
                    onClick={() =>
                      void perform(`gate-stop:${step.id}`, () =>
                        props.onApproveGate(step, "stop"),
                      )
                    }
                  >
                    Stop
                  </button>
                </>
              ) : null}
            </div>
          </article>
        ))}
      </section>
      {props.run.transitionRuns
        .filter((transition) => transition.status === "failed")
        .map((transition) => (
          <section
            key={transition.id}
            className="workflow-card legacy-workflow-condition"
            aria-label="Failed condition recovery"
          >
            <strong>Condition needs recovery</strong>
            {transition.error ? (
              <p className="workflow-error">{transition.error}</p>
            ) : null}
            <textarea
              aria-label="Condition override rationale"
              value={rationales[transition.id] ?? ""}
              onChange={(event) =>
                setRationales({
                  ...rationales,
                  [transition.id]: event.target.value,
                })
              }
            />
            <div className="workflow-card-actions">
              <button
                type="button"
                className="workflow-secondary-button"
                disabled={disabled}
                onClick={() =>
                  void perform(`condition-retry:${transition.id}`, () =>
                    props.onRetryCondition(transition),
                  )
                }
              >
                Retry condition judge
              </button>
              {(["yes", "no"] as const).map((decision) => (
                <button
                  key={decision}
                  type="button"
                  className="workflow-secondary-button"
                  disabled={
                    disabled || !(rationales[transition.id] ?? "").trim()
                  }
                  onClick={() =>
                    void perform(`condition-${decision}:${transition.id}`, () =>
                      props.onOverrideCondition(
                        transition,
                        decision,
                        rationales[transition.id]!.trim(),
                      ),
                    )
                  }
                >
                  Override {decision.toUpperCase()}
                </button>
              ))}
            </div>
          </section>
        ))}
    </section>
  );
}
