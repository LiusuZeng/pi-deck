export type InterventionKind = "steer" | "followUp";

export type InterventionStatus =
  | "sending"
  | "queued"
  | "accepted"
  | "consumed"
  | "failed";

export interface InterventionAttachment {
  id: string;
  fileName: string;
  kind: "image" | "textFile" | "binaryFile";
  sendMode: "imageInput" | "pathReference";
  mimeType?: string;
  previewDataUrl?: string;
}

export interface InterventionTimelineItem {
  id: string;
  kind: "intervention";
  interventionKind: InterventionKind;
  status: InterventionStatus;
  content: string;
  createdAt: string;
  attachments?: InterventionAttachment[];
  /** Pi's durable message identity is recorded only after transcript evidence. */
  durableMessageId?: string;
  failureMessage?: string;
}

export interface DurableUserMessageEvidence {
  id: string;
  content: string;
  createdAt: string;
  attachments?: InterventionAttachment[];
}

export interface ExistingUserMessageEvidence {
  id: string;
  kind: "user";
  content: string;
  attachments?: InterventionAttachment[];
}

export type LocalUserMessageEvidence =
  | ExistingUserMessageEvidence
  | InterventionTimelineItem;

export function createInterventionTimelineItem(options: {
  id: string;
  interventionKind: InterventionKind;
  content: string;
  createdAt: string;
  attachments?: InterventionAttachment[];
}): InterventionTimelineItem {
  return {
    id: options.id,
    kind: "intervention",
    interventionKind: options.interventionKind,
    status: "sending",
    content: options.content,
    createdAt: options.createdAt,
    ...(options.attachments === undefined
      ? {}
      : { attachments: options.attachments }),
  };
}

export function markInterventionQueued(
  item: InterventionTimelineItem,
): InterventionTimelineItem {
  // A later queue-removal or durable-message observation must not be undone by
  // the command acknowledgement resolving out of order.
  return item.status === "sending" ? { ...item, status: "queued" } : item;
}

export function markInterventionFailed(
  item: InterventionTimelineItem,
  failureMessage: string,
): InterventionTimelineItem {
  if (item.status === "consumed") return item;
  return { ...item, status: "failed", failureMessage };
}

/**
 * Reconcile Pi's content-bearing queue evidence without treating disappearance
 * as proof of consumption. Queue entries are aligned from the tail so two
 * identical intentional submissions remain independently identifiable when Pi
 * consumes the earlier occurrence first.
 */
export function reconcileInterventionQueueEvidence(
  items: readonly InterventionTimelineItem[],
  queues: Partial<Record<InterventionKind, readonly string[]>>,
): InterventionTimelineItem[] {
  const nextStatus = new Map<string, InterventionStatus>();

  for (const interventionKind of ["steer", "followUp"] as const) {
    const queue = queues[interventionKind];
    if (queue === undefined) continue;
    const candidates = items.filter(
      (item) =>
        item.interventionKind === interventionKind &&
        item.status !== "failed" &&
        item.status !== "consumed",
    );
    const available = new Set(candidates.map((item) => item.id));

    for (let queueIndex = queue.length - 1; queueIndex >= 0; queueIndex -= 1) {
      const content = queue[queueIndex];
      for (
        let candidateIndex = candidates.length - 1;
        candidateIndex >= 0;
        candidateIndex -= 1
      ) {
        const candidate = candidates[candidateIndex]!;
        if (available.has(candidate.id) && candidate.content === content) {
          nextStatus.set(candidate.id, "queued");
          available.delete(candidate.id);
          break;
        }
      }
    }

    for (const candidate of candidates) {
      if (
        available.has(candidate.id) &&
        (candidate.status === "queued" || candidate.status === "accepted")
      ) {
        // Pi no longer reports this exact local occurrence in its queue. This
        // is not enough to say it was consumed; durable history must prove it.
        nextStatus.set(candidate.id, "accepted");
      }
    }
  }

  return items.map((item) => {
    const status = nextStatus.get(item.id);
    return status === undefined || status === item.status
      ? item
      : { ...item, status };
  });
}

