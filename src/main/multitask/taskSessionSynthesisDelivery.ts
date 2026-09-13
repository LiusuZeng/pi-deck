import { createHash, randomUUID } from "node:crypto";
import type { PersistedTaskSessionTask } from "./taskSessionOrchestrator.js";

/**
 * A Pi-owned user turn is the delivery receipt. The marker is deliberately an
 * HTML comment: it is stable machine data in transcript history but does not
 * render in markdown-capable Pi clients.
 */
export const synthesisDeliveryMarkerPrefix =
  "<!-- pi-deck-synthesis-delivery:v1:";
const synthesisDeliveryMarkerSuffix = " -->";

export interface SynthesisDelivery {
  id: string;
  /** External-dispatch attempt number, persisted before that dispatch. */
  attempt: number;
  /** Exact parent-turn content, including the receipt marker. */
  payload: string;
  payloadFingerprint: string;
  state: "dispatching" | "delivered";
}

export function synthesisDeliveryMarker(id: string): string {
  return `${synthesisDeliveryMarkerPrefix}${id}${synthesisDeliveryMarkerSuffix}`;
}

export function synthesisDeliveryPayload(input: {
  id?: string;
  attempt: number;
  originalPrompt: string;
  tasks: readonly PersistedTaskSessionTask[];
}): SynthesisDelivery {
  const id = input.id ?? randomUUID();
  const report = input.tasks
    .map(
      (task) =>
        `#${task.taskNumber} ${task.generatedName}: ${task.handoffSummary ?? task.lifecycle}`,
    )
    .join("\n");
  const payload = `${synthesisDeliveryMarker(id)}\nTask-session synthesis for: ${input.originalPrompt}\n\n${report}`;
  return {
    id,
    attempt: input.attempt,
    payload,
    payloadFingerprint: createHash("sha256").update(payload).digest("hex"),
    state: "dispatching",
  };
}

/** Exact marker matching avoids treating model prose as a delivery receipt. */
export function containsSynthesisDeliveryMarker(
  content: unknown,
  deliveryId: string,
): boolean {
  const marker = synthesisDeliveryMarker(deliveryId);
  if (typeof content === "string") return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some((part) =>
    typeof part === "string"
      ? part.includes(marker)
      : !!part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string" &&
        (part as { text: string }).text.includes(marker),
  );
}
