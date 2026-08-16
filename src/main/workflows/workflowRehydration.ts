import { recoverWorkflowRun } from "./workflowEngine.js";
import type { WorkflowRun } from "../../shared/workflowSchemas.js";
import {
  workflowRunEnvelopeSchema,
  type WorkflowRunEnvelope,
} from "../../shared/agentWorkflowSchemas.js";

export interface WorkflowRehydrationDependencies {
  resolveWorkspace(workspaceId: string): Promise<unknown>;
  updateRun(run: WorkflowRun): Promise<WorkflowRun>;
  schedule(run: WorkflowRun): Promise<WorkflowRun>;
  emit(run: WorkflowRun): void;
  recordError(message: string): void;
}

/**
 * Restore persisted runs without allowing a stale workspace to abort startup.
 * Runs that cannot currently resolve their workspace remain persisted as-is;
 * they can be scheduled after the workspace is restored on a later startup.
 * A workspace id may be supplied to rehydrate only runs released by an IPC
 * workspace restore without touching unrelated runs.
 */
export interface CanonicalWorkflowRehydrationDependencies {
  resolveWorkspace(workspaceId: string): Promise<unknown>;
  updateRun(run: WorkflowRunEnvelope): Promise<WorkflowRunEnvelope>;
  schedule(run: WorkflowRunEnvelope): Promise<WorkflowRunEnvelope>;
  emit(run: WorkflowRunEnvelope): void;
  recordError(message: string): void;
}

/** A Pi runtime cannot survive restart: mark only in-flight session owners failed.
 * Ready/queued work is resumable, Human remains waiting, and terminal work is untouched. */
export async function rehydrateCanonicalWorkflowRuns(
  persistedRuns: readonly WorkflowRunEnvelope[],
  dependencies: CanonicalWorkflowRehydrationDependencies,
  now = Date.now(),
  workspaceId?: string,
): Promise<void> {
  for (const persisted of persistedRuns) {
    if (workspaceId !== undefined && persisted.workspaceId !== workspaceId)
      continue;
    // Orchestrators have no Pi session and can safely retain their durable
    // coordination state; only Worker/Decider session owners are lost.
    const lostRunning = persisted.occurrences.some(
      (item) =>
        item.status === "running" &&
        (item.role === "worker" || item.role === "decider"),
    );
    const hasQueued = persisted.occurrences.some(
      (item) => item.status === "queued",
    );
    // runtimeId is process-local. Normalize old terminal records too, while
    // retaining sessionFile as the durable Pi transcript reopen reference.
    const hasRuntimeId = persisted.occurrences.some(
      (item) => item.runtimeId !== undefined,
    );
    // Fan-out queues are normally released by a child terminal transition.
    // After a capacity queue survives restart there may be no active child to
    // produce that transition, so deterministically refill each running
    // fan-out's available slots (creation time, then occurrence ID).
    const resumableFanoutQueued = new Set<string>();
    for (const owner of persisted.occurrences) {
      const definitionNode = persisted.definition.nodes.find(
        (node) => node.id === owner.nodeId,
      );
      if (
        owner.role !== "orchestrator" ||
        owner.status !== "running" ||
        definitionNode?.role !== "orchestrator" ||
        definitionNode.config.mode !== "fanout"
      )
        continue;
      const children = persisted.occurrences.filter(
        (item) =>
          item.parentOrchestratorRunId === owner.id &&
          item.iteration === owner.iteration &&
          item.role === "worker",
      );
      const active = children.filter((item) =>
        ["ready", "running"].includes(item.status),
      ).length;
      const available = definitionNode.config.maxConcurrency - active;
      if (available <= 0) continue;
      children
        .filter((item) => item.status === "queued")
        .sort(
          (left, right) =>
            left.createdAtMs - right.createdAtMs ||
            left.id.localeCompare(right.id),
        )
        .slice(0, available)
        .forEach((item) => resumableFanoutQueued.add(item.id));
    }
    const recovered =
      lostRunning || hasQueued || hasRuntimeId
        ? workflowRunEnvelopeSchema.parse({
            ...persisted,
            status: lostRunning
              ? "needsAttention"
              : hasQueued &&
                  !persisted.occurrences.some(
                    (item) => item.status === "running",
                  )
                ? "waiting"
                : persisted.status,
            updatedAtMs: now,
            occurrences: persisted.occurrences.map((item) => {
              const { runtimeId: _runtimeId, ...withoutRuntimeId } = item;
              return item.status === "running" &&
                (item.role === "worker" || item.role === "decider")
                ? {
                    ...withoutRuntimeId,
                    status: "failed" as const,
                    error:
                      "Pi session was interrupted by restart; retry this occurrence.",
                    updatedAtMs: now,
                  }
                : item.status === "queued" &&
                    (!item.parentOrchestratorRunId ||
                      resumableFanoutQueued.has(item.id))
                  ? {
                      ...withoutRuntimeId,
                      status: "ready" as const,
                      updatedAtMs: now,
                    }
                  : withoutRuntimeId;
            }),
          })
        : persisted;
    const run =
      recovered === persisted
        ? persisted
        : await dependencies.updateRun(recovered);
    if (run !== persisted) dependencies.emit(run);
    if (
      ["needsAttention", "stopped", "completed", "failed"].includes(run.status)
    )
      continue;
    try {
      await dependencies.resolveWorkspace(run.workspaceId);
      await dependencies.schedule(run);
    } catch (error) {
      dependencies.recordError(
        `Canonical workflow run ${run.id} could not be rehydrated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export async function rehydrateWorkflowRuns(
  persistedRuns: readonly WorkflowRun[],
  dependencies: WorkflowRehydrationDependencies,
  now = Date.now(),
  workspaceId?: string,
): Promise<void> {
  for (const persisted of persistedRuns) {
    if (workspaceId !== undefined && persisted.workspaceId !== workspaceId) {
      continue;
    }
    const recovered = recoverWorkflowRun(persisted, now);
    const run =
      recovered === persisted
        ? persisted
        : await dependencies.updateRun(recovered);
    if (run !== persisted) dependencies.emit(run);
    if (
      run.status === "needsAttention" ||
      run.status === "stopped" ||
      run.status === "completed"
    ) {
      continue;
    }

    try {
      await dependencies.resolveWorkspace(run.workspaceId);
      await dependencies.schedule(run);
    } catch (error) {
      dependencies.recordError(
        `Workflow run ${run.id} could not be rehydrated for workspace ${run.workspaceId}; it remains resumable after workspace restore: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
