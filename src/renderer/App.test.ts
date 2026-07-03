import { describe, expect, it } from "vitest";
import { emptyOverlays } from "./sessionState.js";
import { __rendererTestHooks } from "./App.js";

function baseSession() {
  return {
    id: "session-1",
    title: "Session",
    project: "Project",
    projectPath: "/tmp/project",
    subtitle: "Idle",
    status: "idle",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline: [],
    baseState: "idle",
    overlays: emptyOverlays,
    runtimeBacked: true,
    backendMode: "real",
  } as const;
}

describe("renderer message_update reduction", () => {
  it("does not render toolcall JSON deltas as assistant text", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "message_update",
      message: {
        id: "assistant-1",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "pwd" },
          },
        ],
      },
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "}",
        partial: {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "pwd" },
        },
      },
    } as any);

    expect(next.timeline).toEqual([]);
  });

  it("still appends text deltas from assistantMessageEvent", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "message_update",
      message: {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Hello",
        partial: { type: "text", text: "Hello" },
      },
    } as any);

    expect(next.timeline).toMatchObject([
      { id: "assistant-1", kind: "assistant", content: "Hello" },
    ]);
  });

  it("summarizes Pi message usage and model context window", () => {
    const session = __rendererTestHooks.sessionFromSnapshot({
      runtimeId: "runtime-1",
      backendMode: "real",
      state: {
        cwd: "/tmp/project",
        model: { id: "model-1", provider: "test", contextWindow: 200000 },
      },
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Done",
          usage: {
            input: 1200,
            output: 300,
            cacheRead: 40,
            cacheWrite: 10,
            cost: { total: 0.0123 },
          },
        },
      ],
    } as any);

    expect(session.usageStats).toMatchObject({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      contextUsedTokens: 1250,
      contextWindowTokens: 200000,
      totalCostUsd: 0.0123,
    });
  });
});
