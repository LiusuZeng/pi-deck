import type { ChatListModelsResult } from "../shared/types.js";

export type WorkspaceDraftDefaults = ReadonlyMap<string, ChatListModelsResult>;

export const emptyDraftModelConfiguration = (): ChatListModelsResult => ({
  models: [],
  thinkingLevels: [],
});

/**
 * Defaults are keyed by workspace so a delayed discovery completion can update
 * its owner without replacing the defaults used by another active workspace.
 */
export function draftDefaultsForWorkspace(
  defaultsByWorkspace: WorkspaceDraftDefaults,
  workspaceId: string,
): ChatListModelsResult | undefined {
  return defaultsByWorkspace.get(workspaceId);
}

/**
 * Own the asynchronous activation boundary and read defaults only afterwards.
 * The production workspace switch uses this operation to create a draft from
 * the latest workspace-owned defaults rather than a render-time closure.
 */
export async function createDraftAfterWorkspaceActivation<
  Activation,
  Draft,
>(options: {
  workspaceId: string;
  activation: Promise<Activation>;
  readDefaults(): WorkspaceDraftDefaults;
  createDraft(
    activation: Activation,
    configuration: ChatListModelsResult | undefined,
  ): Draft;
}): Promise<{ activation: Activation; draft: Draft }> {
  const activation = await options.activation;
  return {
    activation,
    draft: options.createDraft(
      activation,
      draftDefaultsForWorkspace(options.readDefaults(), options.workspaceId),
    ),
  };
}
