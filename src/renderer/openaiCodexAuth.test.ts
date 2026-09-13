import { describe, expect, it } from "vitest";
import { classifyOpenAiCodexAuthFailure } from "./openaiCodexAuth.js";

describe("classifyOpenAiCodexAuthFailure", () => {
  it.each([
    "Provided authentication token is expired.",
    "OpenAI Codex refresh token was revoked.",
    "OAuth refresh failed because token is invalid.",
  ])("classifies narrow OpenAI Codex OAuth failures: %s", (errorMessage) => {
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "message_update",
        message: { provider: "openai-codex", errorMessage },
      }),
    ).toBe("auth-required");
  });

  it("uses the observed expired-token wording when Pi omits provider data", () => {
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            errorMessage: "Provided authentication token is expired.",
          },
        ],
      }),
    ).toBe("auth-required");
  });

  it.each([
    "Usage limit reached for fake provider.",
    "Rate limit exceeded.",
    "Model not found: gpt-5-codex",
  ])("does not misclassify non-auth provider failures: %s", (errorMessage) => {
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "message_update",
        message: { provider: "openai-codex", errorMessage },
      }),
    ).toBeUndefined();
  });

  it("does not treat another provider's expired token as OpenAI Codex auth", () => {
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "message_update",
        message: {
          provider: "anthropic",
          errorMessage: "Provided authentication token is expired.",
        },
      }),
    ).toBeUndefined();
  });

  it("uses structured invalid_grant data for OpenAI Codex only", () => {
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "agent_end",
        message: { provider: "openai-codex", error: { code: "invalid_grant" } },
      }),
    ).toBe("auth-required");
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "agent_end",
        message: { provider: "anthropic", error: { code: "invalid_grant" } },
      }),
    ).toBeUndefined();
  });

  it("does not combine a Codex provider with a sibling structured auth code", () => {
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "agent_end",
        messages: [
          { role: "assistant", provider: "openai-codex", content: "normal" },
          {
            role: "assistant",
            provider: "anthropic",
            error: { code: "invalid_grant" },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("does not combine a Codex provider with another record's OAuth message", () => {
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "message_update",
        message: { provider: "openai-codex", content: "normal" },
        assistantMessageEvent: {
          type: "error",
          error: {
            provider: "anthropic",
            errorMessage: "OAuth refresh token is expired.",
          },
        },
      }),
    ).toBeUndefined();
  });

  it("does not let an unrelated rate-limit record suppress a Codex expiry", () => {
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "message_update",
        message: {
          provider: "openai-codex",
          stopReason: "error",
          errorMessage: "Provided authentication token is expired.",
        },
        assistantMessageEvent: {
          type: "error",
          error: {
            provider: "anthropic",
            errorMessage: "Rate limit exceeded.",
          },
        },
      }),
    ).toBe("auth-required");
  });

  it("does not use an old provider-less expiry from terminal history", () => {
    expect(
      classifyOpenAiCodexAuthFailure({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            errorMessage: "Provided authentication token is expired.",
          },
          { role: "assistant", content: "new terminal message" },
        ],
      }),
    ).toBeUndefined();
  });
});
