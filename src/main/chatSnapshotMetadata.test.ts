import { describe, expect, it } from "vitest";
import { deriveChatSnapshotMetadata } from "./chatSnapshotMetadata.js";
import type { PiMessage, PiState } from "./pi/types.js";

function metadata(
  messages: PiMessage[] = [],
  state: PiState = {},
  skipMessages = false,
) {
  return deriveChatSnapshotMetadata({ state, messages, skipMessages });
}

function message(fields: Partial<PiMessage>): PiMessage {
  return { id: "message", role: "tool", ...fields };
}

describe("chat snapshot metadata", () => {
  it("prefers a normalized session name over the transcript title", () => {
    expect(
      metadata([message({ role: "user", content: "Transcript title" })], {
        sessionName: "  Named\n\tsession  ",
      }),
    ).toMatchObject({ kind: "messages", title: "Named session" });
  });

  it("uses only the first user message for its title fallback", () => {
    expect(
      metadata([
        message({ role: "user", content: "  First\n prompt  " }),
        message({ role: "user", content: "Later prompt" }),
      ]),
    ).toMatchObject({ kind: "messages", title: "First prompt" });

    for (const firstUser of [
      message({ role: "user", content: " \n " }),
      message({ role: "user" }),
    ]) {
      expect(
        metadata([
          firstUser,
          message({ role: "assistant", content: "Answer" }),
          message({ role: "user", content: "Later prompt" }),
        ]),
      ).not.toHaveProperty("title");
    }
  });

  it("keeps skipped and empty transcripts sparse", () => {
    expect(
      metadata([message({ role: "user", content: "Ignored" })], {}, true),
    ).toEqual({ kind: "skipped" });
    expect(metadata()).toEqual({ kind: "empty" });
    expect(
      metadata([
        message({ role: "system" }),
        message({ role: "tool" }),
        message({ role: "assistant", content: "Answer" }),
      ]),
    ).toMatchObject({ kind: "messages", messageCount: 3 });
  });

  it("does not expose synthesis delivery markers in titles or previews", () => {
    expect(
      metadata([
        message({
          role: "user",
          content:
            "<!-- pi-deck-synthesis-delivery:v1:receipt -->\nSynthesized title",
        }),
        message({
          role: "assistant",
          content:
            "<!-- pi-deck-synthesis-delivery:v1:receipt -->\nSynthesized preview",
        }),
      ]),
    ).toMatchObject({
      kind: "messages",
      title: "Synthesized title",
      preview: "Synthesized preview",
    });
    expect(
      metadata([
        message({
          role: "user",
          content: "<!-- pi-deck-synthesis-delivery:v1:receipt -->",
        }),
      ]),
    ).not.toHaveProperty("title");
  });

  it("uses the last string preview and does not fall back from a blank string", () => {
    expect(
      metadata([
        message({ content: "Older preview" }),
        message({ content: "  Latest\n preview  " }),
      ]),
    ).toMatchObject({ kind: "messages", preview: "Latest preview" });
    const blankTerminalPreview = metadata([
      message({ content: "Older preview" }),
      message({ content: " \n " }),
    ]);
    expect(blankTerminalPreview).toEqual({ kind: "messages", messageCount: 2 });
    expect(blankTerminalPreview).not.toHaveProperty("preview");
  });

  it("uses the latest user or assistant as the completion candidate", () => {
    expect(
      metadata([
        message({ role: "user", content: "Prompt" }),
        message({
          role: "assistant",
          content: "Answer",
          createdAt: 8.64e15 + 1,
        }),
      ]),
    ).toMatchObject({ kind: "messages", completedAtMs: 8.64e15 + 1 });

    for (const terminalMessage of [
      message({ role: "user", content: "Follow-up" }),
      message({ role: "assistant", content: "", createdAt: 123 }),
      message({ role: "assistant", content: "Answer", createdAt: NaN }),
      message({ role: "assistant", content: "Answer", createdAt: Infinity }),
      message({
        role: "assistant",
        content: "Answer",
        createdAt: 123,
        status: "error",
      }),
    ]) {
      expect(
        metadata([
          message({ role: "assistant", content: "Answer", createdAt: 123 }),
          terminalMessage,
        ]),
      ).not.toHaveProperty("completedAtMs");
    }
  });

  it("ignores later tool and non-user errors when finding completion", () => {
    const completedAssistant = message({
      role: "assistant",
      content: "Answer",
      createdAt: 123,
    });

    for (const laterMessage of [
      message({ role: "tool", error: { message: "Failed" } }),
      message({ role: "system", status: "error" }),
      message({ role: "other", errorMessage: "Failed" }),
    ]) {
      expect(metadata([completedAssistant, laterMessage])).toMatchObject({
        kind: "messages",
        completedAtMs: 123,
      });
    }
  });
});
