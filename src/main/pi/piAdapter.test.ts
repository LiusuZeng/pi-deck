import assert from "node:assert/strict";
import { it as test } from "vitest";
import { buildFakeRpcServer } from "../../test/fakeRpcHarness.js";
import { SinglePiAdapter } from "./piAdapter.js";
import type { RuntimeEvent } from "./types.js";

function waitForEvents(
  events: RuntimeEvent[],
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  if (predicate()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (!predicate()) {
        return;
      }
      cleanup();
      resolve();
    }, 5);
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for events. Saw: ${events
            .map((event) => `${event.runtimeId}:${event.type}`)
            .join(", ")}`,
        ),
      );
    }, timeoutMs);
    const cleanup = (): void => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  });
}

function eventTypesFor(events: RuntimeEvent[], runtimeId: string): Set<string> {
  return new Set(
    events
      .filter((event) => event.runtimeId === runtimeId)
      .map((event) => event.type),
  );
}

test("SinglePiAdapter routes concurrent worker events by runtime id", async () => {
  const adapter = new SinglePiAdapter();
  const events: RuntimeEvent[] = [];
  const unsubscribe = adapter.onEvent((event) => events.push(event));
  const fakeServer = buildFakeRpcServer();

  const workerA = adapter.createWorker({
    runtimeId: "runtime-a",
    command: process.execPath,
    args: [fakeServer, "--stream-delay-ms", "1"],
    cwd: process.cwd(),
    env: process.env,
    killGraceMs: 100,
  });
  const workerB = adapter.createWorker({
    runtimeId: "runtime-b",
    command: process.execPath,
    args: [fakeServer, "--stream-delay-ms", "1", "--prompt-scenario", "tool"],
    cwd: process.cwd(),
    env: process.env,
    killGraceMs: 100,
  });

  try {
    await Promise.all([
      adapter.prompt(workerA.runtimeId, { text: "hello from a" }),
      adapter.prompt(workerB.runtimeId, { text: "hello from b" }),
    ]);

    await waitForEvents(
      events,
      () =>
        events.some(
          (event) =>
            event.runtimeId === workerA.runtimeId && event.type === "agent_end",
        ) &&
        events.some(
          (event) =>
            event.runtimeId === workerB.runtimeId && event.type === "agent_end",
        ),
    );

    const runtimeIds = new Set(events.map((event) => event.runtimeId));
    assert.deepEqual(
      runtimeIds,
      new Set([workerA.runtimeId, workerB.runtimeId]),
    );

    const typesA = eventTypesFor(events, workerA.runtimeId);
    const typesB = eventTypesFor(events, workerB.runtimeId);
    assert.ok(typesA.has("agent_start"));
    assert.ok(typesA.has("message_update"));
    assert.ok(typesA.has("agent_end"));
    assert.equal(typesA.has("tool_execution_start"), false);

    assert.ok(typesB.has("agent_start"));
    assert.ok(typesB.has("message_update"));
    assert.ok(typesB.has("tool_execution_start"));
    assert.ok(typesB.has("tool_execution_end"));
    assert.ok(typesB.has("agent_end"));
  } finally {
    unsubscribe();
    await Promise.allSettled([
      adapter.closeSession(workerA.runtimeId),
      adapter.closeSession(workerB.runtimeId),
    ]);
  }
});

test("SinglePiAdapter closes one runtime without dropping another runtime", async () => {
  const adapter = new SinglePiAdapter();
  const fakeServer = buildFakeRpcServer();
  const workerA = adapter.createWorker({
    runtimeId: "runtime-close-a",
    command: process.execPath,
    args: [fakeServer],
    cwd: process.cwd(),
    env: process.env,
    killGraceMs: 100,
  });
  const workerB = adapter.createWorker({
    runtimeId: "runtime-close-b",
    command: process.execPath,
    args: [fakeServer],
    cwd: process.cwd(),
    env: process.env,
    killGraceMs: 100,
  });

  try {
    await adapter.closeSession(workerA.runtimeId);
    assert.equal(adapter.hasRuntime(workerA.runtimeId), false);
    assert.equal(adapter.hasRuntime(workerB.runtimeId), true);

    const state = await adapter.getState(workerB.runtimeId);
    assert.equal(state.runtimeId, workerB.runtimeId);
  } finally {
    await Promise.allSettled([
      adapter.hasRuntime(workerA.runtimeId)
        ? adapter.closeSession(workerA.runtimeId)
        : Promise.resolve(),
      adapter.hasRuntime(workerB.runtimeId)
        ? adapter.closeSession(workerB.runtimeId)
        : Promise.resolve(),
    ]);
  }
});
