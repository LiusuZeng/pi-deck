import type { PiMessage, PiState } from "./pi/types.js";

export type ChatSnapshotMetadata =
  | { kind: "skipped"; title?: string }
  | { kind: "empty"; title?: string }
  | {
      kind: "messages";
      title?: string;
      messageCount: number;
      preview?: string;
      completedAtMs?: number;
    };

/**
 * Derives persistence metadata from a Pi snapshot without performing I/O or
 * making lifecycle decisions. Skipped and empty transcripts remain distinct
 * read results, but both keep transcript persistence fields sparse.
 */
export function deriveChatSnapshotMetadata(input: {
  state: PiState;
  messages: readonly PiMessage[];
  skipMessages?: boolean;
}): ChatSnapshotMetadata {
  const title =
    titleFromSessionName(input.state) ??
    (input.skipMessages ? undefined : titleFromMessages(input.messages));

  if (input.skipMessages) {
    return title === undefined
      ? { kind: "skipped" }
      : { kind: "skipped", title };
  }
  if (input.messages.length === 0) {
    return title === undefined ? { kind: "empty" } : { kind: "empty", title };
  }

  const preview = previewFromMessages(input.messages);
  const completedAtMs = completedAtFromMessages(input.messages);
  return {
    kind: "messages",
    ...(title === undefined ? {} : { title }),
    messageCount: input.messages.length,
    ...(preview === undefined ? {} : { preview }),
    ...(completedAtMs === undefined ? {} : { completedAtMs }),
  };
}

/** Maps derived metadata to the exact optional fields accepted by both stores. */
export function chatSnapshotPersistenceFields(metadata: ChatSnapshotMetadata): {
  title?: string;
  updatedAtMs?: number;
  completedAtMs?: number;
  messageCount?: number;
  preview?: string;
} {
  if (metadata.kind !== "messages") {
    return metadata.title === undefined ? {} : { title: metadata.title };
  }
  return {
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    updatedAtMs: Date.now(),
    messageCount: metadata.messageCount,
    ...(metadata.completedAtMs === undefined
      ? {}
      : { completedAtMs: metadata.completedAtMs }),
    ...(metadata.preview === undefined ? {} : { preview: metadata.preview }),
  };
}

function titleFromSessionName(state: PiState): string | undefined {
  return typeof state.sessionName === "string"
    ? normalizedText(state.sessionName, 64)
    : undefined;
}

function titleFromMessages(messages: readonly PiMessage[]): string | undefined {
  const firstUser = messages.find((message) => message.role === "user");
  return typeof firstUser?.content === "string"
    ? normalizedText(stripSynthesisDeliveryMarker(firstUser.content), 64)
    : undefined;
}

function previewFromMessages(
  messages: readonly PiMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    if (typeof content === "string") {
      return normalizedText(stripSynthesisDeliveryMarker(content), 160);
    }
  }
  return undefined;
}

function completedAtFromMessages(
  messages: readonly PiMessage[],
): number | undefined {
  const latestMessage = [...messages]
    .reverse()
    .find((message) => ["user", "assistant"].includes(message.role));
  if (latestMessage?.role !== "assistant") return undefined;

  const content =
    typeof latestMessage.content === "string" ? latestMessage.content : "";
  if (content.trim().length === 0 || isAssistantFailureMessage(latestMessage)) {
    return undefined;
  }
  return typeof latestMessage.createdAt === "number" &&
    Number.isFinite(latestMessage.createdAt)
    ? latestMessage.createdAt
    : undefined;
}

/** The durable synthesis receipt is transport metadata, not user-facing copy. */
function stripSynthesisDeliveryMarker(value: string): string {
  return value.replace(/^<!-- pi-deck-synthesis-delivery:v1:[^\s]+ -->\n?/, "");
}

function normalizedText(value: string, maxLength: number): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function isAssistantFailureMessage(message: PiMessage): boolean {
  return (
    message.status === "error" ||
    message.stopReason === "error" ||
    message.reason === "error" ||
    typeof message.errorMessage === "string" ||
    message.error !== undefined
  );
}
