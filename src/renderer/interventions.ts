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
  content: string;
}

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
 * Match durable user turns by occurrence, never by a global content set. This
 * reserves existing ordinary user turns first, then consumes one intervention
 * for each remaining durable occurrence. Identical repeated instructions are
 * therefore preserved rather than deduplicated.
 */
export function matchDurableInterventionMessages(options: {
  interventions: readonly InterventionTimelineItem[];
  existingUsers: readonly ExistingUserMessageEvidence[];
  durableUsers: readonly DurableUserMessageEvidence[];
}): DurableInterventionMatchResult {
  const interventions = [...options.interventions];
  const usedOrdinaryUsers = new Set<string>();
  const usedInterventions = new Set<string>();
  const interventionByDurableId = new Map(
    interventions.flatMap((item) =>
      item.durableMessageId === undefined
        ? []
        : ([[item.durableMessageId, item]] as const),
    ),
  );
  const ordinaryById = new Map(
    options.existingUsers.map((item) => [item.id, item] as const),
  );
  const unmatchedDurableMessages: DurableUserMessageEvidence[] = [];

  for (const durable of options.durableUsers) {
    const alreadyConsumed = interventionByDurableId.get(durable.id);
    if (alreadyConsumed !== undefined) {
      usedInterventions.add(alreadyConsumed.id);
      continue;
    }

    const exactOrdinary = ordinaryById.get(durable.id);
    if (exactOrdinary !== undefined) {
      usedOrdinaryUsers.add(exactOrdinary.id);
      continue;
    }

    const ordinary = options.existingUsers.find(
      (item) =>
        !usedOrdinaryUsers.has(item.id) && item.content === durable.content,
    );
    if (ordinary !== undefined) {
      usedOrdinaryUsers.add(ordinary.id);
      continue;
    }

    const interventionIndex = interventions.findIndex(
      (item) =>
        !usedInterventions.has(item.id) &&
        item.status !== "failed" &&
        item.durableMessageId === undefined &&
        item.content === durable.content,
    );
    if (interventionIndex >= 0) {
      const intervention = interventions[interventionIndex]!;
      interventions[interventionIndex] = {
        ...intervention,
        status: "consumed",
        durableMessageId: durable.id,
      };
      usedInterventions.add(intervention.id);
      continue;
    }

    unmatchedDurableMessages.push(durable);
  }

  return { interventions, unmatchedDurableMessages };
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
