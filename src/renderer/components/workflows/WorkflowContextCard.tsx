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
        Shared context is opt-in per step. Pi skills and project resources
        remain Pi-native and are loaded by the active worker.
      </p>
      <div className="workflow-field-grid">
        <label className="workflow-field">
          <span>Objective</span>
          <textarea
            rows={3}
            disabled={props.readOnly}
            value={props.context.objective ?? ""}
            onChange={(event) =>
              update({ objective: event.target.value || undefined })
            }
          />
        </label>
        <label className="workflow-field">
          <span>Constraints</span>
          <textarea
            rows={3}
            disabled={props.readOnly}
            value={props.context.constraints ?? ""}
            onChange={(event) =>
              update({ constraints: event.target.value || undefined })
            }
          />
        </label>
        <label className="workflow-field">
          <span>Relevant paths</span>
          <input
            disabled={props.readOnly}
            placeholder="src/, tests/example.test.ts"
            value={props.context.relevantPaths.join(", ")}
            onChange={(event) =>
              update({
                relevantPaths: event.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
        <label className="workflow-field">
          <span>Standards</span>
          <textarea
            rows={2}
            disabled={props.readOnly}
            placeholder="Project conventions, quality bar, or acceptance criteria"
            value={props.context.standards ?? ""}
            onChange={(event) =>
              update({ standards: event.target.value || undefined })
            }
          />
        </label>
        <label className="workflow-field">
          <span>Do not do</span>
          <textarea
            rows={2}
            disabled={props.readOnly}
            value={props.context.doNotDo ?? ""}
            onChange={(event) =>
              update({ doNotDo: event.target.value || undefined })
            }
          />
        </label>
      </div>
    </section>
  );
}
