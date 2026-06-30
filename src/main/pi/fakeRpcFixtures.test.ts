import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it as test } from "vitest";
import { runMinimalRpcSmokeTest } from "../platform/rpcSmokeTest.js";
import type { JsonObject, RpcEventRecord } from "./types.js";
import { spawnFakeRpc, writeFakePiShim } from "../../test/fakeRpcHarness.js";

function waitForEvents(
  client: ReturnType<typeof spawnFakeRpc>,
  predicate: (events: RpcEventRecord[]) => boolean,
  timeoutMs = 2_000,
): Promise<RpcEventRecord[]> {
  return new Promise((resolve, reject) => {
    const events: RpcEventRecord[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for fake RPC events: ${events.map((event) => event.type).join(",")}`,
        ),
      );
    }, timeoutMs);
    const listener = (event: RpcEventRecord): void => {
      events.push(event);
      if (predicate(events)) {
        cleanup();
        resolve(events);
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off("event", listener);
    };
    client.on("event", listener);
  });
}

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

test("fake RPC get_state and get_messages fixtures are deterministic", async () => {
  const client = spawnFakeRpc();
  try {
    const state = (await client.request("get_state")) as JsonObject;
    assert.equal(state.sessionId, "fake-session-1");
    assert.equal(state.model, "fake-model");
    assert.equal(state.provider, "fake-provider");

    const messages = await client.request("get_messages");
    assert.ok(Array.isArray(messages));
    assert.equal(messages[0].content, "Fake RPC ready");
  } finally {
    client.close();
  }
});

test("fake RPC prompt fixture emits start, streaming update, and completed end", async () => {
  const client = spawnFakeRpc(["--stream-delay-ms", "1"]);
  try {
    const done = waitForEvents(client, (events) =>
      events.some((event) => event.type === "agent_end"),
    );
    const accepted = await client.request("prompt", { text: "hello" });
    assert.deepEqual(accepted, { accepted: true });
    const events = await done;
    assert.deepEqual(
      events
        .map((event) => event.type)
        .filter((type) => type !== "message_update"),
      ["agent_start", "agent_end"],
    );
    assert.ok(events.some((event) => event.type === "message_update"));
    assert.equal(events.at(-1)?.type, "agent_end");
    assert.equal((events.at(-1) as JsonObject).status, "completed");
  } finally {
    client.close();
  }
});

test("fake RPC abort fixture stops work and emits an aborted agent_end", async () => {
  const client = spawnFakeRpc(["--stream-delay-ms", "50"]);
  try {
    const aborted = waitForEvents(client, (events) =>
      events.some(
        (event) =>
          event.type === "agent_end" &&
          (event as JsonObject).status === "aborted",
      ),
    );
    await client.request("prompt", { text: "abort fixture" });
    const abortResult = await client.request("abort");
    assert.deepEqual(abortResult, { aborted: true });
    await aborted;
  } finally {
    client.close();
  }
});

test("fake RPC prompt scenario exposes reducer extension event fixtures", async () => {
  const client = spawnFakeRpc([
    "--stream-delay-ms",
    "1",
    "--prompt-scenario",
    "all",
  ]);
  try {
    const allFixtureEvents = waitForEvents(client, (events) =>
      [
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
        "queue_update",
        "compaction_start",
        "compaction_end",
        "auto_retry_start",
        "auto_retry_end",
        "extension_ui_request",
        "agent_end",
      ].every((type) => events.some((event) => event.type === type)),
    );
    await client.request("prompt", { text: "exercise reducer fixtures" });
    const events = await allFixtureEvents;
    assert.equal(
      (
        events.find(
          (event) => event.type === "extension_ui_request",
        ) as JsonObject
      ).method,
      "confirm",
    );
    assert.equal(
      (events.find((event) => event.type === "queue_update") as JsonObject)
        .followUpCount,
      2,
    );
  } finally {
    client.close();
  }
});

test("fake RPC malformed JSON and pending-exit fixtures exercise transport failure paths", async () => {
  const malformed = spawnFakeRpc(["--malformed-on-start"]);
  try {
    const parseError = waitForEvents(malformed, (events) =>
      events.some((event) => event.type === "rpc_parse_error"),
    );
    await parseError;
    assert.match(malformed.stderr.snapshot(), /Malformed JSONL/);
  } finally {
    malformed.close();
  }

  const exiting = spawnFakeRpc(["--exit-after-first-command"]);
  await assert.rejects(exiting.request("get_state"), /exited|subprocess/i);
  assert.equal(exiting.pendingCount, 0);
});

test("platform minimal RPC smoke can run against the shared fake RPC shim", async () => {
  const root = tempDir("pi-deck-fake-rpc-smoke-");
  const piShim = path.join(root, "pi");
  writeFakePiShim(piShim);

  const result = await runMinimalRpcSmokeTest({
    config: { piBinary: piShim, env: { PATH: process.env.PATH ?? "" } },
    version: "pi fake-rpc 0.0.0",
    tempRoot: root,
    timeoutMs: 2_000,
    force: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.noSessionFilesCreated, true);
  assert.equal((result.state as JsonObject).sessionId, "fake-session-1");
  const stripPrivatePrefix = (value: string): string =>
    value.startsWith("/private/") ? value.slice("/private".length) : value;
  assert.equal(
    stripPrivatePrefix((result.state as JsonObject).cwd as string),
    stripPrivatePrefix(result.tempCwd!),
  );
});
