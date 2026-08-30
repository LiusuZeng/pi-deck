import { describe, expect, it } from "vitest";
import {
  recordTaskSessionPromptAfterParentIdle,
  resolveTaskSessionPromptRecordTimeoutMs,
  taskSessionPromptRecordCommand,
  type TaskSessionParentRecorderAdapter,
} from "./taskSessionParentRecorder.js";

describe("task session parent prompt recording", () => {
  it("encodes the original private-task prompt in the deck-task-prompt command", () => {
    const command = taskSessionPromptRecordCommand("Investigate issue #32");
    expect(command).toMatch(/^\/deck-task-prompt /);
    const encoded = command.slice("/deck-task-prompt ".length);
    expect(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    ).toEqual({ prompt: "Investigate issue #32" });
  });

  it("waits for an active parent runtime before recording the prompt", async () => {
    let poll = 0;
    const prompts: string[] = [];
    const adapter: TaskSessionParentRecorderAdapter = {
      async getRuntimeStatus() {
        poll += 1;
        return { isAgentActive: poll < 3 };
      },
      async prompt(_runtimeId, input) {
        prompts.push(input.text);
      },
    };

    await recordTaskSessionPromptAfterParentIdle(
      adapter,
      "parent-runtime",
      "Start an independent private task",
      {
        pollMs: 1,
        sleep: async () => undefined,
      },
    );

    expect(poll).toBe(3);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^\/deck-task-prompt /);
  });

  it("does not issue the parent prompt if the parent remains active past the timeout", async () => {
    let clock = 0;
    const prompts: string[] = [];
    await expect(
      recordTaskSessionPromptAfterParentIdle(
        {
          async getRuntimeStatus() {
            return { isStreaming: true };
          },
          async prompt(_runtimeId, input) {
            prompts.push(input.text);
          },
        },
        "parent-runtime",
        "Prompt that must not be recorded while active",
        {
          timeoutMs: 10,
          pollMs: 4,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      ),
    ).rejects.toThrow(/timed out waiting for parent session/i);
    expect(prompts).toEqual([]);
  });

  it("accepts only positive safe integer timeout overrides", () => {
    expect(resolveTaskSessionPromptRecordTimeoutMs("25")).toBe(25);
    expect(resolveTaskSessionPromptRecordTimeoutMs("0")).toBe(180_000);
    expect(resolveTaskSessionPromptRecordTimeoutMs("not-a-number")).toBe(
      180_000,
    );
  });
});
