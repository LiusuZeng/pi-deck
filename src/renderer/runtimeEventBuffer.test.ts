import { describe, expect, it } from "vitest";
import type { ChatRuntimeEvent } from "../shared/types.js";
import {
  RuntimeEventBuffer,
  type RuntimeEventBufferScheduler,
} from "./runtimeEventBuffer.js";

class ManualScheduler implements RuntimeEventBufferScheduler {
  private nextHandle = 1;
  private frames = new Map<number, FrameRequestCallback>();
  private timers = new Map<number, () => void>();

  requestAnimationFrame(callback: FrameRequestCallback): number {
    const handle = this.nextHandle++;
    this.frames.set(handle, callback);
    return handle;
  }

  cancelAnimationFrame(handle: number): void {
    this.frames.delete(handle);
  }

  setTimeout(callback: () => void): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  runFrame(): void {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    callbacks.forEach((callback) => callback(0));
  }

  runTimers(): void {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    callbacks.forEach((callback) => callback());
  }
}

function event(
  type: string,
  runtimeId: string,
  fields: Record<string, unknown> = {},
): ChatRuntimeEvent {
  return { type, runtimeId, ...fields } as ChatRuntimeEvent;
}

function reduce(events: ChatRuntimeEvent[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const current of events) {
    if (current.type === "message_update") {
      const id = String(current.messageId);
      result[id] =
        typeof current.delta === "string"
          ? `${result[id] ?? ""}${current.delta}`
          : String(current.content ?? "");
    }
    if (current.type === "tool_execution_update") {
      result[`tool:${String(current.toolCallId)}`] = String(
        current.output ?? "",
      );
    }
  }
  return result;
}

describe("RuntimeEventBuffer", () => {
  it("is equivalent to reducing a message and tool burst event-by-event", () => {
    const scheduler = new ManualScheduler();
    const delivered: ChatRuntimeEvent[] = [];
    const buffer = new RuntimeEventBuffer({
      deliver: (current) => delivered.push(current),
      isRuntimeVisible: () => true,
      scheduler,
    });
    const burst = [
      event("message_update", "runtime-a", {
        messageId: "message-1",
        delta: "Hello",
        content: "Hello",
      }),
      // Pi may send a full replacement snapshot between deltas. The pending
      // replacement becomes the baseline for later append-only content.
      event("message_update", "runtime-a", {
        messageId: "message-1",
        content: "Hello beautiful",
      }),
      event("message_update", "runtime-a", {
        messageId: "message-1",
        delta: " world",
      }),
      event("tool_execution_update", "runtime-a", {
        toolCallId: "tool-1",
        output: "one",
      }),
      event("tool_execution_update", "runtime-a", {
        toolCallId: "tool-1",
        output: "two",
      }),
    ];

    burst.forEach((current) => buffer.handle(current));
    expect(delivered).toHaveLength(0);
    scheduler.runFrame();

    expect(reduce(delivered)).toEqual(reduce(burst));
    expect(delivered).toHaveLength(2);
  });

  it("flushes pending updates before a final lifecycle event synchronously", () => {
    const scheduler = new ManualScheduler();
    const delivered: ChatRuntimeEvent[] = [];
    const buffer = new RuntimeEventBuffer({
      deliver: (current) => delivered.push(current),
      isRuntimeVisible: () => true,
      scheduler,
    });

    buffer.handle(
      event("message_update", "runtime-a", {
        messageId: "message-1",
        delta: "final text",
      }),
    );
    buffer.handle(event("agent_end", "runtime-a", { status: "completed" }));

    expect(delivered.map((current) => current.type)).toEqual([
      "message_update",
      "agent_end",
    ]);
    expect(reduce(delivered)).toEqual({ "message-1": "final text" });
    expect(buffer.getStats()).toEqual({ pendingEntries: 0, pendingBytes: 0 });
  });

  it("flushes partial text before object and nested stream errors", () => {
    const scheduler = new ManualScheduler();
    const delivered: ChatRuntimeEvent[] = [];
    const buffer = new RuntimeEventBuffer({
      deliver: (current) => delivered.push(current),
      isRuntimeVisible: () => true,
      scheduler,
    });

    buffer.handle(
      event("message_update", "runtime-a", {
        messageId: "message-1",
        delta: "partial text",
      }),
    );
    buffer.handle(
      event("message_update", "runtime-a", {
        messageId: "message-1",
        error: { message: "provider failed" },
      }),
    );
    buffer.handle(
      event("message_update", "runtime-a", {
        messageId: "message-2",
        delta: "other partial",
      }),
    );
    buffer.handle(
      event("message_update", "runtime-a", {
        messageId: "message-2",
        assistantMessageEvent: {
          type: "error",
          error: { message: "nested failure" },
        },
      }),
    );

    expect(delivered).toHaveLength(4);
    expect(delivered.map((current) => current.messageId)).toEqual([
      "message-1",
      "message-1",
      "message-2",
      "message-2",
    ]);
    expect(delivered[0]?.delta).toBe("partial text");
    expect(delivered[2]?.delta).toBe("other partial");
  });

  it("keeps pending updates isolated by runtime", () => {
    const scheduler = new ManualScheduler();
    const delivered: ChatRuntimeEvent[] = [];
    const buffer = new RuntimeEventBuffer({
      deliver: (current) => delivered.push(current),
      isRuntimeVisible: () => true,
      scheduler,
    });

    buffer.handle(
      event("message_update", "runtime-a", {
        messageId: "message-a",
        delta: "A",
      }),
    );
    buffer.handle(
      event("message_update", "runtime-b", {
        messageId: "message-b",
        delta: "B",
      }),
    );
    buffer.handle(event("agent_end", "runtime-a"));

    expect(delivered.map((current) => current.runtimeId)).toEqual([
      "runtime-a",
      "runtime-a",
    ]);
    expect(buffer.getStats().pendingEntries).toBe(1);
    scheduler.runFrame();
    expect(delivered.map((current) => current.runtimeId)).toEqual([
      "runtime-a",
      "runtime-a",
      "runtime-b",
    ]);
  });

  it("bounds pending state by synchronously draining instead of dropping updates", () => {
    const scheduler = new ManualScheduler();
    const delivered: ChatRuntimeEvent[] = [];
    const buffer = new RuntimeEventBuffer({
      deliver: (current) => delivered.push(current),
      isRuntimeVisible: () => false,
      scheduler,
      maxPendingEntries: 2,
      maxPendingBytes: 10_000,
    });
    const updates = ["one", "two", "three"].map((messageId) =>
      event("message_update", "hidden-runtime", {
        messageId,
        delta: messageId,
      }),
    );

    updates.forEach((current) => buffer.handle(current));

    expect(buffer.getStats().pendingEntries).toBeLessThanOrEqual(2);
    expect(reduce(delivered)).toEqual({
      one: "one",
      two: "two",
      three: "three",
    });
    expect(buffer.getStats()).toEqual({ pendingEntries: 0, pendingBytes: 0 });
    scheduler.runTimers();
  });
});
