import type { ReactElement } from "react";
import type { WorkflowContext } from "../../../shared/workflowSchemas.js";

export function WorkflowContextCard(props: {
  context: WorkflowContext;
  onChange(context: WorkflowContext): void;
  readOnly?: boolean;
}): ReactElement {
  const update = (patch: Partial<WorkflowContext>) =>
    props.onChange({ ...props.context, ...patch });
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
        Every selected agent can receive these instructions. Workspace files and
        project resources are implicit and remain Pi-native.
      </p>
      <div className="workflow-field-grid">
        <label className="workflow-field">
          <span>Shared instructions</span>
          <textarea
            aria-label="Shared instructions"
            rows={5}
            disabled={props.readOnly}
            value={props.context.prompt ?? props.context.objective ?? ""}
            onChange={(event) =>
              update({ prompt: event.target.value || undefined })
            }
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
