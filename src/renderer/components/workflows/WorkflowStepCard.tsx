import { useEffect, useRef, type ReactElement } from "react";
import type {
  WorkflowContext,
  WorkflowInputDefinition,
  WorkflowModelOverride,
  WorkflowStepDefinition,
  WorkflowStepRun,
} from "../../../shared/workflowSchemas.js";
import {
  workflowStepStatusLabel,
  workflowStepStatusTone,
} from "../../workflows/workflowViewModels.js";
import {
  workflowPromptPartLabel,
  WorkflowPromptEditor,
} from "./WorkflowPromptEditor.js";

export interface WorkflowModelChoice {
  provider?: string;
  id: string;
  label: string;
  disabled?: boolean;
  note?: string;
  thinkingChoices?: WorkflowThinkingChoice[];
}

export interface WorkflowThinkingChoice {
  id: string;
  label: string;
  disabled?: boolean;
  note?: string;
}

const defaultThinkingChoices: WorkflowThinkingChoice[] = [
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Xhigh" },
  { id: "max", label: "Max" },
];

function modelChoiceValue(
  model:
    | Pick<WorkflowModelOverride, "provider" | "modelId">
    | WorkflowModelChoice,
): string {
  if ("id" in model) return `${model.provider ?? ""}\u0000${model.id}`;
  return `${model.provider ?? ""}\u0000${model.modelId ?? ""}`;
}

function modelChoiceLabel(
  model:
    | Pick<WorkflowModelOverride, "provider" | "modelId">
    | WorkflowModelChoice,
): string {
  if ("id" in model) return model.label;
  return [model.provider, model.modelId].filter(Boolean).join("/") || "Model";
}

