import { describe, expect, it } from "vitest";
import type { ChatRuntimeEvent } from "../shared/types.js";
import {
  getAssistantMessageEventType,
  getMessageTextUpdate,
  getMessageUpdateId,
  getMessageUpdateRole,
  getThinkingUpdateContent,
} from "./runtimeMessageProjection.js";

function messageUpdate(fields: Record<string, unknown>): ChatRuntimeEvent {
  return {
    type: "message_update",
    runtimeId: "runtime-1",
    ...fields,
  } as ChatRuntimeEvent;
}

describe("runtime message projection", () => {
  it("uses the production message identifier fallback order", () => {
    const cases: Array<[string, Record<string, unknown>, string | undefined]> =
      [
        ["direct messageId", { messageId: "direct" }, "direct"],
        ["message id", { message: { id: "message-id" } }, "message-id"],
        [
          "message response id",
          { message: { responseId: "message-response" } },
          "message-response",
        ],
        [
          "assistant response id",
          { assistantMessageEvent: { responseId: "assistant-response" } },
          "assistant-response",
        ],
        [
          "assistant partial response id",
          {
            assistantMessageEvent: {
              partial: { responseId: "partial-response" },
            },
          },
          "partial-response",
        ],
        [
          "malformed identifiers",
          {
            messageId: 1,
            message: { id: [], responseId: {} },
            assistantMessageEvent: { responseId: null, partial: [] },
          },
          undefined,
        ],
      ];

    for (const [name, fields, expected] of cases) {
      expect(getMessageUpdateId(messageUpdate(fields)), name).toBe(expected);
    }

    expect(
      getMessageUpdateId(
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

  it("projects text deltas and snapshots without accepting non-text assistant events", () => {
    const cases: Array<
      [
        string,
        Record<string, unknown>,
        { content: string; mode: "append" | "replace" } | undefined,
      ]
    > = [
      [
        "direct delta takes precedence",
        {
          delta: "direct",
          assistantMessageEvent: { type: "text_delta", delta: "assistant" },
        },
        { content: "direct", mode: "append" },
      ],
      [
        "assistant text delta",
        { assistantMessageEvent: { type: "text_delta", delta: "assistant" } },
        { content: "assistant", mode: "append" },
      ],
      [
        "untyped assistant delta",
        { assistantMessageEvent: { delta: "legacy" } },
        { content: "legacy", mode: "append" },
      ],
      [
        "direct snapshot",
        { content: "direct" },
        { content: "direct", mode: "replace" },
      ],
      [
        "structured message snapshot",
        {
          message: {
            content: [{ type: "text", text: "one" }, { text: "two" }],
          },
        },
        { content: "one\ntwo", mode: "replace" },
      ],
      [
        "assistant text snapshot",
        {
          assistantMessageEvent: {
            type: "text_start",
            partial: [{ text: "partial" }],
          },
        },
        { content: "partial", mode: "replace" },
      ],
      [
        "done assistant snapshot",
        {
          assistantMessageEvent: {
            type: "done",
            partial: [{ text: "complete" }],
          },
        },
        { content: "complete", mode: "replace" },
      ],
      [
        "toolcall delta",
        {
          assistantMessageEvent: { type: "toolcall_delta", delta: "not text" },
        },
        undefined,
      ],
      [
        "malformed payload",
        { delta: {}, message: [], assistantMessageEvent: "not an event" },
        undefined,
      ],
    ];

    for (const [name, fields, expected] of cases) {
      expect(getMessageTextUpdate(messageUpdate(fields)), name).toEqual(
        expected,
      );
    }
  });

  it("keeps assistant thinking events separate from text", () => {
    const cases: Array<
      [
        string,
        Record<string, unknown>,
        string | undefined,
        { content: string; mode: "append" | "replace" } | undefined,
      ]
    > = [
      [
        "thinking delta",
        {
          assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
        },
        "reasoning",
        undefined,
      ],
      [
        "thinking content",
        { assistantMessageEvent: { type: "thinking", content: "considering" } },
        "considering",
        undefined,
      ],
      [
        "thinking partial",
        {
          assistantMessageEvent: {
            type: "thinking_end",
            partial: [{ thinking: "done" }],
          },
        },
        "done",
        undefined,
      ],
      [
        "message thinking block retains structured text projection",
        {
          message: { content: [{ type: "thinking", text: "from message" }] },
        },
        "from message",
        { content: "from message", mode: "replace" },
      ],
      [
        "ordinary text",
        { message: { content: [{ text: "reply" }] } },
        undefined,
        { content: "reply", mode: "replace" },
      ],
      [
        "malformed thinking payload",
        { assistantMessageEvent: { type: "thinking_delta", partial: {} } },
        undefined,
        undefined,
      ],
    ];

    for (const [name, fields, expectedThinking, expectedText] of cases) {
      const event = messageUpdate(fields);
      expect(getThinkingUpdateContent(event), name).toBe(expectedThinking);
      expect(getMessageTextUpdate(event), name).toEqual(expectedText);
    }
  });

  it("reads role and assistant event type only from string records", () => {
    expect(getMessageUpdateRole(messageUpdate({ role: "assistant" }))).toBe(
      "assistant",
    );
    expect(
      getMessageUpdateRole(messageUpdate({ message: { role: "tool" } })),
    ).toBe("tool");
    expect(
      getMessageUpdateRole(messageUpdate({ role: {}, message: [] })),
    ).toBeUndefined();
    expect(
      getAssistantMessageEventType(
        messageUpdate({ assistantMessageEvent: { type: "text_delta" } }),
      ),
    ).toBe("text_delta");
    expect(
      getAssistantMessageEventType(
        messageUpdate({ assistantMessageEvent: [] }),
      ),
    ).toBeUndefined();
  });
});
