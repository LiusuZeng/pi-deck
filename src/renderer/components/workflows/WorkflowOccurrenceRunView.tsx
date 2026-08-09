import { useState, type ReactElement } from "react";
import type {
  CanonicalNodeOccurrence,
  WorkflowRunEnvelope,
} from "../../../shared/agentWorkflowSchemas.js";

export interface WorkflowOccurrenceRunViewProps {
  run: WorkflowRunEnvelope;
  onBack(): void;
  onStop(): Promise<void> | void;
  onRetry(occurrenceId: string): Promise<void> | void;
  onAnswer(occurrenceId: string, value: string | boolean): Promise<void> | void;
  onOpenSession?(occurrence: CanonicalNodeOccurrence): void;
}

export function WorkflowOccurrenceRunView(
  props: WorkflowOccurrenceRunViewProps,
): ReactElement {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const nodeName = (nodeId: string) =>
    props.run.definition.nodes.find((node) => node.id === nodeId)?.name ??
    nodeId;
  const submit = async (id: string, value: string | boolean) => {
    setBusy(id);
    try {
      await props.onAnswer(id, value);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section className="workflow-run-view" aria-label="Workflow run">
      <header className="workflow-page-heading">
        <div>
          <span className="workflow-kicker">Agent Workflows</span>
          <h2>{props.run.name}</h2>
          <p>
            Status: {props.run.status}
            {props.run.terminalOutcome
              ? ` · Outcome: ${props.run.terminalOutcome}`
              : ""}
          </p>
        </div>
        <div className="workflow-card-actions">
          <button
            type="button"
            className="workflow-secondary-button"
            onClick={props.onBack}
          >
            Back
          </button>
          {!["completed", "stopped"].includes(props.run.status) ? (
            <button
              type="button"
              className="workflow-danger-button"
              onClick={() => void props.onStop()}
            >
              Stop run
            </button>
          ) : null}
        </div>
      </header>
      <ol className="workflow-run-steps" aria-label="Node occurrences">
        {props.run.occurrences.map((occurrence) => {
          const node = props.run.definition.nodes.find(
            (item) => item.id === occurrence.nodeId,
          );
          const isHuman =
            occurrence.role === "human" &&
            occurrence.status === "waitingHuman" &&
            node?.role === "human";
          return (
            <li key={occurrence.id} className="workflow-run-step">
              <article>
                <div className="workflow-template-card-heading">
                  <div>
                    <span className="workflow-template-mark">
                      {occurrence.role}
                    </span>
                    <h3>{nodeName(occurrence.nodeId)}</h3>
                  </div>
                  <span className="workflow-step-status">
                    {occurrence.status}
                  </span>
                </div>
                <p>
                  Iteration {occurrence.iteration} · Attempt{" "}
                  {occurrence.attempt}
                </p>
                {occurrence.output !== undefined ? (
                  <pre className="workflow-run-output">
                    {Array.isArray(occurrence.output)
                      ? occurrence.output.join("\n")
                      : String(occurrence.output)}
                  </pre>
                ) : null}
                {occurrence.error ? (
                  <p className="workflow-error">{occurrence.error}</p>
                ) : null}
                {occurrence.runtimeId ||
                occurrence.sessionFile ||
                occurrence.sessionId ? (
                  <button
                    type="button"
                    className="workflow-secondary-button"
                    onClick={() => props.onOpenSession?.(occurrence)}
                  >
                    Open Pi session
                  </button>
                ) : null}
                {["failed", "cancelled"].includes(occurrence.status) ? (
                  <button
                    type="button"
                    className="workflow-secondary-button"
                    onClick={() => void props.onRetry(occurrence.id)}
                  >
                    Retry
                  </button>
                ) : null}
                {isHuman ? (
                  <div className="workflow-human-control">
                    <label htmlFor={`workflow-human-${occurrence.id}`}>
                      {node.config.prompt}
                    </label>
                    {node.config.interaction === "approval" ? (
                      <div>
                        <button
                          disabled={busy === occurrence.id}
                          type="button"
                          onClick={() => void submit(occurrence.id, true)}
                        >
                          Approve
                        </button>
                        <button
                          disabled={busy === occurrence.id}
                          type="button"
                          onClick={() => void submit(occurrence.id, false)}
                        >
                          Reject
                        </button>
                      </div>
                    ) : node.config.interaction === "choice" ? (
                      <select
                        id={`workflow-human-${occurrence.id}`}
                        value={answers[occurrence.id] ?? ""}
                        onChange={(event) =>
                          setAnswers({
                            ...answers,
                            [occurrence.id]: event.target.value,
                          })
                        }
                      >
                        <option value="">Choose…</option>
                        {node.config.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`workflow-human-${occurrence.id}`}
                        value={answers[occurrence.id] ?? ""}
                        onChange={(event) =>
                          setAnswers({
                            ...answers,
                            [occurrence.id]: event.target.value,
                          })
                        }
                      />
                    )}
                    {node.config.interaction !== "approval" ? (
                      <button
                        type="button"
                        disabled={
                          busy === occurrence.id ||
                          !(answers[occurrence.id] ?? "").trim()
                        }
                        onClick={() =>
                          void submit(
                            occurrence.id,
                            answers[occurrence.id] ?? "",
                          )
                        }
                      >
                        Continue
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
