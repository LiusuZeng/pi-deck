import { useMemo, useState, type ReactElement } from "react";
import type {
  WorkflowContext,
  WorkflowInputDefinition,
  WorkflowStepDefinition,
  WorkflowTemplate,
  WorkflowTemplateDefinition,
  WorkflowTransition,
} from "../../../shared/workflowSchemas.js";
import { workflowTemplateDefinitionSchema } from "../../../shared/workflowSchemas.js";
import { WorkflowContextCard } from "./WorkflowContextCard.js";
import { WorkflowStepCard } from "./WorkflowStepCard.js";
import { WorkflowTransitionCard } from "./WorkflowTransitionCard.js";

const defaultPolicy = {
  includeWorkflowContext: true,
  includeParentFinalAnswer: false,
  includeParentSummary: false,
  includeParentTranscript: false,
};

function newStep(index: number): WorkflowStepDefinition {
  return {
    id: `step-${Date.now()}-${index}`,
    name: `Agent step ${index + 1}`,
    kind: "agent",
    promptParts: [{ type: "text", text: "" }],
    inputPolicy: { ...defaultPolicy },
    startPolicy: "auto",
  };
}

function newInput(index: number): WorkflowInputDefinition {
  return {
    id: `input-${Date.now()}-${index}`,
    label: `Input ${index + 1}`,
    type: "text",
    required: true,
  };
}

function materializeTransitions(
  steps: WorkflowStepDefinition[],
  transitions: WorkflowTransition[],
): WorkflowTransition[] {
  const materialized = [...transitions];
  for (let index = 0; index < steps.length - 1; index += 1) {
    const fromStep = steps[index]!;
    const toStep = steps[index + 1]!;
    if (
      materialized.some((transition) => transition.fromStepId === fromStep.id)
    ) {
      continue;
    }
    materialized.push({
      id: `transition-${fromStep.id}-${toStep.id}`,
      fromStepId: fromStep.id,
      kind: "always",
      toStepId: toStep.id,
    });
  }
  return materialized;
}