export interface DurableInterventionMatchResult {
  interventions: InterventionTimelineItem[];
  unmatchedDurableMessages: DurableUserMessageEvidence[];
}

/**
 * Match durable user turns against the combined local timeline by occurrence.
 * Keeping ordinary turns and interventions in one sequence is important when
 * a snapshot races a newer optimistic prompt: that future prompt must not take
 * durable evidence that belongs to an earlier intervention with the same text.
 */
export function matchDurableInterventionMessages(options: {
  localTimeline: readonly LocalUserMessageEvidence[];
  durableUsers: readonly DurableUserMessageEvidence[];
}): DurableInterventionMatchResult {
  const interventions = options.localTimeline.filter(
    (item): item is InterventionTimelineItem => item.kind === "intervention",
  );
  const candidates = options.localTimeline.filter(
    (item) => item.kind === "user" || item.status !== "failed",
  );
  const usedCandidates = new Set<number>();
  const seenDurableIds = new Set<string>();
  const unmatchedDurableMessages: DurableUserMessageEvidence[] = [];

  for (const durable of options.durableUsers) {
    // A malformed/replayed snapshot row must not consume a second occurrence.
    if (seenDurableIds.has(durable.id)) continue;
    seenDurableIds.add(durable.id);

    const exactIndex = candidates.findIndex(
      (item, index) =>
        !usedCandidates.has(index) &&
        (item.kind === "user"
          ? item.id === durable.id
          : item.durableMessageId === durable.id),
    );
    const candidateIndex =
      exactIndex >= 0
        ? exactIndex
        : candidates.findIndex(
            (item, index) =>
              !usedCandidates.has(index) &&
              (item.kind === "user" || item.durableMessageId === undefined) &&
              sameUserMessageEvidence(item, durable),
          );

    if (candidateIndex < 0) {
      unmatchedDurableMessages.push(durable);
      continue;
    }

    usedCandidates.add(candidateIndex);
    const candidate = candidates[candidateIndex]!;
    if (candidate.kind === "user") continue;

    const interventionIndex = interventions.findIndex(
      (item) => item.id === candidate.id,
    );
    if (interventionIndex >= 0) {
      interventions[interventionIndex] = {
        ...candidate,
        status: "consumed",
        durableMessageId: durable.id,
      };
    }
  }

  return { interventions, unmatchedDurableMessages };
}

function sameUserMessageEvidence(
  local: LocalUserMessageEvidence,
  durable: DurableUserMessageEvidence,
): boolean {
  if (local.content !== durable.content) return false;
  // Streamed message events do not always carry attachment metadata. In that
  // case text is the available evidence; snapshots with attachments can make
  // the stronger comparison below.
  if (durable.attachments === undefined) return true;
  const localAttachments = local.attachments ?? [];
  if (localAttachments.length !== durable.attachments.length) return false;
  return localAttachments.every((attachment, index) => {
    const other = durable.attachments?.[index];
    return (
      other !== undefined &&
      normalizeAttachment(attachment) === normalizeAttachment(other)
    );
  });
}

function normalizeAttachment(attachment: InterventionAttachment): string {
  // IDs, names, MIME types, and previews are transport/UI details. Main may
  // resize an image before Pi persists it, and Pi may omit its original name.
  // The stable evidence is the ordered attachment kind and delivery mode.
  return `${attachment.kind}:${attachment.sendMode}`;
}

export function interventionTypeLabel(kind: InterventionKind): string {
  return kind === "steer" ? "Steering" : "Follow-up";
}

export function interventionStatusLabel(status: InterventionStatus): string {
  switch (status) {
    case "sending":
      return "sending";
    case "queued":
      return "queued";
    case "accepted":
      return "accepted · confirming transcript receipt";
    case "consumed":
      return "consumed by Pi";
    case "failed":
      return "failed to send";
  }
}

export function interventionAccessibleLabel(
  item: Pick<InterventionTimelineItem, "interventionKind" | "status">,
): string {
  return `${interventionTypeLabel(item.interventionKind)} ${interventionStatusLabel(item.status)}`;
}
