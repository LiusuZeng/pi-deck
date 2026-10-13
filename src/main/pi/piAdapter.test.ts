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

async function closeIfPresent(
  adapter: SinglePiAdapter,
  runtimeId: string,
): Promise<void> {
  if (adapter.hasRuntime(runtimeId)) {
    await adapter.closeSession(runtimeId);
  }
}

test("SinglePiAdapter releases a fatal malformed worker only after cooperative exit", async () => {
  const adapter = new SinglePiAdapter();
  const events: RuntimeEvent[] = [];
  const unsubscribe = adapter.onEvent((event) => events.push(event));
  const fakeServer = buildFakeRpcServer();
  const worker = adapter.createWorker({
    runtimeId: "fatal-cooperative",
    command: process.execPath,
    args: [fakeServer, "--malformed-on-start", "--sigterm-exit-delay-ms", "80"],
    cwd: process.cwd(),
    env: process.env,
    requestTimeoutMs: 200,
    killGraceMs: 500,
  });

  try {
    await waitForEvents(events, () =>
      events.some(
        (event) =>
          event.runtimeId === worker.runtimeId &&
          event.type === "rpc_parse_error",
      ),
    );
    assert.equal(adapter.hasRuntime(worker.runtimeId), true);
    assert.equal(adapter.workerCount(), 1);

    await waitForEvents(events, () =>
      events.some(
        (event) =>
          event.runtimeId === worker.runtimeId && event.type === "worker_exit",
      ),
    );

    assert.equal(adapter.hasRuntime(worker.runtimeId), false);
    assert.equal(adapter.workerCount(), 0);
    const exits = events.filter(
      (event) =>
        event.runtimeId === worker.runtimeId && event.type === "worker_exit",
    );
    assert.equal(exits.length, 1);
    assert.equal((exits[0] as { intentional?: boolean }).intentional, false);
  } finally {
    unsubscribe();
    await closeIfPresent(adapter, worker.runtimeId);
  }
});

test("SinglePiAdapter escalates a SIGTERM-resistant fatal malformed worker", async () => {
  const adapter = new SinglePiAdapter();
  const events: RuntimeEvent[] = [];
  const unsubscribe = adapter.onEvent((event) => events.push(event));
  const fakeServer = buildFakeRpcServer();
  const worker = adapter.createWorker({
    runtimeId: "fatal-resistant",
    command: process.execPath,
    args: [fakeServer, "--malformed-on-start", "--ignore-sigterm"],
    cwd: process.cwd(),
    env: process.env,
    requestTimeoutMs: 200,
    killGraceMs: 50,
  });

  try {
    await waitForEvents(events, () =>
      events.some(
        (event) =>
          event.runtimeId === worker.runtimeId &&
          event.type === "rpc_parse_error",
      ),
    );
    await assert.rejects(
      adapter.getState(worker.runtimeId),
      /Malformed JSONL from RPC subprocess/i,
    );
    assert.equal(adapter.hasRuntime(worker.runtimeId), true);

    await waitForEvents(events, () =>
      events.some(
        (event) =>
          event.runtimeId === worker.runtimeId && event.type === "worker_exit",
      ),
    );

    assert.equal(adapter.workerCount(), 0);
    const exits = events.filter(
      (event) =>
        event.runtimeId === worker.runtimeId && event.type === "worker_exit",
    );
    assert.equal(exits.length, 1);
    assert.equal((exits[0] as { signal?: string }).signal, "SIGKILL");
    assert.equal((exits[0] as { intentional?: boolean }).intentional, false);
  } finally {
    unsubscribe();
    await closeIfPresent(adapter, worker.runtimeId);
  }
});

test("SinglePiAdapter handles repeated malformed output racing explicit close", async () => {
  const adapter = new SinglePiAdapter();
  const events: RuntimeEvent[] = [];
  const unsubscribe = adapter.onEvent((event) => events.push(event));
  const script = `
    process.on("SIGTERM", () => {});
    process.stdout.write("not-json\\nalso-not-json\\n");
    setInterval(() => {}, 1000);
  `;
  const worker = adapter.createWorker({
    runtimeId: "fatal-repeat-close-race",
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: process.env,
    requestTimeoutMs: 200,
    killGraceMs: 50,
  });

  try {
    await waitForEvents(events, () =>
      events.some(
        (event) =>
          event.runtimeId === worker.runtimeId &&
          event.type === "rpc_parse_error",
      ),
    );
    const close = adapter.closeSession(worker.runtimeId);
    await close;

    assert.equal(adapter.workerCount(), 0);
    const parseErrors = events.filter(
      (event) =>
        event.runtimeId === worker.runtimeId &&
        event.type === "rpc_parse_error",
    );
    assert.equal(parseErrors.length, 2);
    const exits = events.filter(
      (event) =>
        event.runtimeId === worker.runtimeId && event.type === "worker_exit",
    );
    assert.equal(exits.length, 1);
    assert.equal((exits[0] as { signal?: string }).signal, "SIGKILL");
    assert.equal((exits[0] as { intentional?: boolean }).intentional, false);
  } finally {
    unsubscribe();
    await closeIfPresent(adapter, worker.runtimeId);
  }
});

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

test("SinglePiAdapter removes an exited worker from capacity accounting", async () => {
  const adapter = new SinglePiAdapter();
  const fakeServer = buildFakeRpcServer();
  const worker = adapter.createWorker({
    runtimeId: "runtime-exited",
    command: process.execPath,
    args: [fakeServer],
    cwd: process.cwd(),
    env: process.env,
  });

  assert.equal(adapter.workerCount(), 1);
  adapter.forgetExitedWorker(worker.runtimeId);
  assert.equal(adapter.hasRuntime(worker.runtimeId), false);
  assert.equal(adapter.workerCount(), 0);
  await worker.closeSession();
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
    assert.equal(adapter.workerCount(), 2);
    await adapter.closeSession(workerA.runtimeId);
    assert.equal(adapter.hasRuntime(workerA.runtimeId), false);
    assert.equal(adapter.hasRuntime(workerB.runtimeId), true);
    assert.equal(adapter.workerCount(), 1);

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
