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
    const lostRunning = persisted.occurrences.some(
      (item) => item.status === "running",
    );
    const hasQueued = persisted.occurrences.some(
      (item) => item.status === "queued",
    );
    const recovered =
      lostRunning || hasQueued
        ? workflowRunEnvelopeSchema.parse({
            ...persisted,
            status: lostRunning ? "needsAttention" : "waiting",
            updatedAtMs: now,
            occurrences: persisted.occurrences.map((item) =>
              item.status === "running"
                ? {
                    ...item,
                    status: "failed" as const,
                    error:
                      "Pi session was interrupted by restart; retry this occurrence.",
                    runtimeId: undefined,
                    updatedAtMs: now,
                  }
                : item.status === "queued"
                  ? { ...item, status: "ready" as const, updatedAtMs: now }
                  : item,
            ),
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
