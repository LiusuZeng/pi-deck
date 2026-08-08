import type { ReactElement } from "react";
import type { WorkflowContext } from "../../../shared/workflowSchemas.js";

export function workflowContextPromptValue(context: WorkflowContext): string {
  if (context.prompt !== undefined) return context.prompt;

  const legacySections: string[] = [];
  if (context.objective?.trim()) legacySections.push(context.objective);
  if (context.constraints?.trim()) {
    legacySections.push(`Constraints:\n${context.constraints}`);
  }
  if (context.relevantPaths.length > 0) {
    legacySections.push(`Relevant paths:\n${context.relevantPaths.join("\n")}`);
  }
  if (context.standards?.trim()) {
    legacySections.push(`Standards:\n${context.standards}`);
  }
  return legacySections.join("\n\n");
}

export function WorkflowContextCard(props: {
  context: WorkflowContext;
  onChange(context: WorkflowContext): void;
  readOnly?: boolean;
}): ReactElement {
  const update = (patch: Partial<WorkflowContext>) =>
    props.onChange({ ...props.context, ...patch });
  const updatePrompt = (prompt: string) => {
    const {
      objective: _objective,
      constraints: _constraints,
      relevantPaths: _relevantPaths,
      standards: _standards,
      ...promptFirstContext
    } = props.context;
    props.onChange({
      ...promptFirstContext,
      prompt: prompt || undefined,
      relevantPaths: [],
    });
  };
  return (
    <section className="workflow-card workflow-context-card">
      <div className="workflow-section-heading">
        <div>
          <span className="workflow-kicker">Shared context</span>
          <h3>What should every selected agent know?</h3>
        </div>
        <span className="workflow-context-badge">Explicit</span>
      </div>
      <p className="workflow-help">
        Every agent receives these instructions. Workspace files and project
        resources are implicit and remain Pi-native.
      </p>
      <div className="workflow-field-grid">
        <label className="workflow-field">
          <span>Prompt</span>
          <textarea
            aria-label="Prompt"
            rows={5}
            disabled={props.readOnly}
            value={workflowContextPromptValue(props.context)}
            onChange={(event) => updatePrompt(event.target.value)}
            placeholder="Give every selected agent the context they need…"
          />
        </label>
        <label className="workflow-field">
          <span>Don't do</span>
          <textarea
            aria-label="Don't do"
            rows={3}
            disabled={props.readOnly}
            value={props.context.doNotDo ?? ""}
            onChange={(event) =>
              update({ doNotDo: event.target.value || undefined })
            }
            placeholder="Guardrails or approaches to avoid…"
          />
        </label>
      </div>
    </section>
  );
}
