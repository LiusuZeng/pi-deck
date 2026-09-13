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

const stoppedDormantStatuses = new Set([
  "ready",
  "queued",
  "running",
  "waitingHuman",
]);

/**
 * Legacy builds could persist a stopped envelope while an old retry was still
 * ready. Keep exactly one latest retry target per logical node lineage, mark
 * superseded retry records historical, and never let restart schedule it.
 */
function repairStoppedCanonicalRun(
  persisted: WorkflowRunEnvelope,
  now: number,
): WorkflowRunEnvelope {
  const candidates = new Map<
    string,
    WorkflowRunEnvelope["occurrences"][number]
  >();
  const keyOf = (item: WorkflowRunEnvelope["occurrences"][number]) =>
    `${item.nodeId}:${item.parentOrchestratorRunId ?? "root"}:${item.iteration}`;
  const retryable = (item: WorkflowRunEnvelope["occurrences"][number]) =>
    stoppedDormantStatuses.has(item.status) ||
    item.status === "failed" ||
    item.status === "cancelled";
  for (const item of persisted.occurrences) {
    if (!retryable(item)) continue;
    const key = keyOf(item);
    const prior = candidates.get(key);
    if (
      !prior ||
      item.attempt > prior.attempt ||
      (item.attempt === prior.attempt &&
        (item.createdAtMs > prior.createdAtMs ||
          (item.createdAtMs === prior.createdAtMs && item.id > prior.id)))
    )
      candidates.set(key, item);
  }
  return workflowRunEnvelopeSchema.parse({
    ...persisted,
    status: "stopped",
    updatedAtMs: now,
    occurrences: persisted.occurrences.map((item) => {
      const { runtimeId: _runtimeId, ...withoutRuntimeId } = item;
      const winner = candidates.get(keyOf(item));
      if (retryable(item) && winner && winner.id !== item.id)
        return {
          ...withoutRuntimeId,
          status: "skipped" as const,
          updatedAtMs: now,
        };
      if (stoppedDormantStatuses.has(item.status))
        return {
          ...withoutRuntimeId,
          status: "cancelled" as const,
          error:
            item.error ??
            "Cancelled because this workflow run was stopped before restart.",
          updatedAtMs: now,
        };
      return withoutRuntimeId;
    }),
  });
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
    // A stopped envelope is never executable on restart. Older versions could
    // leave ready/queued replacements, session-owning work, or Human gates in
    // it; normalize every such record before any workspace/scheduler access.
    const hasLegacyStoppedDormant =
      persisted.status === "stopped" &&
      persisted.occurrences.some(
        (item) =>
          stoppedDormantStatuses.has(item.status) ||
          item.runtimeId !== undefined,
      );
    // runtimeId is process-local. Normalize old terminal records too, while
    // retaining sessionFile as the durable Pi transcript reopen reference.
    const hasRuntimeId = persisted.occurrences.some(
      (item) => item.runtimeId !== undefined,
    );
    // Fan-out queues are normally released by a child terminal transition.
    // After a capacity queue survives restart there may be no active child to
    // produce that transition, so deterministically refill each running
    // fan-out's available slots in durable occurrence order.
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
        .slice(0, available)
        .forEach((item) => resumableFanoutQueued.add(item.id));
    }
    if (hasLegacyStoppedDormant) {
      const recovered = repairStoppedCanonicalRun(persisted, now);
      const run = await dependencies.updateRun(recovered);
      dependencies.emit(run);
      continue;
    }

    // A queued occurrence may have been retained because allocation raced an
    // archive claim. Do not promote it to ready until the workspace resolves;
    // an actually archived workspace must keep the durable queue until restore
    // provides the next scheduling boundary. Lost runtime ownership is still
    // recovered even when the workspace is archived, so it cannot remain stale.
    let workspaceResolved = false;
    let workspaceResolutionAttempted = false;
    if (hasQueued) {
      workspaceResolutionAttempted = true;
      try {
        await dependencies.resolveWorkspace(persisted.workspaceId);
        workspaceResolved = true;
      } catch (error) {
        dependencies.recordError(
          `Canonical workflow run ${persisted.id} could not be rehydrated: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Leave a queued-only archived run byte-for-byte durable. Workspace
        // restore will provide the next scheduling boundary. A run with lost
        // runtime metadata still needs the recovery mutation below.
        if (!lostRunning && !hasRuntimeId) continue;
      }
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
                    workspaceResolved &&
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
    if (!workspaceResolved) {
      if (workspaceResolutionAttempted) continue;
      try {
        await dependencies.resolveWorkspace(run.workspaceId);
      } catch (error) {
        dependencies.recordError(
          `Canonical workflow run ${run.id} could not be rehydrated: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }
    try {
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
