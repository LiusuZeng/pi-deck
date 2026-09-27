import type { ChatListModelsResult } from "../shared/types.js";

export interface ScopedDraftDefaults {
  workspaceId: string;
  configuration: ChatListModelsResult;
}

export const emptyDraftModelConfiguration = (): ChatListModelsResult => ({
  models: [],
  thinkingLevels: [],
});

/**
 * Defaults are workspace-scoped and read after async navigation barriers.
 * Callers must not reuse a render-time configuration captured before await.
 */
export function draftDefaultsForWorkspace(
  latest: ScopedDraftDefaults,
  workspaceId: string,
): ChatListModelsResult | undefined {
  return latest.workspaceId === workspaceId ? latest.configuration : undefined;
}
