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
                  <input
                    placeholder="Inherit from Pi Deck"
                    value={props.step.thinkingOverride ?? ""}
                    onChange={(event) =>
                      props.onChange?.({
                        thinkingOverride: event.target.value || undefined,
                      })
                    }
                  />
                </label>
                <label className="workflow-field">
                  <span>Model override</span>
                  <input
                    placeholder="Optional model id"
                    value={props.step.modelOverride?.modelId ?? ""}
                    onChange={(event) =>
                      props.onChange?.({
                        modelOverride: event.target.value
                          ? { modelId: event.target.value }
                          : undefined,
                      })
                    }
                  />
                </label>
              </div>
              <fieldset className="workflow-policy-fieldset">
                <legend>Include with this agent</legend>
                <label className="workflow-checkbox">
                  <input
                    type="checkbox"
                    checked={props.step.inputPolicy.includeWorkflowContext}
                    onChange={(event) =>
                      props.onChange?.({
                        inputPolicy: {
                          ...props.step.inputPolicy,
                          includeWorkflowContext: event.target.checked,
                        },
                      })
                    }
                  />
                  Shared workflow context
                </label>
                <p className="workflow-help">
                  Parent-session final answers, summaries, and transcripts are
                  not available to workflows. Add a previous-agent result chip
                  in the prompt above when you need a supported handoff.
                </p>
              </fieldset>
            </>
          ) : (
            <>
              <div className="workflow-prompt-preview">
                <span className="workflow-field-label">
                  {props.run?.renderedPrompt !== undefined
                    ? "Rendered prompt"
                    : "Instructions and handoffs"}
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
                  {props.context.objective ? (
                    <p>
                      <strong>Objective:</strong> {props.context.objective}
                    </p>
                  ) : null}
                  {props.context.constraints ? (
                    <p>
                      <strong>Constraints:</strong> {props.context.constraints}
                    </p>
                  ) : null}
                  {props.context.relevantPaths.length > 0 ? (
                    <p>
                      <strong>Relevant paths:</strong>{" "}
                      {props.context.relevantPaths.join(", ")}
                    </p>
                  ) : null}
                  {props.context.standards ? (
                    <p>
                      <strong>Standards:</strong> {props.context.standards}
                    </p>
                  ) : null}
                  {props.context.doNotDo ? (
                    <p>
                      <strong>Do not do:</strong> {props.context.doNotDo}
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
              {props.run?.sessionFile && props.onOpenSession ? (
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
