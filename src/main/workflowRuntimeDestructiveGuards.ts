import type { WorkflowRuntimeOwnershipRegistry } from "./workflowRuntimeOwnership.js";

export function workflowRuntimeMutationBlockedMessage(action: string): string {
  return `Workflow runtime is still finalizing. Stop the workflow or wait for it to finish before ${action}.`;
}

export function assertRuntimeNotWorkflowOwned(
  ownership: WorkflowRuntimeOwnershipRegistry,
  runtimeId: string,
  action: string,
): void {
  if (!ownership.isOwned(runtimeId)) return;
  throw new Error(workflowRuntimeMutationBlockedMessage(action));
}

export function assertSessionFileNotWorkflowOwned(
  ownership: WorkflowRuntimeOwnershipRegistry,
  sessionFile: string,
  action: string,
): void {
  if (!ownership.isSessionFileOwned(sessionFile)) return;
  throw new Error(workflowRuntimeMutationBlockedMessage(action));
}

export function assertWorkspaceNotWorkflowOwned(
  ownership: WorkflowRuntimeOwnershipRegistry,
  workspaceId: string,
  action: string,
): void {
  if (!ownership.isWorkspaceOwned(workspaceId)) return;
  throw new Error(workflowRuntimeMutationBlockedMessage(action));
}

export function assertNoWorkflowRuntimesForReset(
  ownership: WorkflowRuntimeOwnershipRegistry,
): void {
  if (!ownership.hasOwnedRuntimes()) return;
  throw new Error(workflowRuntimeMutationBlockedMessage("resetting chat"));
}

export function chatSessionIsBusyForMutation(input: {
  canonicalSessionFile: string;
  sessionFileLocks: ReadonlyMap<string, string>;
  sessionResumePromises: ReadonlyMap<string, unknown>;
  sessionMutationReservations: ReadonlySet<string>;
  workflowRuntimeOwnership: WorkflowRuntimeOwnershipRegistry;
}): boolean {
  return (
    input.sessionFileLocks.has(input.canonicalSessionFile) ||
    input.sessionResumePromises.has(input.canonicalSessionFile) ||
    input.sessionMutationReservations.has(input.canonicalSessionFile) ||
    input.workflowRuntimeOwnership.isSessionFileOwned(
      input.canonicalSessionFile,
    )
  );
}
