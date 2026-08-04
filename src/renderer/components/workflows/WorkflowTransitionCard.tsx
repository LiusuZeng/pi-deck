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
              // Conditions cannot fan multiple routes into one step. Keep the
              // initial condition saveable: YES continues to the next step,
              // while NO and UNSURE stop until the author chooses distinct
              // targets explicitly.
              const nextStep = steps.find(
                (step) => step.id !== props.fromStepId,
              );
              props.onChange({
                id: transition.id,
                fromStepId: props.fromStepId,
                kind,
                question:
                  "Did this agent produce a result ready for the next step?",
                routes: {
                  yes: nextStep
                    ? { kind: "step", stepId: nextStep.id }
                    : undefined,
                  no: { kind: "stop" },
                  unsure: { kind: "stop" },
                },
                previewBeforeStart: true,
              });
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
            {(["yes", "no", "unsure"] as const).map((decision) => {
              const currentTarget = transition.routes[decision];
              const currentStepId =
                currentTarget?.kind === "step"
                  ? currentTarget.stepId
                  : undefined;
              const targetsUsedByOtherRoutes = new Set(
                (["yes", "no", "unsure"] as const)
                  .filter((otherDecision) => otherDecision !== decision)
                  .flatMap((otherDecision) => {
                    const target = transition.routes[otherDecision];
                    return target?.kind === "step" ? [target.stepId] : [];
                  }),
              );
              return (
                <label className="workflow-field" key={decision}>
                  <span>
                    If {decision.toUpperCase()}
                    {decision === "unsure" ? " (manual approval)" : ""}
                  </span>
                  <select
                    value={currentStepId ?? "stop"}
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
                      .filter(
                        (step) =>
                          step.id !== props.fromStepId &&
                          (step.id === currentStepId ||
                            !targetsUsedByOtherRoutes.has(step.id)),
                      )
                      .map((step) => (
                        <option key={step.id} value={step.id}>
                          {step.name}
                        </option>
                      ))}
                  </select>
                </label>
              );
            })}
          </div>
          <p className="workflow-help">
            UNSURE stops by default. To request manual approval instead, choose
            a dedicated step that is different from the YES/NO targets; it will
            be configured as “Ask before starting” so the backend can pause for
            an explicit approval.
          </p>
        </>
      ) : null}
    </section>
  );
}
