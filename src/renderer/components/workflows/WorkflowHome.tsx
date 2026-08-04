import { useMemo, useState, type FormEvent, type ReactElement } from "react";
import type {
  WorkflowInputDefinition,
  WorkflowRun,
  WorkflowTemplate,
} from "../../../shared/workflowSchemas.js";
import {
  runProgress,
  workflowRunStatusLabel,
  workflowRunStatusTone,
} from "../../workflows/workflowViewModels.js";

function WorkflowStartForm(props: {
  template: WorkflowTemplate;
  onCancel(): void;
  onStart(inputs: Record<string, string>): Promise<void> | void;
}): ReactElement {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      props.template.inputs.map((input) => [
        input.id,
        input.defaultValue ?? "",
      ]),
    ),
  );
  const [error, setError] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const missing = useMemo(
    () =>
      props.template.inputs.find(
        (input) => input.required && !values[input.id]?.trim(),
      ),
    [props.template.inputs, values],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (missing) {
      setError(`${missing.label} is required.`);
      return;
    }
    setStarting(true);
    setError(undefined);
    try {
      await props.onStart(values);
    } catch (startError) {
      setError(
        startError instanceof Error ? startError.message : String(startError),
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <form
      className="workflow-start-form workflow-card"
      onSubmit={(event) => void submit(event)}
    >
      <div className="workflow-section-heading">
        <div>
          <span className="workflow-kicker">Start a run</span>
          <h3>{props.template.name}</h3>
        </div>
        <button
          type="button"
          className="workflow-secondary-button"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
      <p className="workflow-help">
        These reusable inputs apply to this run only. Each agent receives only
        the context selected in its configuration.
      </p>
      {props.template.inputs.length === 0 ? (
        <p className="workflow-empty-inline">
          This workflow has no run inputs.
        </p>
      ) : (
        <div className="workflow-field-grid">
          {props.template.inputs.map((input) => (
            <label className="workflow-field" key={input.id}>
              <span>
                {input.label}
                {input.required ? " *" : ""}
              </span>
              {input.description ? <small>{input.description}</small> : null}
              {input.type === "path" ? (
                <input
                  type="text"
                  placeholder="Path or file reference"
                  value={values[input.id] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [input.id]: event.target.value,
                    }))
                  }
                />
              ) : (
                <textarea
                  rows={3}
                  value={values[input.id] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [input.id]: event.target.value,
                    }))
                  }
                />
              )}
            </label>
          ))}
        </div>
      )}
      {error ? (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="workflow-form-actions">
        <button
          type="submit"
          className="workflow-primary-button"
          disabled={starting}
        >
          {starting ? "Starting…" : "Start workflow"}
        </button>
      </div>
    </form>
  );
}

export function WorkflowHome(props: {
  templates: WorkflowTemplate[];
  workspaceName?: string;
  recentRuns?: WorkflowRun[];
  onCreate(): void;
  onEdit(template: WorkflowTemplate): void;
  onStart(
    template: WorkflowTemplate,
    inputs: Record<string, string>,
  ): Promise<void> | void;
  onOpenRun(run: WorkflowRun): void;
}): ReactElement {
  const [startingTemplate, setStartingTemplate] = useState<
    WorkflowTemplate | undefined
  >();
  const runs = props.recentRuns ?? [];

  if (startingTemplate) {
    return (
      <div className="workflow-home">
        <button
          type="button"
          className="workflow-back-button"
          onClick={() => setStartingTemplate(undefined)}
        >
          ← Agent Workflows
        </button>
        <WorkflowStartForm
          template={startingTemplate}
          onCancel={() => setStartingTemplate(undefined)}
          onStart={(inputs) => props.onStart(startingTemplate, inputs)}
        />
      </div>
    );
  }

  return (
    <div className="workflow-home">
      <div className="workflow-page-heading">
        <div>
          <span className="workflow-kicker">Orchestration</span>
          <h2>Agent Workflows</h2>
          <p>
            Coordinate reusable sequences of Pi agent sessions. Workflows decide
            what runs next; Pi skills remain capabilities inside each agent
            session.
          </p>
          {props.workspaceName ? (
            <p className="workflow-workspace-context">
              Workspace: <strong>{props.workspaceName}</strong>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="workflow-primary-button"
          onClick={props.onCreate}
        >
          New workflow
        </button>
      </div>
      <section
        className="workflow-boundary-note"
        aria-label="Workflows and skills distinction"
      >
        <strong>Workflows coordinate. Skills equip.</strong>
        <span>
          Use a workflow for multi-agent handoffs and approvals. Skills stay
          Pi-native and are discovered by the active agent.
        </span>
      </section>
      <section className="workflow-template-section">
        <div className="workflow-section-heading">
          <div>
            <span className="workflow-kicker">Reusable plans</span>
            <h3>Your agent workflows</h3>
          </div>
          <span className="workflow-count">{props.templates.length}</span>
        </div>
        {props.templates.length === 0 ? (
          <div className="workflow-empty-state">
            <h3>Build a repeatable agent handoff</h3>
            <p>
              Create a workflow with shared context, run inputs, and explicit
              transitions between agent sessions.
            </p>
            <button
              type="button"
              className="workflow-secondary-button"
              onClick={props.onCreate}
            >
              Create your first workflow
            </button>
          </div>
        ) : (
          <div className="workflow-template-grid">
            {props.templates.map((template) => (
              <article
                className="workflow-card workflow-template-card"
                key={template.id}
              >
                <div className="workflow-template-card-heading">
                  <div>
                    <span className="workflow-template-mark">Workflow</span>
                    <h3>{template.name}</h3>
                  </div>
                  <span className="workflow-step-count">
                    {template.steps.length} agents
                  </span>
                </div>
                <p>
                  {template.description ??
                    "A reusable sequence of Pi agent sessions."}
                </p>
                <div className="workflow-card-facts">
                  <span>
                    {template.inputs.length} reusable input
                    {template.inputs.length === 1 ? "" : "s"}
                  </span>
                  <span>
                    {template.transitions.length} transition
                    {template.transitions.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="workflow-card-actions">
                  <button
                    type="button"
                    className="workflow-primary-button"
                    onClick={() => setStartingTemplate(template)}
                  >
                    Start run
                  </button>
                  <button
                    type="button"
                    className="workflow-secondary-button"
                    onClick={() => props.onEdit(template)}
                  >
                    Edit
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="workflow-runs-section">
        <div className="workflow-section-heading">
          <div>
            <span className="workflow-kicker">Activity</span>
            <h3>Recent runs</h3>
          </div>
        </div>
        {runs.length === 0 ? (
          <p className="workflow-empty-inline">
            Runs will appear here after you start a workflow.
          </p>
        ) : (
          <div className="workflow-run-list">
            {runs.map((run) => {
              const progress = runProgress(run);
              return (
                <button
                  type="button"
                  className="workflow-run-row"
                  key={run.id}
                  onClick={() => props.onOpenRun(run)}
                >
                  <span
                    className={`workflow-status-dot workflow-tone-${workflowRunStatusTone(run.status)}`}
                    aria-hidden="true"
                  />
                  <span className="workflow-run-row-copy">
                    <strong>{run.name}</strong>
                    <small>
                      {progress.completed}/{progress.total} agents complete ·{" "}
                      {new Date(run.updatedAtMs).toLocaleString()}
                    </small>
                  </span>
                  <span
                    className="workflow-run-status"
                    aria-label={`Workflow status: ${workflowRunStatusLabel(run.status)}`}
                  >
                    {workflowRunStatusLabel(run.status)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export { WorkflowStartForm };
