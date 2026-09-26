import type { WorkspaceStore } from "./workspaces/workspaceStore.js";

/** The workspace store operations needed by chat ownership resolution. */
export type ChatWorkspaceLookupStore = Pick<
  WorkspaceStore,
  "getSessionOwner" | "ensureDefaultWorkspace"
>;

export type ChatWorkspaceOwnershipStore = ChatWorkspaceLookupStore &
  Pick<WorkspaceStore, "claimUnassignedSessionRefFromSnapshot">;

export interface ChatResumeOwnershipLease {
  release(): void;
}

export interface ChatResumeOwnershipGate<
  TLease extends ChatResumeOwnershipLease = ChatResumeOwnershipLease,
> {
  enter(generation: number): Promise<TLease>;
}

/**
 * Hold the discovery/attachment gate across resume ownership authorization and
 * the eventual validated claim. Callers that already hold this lease must pass
 * it through to worker attachment rather than trying to enter the gate again.
 */
export async function withChatResumeOwnershipTransaction<
  T,
  TLease extends ChatResumeOwnershipLease,
>(options: {
  gate: ChatResumeOwnershipGate<TLease>;
  generation: number;
  assertActive: () => void;
  /** Read-only rejection of existing reservations; never resolves ownership. */
  assertAvailable?: () => Promise<void>;
  operation: (lease: TLease) => Promise<T>;
}): Promise<T> {
  options.assertActive();
  // A request for an already-reserved fork must fail now, not silently wait
  // until the fork commits and attach it. Availability is rechecked during
  // the operation; this preflight does not authorize or claim the session.
  await options.assertAvailable?.();
  options.assertActive();
  const lease = await options.gate.enter(options.generation);
  try {
    options.assertActive();
    const result = await options.operation(lease);
    options.assertActive();
    return result;
  } finally {
    lease.release();
  }
}

/**
 * Compatibility chat creation may omit ownership at the IPC boundary, but a
 * runtime must always be registered against a concrete workspace.
 */
export function resolveChatCreationWorkspaceId(
  requestedWorkspaceId: string | undefined,
  defaultWorkspaceId: string | undefined,
): string {
  const workspaceId = requestedWorkspaceId ?? defaultWorkspaceId;
  if (workspaceId === undefined) {
    throw new Error("Chat session creation requires a workspace.");
  }
  return workspaceId;
}

/**
 * Resolve an omitted-workspace resume in ownership order. Explicit workspace
 * requests are validated separately by the main-process membership seam; a
 * persisted owner wins over the default fallback so an omitted legacy
 * workspace cannot silently move a saved session.
 */
export function resolveChatResumeWorkspaceId(
  existingWorkspaceId: string | undefined,
  defaultWorkspaceId: string | undefined,
): string {
  const workspaceId = existingWorkspaceId ?? defaultWorkspaceId;
  if (workspaceId === undefined) {
    throw new Error("Chat session resume requires a workspace.");
  }
  return workspaceId;
}

export interface ChatResumeWorkspaceResolution {
  workspaceId: string;
  source: "existing" | "default";
}

/**
 * Look up ownership by the store's canonical session-file key. A missing
 * owner is intentionally not claimed here: the caller must first validate the
 * Pi file, then use claimUnassignedChatResumeWorkspace so invalid paths never
 * leave durable default-workspace metadata behind.
 */
export async function resolveChatResumeWorkspace(
  store: ChatWorkspaceLookupStore,
  sessionFile: string,
): Promise<ChatResumeWorkspaceResolution> {
  const owner = await store.getSessionOwner(sessionFile);
  if (owner !== undefined) {
    return {
      workspaceId: resolveChatResumeWorkspaceId(owner.workspaceId, undefined),
      source: "existing",
    };
  }

  const defaultWorkspace = await store.ensureDefaultWorkspace();
  return {
    workspaceId: resolveChatResumeWorkspaceId(undefined, defaultWorkspace.id),
    source: "default",
  };
}

/**
 * Claim an unassigned, already-validated session for the stable default. The
 * store performs the owner check and insertion in one mutation seam, so a
 * concurrent explicit move cannot be silently overwritten.
 */
export async function claimUnassignedChatResumeWorkspace(
  store: ChatWorkspaceOwnershipStore,
  workspaceId: string,
  sessionFile: string,
): Promise<void> {
  const result = await store.claimUnassignedSessionRefFromSnapshot({
    workspaceId,
    sessionFile,
  });
  if (result.workspaceId !== workspaceId) {
    throw new Error(
      "Session workspace ownership changed while it was being resumed.",
    );
  }
}

/** Recheck an existing owner after Pi-file validation and before worker spawn. */
export async function assertChatResumeWorkspaceOwnership(
  store: ChatWorkspaceLookupStore,
  workspaceId: string,
  sessionFile: string,
): Promise<void> {
  const owner = await store.getSessionOwner(sessionFile);
  if (owner === undefined) {
    throw new Error("Session is no longer assigned to a workspace.");
  }
  if (owner.workspaceId !== workspaceId) {
    throw new Error(
      "Session workspace ownership changed while it was being resumed.",
    );
  }
}
