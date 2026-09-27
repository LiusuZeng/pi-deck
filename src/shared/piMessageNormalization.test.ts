import { describe, expect, it } from "vitest";
import {
  extractPiMessageText,
  isPiAssistantFailureOrAbort,
  normalizePiMessage,
  piMessageTimestampMs,
} from "./piMessageNormalization.js";

describe("Pi message normalization", () => {
  it("extracts string and structured text while ignoring non-text parts", () => {
    expect(extractPiMessageText("plain")).toBe("plain");
    expect(
      extractPiMessageText(
        [
          { type: "thinking", text: "hidden" },
          { type: "text", text: "one" },
          { type: "image", data: "abc" },
          { text: "legacy" },
          { type: "text", text: "two" },
        ],
        { textPartsOnly: true },
      ),
    ).toBe("one\nlegacy\ntwo");
    expect(
      extractPiMessageText([{ type: "thinking", text: "stream projection" }]),
    ).toBe("stream projection");
    expect(extractPiMessageText([{ type: "text", text: "" }])).toBe("");
    expect(
      extractPiMessageText([{ type: "image", data: "abc" }]),
    ).toBeUndefined();
  });

  it("preserves the exact source object in the normalized view", () => {
    const original = {
      id: "assistant-1",
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        { type: "provider-private", payload: { keep: true } },
      ],
      providerMetadata: { responseId: "response-1" },
    };
    const normalized = normalizePiMessage(original);
    expect(normalized.original).toBe(original);
    expect(normalized.original.content).toBe(original.content);
    expect(normalized.text).toBe("answer");
  });

  it("normalizes createdAt, message timestamp, and envelope fallback order", () => {
    expect(
      piMessageTimestampMs(
        {
          createdAt: "2026-09-14T10:00:00.000Z",
          timestamp: "2026-09-14T11:00:00.000Z",
        },
        "2026-09-14T12:00:00.000Z",
      ),
    ).toBe(Date.parse("2026-09-14T10:00:00.000Z"));
    expect(
      piMessageTimestampMs(
        { timestamp: "2026-09-14T11:00:00.000Z" },
        "2026-09-14T12:00:00.000Z",
      ),
    ).toBe(Date.parse("2026-09-14T11:00:00.000Z"));
    expect(piMessageTimestampMs({}, 123)).toBe(123);
  });

  it("classifies assistant errors and aborts independently from content", () => {
    expect(
      isPiAssistantFailureOrAbort({
        content: [{ type: "text", text: "partial" }],
        stopReason: "aborted",
      }),
    ).toBe(true);
    expect(
      isPiAssistantFailureOrAbort(
        { content: [{ type: "text", text: "partial" }] },
        { status: "error" },
      ),
    ).toBe(true);
    expect(
      isPiAssistantFailureOrAbort({
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      }),
    ).toBe(false);
  });
});
