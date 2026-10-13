import { describe, expect, it } from "vitest";
import { selectCompletedAssistantAnswer } from "./savedAnswerSelection.js";

describe("selectCompletedAssistantAnswer", () => {
  const messages = [
    { id: "user-1", role: "user", content: "Question" },
    { id: "assistant-1", role: "assistant", content: "Same answer" },
    { id: "assistant-2", role: "assistant", content: "Same answer" },
  ];

  it("selects only an exact completed assistant message", () => {
    expect(
      selectCompletedAssistantAnswer({
        isAgentActive: false,
        messages,
        assistantMessageId: "assistant-1",
        assistantText: "Same answer",
      }),
    ).toBe("Same answer");
    expect(() =>
      selectCompletedAssistantAnswer({
        isAgentActive: false,
        messages,
        assistantMessageId: "assistant-1",
        assistantText: "Changed in renderer",
      }),
    ).toThrow(/no longer present/);
  });

  it("rejects active work and stale message identity", () => {
    expect(() =>
      selectCompletedAssistantAnswer({
        isAgentActive: true,
        messages,
        assistantText: "Same answer",
      }),
    ).toThrow(/finish/);
    expect(() =>
      selectCompletedAssistantAnswer({
        isAgentActive: false,
        messages,
        assistantMessageId: "assistant-missing",
        assistantText: "Same answer",
      }),
    ).toThrow(/no longer present/);
  });

  it("uses identical bytes when legacy messages have no durable id", () => {
    expect(
      selectCompletedAssistantAnswer({
        isAgentActive: false,
        messages: [
          { role: "assistant", content: "Repeated" },
          { role: "assistant", content: "Repeated" },
        ],
        assistantText: "Repeated",
      }),
    ).toBe("Repeated");
  });

  it("removes only the internal parent-synthesis transport marker", () => {
    expect(
      selectCompletedAssistantAnswer({
        isAgentActive: false,
        messages: [
          {
            id: "synthesis",
            role: "assistant",
            content:
              "<!-- pi-deck-synthesis-delivery:v1:receipt -->\nVisible synthesis",
          },
        ],
        assistantMessageId: "synthesis",
        assistantText: "Visible synthesis",
      }),
    ).toBe("Visible synthesis");
  });
});
