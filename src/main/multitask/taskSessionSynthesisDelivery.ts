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
  /** Parent-boundary sends that have actually started; zero before the first. */
  attempt: number;
  /** Exact parent-turn content, including the receipt marker. */
  payload: string;
  payloadFingerprint: string;
  state: "dispatching" | "delivered";
}

export function synthesisDeliveryMarker(id: string): string {
  return `${synthesisDeliveryMarkerPrefix}${id}${synthesisDeliveryMarkerSuffix}`;
}

export function synthesisDeliveryFingerprint(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
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
    payloadFingerprint: synthesisDeliveryFingerprint(payload),
    state: "dispatching",
  };
}

/**
 * Normalize Pi's textual multipart representation without discarding any
 * content. A non-text part cannot be an exact receipt for this text payload.
 */
export function normalizedSynthesisDeliveryContent(
  content: unknown,
): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    )
      parts.push((part as { text: string }).text);
    else return undefined;
  }
  return parts.join("");
}

/**
 * Pi's durable user turn is a receipt only when it contains the entire
 * write-ahead payload. The marker identifies an outbox record but is never an
 * acknowledgement on its own.
 */
export function matchesSynthesisDeliveryReceipt(
  content: unknown,
  delivery: Pick<SynthesisDelivery, "payload" | "payloadFingerprint">,
): boolean {
  const normalized = normalizedSynthesisDeliveryContent(content);
  return (
    normalized !== undefined &&
    (normalized === delivery.payload ||
      synthesisDeliveryFingerprint(normalized) === delivery.payloadFingerprint)
  );
}
