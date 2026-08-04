import { recoverWorkflowRun } from "./workflowEngine.js";
import type { WorkflowRun } from "../../shared/workflowSchemas.js";

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
 */
export async function rehydrateWorkflowRuns(
  persistedRuns: readonly WorkflowRun[],
  dependencies: WorkflowRehydrationDependencies,
  now = Date.now(),
): Promise<void> {
  for (const persisted of persistedRuns) {
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
