export type PiMessageTimestamp = number | string;

/**
 * Pi keeps provider-native content parts on messages. Consumers may derive
 * display text, but must not replace or discard the original content value.
 */
export type PiMessageContent = string | readonly unknown[];

export interface PiMessageLike {
  role?: unknown;
  content?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
  status?: unknown;
  stopReason?: unknown;
  reason?: unknown;
  errorMessage?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface NormalizedPiMessage<T extends PiMessageLike = PiMessageLike> {
  /** The exact input object, retained for provider-specific consumers. */
  original: T;
  text?: string;
  timestampMs?: number;
  assistantFailedOrAborted: boolean;
}

export const PI_MESSAGE_TITLE_MAX_LENGTH = 80;
export const PI_MESSAGE_PREVIEW_MAX_LENGTH = 160;

/**
 * Extracts text-bearing parts while leaving the source payload untouched.
 * Metadata consumers use textPartsOnly so thinking/tool parts cannot become
 * titles or previews; streaming compatibility may retain legacy text-bearing
 * parts until Pi classifies them separately.
 */
export function extractPiMessageText(
  content: unknown,
  options: { textPartsOnly?: boolean } = {},
): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content.flatMap((part): string[] => {
    if (!isRecord(part)) return [];
    // Current Pi messages use { type: "text", text }. Accept an omitted type
    // for older provider adapters, but never treat thinking/tool/image parts as
    // transcript text merely because they happen to expose a text property.
    if (
      typeof part.text === "string" &&
      (!options.textPartsOnly ||
        part.type === undefined ||
        part.type === "text")
    ) {
      return [part.text];
    }
    return [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function parsePiMessageTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Message createdAt wins; RPC/message timestamp then JSONL envelope follows. */
export function piMessageTimestampMs(
  message: PiMessageLike,
  envelopeTimestamp?: unknown,
): number | undefined {
  return (
    parsePiMessageTimestamp(message.createdAt) ??
    parsePiMessageTimestamp(message.timestamp) ??
    parsePiMessageTimestamp(envelopeTimestamp)
  );
}

export function isPiAssistantFailureOrAbort(
  message: PiMessageLike,
  envelope?: PiMessageLike,
): boolean {
  const terminalValues = [
    envelope?.status,
    envelope?.stopReason,
    envelope?.reason,
    message.status,
    message.stopReason,
    message.reason,
  ];
  return (
    terminalValues.some(
      (value) => value === "error" || value === "aborted" || value === "abort",
    ) ||
    typeof message.errorMessage === "string" ||
    message.error !== undefined ||
    typeof envelope?.errorMessage === "string" ||
    envelope?.error !== undefined
  );
}

export function normalizePiMessage<T extends PiMessageLike>(
  message: T,
  envelopeTimestamp?: unknown,
  envelope?: PiMessageLike,
): NormalizedPiMessage<T> {
  const text = extractPiMessageText(message.content, { textPartsOnly: true });
  const timestampMs = piMessageTimestampMs(message, envelopeTimestamp);
  return {
    original: message,
    ...(text === undefined ? {} : { text }),
    ...(timestampMs === undefined ? {} : { timestampMs }),
    assistantFailedOrAborted: isPiAssistantFailureOrAbort(message, envelope),
  };
}

/** Internal delivery receipts are transport metadata, never display copy. */
export function stripPiDeckSynthesisDeliveryMarker(value: string): string {
  return value.replace(/^<!-- pi-deck-synthesis-delivery:v1:[^\s]+ -->\n?/, "");
}

export function normalizePiMessageDisplayText(
  value: string,
  maxLength: number,
): string | undefined {
  const normalized = stripPiDeckSynthesisDeliveryMarker(value)
    .trim()
    .replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
