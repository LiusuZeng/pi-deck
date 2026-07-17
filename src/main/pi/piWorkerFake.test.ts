import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { it as test } from "vitest";
import { PiWorker } from "./piWorker.js";
import { SinglePiAdapter } from "./piAdapter.js";
import type { RuntimeEvent } from "./types.js";

let builtFakePath: string | undefined;

function fakePath(): string {
  if (!builtFakePath) {
    const outdir = path.join(tmpdir(), "pi-deck-fake-rpc-tests");
    mkdirSync(outdir, { recursive: true });
    builtFakePath = path.join(outdir, "fakeRpcServer.cjs");
    buildSync({
      entryPoints: [
        fileURLToPath(new URL("./fakeRpc/fakeRpcServer.ts", import.meta.url)),
      ],
      outfile: builtFakePath,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node26",
    });
  }
  return builtFakePath;
}

function createWorker(args: string[] = []): PiWorker {
  return new PiWorker({
    command: process.execPath,
    args: [fakePath(), ...args],
    cwd: process.cwd(),
    env: process.env,
    requestTimeoutMs: 5_000,
    killGraceMs: 100,
  });
}

function waitForWorkerEvent(
  worker: PiWorker,
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 5_000,
): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for worker event"));
    }, timeoutMs);
    const unsubscribe = worker.onEvent((event) => {
      if (!predicate(event)) {
        return;
      }
      cleanup();
      resolve(event);
    });
    const cleanup = (): void => {
      clearTimeout(timer);
      unsubscribe();
    };
  });
}

test("PiWorker gets deterministic state and messages from fake RPC", async () => {
  const worker = createWorker();
  try {
    const state = await worker.getState();
    assert.equal(state.runtimeId, worker.runtimeId);
    assert.equal(state.sessionId, "fake-session-1");

    const messages = await worker.getMessages();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, "Fake RPC ready");
  } finally {
    await worker.closeSession();
  }
});

test("PiWorker supports real-Pi type-field command protocol", async () => {
  const worker = new PiWorker({
    command: process.execPath,
    args: [fakePath(), "--stream-delay-ms", "1"],
    cwd: process.cwd(),
    env: process.env,
    requestTimeoutMs: 5_000,
    killGraceMs: 100,
    commandProtocol: "type-field",
  });
  try {
    const state = await worker.getState();
    assert.equal(state.sessionId, "fake-session-1");
    await worker.prompt({ text: "type field prompt" });
    await waitForWorkerEvent(worker, (event) => event.type === "agent_end");
  } finally {
    await worker.closeSession();
  }
});

test("PiWorker prompt resolves on command acceptance and continues streaming events", async () => {
  const worker = createWorker(["--stream-delay-ms", "1"]);
  const messageUpdates: RuntimeEvent[] = [];
  const unsubscribe = worker.onEvent((event) => {
    if (event.type === "message_update") {
      messageUpdates.push(event);
    }
  });
  try {
    await worker.prompt({ text: "stream please" });
    const endEvent = await waitForWorkerEvent(
      worker,
      (event) => event.type === "agent_end",
    );
    assert.equal((endEvent as { status?: string }).status, "completed");
    assert.ok(messageUpdates.length >= 1);
    assert.equal(messageUpdates[0].runtimeId, worker.runtimeId);
  } finally {
    unsubscribe();
    await worker.closeSession();
  }
});

test("PiWorker sends exact steer and follow_up RPC commands", async () => {
  const worker = new PiWorker({
    command: process.execPath,
    args: [fakePath(), "--stream-delay-ms", "50"],
    cwd: process.cwd(),
    env: process.env,
    requestTimeoutMs: 5_000,
    killGraceMs: 100,
    commandProtocol: "type-field",
  });
  try {
    await worker.prompt({ text: "keep working" });
    const queued = waitForWorkerEvent(
      worker,
      (event) =>
        event.type === "queue_update" &&
        Array.isArray((event as { steering?: unknown }).steering) &&
        Array.isArray((event as { followUp?: unknown }).followUp) &&
        (event as { steering: unknown[] }).steering.length === 1 &&
        (event as { followUp: unknown[] }).followUp.length === 1,
    );
    await worker.steer({ text: "Use the focused tests" });
    await worker.followUp({ text: "Summarize the result" });
    const event = await queued;
    assert.deepEqual((event as { steering: unknown[] }).steering, [
      "Use the focused tests",
    ]);
    assert.deepEqual((event as { followUp: unknown[] }).followUp, [
      "Summarize the result",
    ]);
  } finally {
    await worker.closeSession();
  }
});

test("PiWorker abort path emits a sensible aborted end state", async () => {
  const worker = createWorker(["--stream-delay-ms", "50"]);
  try {
    await worker.prompt({ text: "abort me" });
    const abortedEvent = waitForWorkerEvent(
      worker,
      (event) =>
        event.type === "agent_end" &&
        (event as { status?: string }).status === "aborted",
    );
    await worker.abort();
    const aborted = await abortedEvent;
    assert.equal(aborted.runtimeId, worker.runtimeId);
  } finally {
    await worker.closeSession();
  }
});

test("PiWorker intentional close does not create error diagnostic", async () => {
  const worker = createWorker();
  await worker.getState();
  await worker.closeSession();

  const diagnostics = worker.getDiagnostics().recentDiagnostics;
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.level === "error"),
    false,
  );
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.level === "info" && /closed/.test(diagnostic.message),
    ),
  );
});

test("PiWorker unexpected exit rejects pending request and emits error diagnostic", async () => {
  const worker = createWorker(["--exit-after-first-command"]);
  const errorDiagnostic = waitForWorkerEvent(
    worker,
    (event) =>
      event.type === "diagnostic" &&
      (event as { level?: string }).level === "error",
  );

  await assert.rejects(worker.getState(), /exited|subprocess/i);
  const diagnostic = await errorDiagnostic;
  assert.match((diagnostic as { message?: string }).message ?? "", /exited/);
  assert.equal(worker.getDiagnostics().healthy, false);
});

test("SinglePiAdapter routes required methods by runtime id", async () => {
  const adapter = new SinglePiAdapter();
  const worker = adapter.createWorker({
    command: process.execPath,
    args: [fakePath(), "--stream-delay-ms", "1"],
    cwd: process.cwd(),
    env: process.env,
    requestTimeoutMs: 5_000,
    killGraceMs: 100,
  });

  try {
    const events: RuntimeEvent[] = [];
    const unsubscribe = adapter.onEvent((event) => events.push(event));
    const state = await adapter.getState(worker.runtimeId);
    assert.equal(state.sessionId, "fake-session-1");
    await adapter.prompt(worker.runtimeId, { text: "via adapter" });
    await adapter.steer(worker.runtimeId, { text: "via adapter steer" });
    await adapter.followUp(worker.runtimeId, { text: "via adapter follow-up" });
    await waitForWorkerEvent(worker, (event) => event.type === "agent_end");
    assert.ok(events.some((event) => event.type === "message_update"));
    unsubscribe();
  } finally {
    await adapter.closeSession(worker.runtimeId);
  }
});
