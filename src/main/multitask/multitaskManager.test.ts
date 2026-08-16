import { describe, expect, it } from "vitest";
import {
  InvalidChildTaskTransitionError,
  MultitaskManager,
  MultitaskQueueFullError,
} from "./multitaskManager.js";

describe("MultitaskManager", () => {
  it("assigns caller identities, bounds the queue, and starts in number order", () => {
    const manager = new MultitaskManager<string>({
      mode: "parallel",
      maxQueuedTasks: 2,
    });
    manager.enqueue({ number: 1, name: "child-1", request: "first" });
    manager.enqueue({ number: 2, name: "child-2", request: "second" });
    expect(() =>
      manager.enqueue({ number: 3, name: "child-3", request: "third" }),
    ).toThrow(MultitaskQueueFullError);
    expect(manager.startNext(false)).toBeUndefined();
    expect(manager.startNext(true)).toMatchObject({
      number: 1,
      request: "first",
    });
    expect(manager.startNext(true)).toMatchObject({
      number: 2,
      request: "second",
    });
    expect(() =>
      manager.enqueue({ number: 2, name: "again", request: "x" }),
    ).toThrow(/monotonic/);
  });

  it("handles input through parent-mediated state transitions", () => {
    const manager = new MultitaskManager<string, string>({
      mode: "parallel",
      maxQueuedTasks: 1,
    });
    manager.enqueue({ number: 1, name: "child-1", request: "work" });
    manager.startNext(true);
    manager.markWaitingForInput(1);
    expect(manager.provideInput(1, "yes").status).toBe("queued");
    expect(manager.startNext(true)).toMatchObject({ number: 1, input: "yes" });
    expect(manager.complete(1, { summary: "done" })).toMatchObject({
      status: "completed",
      terminalHandoff: { summary: "done" },
    });
    expect(() => manager.markWaitingForInput(1)).toThrow(
      InvalidChildTaskTransitionError,
    );
  });

  it("serializes sequential work while another child is active", () => {
    const manager = new MultitaskManager<string>({
      mode: "sequential",
      maxQueuedTasks: 2,
    });
    manager.enqueue({ number: 1, name: "one", request: "one" });
    manager.enqueue({ number: 2, name: "two", request: "two" });
    expect(manager.startNext(true)?.number).toBe(1);
    expect(manager.startNext(true)).toBeUndefined();
    manager.fail(1, { summary: "failed safely" });
    expect(manager.startNext(true)?.number).toBe(2);
  });

  it("exports no request/input and rehydrates live children as interrupted", () => {
    const manager = new MultitaskManager<{ secret: string }, string>({
      mode: "parallel",
      maxQueuedTasks: 3,
    });
    manager.enqueue({
      number: 1,
      name: "queued",
      request: { secret: "do not persist" },
    });
    manager.enqueue({
      number: 2,
      name: "done",
      request: { secret: "also private" },
    });
    manager.startNext(true);
    manager.complete(1, {
      summary: "safe result",
      details: "only these strings survive",
    });
    manager.startNext(true);
    manager.markWaitingForInput(2);
    const state = manager.exportState();
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(state.tasks).toEqual([
      {
        number: 1,
        name: "queued",
        status: "completed",
        terminalHandoff: {
          summary: "safe result",
          details: "only these strings survive",
        },
      },
      { number: 2, name: "done", status: "waiting-input" },
    ]);

    const resumed = MultitaskManager.rehydrate(state, { maxQueuedTasks: 3 });
    expect(resumed.snapshots()[1]).toMatchObject({
      status: "cancelled",
      terminalHandoff: {
        summary: "Child task interrupted during session resume.",
      },
    });
    expect(resumed.startNext(true)).toBeUndefined();
  });
});
