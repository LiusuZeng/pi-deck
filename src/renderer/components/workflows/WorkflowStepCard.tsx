import { useEffect, useRef, type ReactElement } from "react";
import type {
  WorkflowInputDefinition,
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
  promptError?: string | undefined;
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
                  value={props.step.name}
                  onChange={(event) =>
                    props.onChange?.({ name: event.target.value })
                  }
                />
              </label>
              <WorkflowPromptEditor
                parts={props.step.promptParts}
                inputs={props.inputs ?? []}
                previousSteps={props.previousSteps ?? []}
                onChange={(promptParts) => props.onChange?.({ promptParts })}
                inputRef={promptRef}
                invalid={props.promptError !== undefined}
                errorId={props.promptError ? `workflow-${props.step.id}-prompt-error` : undefined}
              />
              {props.promptError ? (
                <p id={`workflow-${props.step.id}-prompt-error`} className="workflow-field-error" role="alert">
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
                <label className="workflow-checkbox">
                  <input
                    type="checkbox"
                    checked={props.step.inputPolicy.includeParentFinalAnswer}
                    onChange={(event) =>
                      props.onChange?.({
                        inputPolicy: {
                          ...props.step.inputPolicy,
                          includeParentFinalAnswer: event.target.checked,
                        },
                      })
                    }
                  />
                  Parent session result
                </label>
                <label className="workflow-checkbox">
                  <input
                    type="checkbox"
                    checked={props.step.inputPolicy.includeParentSummary}
                    onChange={(event) =>
                      props.onChange?.({
                        inputPolicy: {
                          ...props.step.inputPolicy,
                          includeParentSummary: event.target.checked,
                        },
                      })
                    }
                  />
                  Parent session summary
                </label>
              </fieldset>
            </>
          ) : (
            <>
              <div className="workflow-prompt-preview">
                <span className="workflow-field-label">
                  Instructions and handoffs
                </span>
                {props.step.promptParts.map((part, partIndex) =>
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
                )}
              </div>
              {props.run?.finalAnswer ? (
                <div className="workflow-output-preview">
                  <span>Latest output</span>
                  <p>{props.run.finalAnswer}</p>
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
