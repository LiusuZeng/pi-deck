import type {
  CanonicalNodeOccurrence,
  WorkflowDefinition,
  WorkflowGraphSnapshot,
  WorkflowRunEnvelope,
} from "../../shared/agentWorkflowSchemas.js";

type Aggregate = NonNullable<
  WorkflowGraphSnapshot["nodes"][number]["aggregateStatus"]
>;
type EdgeState = NonNullable<WorkflowGraphSnapshot["edges"][number]["status"]>;
const state: Record<CanonicalNodeOccurrence["status"], Aggregate> = {
  ready: "queued",
  queued: "queued",
  running: "in_progress",
  waitingHuman: "waiting_human",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
};
const precedence: Aggregate[] = [
  "waiting_human",
  "in_progress",
  "retrying",
  "queued",
  "failed",
  "cancelled",
  "completed",
  "skipped",
];
const truncate = (value: string, max = 500) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Pure renderer-safe projection. It intentionally never includes runtimeId, inputs, prompts, or raw output. */
export function deriveWorkflowGraphSnapshot(
  definition: WorkflowDefinition,
  run?: WorkflowRunEnvelope,
): WorkflowGraphSnapshot {
  const occurrences = run?.occurrences ?? [];
  const nodes = definition.nodes.map((node) => {
    const matching = occurrences.filter((item) => item.nodeId === node.id);
    if (!run) return { nodeId: node.id };
    const counts: Partial<Record<Aggregate, number>> = {};
    for (const occurrence of matching) {
      const key = state[occurrence.status];
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const retrying = matching.some(
      (item) =>
        item.attempt > 1 &&
        ["ready", "queued", "running", "failed"].includes(item.status),
    );
    const aggregateStatus = !matching.length
      ? "not_started"
      : (precedence.find((candidate) =>
          candidate === "retrying" ? retrying : (counts[candidate] ?? 0) > 0,
        ) ?? "unknown");
    const summaries = matching
      .slice()
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id))
      .slice(0, 100)
      .map((item) => ({
        occurrenceId: item.id,
        nodeId: item.nodeId,
        status: item.status,
        attempt: item.attempt,
        iteration: item.iteration,
        ...(item.parentOrchestratorRunId
          ? { parentOrchestratorRunId: item.parentOrchestratorRunId }
          : {}),
        ...(item.startedAtMs !== undefined
          ? { startedAtMs: item.startedAtMs }
          : {}),
        ...(item.completedAtMs !== undefined
          ? { completedAtMs: item.completedAtMs }
          : {}),
        ...(item.startedAtMs !== undefined
          ? {
              elapsedMs: Math.max(
                0,
                (item.completedAtMs ?? run.updatedAtMs) - item.startedAtMs,
              ),
            }
          : {}),
        ...(typeof item.output === "string"
          ? { outputSummary: truncate(item.output) }
          : {}),
        ...(item.error ? { errorSummary: truncate(item.error) } : {}),
        ...(node.role === "human"
          ? { humanInteraction: node.config.interaction }
          : {}),
        ...(item.sessionFile ? { sessionFile: item.sessionFile } : {}),
      }));
    return { nodeId: node.id, aggregateStatus, counts, occurrences: summaries };
  });
  const edges = definition.relationships.map((relationship) => {
    const source = occurrences.filter(
      (item) => item.nodeId === relationship.from,
    );
    const targetNodeId =
      "nodeId" in relationship.to ? relationship.to.nodeId : undefined;
    const target = targetNodeId
      ? occurrences.filter((item) => item.nodeId === targetNodeId)
      : [];
    let status: EdgeState = "pending";
    if (!source.length) status = "pending";
    else if (
      target.some((item) =>
        item.parentOccurrenceIds.some((parent) =>
          source.some((sourceItem) => sourceItem.id === parent),
        ),
      )
    )
      status = target.some((item) =>
        ["ready", "queued", "running", "waitingHuman"].includes(item.status),
      )
        ? "active"
        : "taken";
    else if (
      source.some((item) =>
        ["running", "waitingHuman", "ready", "queued"].includes(item.status),
      )
    )
      status = "active";
    else if (
      source.some((item) => ["failed", "cancelled"].includes(item.status))
    )
      status = "blocked";
    else if (relationship.when)
      status = source.some(
        (item) =>
          item.status === "completed" &&
          item.output === relationship.when?.equals,
      )
        ? "taken"
        : "not_taken";
    else if (source.some((item) => item.status === "completed"))
      status = "taken";
    return { relationshipId: relationship.id, ...(run ? { status } : {}) };
  });
  return {
    workflowSnapshot: structuredClone(definition),
    ...(run
      ? { runId: run.id, runStatus: run.status, updatedAtMs: run.updatedAtMs }
      : {}),
    revision: run?.revision ?? 1,
    nodes,
    edges,
  };
}