function definitionForTemplate(
  template: WorkflowTemplate,
  workspaceId?: string,
): WorkflowTemplateDefinition {
  const steps = template.steps
    .map((step) => ({
      ...step,
      promptParts: step.promptParts.filter(
        (part) => part.type !== "stepOutput" || part.output !== "transcript",
      ),
      inputPolicy: {
        ...step.inputPolicy,
        // Parent-session wiring is not available yet. Do not preserve settings
        // that would render an unavailable placeholder into a new run.
        includeParentFinalAnswer: false,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
    }))
    .map((step) => ({
      ...step,
      promptParts:
        step.promptParts.length > 0
          ? step.promptParts
          : [{ type: "text" as const, text: "" }],
    }));
  return {
    name: template.name,
    ...(template.description !== undefined
      ? { description: template.description }
      : {}),
    ...(workspaceId !== undefined
      ? { workspaceId }
      : template.workspaceId !== undefined
        ? { workspaceId: template.workspaceId }
        : {}),
    ...(template.context !== undefined ? { context: template.context } : {}),
    ...(template.defaultModel !== undefined
      ? { defaultModel: template.defaultModel }
      : {}),
    ...(template.defaultThinkingLevel !== undefined
      ? { defaultThinkingLevel: template.defaultThinkingLevel }
      : {}),
    inputs: template.inputs,
    steps,
    transitions: materializeTransitions(steps, template.transitions),
  };
}

function initialDefinition(
  template?: WorkflowTemplate,
  workspaceId?: string,
): WorkflowTemplateDefinition {
  if (template) {
    return definitionForTemplate(template, workspaceId);
  }
  return {
    name: "New agent workflow",
    inputs: [],
    context: { relevantPaths: [] },
    steps: [newStep(0)],
    transitions: [],
    ...(workspaceId !== undefined ? { workspaceId } : {}),
  };
}

export function WorkflowBuilder(props: {
  initialTemplate?: WorkflowTemplate;
  workspaceId?: string;
  workspaceName?: string;
  onSave(
    definition: WorkflowTemplateDefinition,
    templateId?: string,
  ): Promise<void> | void;
  onCancel(): void;
}): ReactElement {
  const [definition, setDefinition] = useState<WorkflowTemplateDefinition>(() =>
    initialDefinition(props.initialTemplate, props.workspaceId),
  );
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({
    [definition.steps[0]!.id]: true,
  });
  const [error, setError] = useState<string | undefined>();
  const [focusPromptStepId, setFocusPromptStepId] = useState<
    string | undefined
  >();
  const [saving, setSaving] = useState(false);

  const updateInput = (
    inputId: string,
    patch: Partial<WorkflowInputDefinition>,
  ) => {
    setDefinition((current) => ({
      ...current,
      inputs: current.inputs.map((input) =>
        input.id === inputId ? { ...input, ...patch } : input,
      ),
    }));
  };

  const removeInput = (inputId: string) => {
    setDefinition((current) => ({
      ...current,
      inputs: current.inputs.filter((input) => input.id !== inputId),
      steps: current.steps.map((step) => {
        const promptParts = step.promptParts.filter(
          (part) => part.type !== "workflowInput" || part.inputId !== inputId,
        );
        return {
          ...step,
          promptParts:
            promptParts.length > 0 ? promptParts : [{ type: "text", text: "" }],
        };
      }),
    }));
  };

  const updateStep = (
    stepId: string,
    patch: Partial<WorkflowStepDefinition>,
  ) => {
    setDefinition((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === stepId ? { ...step, ...patch } : step,
      ),
    }));
  };

  const updateContext = (context: WorkflowContext) =>
    setDefinition((current) => ({ ...current, context }));

  const addStep = () => {
    setDefinition((current) => {
      const step = newStep(current.steps.length);
      const previous = current.steps.at(-1);
      const hasPreviousTransition = current.transitions.some(
        (transition) => transition.fromStepId === previous?.id,
      );
      const transitions =
        previous && !hasPreviousTransition
          ? [
              ...current.transitions,
              {
                id: `transition-${Date.now()}`,
                fromStepId: previous.id,
                kind: "always" as const,
                toStepId: step.id,
              },
            ]
          : current.transitions;
      setExpandedSteps((expanded) => ({ ...expanded, [step.id]: true }));
      return { ...current, steps: [...current.steps, step], transitions };
    });
  };

  const addInput = () => {
    setDefinition((current) => ({
      ...current,
      inputs: [...current.inputs, newInput(current.inputs.length)],
    }));
  };

  const updateTransition = (transition: WorkflowTransition) => {
    setDefinition((current) => ({
      ...current,
      transitions: [
        ...current.transitions.filter(
          (item) => item.fromStepId !== transition.fromStepId,
        ),
        transition,
      ],
    }));
  };

  const transitionForStep = (stepId: string) =>
    definition.transitions.find(
      (transition) => transition.fromStepId === stepId,
    );
  const missingTransitionErrors = useMemo(
    () =>
      Object.fromEntries(
        definition.steps
          .slice(0, -1)
          .flatMap((step) =>
            transitionForStep(step.id) === undefined
              ? [[step.id, "Choose a persisted transition before saving."]]
              : [],
          ),
      ) as Record<string, string>,
    [definition.steps, definition.transitions],
  );
  const promptErrors = useMemo(
    () =>
      Object.fromEntries(
        definition.steps.flatMap((step) => {
          const hasPrompt = step.promptParts.some(
            (part) => part.type !== "text" || part.text.trim().length > 0,
          );
          return hasPrompt
            ? []
            : [[step.id, "Add instructions for this agent."]];
        }),
      ) as Record<string, string>,
    [definition.steps],
  );
  const stepErrors = useMemo(() => {
    const result = workflowTemplateDefinitionSchema.safeParse(definition);
    const errors: Record<string, string> = {};
    if (!result.success) {
      for (const issue of result.error.issues) {
        const stepIndex =
          issue.path[0] === "steps" && typeof issue.path[1] === "number"
            ? issue.path[1]
            : undefined;
        const step =
          stepIndex === undefined ? undefined : definition.steps[stepIndex];
        if (step !== undefined && errors[step.id] === undefined) {
          errors[step.id] = issue.message;
        }
      }
    }
    return errors;
  }, [definition]);
  const transitionErrors = useMemo(() => {
    const result = workflowTemplateDefinitionSchema.safeParse(definition);
    const errors: Record<string, string> = { ...missingTransitionErrors };
    if (!result.success) {
      for (const issue of result.error.issues) {
        const transitionIndex =
          issue.path[0] === "transitions" && typeof issue.path[1] === "number"
            ? issue.path[1]
            : undefined;
        if (transitionIndex === undefined) continue;
        const transition = definition.transitions[transitionIndex];
        if (
          transition !== undefined &&
          errors[transition.fromStepId] === undefined
        ) {
          errors[transition.fromStepId] = issue.message;
        }
      }
    }
    return errors;
  }, [definition, missingTransitionErrors]);
  const validation = useMemo(() => {
    const result = workflowTemplateDefinitionSchema.safeParse(definition);
    const schemaErrors = result.success
      ? []
      : result.error.issues.map((issue) => issue.message);
    return [
      ...Object.values(promptErrors),
      ...Object.values(missingTransitionErrors),
      ...schemaErrors,
    ];
  }, [definition, missingTransitionErrors, promptErrors]);

  const save = async () => {
    const firstBlankStep = definition.steps.find(
      (step) => promptErrors[step.id] !== undefined,
    );
    if (firstBlankStep !== undefined) {
      setExpandedSteps((current) => ({
        ...current,
        [firstBlankStep.id]: true,
      }));
      setFocusPromptStepId(firstBlankStep.id);
    }
    if (validation.length > 0) {
      setError(validation[0]);
      return;
    }
    setSaving(true);
    try {
      await props.onSave(
        workflowTemplateDefinitionSchema.parse(definition),
        props.initialTemplate?.id,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="workflow-builder">
      <div className="workflow-page-heading">
        <div>
          <button
            type="button"
            className="workflow-back-button"
            onClick={props.onCancel}
          >
            ← Agent Workflows
          </button>
          <h2>
            {props.initialTemplate
              ? "Edit agent workflow"
              : "New agent workflow"}
          </h2>
          <p>
            Define the orchestration plan now. Pi Deck starts each selected
            agent session only when its dependencies are ready.
          </p>
          {props.workspaceId ? (
            <p className="workflow-workspace-context">
              Workspace:{" "}
              <strong>{props.workspaceName ?? props.workspaceId}</strong>
            </p>
          ) : null}
        </div>
        <div className="workflow-heading-actions">
          <button
            type="button"
            className="workflow-secondary-button"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="workflow-primary-button"
            disabled={saving}
            aria-disabled={validation.length > 0 || undefined}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save workflow"}
          </button>
        </div>
      </div>

      <section className="workflow-card workflow-meta-card">
        <div className="workflow-field-grid">
          <label className="workflow-field">
            <span>Workflow name</span>
            <input
              value={definition.name}
              onChange={(event) =>
                setDefinition((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          </label>
          <label className="workflow-field">
            <span>Description</span>
            <input
              value={definition.description ?? ""}
              placeholder="What does this workflow coordinate?"
              onChange={(event) =>
                setDefinition((current) => ({
                  ...current,
                  description: event.target.value || undefined,
                }))
              }
            />
          </label>
        </div>
      </section>

      <WorkflowContextCard
        context={definition.context ?? { relevantPaths: [] }}
        onChange={updateContext}
      />

      <section className="workflow-card workflow-inputs-card">
        <div className="workflow-section-heading">
          <div>
            <span className="workflow-kicker">Reusable inputs</span>
            <h3>Ask for run-specific information</h3>
          </div>
          <button
            type="button"
            className="workflow-secondary-button"
            onClick={addInput}
          >
            + Add input
          </button>
        </div>
        <p className="workflow-help">
          Inputs are collected when a workflow starts and included in steps that
          opt into shared context.
        </p>
        {definition.inputs.length === 0 ? (
          <p className="workflow-empty-inline">
            No inputs. This workflow can run without a setup form.
          </p>
        ) : null}
        <div className="workflow-input-list">
          {definition.inputs.map((input, index) => (
            <div className="workflow-input-row" key={input.id}>
              <label className="workflow-field">
                <span>Input {index + 1} label</span>
                <input
                  aria-label={`Input ${index + 1} label`}
                  value={input.label}
                  onChange={(event) =>
                    updateInput(input.id, { label: event.target.value })
                  }
                />
              </label>
              <label className="workflow-field">
                <span>Type</span>
                <select
                  aria-label={`Input ${index + 1} type`}
                  value={input.type}
                  onChange={(event) =>
                    updateInput(input.id, {
                      type: event.target
                        .value as WorkflowInputDefinition["type"],
                    })
                  }
                >
                  <option value="text">Text</option>
                  <option value="path">Path reference</option>
                </select>
              </label>
              <label className="workflow-checkbox">
                <input
                  type="checkbox"
                  checked={input.required}
                  onChange={(event) =>
                    updateInput(input.id, {
                      required: event.target.checked,
                      ...(event.target.checked
                        ? { defaultValue: undefined }
                        : {}),
                    })
                  }
                />{" "}
                Required
              </label>
              <button
                type="button"
                className="workflow-icon-text-button"
                onClick={() => removeInput(input.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>

      <div className="workflow-flow-heading">
        <div>
          <span className="workflow-kicker">Agent steps</span>
          <h3>What should Pi agents do?</h3>
        </div>
        <button
          type="button"
          className="workflow-secondary-button"
          onClick={addStep}
        >
          + Add agent step
        </button>
      </div>
      <div className="workflow-flow-list">
        {definition.steps.map((step, index) => (
          <div key={step.id} className="workflow-flow-item">
            <WorkflowStepCard
              step={step}
              index={index}
              expanded={expandedSteps[step.id] === true}
              onToggle={() =>
                setExpandedSteps((current) => ({
                  ...current,
                  [step.id]: !current[step.id],
                }))
              }
              onChange={(patch) => updateStep(step.id, patch)}
              inputs={definition.inputs}
              previousSteps={definition.steps.slice(0, index)}
              promptError={promptErrors[step.id]}
              stepError={stepErrors[step.id]}
              focusPrompt={focusPromptStepId === step.id}
            />
            {index < definition.steps.length - 1 ? (
              <div className="workflow-transition-wrap">
                {transitionForStep(step.id) ? (
                  <WorkflowTransitionCard
                    transition={transitionForStep(step.id)!}
                    steps={definition.steps}
                    fromStepId={step.id}
                    onChange={updateTransition}
                    error={transitionErrors[step.id]}
                  />
                ) : (
                  <p
                    className="workflow-error workflow-transition-missing"
                    role="alert"
                  >
                    {missingTransitionErrors[step.id]}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {error || validation.length > 0 ? (
        <p
          className="workflow-error workflow-builder-error"
          role="alert"
          aria-live="assertive"
        >
          {error ?? validation[0]}
        </p>
      ) : null}
    </div>
  );
}
