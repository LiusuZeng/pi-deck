import type { AttachmentDraft, PiDeckApi } from "../shared/types.js";

export interface AttachmentMergeResult {
  attachments: AttachmentDraft[];
  /** Newly imported drafts rejected by local deduplication and safe to revoke. */
  discarded: AttachmentDraft[];
}

type AttachmentApi = PiDeckApi["attachments"];

/** Allocate a one-use owner generation for a stable/reusable session ID. */
export function getOrCreateAttachmentOwnerGeneration(
  ownersBySession: Map<string, string>,
  blockedSessionIds: Set<string>,
  sessionId: string,
  createOwnerId: () => string,
): string {
  const existing = ownersBySession.get(sessionId);
  if (existing !== undefined) {
    return existing;
  }
  const ownerId = createOwnerId();
  ownersBySession.set(sessionId, ownerId);
  blockedSessionIds.delete(sessionId);
  return ownerId;
}

export function attachmentTokens(
  attachments: readonly AttachmentDraft[],
): string[] {
  return [
    ...new Set(
      attachments
        .map((attachment) => attachment.selectedPathToken)
        .filter((token) => token.trim().length > 0),
    ),
  ];
}

/** Missing/unreadable drafts never received a main-process selection record. */
export function readyAttachmentTokens(
  attachments: readonly AttachmentDraft[],
): string[] {
  return attachmentTokens(
    attachments.filter((attachment) => attachment.status === "ready"),
  );
}

/**
 * Do not keep tokens returned by main when the renderer drops a duplicate chip.
 * Token identity is included in addition to display identity so one token can
 * never back two independently removable chips.
 */
export function mergeAttachmentDrafts(
  existing: readonly AttachmentDraft[],
  incoming: readonly AttachmentDraft[],
): AttachmentMergeResult {
  const attachments = [...existing];
  const discarded: AttachmentDraft[] = [];
  const identities = new Set(existing.map(attachmentDedupKey));
  const tokens = new Set(
    existing.map((attachment) => attachment.selectedPathToken),
  );

  for (const attachment of incoming) {
    const identity = attachmentDedupKey(attachment);
    if (identities.has(identity) || tokens.has(attachment.selectedPathToken)) {
      discarded.push(attachment);
      continue;
    }
    identities.add(identity);
    tokens.add(attachment.selectedPathToken);
    attachments.push(attachment);
  }

  return { attachments, discarded };
}

export async function releaseAttachmentTokens(
  api: Pick<AttachmentApi, "release">,
  ownerId: string,
  selectedPathTokens: readonly string[],
): Promise<void> {
  const tokens = [...new Set(selectedPathTokens)];
  if (tokens.length === 0) {
    return;
  }
  await api.release({ ownerId, selectedPathTokens: tokens });
}

export async function releaseAttachmentOwner(
  api: Pick<AttachmentApi, "releaseOwner">,
  ownerId: string,
): Promise<void> {
  await api.releaseOwner({ ownerId });
}

/** Move retained ready selections from a renderer draft id to a Pi runtime id. */
export async function transferAttachmentOwnership(
  api: Pick<AttachmentApi, "assignOwner">,
  previousOwnerId: string,
  previousSessionId: string,
  ownerId: string,
  sessionId: string,
  attachments: readonly AttachmentDraft[],
): Promise<void> {
  const selectedPathTokens = readyAttachmentTokens(attachments);
  if (selectedPathTokens.length === 0) {
    return;
  }
  await api.assignOwner({
    selectedPathTokens,
    previousOwnerId,
    previousSessionId,
    ownerId,
    sessionId,
  });
}

function attachmentDedupKey(attachment: AttachmentDraft): string {
  return [
    attachment.kind,
    attachment.sendMode,
    attachment.displayPath,
    attachment.size ?? "unknown-size",
  ].join("|");
}
