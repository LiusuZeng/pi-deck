import { describe, expect, it } from "vitest";
import type { ChatRuntimeEvent } from "../shared/types.js";
import {
  getRuntimeMessageIdentity,
  getRuntimeMessageStreamKind,
  type RuntimeMessageStreamKind,
} from "./runtimeMessageClassification.js";

function messageUpdate(fields: Record<string, unknown>): ChatRuntimeEvent {
  return {
    type: "message_update",
    runtimeId: "runtime-1",
    ...fields,
  } as ChatRuntimeEvent;
}

describe("runtime message classification", () => {
  it("uses the canonical production identity fallback order", () => {
    const cases: Array<[string, Record<string, unknown>, string | undefined]> =
      [
        ["legacy messageId", { messageId: "direct" }, "direct"],
        [
          "production message id",
          { message: { id: "message-id" } },
          "message-id",
        ],
        [
          "production message response id",
          { message: { responseId: "message-response" } },
          "message-response",
        ],
        [
          "production assistant response id",
          { assistantMessageEvent: { responseId: "assistant-response" } },
          "assistant-response",
        ],
        [
          "production assistant partial response id",
          {
            assistantMessageEvent: {
              partial: { responseId: "partial-response" },
            },
          },
          "partial-response",
        ],
        ["empty event", {}, undefined],
        [
          "malformed identity candidates",
          {
            messageId: 1,
            message: { id: [], responseId: {} },
            assistantMessageEvent: { responseId: null, partial: [] },
          },
          undefined,
        ],
      ];

    for (const [name, fields, expected] of cases) {
      expect(getRuntimeMessageIdentity(messageUpdate(fields)), name).toBe(
        expected,
      );
    }

    expect(
      getRuntimeMessageIdentity(
        messageUpdate({
          messageId: "direct",
          message: { id: "message-id", responseId: "message-response" },
          assistantMessageEvent: {
            responseId: "assistant-response",
            partial: { responseId: "partial-response" },
          },
        }),
      ),
    ).toBe("direct");
  });

  it("classifies production, legacy, and malformed assistant streams", () => {
    const cases: Array<
      [string, Record<string, unknown>, RuntimeMessageStreamKind]
    > = [
      ["empty event remains legacy text", {}, "text"],
      ["legacy direct event", { delta: "text" }, "text"],
      [
        "legacy untyped assistant event",
        { assistantMessageEvent: { delta: "text" } },
        "text",
      ],
      [
        "production text delta",
        { assistantMessageEvent: { type: "text_delta" } },
        "text",
      ],
      [
        "production text snapshot",
        { assistantMessageEvent: { type: "text_start" } },
        "text",
      ],
      [
        "production done snapshot",
        { assistantMessageEvent: { type: "done" } },
        "text",
      ],
      [
        "production thinking delta",
        { assistantMessageEvent: { type: "thinking_delta" } },
        "thinking",
      ],
      [
        "production thinking snapshot",
        { assistantMessageEvent: { type: "thinking_end" } },
        "thinking",
      ],
      [
        "ambiguous text-thinking stream prefers thinking classification",
        { assistantMessageEvent: { type: "text_thinking_delta" } },
        "thinking",
      ],
      [
        "production tool call",
        { assistantMessageEvent: { type: "toolcall_delta" } },
        "other",
      ],
      [
        "production error",
        { assistantMessageEvent: { type: "error" } },
        "other",
      ],
      [
        "future assistant stream",
        { assistantMessageEvent: { type: "image_delta" } },
        "other",
      ],
      [
        "malformed numeric type remains legacy text",
        { assistantMessageEvent: { type: 1, delta: "text" } },
        "text",
      ],
      [
        "malformed array event remains legacy text",
        { assistantMessageEvent: [] },
        "text",
      ],
    ];

    for (const [name, fields, expected] of cases) {
      expect(getRuntimeMessageStreamKind(messageUpdate(fields)), name).toBe(
        expected,
      );
    }
  });
});
