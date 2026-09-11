import { describe, expect, it, vi } from "vitest";
import { readChatSnapshotInputs } from "./chatSnapshotRead.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("chat snapshot reads", () => {
  it("starts state and transcript RPCs concurrently", async () => {
    const state = deferred<{ isAgentActive: boolean }>();
    const messages = deferred<Array<{ role: string }>>();
    const getState = vi.fn(() => state.promise);
    const getMessages = vi.fn(() => messages.promise);

    const pending = readChatSnapshotInputs(
      { getState, getMessages },
      "runtime-1",
    );

    expect(getState).toHaveBeenCalledWith("runtime-1");
    expect(getMessages).toHaveBeenCalledWith("runtime-1");

    messages.resolve([{ role: "assistant" }]);
    await Promise.resolve();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    state.resolve({ isAgentActive: false });
    await expect(pending).resolves.toEqual({
      state: { isAgentActive: false },
      messages: [{ role: "assistant" }],
    });
  });

  it("does not issue a transcript RPC for state-only snapshots", async () => {
    const getState = vi.fn(async () => ({ isAgentActive: true }));
    const getMessages = vi.fn(async () => [{ role: "assistant" }]);

    await expect(
      readChatSnapshotInputs({ getState, getMessages }, "runtime-2", {
        skipMessages: true,
      }),
    ).resolves.toEqual({
      state: { isAgentActive: true },
      messages: [],
    });
    expect(getMessages).not.toHaveBeenCalled();
  });
});
