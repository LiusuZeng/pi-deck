import type { RuntimeEventLike } from "./sessionState.js";

export type FailureKind = "auth-required";

/**
 * Pi persists an assistant turn's authoritative terminal outcome here. A
 * tool-use turn is only an intermediate agent-loop step, while a missing
 * reason can be a streamed partial; neither proves repaired credentials.
 */
export function isSuccessfulTerminalAssistantCompletion(
  message: Record<string, unknown> | undefined,
): boolean {
  const stopReason = message?.stopReason;
  return stopReason === "stop" || stopReason === "length";
}

/** Legacy terminal events without a final assistant payload carry this proof. */
export function isSuccessfulTerminalStatus(status: unknown): boolean {
  return status === "completed" || status === "success";
}

const AUTH_MESSAGE =
  /\bprovided authentication token is (?:expired|revoked|invalid)\b/i;
const AUTH_FAILURE =
  /\b(?:authentication|authorization|oauth|refresh(?:[ -]?token)?)\b[^\n]{0,160}\b(?:expired|revoked|invalid|failed|failure)\b/i;
const AUTH_CODE = new Set([
  "invalid_grant",
  "invalid_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_reused",
]);
const NOT_AUTH =
  /\b(?:quota|usage limit|rate[ -]?limit|too many requests|model (?:not found|unsupported|unavailable))\b/i;

type FailureCandidate = {
  provider?: string;
  code?: string;
  messages: string[];
  /** The narrow provider-less wording needs an actual terminal error payload. */
  allowsProviderlessFallback: boolean;
};

/**
 * Classifies only Pi's OpenAI Codex OAuth credential failures. Pi RPC currently
 * does not promise a normalized error code, so each provider/code/message set
 * is evaluated as one failure record. This prevents one record's provider or
 * exclusion from changing a sibling record's diagnosis.
 */
export function classifyOpenAiCodexAuthFailure(
  event: RuntimeEventLike,
): FailureKind | undefined {
  for (const candidate of collectFailureCandidates(event)) {
    if (candidate.messages.some((message) => NOT_AUTH.test(message))) {
      continue;
    }
    const isCodex = candidate.provider === "openai-codex";
    const hasAuthCode =
      candidate.code !== undefined &&
      AUTH_CODE.has(candidate.code.toLowerCase());
    if (isCodex && hasAuthCode) return "auth-required";

    if (
      isCodex &&
      candidate.messages.some((message) => AUTH_MESSAGE.test(message))
    ) {
      return "auth-required";
    }
    if (
      isCodex &&
      candidate.messages.some((message) => AUTH_FAILURE.test(message))
    ) {
      return "auth-required";
    }

    // Pi's observed provider-less expiry shape is accepted only from the
    // terminal failing assistant/error payload, not arbitrary event history.
    if (
      candidate.provider === undefined &&
      candidate.allowsProviderlessFallback &&
      candidate.messages.some((message) => AUTH_MESSAGE.test(message))
    ) {
      return "auth-required";
    }
  }
  return undefined;
}

function collectFailureCandidates(event: RuntimeEventLike): FailureCandidate[] {
  const candidates: FailureCandidate[] = [];

  function visit(
    value: unknown,
    inheritedProvider: string | undefined,
    allowsProviderlessFallback: boolean,
    depth: number,
  ): void {
    if (depth > 4 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, undefined, false, depth + 1);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const provider =
      typeof record.provider === "string" ? record.provider : inheritedProvider;
    const messages = [record.errorMessage, record.message, record.error]
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    const code = typeof record.code === "string" ? record.code : undefined;
    const isFailurePayload =
      allowsProviderlessFallback ||
      record.type === "error" ||
      record.stopReason === "error" ||
      typeof record.errorMessage === "string" ||
      typeof record.error === "string";

    if (provider !== undefined || code !== undefined || messages.length > 0) {
      candidates.push({
        ...(provider !== undefined ? { provider } : {}),
        ...(code !== undefined ? { code } : {}),
        messages,
        allowsProviderlessFallback: isFailurePayload,
      });
    }

    // An error object is part of the same structured failure record, so it
    // inherits only its direct parent's provider. Other object branches are
    // independent records and must supply their own provider evidence.
    visit(record.error, provider, true, depth + 1);
    visit(record.message, undefined, true, depth + 1);
    visit(record.assistantMessageEvent, undefined, false, depth + 1);

    const messagesList = record.messages;
    if (Array.isArray(messagesList)) {
      // agent_end may carry a history-shaped messages array. Its terminal
      // assistant/error payload alone is relevant; never mine older history.
      for (let index = messagesList.length - 1; index >= 0; index -= 1) {
        const item = messagesList[index];
        if (
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).role === "assistant"
        ) {
          visit(item, undefined, true, depth + 1);
          break;
        }
      }
    }
  }

  visit(event, undefined, false, 0);
  return candidates;
}
