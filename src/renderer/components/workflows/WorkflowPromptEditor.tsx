import type { RefObject, ReactElement } from "react";
import type {
  WorkflowInputDefinition,
  WorkflowPromptPart,
  WorkflowStepDefinition,
} from "../../../shared/workflowSchemas.js";

export function workflowPromptPartLabel(
  part: WorkflowPromptPart,
  inputs: WorkflowInputDefinition[],
  steps: WorkflowStepDefinition[],
): string {
  if (part.type === "workflowInput") {
    return (
      inputs.find((input) => input.id === part.inputId)?.label ?? "Run input"
    );
  }
  if (part.type === "stepOutput") {
    const step = steps.find((candidate) => candidate.id === part.stepId);
    const output = part.output === "finalAnswer" ? "result" : part.output;
    return `${step?.name ?? "Previous agent"} ${output}`;
  }
  return "Instructions";
}

export function WorkflowPromptEditor(props: {
  parts: WorkflowPromptPart[];
  inputs: WorkflowInputDefinition[];
  previousSteps: WorkflowStepDefinition[];
  onChange(parts: WorkflowPromptPart[]): void;
  inputRef?: RefObject<HTMLTextAreaElement | null> | undefined;
  invalid?: boolean | undefined;
  errorId?: string | undefined;
  showOptionalReferenceWarning?: boolean | undefined;
}): ReactElement {
  const addPart = (part: WorkflowPromptPart) =>
    props.onChange([...props.parts, part]);
  const removePart = (index: number) => {
    const next = props.parts.filter((_, partIndex) => partIndex !== index);
    props.onChange(next.length > 0 ? next : [{ type: "text", text: "" }]);
  };

  return (
    <div className="workflow-prompt-editor">
      <span className="workflow-field-label">Instructions and handoffs</span>
      <div className="workflow-prompt-parts">
        {props.parts.map((part, index) => (
          <div className="workflow-prompt-part" key={`${part.type}-${index}`}>
            {part.type === "text" ? (
              <textarea
                aria-label={`Instruction ${index + 1}`}
                aria-invalid={props.invalid || undefined}
                aria-describedby={props.invalid ? props.errorId : undefined}
                ref={index === 0 ? props.inputRef : undefined}
                rows={4}
                value={part.text}
                onChange={(event) => {
                  const next = [...props.parts];
                  next[index] = { type: "text", text: event.target.value };
                  props.onChange(next);
                }}
                placeholder="Tell this agent what to accomplish…"
              />
            ) : (
              <span className="workflow-reference-chip">
                <span className="workflow-reference-kind">
                  {part.type === "workflowInput"
                    ? "Run input"
                    : "Previous result"}
                </span>
                <strong>
                  {workflowPromptPartLabel(
                    part,
                    props.inputs,
                    props.previousSteps,
                  )}
                </strong>
                {props.showOptionalReferenceWarning &&
                part.type === "workflowInput" &&
                (() => {
                  const input = props.inputs.find(
                    (candidate) => candidate.id === part.inputId,
                  );
                  return (
                    input !== undefined &&
                    !input.required &&
                    !input.defaultValue?.trim()
                  );
                })() ? (
                  <span className="workflow-reference-warning" role="alert">
                    Optional input needs a value or default before this workflow
                    can run.
                  </span>
                ) : null}
                <button
                  type="button"
                  className="workflow-chip-remove"
                  aria-label={`Remove ${workflowPromptPartLabel(part, props.inputs, props.previousSteps)}`}
                  onClick={() => removePart(index)}
                >
                  Remove
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="workflow-prompt-additions">
        <span className="workflow-help">Add structured handoff</span>
        <select
          aria-label="Add a workflow reference"
          value=""
          onChange={(event) => {
            const [kind, id, output] = event.target.value.split(":");
            if (kind === "input" && id) {
              addPart({ type: "workflowInput", inputId: id });
            } else if (kind === "output" && id && output) {
              addPart({
                type: "stepOutput",
                stepId: id,
                output: output as "finalAnswer" | "summary" | "transcript",
              });
            }
          }}
        >
          <option value="">Choose a run input or previous result…</option>
          {props.inputs.map((input) => (
            <option key={`input:${input.id}`} value={`input:${input.id}`}>
              Run input: {input.label}
            </option>
          ))}
          {props.previousSteps.flatMap((step) =>
            (["finalAnswer", "summary", "transcript"] as const).map(
              (output) => (
                <option
                  key={`output:${step.id}:${output}`}
                  value={`output:${step.id}:${output}`}
                >
                  {step.name}: {output === "finalAnswer" ? "result" : output}
                </option>
              ),
            ),
          )}
        </select>
      </div>
    </div>
  );
}
