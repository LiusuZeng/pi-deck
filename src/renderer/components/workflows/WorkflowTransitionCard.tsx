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
              const fromIndex = steps.findIndex(
                (step) => step.id === props.fromStepId,
              );
              const nextStep =
                fromIndex >= 0 ? steps[fromIndex + 1] : undefined;
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
                // The selected branch runs automatically unless the author
                // explicitly enables a preview/approval pause below.
                previewBeforeStart: false,
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
          <label className="workflow-checkbox">
            <input
              id={`workflow-${transition.id}-preview`}
              type="checkbox"
              checked={transition.previewBeforeStart}
              aria-describedby={`workflow-${transition.id}-preview-help`}
              onChange={(event) =>
                props.onChange({
                  ...transition,
                  previewBeforeStart: event.target.checked,
                })
              }
            />
            <span>Preview selected branch before starting</span>
          </label>
          <p
            id={`workflow-${transition.id}-preview-help`}
            className="workflow-help"
          >
            When enabled, the selected branch waits for approval. Leave this off
            to start the selected branch automatically.
          </p>
          <div className="workflow-branch-grid">
            {(["yes", "no", "unsure"] as const).map((decision) => {
              const currentTarget = transition.routes[decision];
              const currentStepId =
                currentTarget?.kind === "step"
                  ? currentTarget.stepId
                  : currentTarget?.kind === "manualGate"
                    ? currentTarget.toStepId
                    : undefined;
              const targetsUsedByOtherRoutes = new Set(
                (["yes", "no", "unsure"] as const)
                  .filter((otherDecision) => otherDecision !== decision)
                  .flatMap((otherDecision) => {
                    const target = transition.routes[otherDecision];
                    return target?.kind === "step"
                      ? [target.stepId]
                      : target?.kind === "manualGate"
                        ? [target.toStepId]
                        : [];
                  }),
              );
              return (
                <label className="workflow-field" key={decision}>
                  <span>If {decision.toUpperCase()}</span>
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
                              : decision === "unsure"
                                ? { kind: "manualGate", toStepId: value }
                                : { kind: "step", stepId: value },
                        },
                      });
                    }}
                  >
                    <option value="stop">
                      {decision === "unsure"
                        ? "Stop workflow (default)"
                        : "Stop workflow"}
                    </option>
                    {steps
                      .filter(
                        (step) =>
                          step.id !== props.fromStepId &&
                          (step.id === currentStepId ||
                            !targetsUsedByOtherRoutes.has(step.id)),
                      )
                      .map((step) => (
                        <option key={step.id} value={step.id}>
                          {decision === "unsure"
                            ? `Request approval at ${step.name}`
                            : step.name}
                        </option>
                      ))}
                  </select>
                </label>
              );
            })}
          </div>
          <p className="workflow-help">
            UNSURE stops by default. Choosing a step creates a dedicated
            approval branch, so YES remains automatic even when it shares that
            step as its target.
          </p>
        </>
      ) : null}
    </section>
  );
}
