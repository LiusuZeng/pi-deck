import type { ChatRuntimeEvent } from "../shared/types.js";

export type RuntimeMessageStreamKind = "text" | "thinking" | "other";

/**
 * Resolves the stable message identity emitted by both legacy fixture events
 * and production Pi assistant-message events. Non-string and malformed
 * candidates intentionally fall through to the next production variant.
 */
export function getRuntimeMessageIdentity(
  event: ChatRuntimeEvent,
): string | undefined {
  const direct = getString(event, "messageId");
  if (direct !== undefined) {
    return direct;
  }

  const message = getRecord(event, "message");
  const messageId = getString(message, "id");
  if (messageId !== undefined) {
    return messageId;
  }
  const responseId = getString(message, "responseId");
  if (responseId !== undefined) {
    return responseId;
  }

  const assistantEvent = getRecord(event, "assistantMessageEvent");
  const assistantResponseId = getString(assistantEvent, "responseId");
  if (assistantResponseId !== undefined) {
    return assistantResponseId;
  }
  return getString(getRecord(assistantEvent, "partial"), "responseId");
}

/**
 * Classifies Pi's nested assistant stream while retaining the legacy rule that
 * absent or malformed `type` values are treated as an untyped text stream.
 */
export function getRuntimeMessageStreamKind(
  event: ChatRuntimeEvent,
): RuntimeMessageStreamKind {
  const type = getString(getRecord(event, "assistantMessageEvent"), "type");
  if (type === undefined || type === "") {
    return "text";
  }
  if (type.includes("thinking")) {
    return "thinking";
  }
  if (type === "text_delta" || type.startsWith("text_") || type === "done") {
    return "text";
  }
  return "other";
}

function getRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value?.[key];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function getString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}
