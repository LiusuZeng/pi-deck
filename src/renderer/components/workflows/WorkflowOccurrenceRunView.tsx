import { useState, type ReactElement } from "react";
import type {
  CanonicalNodeOccurrence,
  WorkflowNode,
  WorkflowRunEnvelope,
} from "../../../shared/agentWorkflowSchemas.js";
import { AgentWorkflowGraph } from "./AgentWorkflowGraph.js";

export interface WorkflowOccurrenceRunViewProps {
  run: WorkflowRunEnvelope;
  onBack(): void;
  onStop(): Promise<void> | void;
  onRetry(occurrenceId: string): Promise<void> | void;
  onAnswer(occurrenceId: string, value: string | boolean): Promise<void> | void;
  onOpenSession?(occurrence: CanonicalNodeOccurrence): void;
}

const statusLabel = (status: string) =>
  ({
    needsAttention: "Needs attention",
    waitingHuman: "Waiting for your input",
    waiting: "Waiting",
    queued: "Queued",
    running: "Running",
    ready: "Ready",
    completed: "Completed",
    failed: "Failed",
    skipped: "Skipped",
    cancelled: "Cancelled",
    stopped: "Stopped",
  })[status] ?? status;

const outputText = (output: CanonicalNodeOccurrence["output"]) =>
  Array.isArray(output)
    ? output.join("\n")
    : output === undefined
      ? ""
      : String(output);

