import type { PiMessage, PiState } from "./pi/types.js";

export type ChatSnapshotMetadata =
  | { kind: "skipped"; title?: string }
  | { kind: "empty"; title?: string; messageCount: 0 }
  | {
      kind: "messages";
      title?: string;
      messageCount: number;
      preview?: string;
      completedAtMs?: number;
    };

/**
 * Derives persistence metadata from a Pi snapshot without performing I/O or
 * making lifecycle decisions. A skipped transcript deliberately remains
 * distinct from an authoritative, empty transcript.
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
    return title === undefined
      ? { kind: "empty", messageCount: 0 }
      : { kind: "empty", title, messageCount: 0 };
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

function titleFromSessionName(state: PiState): string | undefined {
  return typeof state.sessionName === "string"
    ? normalizedText(state.sessionName, 64)
    : undefined;
}

function titleFromMessages(messages: readonly PiMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") {
      continue;
    }
    const title = normalizedText(message.content, 64);
    if (title !== undefined) return title;
  }
  return undefined;
}

function previewFromMessages(
  messages: readonly PiMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    if (typeof content === "string") {
      return normalizedText(content, 160);
    }
  }
  return undefined;
}

function completedAtFromMessages(
  messages: readonly PiMessage[],
): number | undefined {
  let completedAtMs: number | undefined;
  for (const message of messages) {
    if (message.role === "user" || isFailureMessage(message)) {
      completedAtMs = undefined;
      continue;
    }
    if (message.role !== "assistant") continue;

    completedAtMs = undefined;
    if (
      typeof message.content === "string" &&
      message.content.trim().length > 0 &&
      isDateTimestamp(message.createdAt)
    ) {
      completedAtMs = message.createdAt;
    }
  }
  return completedAtMs;
}

function normalizedText(value: string, maxLength: number): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function isDateTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function isFailureMessage(message: PiMessage): boolean {
  return (
    message.status === "error" ||
    message.stopReason === "error" ||
    message.reason === "error" ||
    typeof message.errorMessage === "string" ||
    message.error !== undefined
  );
}
