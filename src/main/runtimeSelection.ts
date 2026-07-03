export type RuntimeSelectionReason =
  | "requested"
  | "active"
  | "fallback"
  | "none";

export interface RuntimeSelectionInput {
  requestedRuntimeId: string;
  activeRuntimeId?: string | undefined;
  runtimeIds: Iterable<string>;
  hasRuntime(runtimeId: string): boolean;
}

export interface RuntimeSelection {
  runtimeId?: string;
  reason: RuntimeSelectionReason;
}

export function selectAvailableRuntime(
  input: RuntimeSelectionInput,
): RuntimeSelection {
  const runtimeIds = [...input.runtimeIds];
  const knownRuntimeIds = new Set(runtimeIds);

  if (
    knownRuntimeIds.has(input.requestedRuntimeId) &&
    input.hasRuntime(input.requestedRuntimeId)
  ) {
    return { runtimeId: input.requestedRuntimeId, reason: "requested" };
  }

  if (
    input.activeRuntimeId !== undefined &&
    input.activeRuntimeId !== input.requestedRuntimeId &&
    input.hasRuntime(input.activeRuntimeId)
  ) {
    return { runtimeId: input.activeRuntimeId, reason: "active" };
  }

  const fallbackRuntimeId = runtimeIds.find(
    (runtimeId) =>
      runtimeId !== input.requestedRuntimeId && input.hasRuntime(runtimeId),
  );
  if (fallbackRuntimeId !== undefined) {
    return { runtimeId: fallbackRuntimeId, reason: "fallback" };
  }

  return { reason: "none" };
}
