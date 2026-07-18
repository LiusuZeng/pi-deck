export type RuntimeSelectionReason = "requested" | "none";

/**
 * A renderer action is scoped to the runtime ID it supplied. Never redirect a
 * stale action to the currently active (or any other) worker: that could send
 * a prompt, abort, or close operation to the wrong conversation.
 */
export interface RuntimeSelectionInput {
  requestedRuntimeId: string;
  hasRuntime(runtimeId: string): boolean;
}

export interface RuntimeSelection {
  runtimeId?: string;
  reason: RuntimeSelectionReason;
}

export function selectAvailableRuntime(
  input: RuntimeSelectionInput,
): RuntimeSelection {
  if (input.hasRuntime(input.requestedRuntimeId)) {
    return { runtimeId: input.requestedRuntimeId, reason: "requested" };
  }

  return { reason: "none" };
}
