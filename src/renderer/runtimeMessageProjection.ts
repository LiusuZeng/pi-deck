import type { ChatRuntimeEvent } from "../shared/types.js";
import {
  getRuntimeMessageIdentity,
  getRuntimeMessageStreamKind,
} from "./runtimeMessageClassification.js";
import {
  extractTextContent,
  extractThinkingContent,
} from "./sessionUsageProjection.js";

export type MessageTextUpdate = {
  content: string;
  mode: "replace" | "append";
};

export function getMessageUpdateId(
  event: ChatRuntimeEvent,
): string | undefined {
  return getRuntimeMessageIdentity(event);
}

export function getMessageUpdateRole(
  event: ChatRuntimeEvent,
): string | undefined {
  return (
    getString(event, "role") ?? getString(getRecord(event, "message"), "role")
  );
}

export function getMessageTextUpdate(
  event: ChatRuntimeEvent,
): MessageTextUpdate | undefined {
  const directDelta = getString(event, "delta");
  const assistantDelta = getAssistantMessageDelta(event);
  if (directDelta !== undefined) {
    return { content: directDelta, mode: "append" };
  }
  if (assistantDelta !== undefined) {
    return { content: assistantDelta, mode: "append" };
  }

  const directContent = getString(event, "content");
  if (directContent !== undefined) {
    return { content: directContent, mode: "replace" };
  }

  const messageContent = getMessageUpdateContent(event);
  if (messageContent !== undefined) {
    return { content: messageContent, mode: "replace" };
  }

  const assistantContent = getAssistantMessageContent(event);
  if (assistantContent !== undefined) {
    return { content: assistantContent, mode: "replace" };
  }

  return undefined;
}

export function getAssistantMessageEventType(
  event: ChatRuntimeEvent,
): string | undefined {
  return getString(getRecord(event, "assistantMessageEvent"), "type");
}

export function getThinkingUpdateContent(
  event: ChatRuntimeEvent,
): string | undefined {
  const assistantEvent = getRecord(event, "assistantMessageEvent");
  if (getRuntimeMessageStreamKind(event) === "thinking") {
    return (
      getString(assistantEvent, "delta") ??
      getString(assistantEvent, "content") ??
      extractThinkingContent(assistantEvent?.partial)
    );
  }
  return extractThinkingContent(getRecord(event, "message")?.content);
}

function getMessageUpdateContent(event: ChatRuntimeEvent): string | undefined {
  return extractTextContent(getRecord(event, "message")?.content);
}

function getAssistantMessageDelta(event: ChatRuntimeEvent): string | undefined {
  const assistantEvent = getRecord(event, "assistantMessageEvent");
  const type = getString(assistantEvent, "type") ?? "";
  if (
    getRuntimeMessageStreamKind(event) !== "text" ||
    (type !== "" && type !== "text_delta")
  ) {
    return undefined;
  }
  return getString(assistantEvent, "delta");
}

function getAssistantMessageContent(
  event: ChatRuntimeEvent,
): string | undefined {
  const assistantEvent = getRecord(event, "assistantMessageEvent");
  const type = getString(assistantEvent, "type") ?? "";
  if (
    getRuntimeMessageStreamKind(event) === "other" ||
    (type !== "" && !type.startsWith("text_") && type !== "done")
  ) {
    return undefined;
  }
  if (type === "done") {
    return extractTextContent(assistantEvent?.partial);
  }
  return (
    getString(assistantEvent, "content") ??
    extractTextContent(assistantEvent?.partial)
  );
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
