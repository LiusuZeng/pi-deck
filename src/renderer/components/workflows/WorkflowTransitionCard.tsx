import type { ReactElement } from "react";
import type {
  WorkflowStepDefinition,
  WorkflowTransition,
} from "../../../shared/workflowSchemas.js";

export function WorkflowTransitionCard(props: {
  transition: WorkflowTransition;
  steps: WorkflowStepDefinition[];
  fromStepId: string;
  onChange(transition: WorkflowTransition): void;
  onStepChange?(stepId: string, patch: Partial<WorkflowStepDefinition>): void;
  error?: string | undefined;
}): ReactElement {
  const { transition, steps } = props;
  return (
    <section className="workflow-transition-card">
      <label className="workflow-field">
        <span>After this step</span>
        <select
          value={transition.kind}
          onChange={(event) => {
            const kind = event.target.value as WorkflowTransition["kind"];
            if (kind === "always") {
              props.onChange({
                id: transition.id,
                fromStepId: props.fromStepId,
                kind,
                toStepId:
                  steps.find((step) => step.id !== props.fromStepId)?.id ??
                  props.fromStepId,
              });
            } else if (kind === "manualGate") {
              props.onChange({
                id: transition.id,
                fromStepId: props.fromStepId,
                kind,
                toStepId:
                  steps.find((step) => step.id !== props.fromStepId)?.id ??
                  props.fromStepId,
              });
            } else {
              const approvalStep = steps.find(
                (step) => step.id !== props.fromStepId,
              );
              props.onChange({
                id: transition.id,
                fromStepId: props.fromStepId,
                kind,
                question:
                  "Did this agent produce a result ready for the next step?",
                routes: {
                  yes: approvalStep
                    ? { kind: "step", stepId: approvalStep.id }
                    : undefined,
                  no: { kind: "stop" },
                  // UNSURE resolves through a real step-level manual approval;
                  // condition manual gates are rejected by the backend.
                  unsure: approvalStep
                    ? { kind: "step", stepId: approvalStep.id }
                    : { kind: "stop" },
                },
                previewBeforeStart: true,
              });
              if (approvalStep) {
                props.onStepChange?.(approvalStep.id, {
                  startPolicy: "manualApproval",
                });
              }
            }
          }}
        >
          <option value="always">Always continue</option>
          <option value="condition">Ask a condition</option>
          <option value="manualGate">Ask me before continuing</option>
        </select>
      </label>
      {transition.kind === "always" ? (
        <label className="workflow-field">
          <span>Run next</span>
          <select
            value={transition.toStepId}
            onChange={(event) =>
              props.onChange({ ...transition, toStepId: event.target.value })
            }
          >
            {steps
              .filter((step) => step.id !== props.fromStepId)
              .map((step) => (
                <option key={step.id} value={step.id}>
                  {step.name}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      {transition.kind === "manualGate" ? (
        <label className="workflow-field">
          <span>Continue to</span>
          <select
            value={transition.toStepId}
            onChange={(event) =>
              props.onChange({ ...transition, toStepId: event.target.value })
            }
          >
            {steps
              .filter((step) => step.id !== props.fromStepId)
              .map((step) => (
                <option key={step.id} value={step.id}>
                  {step.name}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      {props.error ? (
        <p className="workflow-field-error" role="alert" aria-live="assertive">
          {props.error}
        </p>
      ) : null}
      {transition.kind === "condition" ? (
        <>
          <label className="workflow-field">
            <span>Condition question</span>
            <textarea
              rows={3}
              value={transition.question}
              onChange={(event) =>
                props.onChange({ ...transition, question: event.target.value })
              }
            />
          </label>
          <div className="workflow-branch-grid">
            {(["yes", "no", "unsure"] as const).map((decision) => (
              <label className="workflow-field" key={decision}>
                <span>
                  If {decision.toUpperCase()}
                  {decision === "unsure" ? " (manual approval)" : ""}
                </span>
                <select
                  value={
                    transition.routes[decision]?.kind === "step"
                      ? transition.routes[decision].stepId
                      : (transition.routes[decision]?.kind ?? "stop")
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    props.onChange({
                      ...transition,
                      routes: {
                        ...transition.routes,
                        [decision]:
                          value === "stop"
                            ? { kind: "stop" }
                            : { kind: "step", stepId: value },
                      },
                    });
                    if (decision === "unsure" && value !== "stop") {
                      props.onStepChange?.(value, {
                        startPolicy: "manualApproval",
                      });
                    }
                  }}
                >
                  <option value="stop">Stop workflow</option>
                  {steps
                    .filter((step) => step.id !== props.fromStepId)
                    .map((step) => (
                      <option key={step.id} value={step.id}>
                        {step.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          <p className="workflow-help">
            UNSURE routes to a step configured “Ask before starting” so the
            backend can pause for an explicit approval.
          </p>
        </>
      ) : null}
    </section>
  );
}
