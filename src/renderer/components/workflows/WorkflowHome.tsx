import {
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
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
  onStartingChange?(starting: boolean): void;
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
  const startingRef = useRef(false);
  const missing = useMemo(
    () =>
      props.template.inputs.find(
        (input) => input.required && !values[input.id]?.trim(),
      ),
    [props.template.inputs, values],
  );
  const blankReferencedOptional = useMemo(() => {
    const referencedIds = new Set(
      props.template.steps.flatMap((step) =>
        step.promptParts.flatMap((part) =>
          part.type === "workflowInput" ? [part.inputId] : [],
        ),
      ),
    );
    return props.template.inputs.find(
      (input) =>
        referencedIds.has(input.id) &&
        !input.required &&
        !values[input.id]?.trim(),
    );
  }, [props.template.inputs, props.template.steps, values]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (startingRef.current) return;
    if (missing) {
      setError(`${missing.label} is required.`);
      return;
    }
    if (blankReferencedOptional) {
      setError(
        `${blankReferencedOptional.label} is optional, but an agent references it. Add a value or remove that reference before starting this workflow.`,
      );
      return;
    }
    startingRef.current = true;
    setStarting(true);
    props.onStartingChange?.(true);
    setError(undefined);
    try {
      await props.onStart(values);
    } catch (startError) {
      setError(
        startError instanceof Error ? startError.message : String(startError),
      );
    } finally {
      startingRef.current = false;
      setStarting(false);
      props.onStartingChange?.(false);
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
          disabled={starting}
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
              <textarea
                aria-label={input.label}
                rows={4}
                placeholder="Enter instructions or other run-specific context…"
                value={values[input.id] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [input.id]: event.target.value,
                  }))
                }
              />
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
  additionalWorkflowCount?: number;
  additionalWorkflowSection?: ReactNode;
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
  const [formStarting, setFormStarting] = useState(false);
  const [quickStartingTemplateId, setQuickStartingTemplateId] = useState<
    string | undefined
  >();
  const [quickStartError, setQuickStartError] = useState<string | undefined>();
  const quickStarts = useRef(new Set<string>());
  const runs = props.recentRuns ?? [];

  const startTemplate = async (template: WorkflowTemplate) => {
    if (template.inputs.length > 0) {
      setFormStarting(false);
      setStartingTemplate(template);
      return;
    }
    if (quickStarts.current.has(template.id)) return;

    quickStarts.current.add(template.id);
    setQuickStartingTemplateId(template.id);
    setQuickStartError(undefined);
    try {
      await props.onStart(template, {});
    } catch (startError) {
      setQuickStartError(
        startError instanceof Error ? startError.message : String(startError),
      );
    } finally {
      quickStarts.current.delete(template.id);
      setQuickStartingTemplateId((current) =>
        current === template.id ? undefined : current,
      );
    }
  };

  if (startingTemplate) {
    return (
      <div className="workflow-home">
        <button
          type="button"
          className="workflow-back-button"
          disabled={formStarting}
          onClick={() => setStartingTemplate(undefined)}
        >
          ← Agent Workflows
        </button>
        <WorkflowStartForm
          template={startingTemplate}
          onCancel={() => setStartingTemplate(undefined)}
          onStart={(inputs) => props.onStart(startingTemplate, inputs)}
          onStartingChange={setFormStarting}
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
            what runs next.
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
      <section className="workflow-template-section">
        <div className="workflow-section-heading">
          <div>
            <span className="workflow-kicker">Reusable plans</span>
            <h3>Your agent workflows</h3>
          </div>
          <span className="workflow-count">
            {props.templates.length + (props.additionalWorkflowCount ?? 0)}
          </span>
        </div>
        {quickStartError ? (
          <p className="workflow-error" role="alert">
            {quickStartError}
          </p>
        ) : null}
        {props.templates.length === 0 &&
        (props.additionalWorkflowCount ?? 0) === 0 ? (
          <div className="workflow-empty-state">
            <h3>Build a repeatable agent handoff</h3>
            <p>
              Create a workflow with shared context, run inputs, and explicit
              transitions between agent sessions.
            </p>
          </div>
        ) : props.templates.length > 0 ? (
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
                    {template.steps.length} role
                    {template.steps.length === 1 ? "" : "s"}
                  </span>
                </div>
                <p>{template.description ?? "A reusable Agent Workflow."}</p>
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
                    disabled={quickStartingTemplateId === template.id}
                    onClick={() => void startTemplate(template)}
                  >
                    {quickStartingTemplateId === template.id
                      ? "Starting…"
                      : "Start run"}
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
        ) : null}
        {props.additionalWorkflowSection}
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
                      {progress.completed}/{progress.total} roles complete ·{" "}
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