function executionPath(run: WorkflowRunEnvelope) {
  const nodeNames = new Map(
    run.definition.nodes.map((node) => [node.id, node.name]),
  );
  const occurrences = [...run.occurrences].sort(
    (a, b) => a.createdAtMs - b.createdAtMs,
  );
  const grouped = new Map<string, CanonicalNodeOccurrence[]>();
  for (const occurrence of occurrences) {
    const key =
      occurrence.parentOrchestratorRunId ??
      `${occurrence.nodeId}:${occurrence.iteration}`;
    const items = grouped.get(key) ?? [];
    items.push(occurrence);
    grouped.set(key, items);
  }
  const seen = new Set<string>();
  return occurrences.flatMap((occurrence) => {
    const key =
      occurrence.parentOrchestratorRunId ??
      `${occurrence.nodeId}:${occurrence.iteration}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const names = [
      ...new Set(
        grouped.get(key)!.map((item) => {
          const name = nodeNames.get(item.nodeId) ?? item.nodeId;
          return item.iteration > 1
            ? `${name} (iteration ${item.iteration})`
            : name;
        }),
      ),
    ];
    return [names.join(" + ")];
  });
}

function NodeDetails(props: {
  node: WorkflowNode;
  occurrences: CanonicalNodeOccurrence[];
  onRetry(occurrenceId: string): Promise<void> | void;
  onOpenSession: ((occurrence: CanonicalNodeOccurrence) => void) | undefined;
}): ReactElement {
  const { node, occurrences } = props;
  return (
    <div className="workflow-node-details" id={`workflow-node-${node.id}`}>
      <h4>Execution details</h4>
      {node.role === "worker" ? (
        <p>Prompt: {node.config.instructions}</p>
      ) : null}
      {node.role === "decider" ? <p>Decision: {node.config.question}</p> : null}
      {node.role === "human" ? <p>Human input: {node.config.prompt}</p> : null}
      {node.role === "orchestrator" ? (
        <p>
          {node.config.mode === "fanout"
            ? `Fan out to ${node.config.agents.length} nodes; complete when ${node.config.completion}.`
            : `Loop through ${node.config.agents.length} nodes, up to ${node.config.maxIterations} iterations.`}
        </p>
      ) : null}
      <ol
        className="workflow-occurrence-history"
        aria-label={`${node.name} attempt history`}
      >
        {[...occurrences]
          .sort((a, b) => a.createdAtMs - b.createdAtMs)
          .map((occurrence) => {
            const hasSession =
              occurrence.runtimeId ||
              occurrence.sessionFile ||
              occurrence.sessionId;
            return (
              <li key={occurrence.id}>
                <div className="workflow-template-card-heading">
                  <strong>
                    Iteration {occurrence.iteration} · Attempt{" "}
                    {occurrence.attempt}
                  </strong>
                  <span className="workflow-step-status">
                    {statusLabel(occurrence.status)}
                  </span>
                </div>
                {occurrence.output !== undefined ? (
                  <pre className="workflow-run-output">
                    {outputText(occurrence.output)}
                  </pre>
                ) : null}
                {occurrence.aggregation.length ? (
                  <pre className="workflow-run-output">
                    {occurrence.aggregation.join("\n")}
                  </pre>
                ) : null}
                {occurrence.error ? (
                  <p className="workflow-error" role="alert">
                    {occurrence.error}
                  </p>
                ) : null}
                <div className="workflow-card-actions">
                  {hasSession ? (
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
                      Retry attempt {occurrence.attempt}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
      </ol>
    </div>
  );
}

function HumanControl(props: {
  occurrence: CanonicalNodeOccurrence;
  node: Extract<WorkflowNode, { role: "human" }>;
  busy: string | undefined;
  answer: string | undefined;
  onAnswer(value: string | boolean): void;
  onChange(value: string): void;
}): ReactElement {
  const { occurrence, node } = props;
  const inputId = `workflow-human-${occurrence.id}`;
  return (
    <fieldset
      className="workflow-human-control"
      aria-busy={props.busy === occurrence.id}
    >
      <legend>
        {node.name}: {node.config.prompt}
      </legend>
      {node.config.interaction === "approval" ? (
        <div className="workflow-card-actions">
          <button
            disabled={props.busy === occurrence.id}
            type="button"
            onClick={() => props.onAnswer(true)}
          >
            Approve
          </button>
          <button
            disabled={props.busy === occurrence.id}
            type="button"
            onClick={() => props.onAnswer(false)}
          >
            Reject
          </button>
        </div>
      ) : node.config.interaction === "choice" ? (
        <>
          <label htmlFor={inputId}>Response</label>
          <select
            id={inputId}
            value={props.answer ?? ""}
            onChange={(event) => props.onChange(event.target.value)}
          >
            <option value="">Choose…</option>
            {node.config.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label htmlFor={inputId}>Response</label>
          <input
            id={inputId}
            value={props.answer ?? ""}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </>
      )}
      {node.config.interaction !== "approval" ? (
        <button
          type="button"
          disabled={
            props.busy === occurrence.id || !(props.answer ?? "").trim()
          }
          onClick={() => props.onAnswer(props.answer ?? "")}
        >
          Continue
        </button>
      ) : null}
    </fieldset>
  );
}

export function WorkflowOccurrenceRunView(
  props: WorkflowOccurrenceRunViewProps,
): ReactElement {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const nodes = props.run.definition.nodes;
  const groups = nodes
    .map((node) => ({
      node,
      occurrences: props.run.occurrences.filter(
        (item) => item.nodeId === node.id,
      ),
    }))
    .filter((group) => group.occurrences.length);
  const path = executionPath(props.run);
  const counts = props.run.occurrences.reduce<Record<string, number>>(
    (result, occurrence) => {
      result[occurrence.status] = (result[occurrence.status] ?? 0) + 1;
      return result;
    },
    {},
  );
  const waitingHumans = groups.flatMap(({ node, occurrences }) =>
    node.role === "human"
      ? occurrences
          .filter(
            (occurrence) =>
              occurrence.role === "human" &&
              occurrence.status === "waitingHuman",
          )
          .map((occurrence) => ({ node, occurrence }))
      : [],
  );
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
          <p aria-live="polite">
            Status: {statusLabel(props.run.status)}
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

      <section
        className="workflow-run-overview"
        aria-labelledby="workflow-run-summary"
      >
        <h3 id="workflow-run-summary">Execution summary</h3>
        <p>
          {groups.length} logical {groups.length === 1 ? "node" : "nodes"} ·{" "}
          {counts.running ?? 0} running · {waitingHumans.length} waiting for you
          · {counts.failed ?? 0} failed
        </p>
        <p className="workflow-execution-path">
          <strong>Path:</strong> {path.join(" → ") || "Not started"}
          {["completed", "stopped"].includes(props.run.status) &&
          props.run.terminalOutcome
            ? ` → ${props.run.terminalOutcome}`
            : ""}
        </p>
      </section>

      {waitingHumans.length ? (
        <section
          className="workflow-waiting-human"
          aria-labelledby="workflow-waiting-human-heading"
        >
          <h3 id="workflow-waiting-human-heading">Waiting for your input</h3>
          {waitingHumans.map(({ node, occurrence }) => (
            <HumanControl
              key={occurrence.id}
              occurrence={occurrence}
              node={node}
              busy={busy}
              answer={answers[occurrence.id]}
              onChange={(value) =>
                setAnswers({ ...answers, [occurrence.id]: value })
              }
              onAnswer={(value) => void submit(occurrence.id, value)}
            />
          ))}
        </section>
      ) : null}

      <section aria-labelledby="workflow-logical-nodes">
        <h3 id="workflow-logical-nodes">Logical execution</h3>
        <AgentWorkflowGraph
          definition={props.run.definition}
          occurrences={props.run.occurrences}
          selectedNodeId={selectedNodeId}
          onSelectNode={(nodeId) =>
            setSelectedNodeId(selectedNodeId === nodeId ? undefined : nodeId)
          }
        />
        {selectedNodeId ? (() => {
          const node = nodes.find((item) => item.id === selectedNodeId);
          const occurrences = props.run.occurrences.filter(
            (item) => item.nodeId === selectedNodeId,
          );
          return node ? (
            <NodeDetails
              node={node}
              occurrences={occurrences}
              onRetry={props.onRetry}
              onOpenSession={props.onOpenSession}
            />
          ) : null;
        })() : null}
      </section>
    </section>
  );
}
