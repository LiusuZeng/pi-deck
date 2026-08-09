export const agentWorkflowsUnavailableMessage =
  "Agent Workflows unavailable. Check Diagnostics for workflow metadata errors, then restart Pi Deck.";

export type WorkflowInitialization<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; diagnostic: string };

export async function initializeWorkflows<T>(
  initialize: () => Promise<T>,
): Promise<WorkflowInitialization<T>> {
  try {
    return { status: "available", value: await initialize() };
  } catch (error) {
    return {
      status: "unavailable",
      diagnostic:
        `Agent Workflows unavailable: workflow metadata could not be initialized. ` +
        `Existing workflow metadata was left unchanged. ${formatError(error)}`,
    };
  }
}

export function requireAgentWorkflows<T>(
  initialization: WorkflowInitialization<T> | undefined,
): T {
  if (initialization?.status !== "available") {
    throw new Error(agentWorkflowsUnavailableMessage);
  }
  return initialization.value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