export function WorkflowStepCard(props: {
  step: WorkflowStepDefinition;
  run?: WorkflowStepRun;
  index: number;
  expanded: boolean;
  onToggle(): void;
  onChange?(patch: Partial<WorkflowStepDefinition>): void;
  onOpenSession?(step: WorkflowStepRun): void;
  inputs?: WorkflowInputDefinition[];
  previousSteps?: WorkflowStepDefinition[];
  context?: WorkflowContext;
  defaultModel?: WorkflowModelOverride;
  defaultThinkingLevel?: string;
  modelChoices?: WorkflowModelChoice[];
  thinkingChoices?: WorkflowThinkingChoice[];
  promptError?: string | undefined;
  stepError?: string | undefined;
  focusPrompt?: boolean | undefined;
}): ReactElement {
  const status = props.run?.status;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.focusPrompt) promptRef.current?.focus();
  }, [props.focusPrompt]);
  const tone = status ? workflowStepStatusTone(status) : "neutral";
  const modelChoices = props.modelChoices ?? [];
  const effectiveModel = props.step.modelOverride ?? props.defaultModel;
  const effectiveModelChoice =
    effectiveModel === undefined
      ? undefined
      : modelChoices.find(
          (choice) =>
            modelChoiceValue(choice) === modelChoiceValue(effectiveModel),
        );
  const effectiveThinkingChoices =
    effectiveModelChoice?.thinkingChoices ??
    props.thinkingChoices ??
    defaultThinkingChoices;
  return (
    <article
      className={`workflow-card workflow-step-card workflow-tone-${tone}`}
    >
      <button
        type="button"
        className="workflow-card-heading"
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <span className="workflow-step-index">{props.index + 1}</span>
        <span className="workflow-card-heading-copy">
          <strong>{props.step.name}</strong>
          <span className="workflow-card-subtitle">
            {status ? workflowStepStatusLabel(status) : "Agent step"}
            {props.run?.sessionFile ? " · Pi session attached" : ""}
          </span>
        </span>
        <span className="workflow-card-chevron" aria-hidden="true">
          {props.expanded ? "−" : "+"}
        </span>
      </button>
      {props.expanded ? (
        <div className="workflow-card-body">
          {props.onChange ? (
            <>
              <label className="workflow-field">
                <span>Step name</span>
                <input
                  aria-invalid={props.stepError ? true : undefined}
                  value={props.step.name}
                  onChange={(event) =>
                    props.onChange?.({ name: event.target.value })
                  }
                />
              </label>
              {props.stepError ? (
                <p
                  className="workflow-field-error"
                  role="alert"
                  aria-live="assertive"
                >
                  {props.stepError}
                </p>
              ) : null}
              <WorkflowPromptEditor
                parts={props.step.promptParts}
                inputs={props.inputs ?? []}
                previousSteps={props.previousSteps ?? []}
                onChange={(promptParts) => props.onChange?.({ promptParts })}
                inputRef={promptRef}
                showOptionalReferenceWarning
                invalid={props.promptError !== undefined}
                errorId={
                  props.promptError
                    ? `workflow-${props.step.id}-prompt-error`
                    : undefined
                }
              />
              {props.promptError ? (
                <p
                  id={`workflow-${props.step.id}-prompt-error`}
                  className="workflow-field-error"
                  role="alert"
                >
                  {props.promptError}
                </p>
              ) : null}
              <div className="workflow-inline-fields">
                <label className="workflow-field">
                  <span>Start behavior</span>
                  <select
                    aria-label="Start behavior"
                    value={props.step.startPolicy}
                    onChange={(event) =>
                      props.onChange?.({
                        startPolicy: event.target
                          .value as WorkflowStepDefinition["startPolicy"],
                      })
                    }
                  >
                    <option value="auto">Start automatically</option>
                    <option value="manualApproval">Ask before starting</option>
                  </select>
                </label>
                <label className="workflow-field">
                  <span>Thinking level</span>
                  <select
                    aria-label="Thinking level"
                    value={props.step.thinkingOverride ?? ""}
                    onChange={(event) =>
                      props.onChange?.({
                        thinkingOverride: event.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Inherit from Pi Deck</option>
                    {effectiveThinkingChoices
                      .filter(
                        (choice, index, choices) =>
                          choices.findIndex(
                            (candidate) => candidate.id === choice.id,
                          ) === index,
                      )
                      .concat(
                        props.step.thinkingOverride !== undefined &&
                          !effectiveThinkingChoices.some(
                            (choice) =>
                              choice.id === props.step.thinkingOverride,
                          )
                          ? [
                              {
                                id: props.step.thinkingOverride,
                                label: props.step.thinkingOverride,
                              },
                            ]
                          : [],
                      )
                      .map((choice) => (
                        <option
                          key={choice.id}
                          value={choice.id}
                          disabled={choice.disabled}
                        >
                          {choice.label}
                          {choice.note ? ` — ${choice.note}` : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="workflow-field">
                  <span>Model override</span>
                  <select
                    aria-label="Model override"
                    value={
                      props.step.modelOverride === undefined
                        ? ""
                        : modelChoiceValue(props.step.modelOverride)
                    }
                    onChange={(event) => {
                      const selected = modelChoices.find(
                        (choice) =>
                          modelChoiceValue(choice) === event.target.value,
                      );
                      const inheritedChoice =
                        props.defaultModel === undefined
                          ? undefined
                          : modelChoices.find(
                              (choice) =>
                                modelChoiceValue(choice) ===
                                modelChoiceValue(props.defaultModel!),
                            );
                      const nextThinkingChoices =
                        (selected ?? inheritedChoice)?.thinkingChoices ??
                        props.thinkingChoices ??
                        defaultThinkingChoices;
                      const thinkingOverride = props.step.thinkingOverride;
                      const thinkingIsUnsupported =
                        thinkingOverride !== undefined &&
                        !nextThinkingChoices.some(
                          (choice) =>
                            choice.id === thinkingOverride && !choice.disabled,
                        );
                      props.onChange?.({
                        modelOverride:
                          selected === undefined
                            ? undefined
                            : {
                                ...(selected.provider
                                  ? { provider: selected.provider }
                                  : {}),
                                modelId: selected.id,
                              },
                        ...(thinkingIsUnsupported
                          ? { thinkingOverride: undefined }
                          : {}),
                      });
                    }}
                  >
                    <option value="">Inherit from Pi Deck</option>
                    {modelChoices
                      .filter(
                        (choice, index, choices) =>
                          choices.findIndex(
                            (candidate) =>
                              modelChoiceValue(candidate) ===
                              modelChoiceValue(choice),
                          ) === index,
                      )
                      .concat(
                        props.step.modelOverride !== undefined &&
                          !modelChoices.some(
                            (choice) =>
                              modelChoiceValue(choice) ===
                              modelChoiceValue(props.step.modelOverride!),
                          )
                          ? [
                              {
                                provider:
                                  props.step.modelOverride.provider ?? "",
                                id: props.step.modelOverride.modelId ?? "",
                                label: modelChoiceLabel(
                                  props.step.modelOverride,
                                ),
                              },
                            ]
                          : [],
                      )
                      .map((choice) => (
                        <option
                          key={modelChoiceValue(choice)}
                          value={modelChoiceValue(choice)}
                          disabled={choice.disabled}
                        >
                          {modelChoiceLabel(choice)}
                          {choice.note ? ` — ${choice.note}` : ""}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            </>
          ) : (
            <>
              <div className="workflow-prompt-preview">
                <span className="workflow-field-label">
                  {props.run?.renderedPrompt !== undefined
                    ? "Rendered prompt"
                    : "Instructions"}
                </span>
                {props.run?.renderedPrompt !== undefined ? (
                  <pre>{props.run.renderedPrompt || "No rendered prompt."}</pre>
                ) : (
                  props.step.promptParts.map((part, partIndex) =>
                    part.type === "text" ? (
                      <p key={`text-${partIndex}`}>
                        {part.text || "No written instructions."}
                      </p>
                    ) : (
                      <span
                        className="workflow-reference-chip"
                        key={`${part.type}-${partIndex}`}
                      >
                        <span className="workflow-reference-kind">
                          {part.type === "workflowInput"
                            ? "Run input"
                            : "Previous result"}
                        </span>
                        <strong>
                          {workflowPromptPartLabel(
                            part,
                            props.inputs ?? [],
                            props.previousSteps ?? [],
                          )}
                        </strong>
                      </span>
                    ),
                  )
                )}
              </div>
              {props.context !== undefined &&
              props.step.inputPolicy.includeWorkflowContext ? (
                <div className="workflow-run-context-preview">
                  <span className="workflow-field-label">Shared context</span>
                  {(props.context.prompt ?? props.context.objective) ? (
                    <p>
                      <strong>Shared instructions:</strong>{" "}
                      {props.context.prompt ?? props.context.objective}
                    </p>
                  ) : null}
                  {props.context.doNotDo ? (
                    <p>
                      <strong>Don't do:</strong> {props.context.doNotDo}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {(() => {
                const model = props.step.modelOverride ?? props.defaultModel;
                const modelLabel = model
                  ? [model.provider, model.modelId].filter(Boolean).join("/")
                  : undefined;
                const thinking =
                  props.step.thinkingOverride ?? props.defaultThinkingLevel;
                return modelLabel !== undefined || thinking !== undefined ? (
                  <dl className="workflow-run-metadata">
                    {modelLabel !== undefined ? (
                      <div>
                        <dt>Model</dt>
                        <dd>{modelLabel}</dd>
                      </div>
                    ) : null}
                    {thinking !== undefined ? (
                      <div>
                        <dt>Thinking</dt>
                        <dd>{thinking}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null;
              })()}
              {props.run?.finalAnswer !== undefined ? (
                <div className="workflow-output-preview">
                  <span>Final output</span>
                  <p>{props.run.finalAnswer || "No final output."}</p>
                </div>
              ) : null}
              {props.run?.summary !== undefined ? (
                <div className="workflow-output-preview">
                  <span>Summary</span>
                  <p>{props.run.summary || "No summary."}</p>
                </div>
              ) : null}
              {props.run?.transcript !== undefined ? (
                <div className="workflow-output-preview">
                  <span>Transcript</span>
                  <p>{props.run.transcript || "No transcript."}</p>
                </div>
              ) : null}
              {props.run?.error ? (
                <p className="workflow-error">{props.run.error}</p>
              ) : null}
              {(props.run?.runtimeId || props.run?.sessionFile) &&
              props.onOpenSession ? (
                <button
                  type="button"
                  className="workflow-secondary-button"
                  onClick={() => props.onOpenSession?.(props.run!)}
                >
                  Open Pi session
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}
