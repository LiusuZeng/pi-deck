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

/**
 * The v1 editor intentionally has one prompt surface. Persisted structured
 * references are retained in the prompt parts array, but are not exposed as
 * new controls in this UI.
 */
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
  const textParts = props.parts.filter(
    (part): part is Extract<WorkflowPromptPart, { type: "text" }> =>
      part.type === "text",
  );
  const instructions = textParts.map((part) => part.text).join("\n\n");
  const hasLegacyReferences = props.parts.some((part) => part.type !== "text");

  const updateInstructions = (text: string) => {
    props.onChange([{ type: "text", text }]);
  };

  return (
    <div className="workflow-prompt-editor workflow-field">
      <span className="workflow-field-label">Instructions</span>
      <textarea
        aria-label="Instructions"
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.invalid ? props.errorId : undefined}
        ref={props.inputRef}
        rows={5}
        value={instructions}
        readOnly={hasLegacyReferences}
        onChange={(event) => updateInstructions(event.target.value)}
        placeholder="Tell this agent what to accomplish…"
      />
      {hasLegacyReferences ? (
        <div className="workflow-legacy-prompt-note">
          <span className="workflow-help">
            This saved workflow uses older prompt references and will run
            unchanged until you replace them.
          </span>
          <button
            type="button"
            className="workflow-secondary-button"
            onClick={() => updateInstructions(instructions)}
          >
            Replace with prompt-only instructions
          </button>
        </div>
      ) : null}
    </div>
  );
}
