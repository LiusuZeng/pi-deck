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

  it("uses the first nonblank string user message as its title fallback", () => {
    expect(
      metadata([
        message({ role: "user", content: " \n " }),
        message({ role: "user" }),
        message({ role: "assistant", content: "Answer" }),
        message({ role: "user", content: "  First\n prompt  " }),
        message({ role: "user", content: "Later prompt" }),
      ]),
    ).toMatchObject({ kind: "messages", title: "First prompt" });
  });

  it("keeps skipped and empty transcripts distinct with exact counts", () => {
    expect(
      metadata([message({ role: "user", content: "Ignored" })], {}, true),
    ).toEqual({ kind: "skipped" });
    expect(metadata()).toEqual({ kind: "empty", messageCount: 0 });
    expect(
      metadata([
        message({ role: "system" }),
        message({ role: "tool" }),
        message({ role: "assistant", content: "Answer" }),
      ]),
    ).toMatchObject({ kind: "messages", messageCount: 3 });
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

  it("only completes on a valid non-error terminal assistant", () => {
    expect(
      metadata([
        message({ role: "user", content: "Prompt" }),
        message({
          role: "assistant",
          content: "Answer",
          createdAt: 123,
        }),
      ]),
    ).toMatchObject({ kind: "messages", completedAtMs: 123 });

    for (const terminalAssistant of [
      message({ role: "assistant", content: "", createdAt: 123 }),
      message({ role: "assistant", content: "Answer", createdAt: NaN }),
      message({ role: "assistant", content: "Answer", createdAt: Infinity }),
      message({
        role: "assistant",
        content: "Answer",
        createdAt: 8.64e15 + 1,
      }),
      message({
        role: "assistant",
        content: "Answer",
        createdAt: 123,
        status: "error",
      }),
    ]) {
      expect(metadata([terminalAssistant])).not.toHaveProperty("completedAtMs");
    }
  });

  it("invalidates completion after later user or error messages", () => {
    const completedAssistant = message({
      role: "assistant",
      content: "Answer",
      createdAt: 123,
    });

    for (const laterMessage of [
      message({ role: "user", content: "Follow-up" }),
      message({ role: "tool", error: { message: "Failed" } }),
      message({ role: "assistant", errorMessage: "Failed" }),
    ]) {
      expect(metadata([completedAssistant, laterMessage])).not.toHaveProperty(
        "completedAtMs",
      );
    }
  });
});
