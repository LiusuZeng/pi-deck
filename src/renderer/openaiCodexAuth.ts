import type { RuntimeEventLike } from "./sessionState.js";

export type FailureKind = "auth-required";

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

/**
 * Classifies only Pi's OpenAI Codex OAuth credential failures. Pi RPC currently
 * does not promise a normalized error code, so structured provider/code data
 * wins when present and the observed token-expiry wording is the narrow
 * provider-less fallback. Raw diagnostics remain owned by the caller.
 */
export function classifyOpenAiCodexAuthFailure(
  event: RuntimeEventLike,
): FailureKind | undefined {
  const records = collectRecords(event);
  const providerKnown = records.some(
    (record) => record.provider === "openai-codex",
  );
  const nonCodexProviderKnown = records.some(
    (record) =>
      typeof record.provider === "string" && record.provider !== "openai-codex",
  );
  const messages = records.flatMap((record) =>
    [record.errorMessage, record.message, record.error]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()),
  );
  if (messages.some((message) => NOT_AUTH.test(message))) return undefined;

  const hasStructuredAuthCode = records.some(
    (record) =>
      typeof record.code === "string" &&
      AUTH_CODE.has(record.code.toLowerCase()),
  );
  if (providerKnown && hasStructuredAuthCode) return "auth-required";

  // `Provided authentication token is expired.` is Pi's observed, providerless
  // failure shape. Do not broaden this fallback to generic authentication text.
  if (
    (providerKnown || !nonCodexProviderKnown) &&
    messages.some((message) => AUTH_MESSAGE.test(message))
  ) {
    return "auth-required";
  }
  return providerKnown && messages.some((message) => AUTH_FAILURE.test(message))
    ? "auth-required"
    : undefined;
}

function collectRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRecords(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const nested = [
    record.error,
    record.message,
    record.assistantMessageEvent,
    record.messages,
  ].flatMap((item) => collectRecords(item, depth + 1));
  return [record, ...nested];
}
