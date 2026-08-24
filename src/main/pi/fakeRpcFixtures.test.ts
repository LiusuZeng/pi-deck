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
  timeoutMs = 5_000,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    const messages = (await client.request("get_messages")) as JsonObject;
    assert.ok(Array.isArray(messages.messages));
    assert.equal(
      (messages.messages as JsonObject[])[0]?.content,
      "Fake RPC ready",
    );
  } finally {
    client.close();
  }
});

test("fake RPC production-shaped profile uses realistic documentation labels", async () => {
  const client = spawnFakeRpc([
    "--production-shaped",
    "--extra-model",
    "--prompt-scenario",
    "extension-ui",
    "--stream-delay-ms",
    "1",
  ]);
  try {
    const state = (await client.request("get_state")) as JsonObject;
    assert.equal(state.provider, "anthropic");

    const modelsResponse = (await client.request(
      "get_available_models",
    )) as JsonObject;
    const models = modelsResponse.models as JsonObject[];
    assert.deepEqual(
      models.map((model) => [model.provider, model.name]),
      [
        ["anthropic", "Claude Sonnet 4.5"],
        ["openai", "GPT-5 Codex"],
      ],
    );

    const extensionRequest = waitForEvents(client, (events) =>
      events.some((event) => event.type === "extension_ui_request"),
    );
    await client.request("prompt", { message: "Review this workspace." });
    const events = await extensionRequest;
    const request = events.find(
      (event) => event.type === "extension_ui_request",
    ) as JsonObject;
    assert.equal(request.title, "Workspace approval");
    assert.equal(
      request.message,
      "Allow Pi to continue with this workspace action?",
    );
  } finally {
    client.close();
  }
});

test("fake RPC configures the extension UI auto-complete timeout", async () => {
  const client = spawnFakeRpc([
    "--prompt-scenario",
    "extension-ui",
    "--extension-ui-auto-complete-timeout-ms",
    "25",
    "--stream-delay-ms",
    "1",
  ]);
  try {
    const extensionRequest = waitForEvents(client, (events) =>
      events.some((event) => event.type === "extension_ui_request"),
    );
    const completed = waitForEvents(client, (events) =>
      events.some((event) => event.type === "agent_end"),
    );
    await client.request("prompt", { message: "timeout fixture" });
    const request = (await extensionRequest).find(
      (event) => event.type === "extension_ui_request",
    ) as JsonObject;
    assert.equal(request.timeout, 25);

    const events = await completed;
    assert.equal((events.at(-1) as JsonObject).status, "completed");
  } finally {
    client.close();
  }
});

test("fake RPC retains the default extension UI timeout for invalid values", async () => {
  for (const timeout of [
    "-1",
    "2147483648",
    "9007199254740992",
    "not-a-number",
  ]) {
    const client = spawnFakeRpc([
      "--prompt-scenario",
      "extension-ui",
      "--extension-ui-auto-complete-timeout-ms",
      timeout,
    ]);
    try {
      const extensionRequest = waitForEvents(client, (events) =>
        events.some((event) => event.type === "extension_ui_request"),
      );
      await client.request("prompt", { message: `invalid timeout ${timeout}` });
      const request = (await extensionRequest).find(
        (event) => event.type === "extension_ui_request",
      ) as JsonObject;
      assert.equal(request.timeout, 5_000);
      await client.send({ type: "extension_ui_response", id: request.id });
    } finally {
      client.close();
    }
  }
});

test("fake RPC can reject a configured command while retaining the worker", async () => {
  const client = spawnFakeRpc(["--fail-command", "set_model"]);
  try {
    await assert.rejects(
      client.request("set_model", {
        provider: "fake-provider",
        modelId: "fake-model",
      }),
      /Fake RPC configured to fail command: set_model/,
    );
    const state = (await client.request("get_state")) as JsonObject;
    assert.equal(state.model, "fake-model");
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
    const accepted = await client.request("prompt", { message: "hello" });
    assert.equal(accepted, null);
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
    assert.equal(abortResult, null);
    await aborted;
  } finally {
    client.close();
  }
});

test("fake RPC abort clears a pending extension UI request and timer", async () => {
  const client = spawnFakeRpc([
    "--prompt-scenario",
    "extension-ui",
    "--extension-ui-auto-complete-timeout-ms",
    "25",
  ]);
  const events: RpcEventRecord[] = [];
  const onEvent = (event: RpcEventRecord): void => {
    events.push(event);
  };
  client.on("event", onEvent);
  try {
    const extensionRequest = waitForEvents(client, (received) =>
      received.some((event) => event.type === "extension_ui_request"),
    );
    await client.request("prompt", { message: "abort extension UI fixture" });
    const request = (await extensionRequest).find(
      (event) => event.type === "extension_ui_request",
    ) as JsonObject;
    await client.request("abort");
    await client.send({ type: "extension_ui_response", id: request.id });
    await delay(50);

    const agentEnds = events.filter((event) => event.type === "agent_end");
    assert.equal(agentEnds.length, 1);
    assert.equal((agentEnds[0] as JsonObject).status, "aborted");
  } finally {
    client.off("event", onEvent);
    client.close();
  }
});

test("fake RPC error fixture mirrors Pi 0.81 terminal error events", async () => {
  const client = spawnFakeRpc(["--prompt-scenario", "error"]);
  try {
    const terminal = waitForEvents(client, (events) =>
      events.some((event) => event.type === "agent_end"),
    );
    await client.request("prompt", { message: "trigger provider error" });
    const events = await terminal;
    const update = events.find(
      (event) => event.type === "message_update",
    ) as JsonObject;
    const assistantMessage = update.message as JsonObject;
    const assistantEvent = update.assistantMessageEvent as JsonObject;
    const nestedError = assistantEvent.error as JsonObject;
    const agentEnd = events.find(
      (event) => event.type === "agent_end",
    ) as JsonObject;
    const terminalMessages = agentEnd.messages as JsonObject[];

    assert.equal(assistantEvent.type, "error");
    assert.equal(assistantMessage.stopReason, "error");
    assert.equal(
      nestedError.errorMessage,
      "Usage limit reached for fake provider.",
    );
    assert.equal(agentEnd.willRetry, false);
    assert.equal("status" in agentEnd, false);
    assert.equal(
      terminalMessages.at(-1)?.errorMessage,
      nestedError.errorMessage,
    );
  } finally {
    client.close();
  }
});

test("fake RPC accepts exact steer and follow_up commands and emits full queues", async () => {
  const client = spawnFakeRpc(["--stream-delay-ms", "50"]);
  try {
    const queueUpdate = waitForEvents(client, (events) =>
      events.some(
        (event) =>
          event.type === "queue_update" &&
          Array.isArray((event as JsonObject).steering) &&
          Array.isArray((event as JsonObject).followUp) &&
          ((event as JsonObject).steering as unknown[]).length === 1 &&
          ((event as JsonObject).followUp as unknown[]).length === 1,
      ),
    );
    await client.request("prompt", { message: "work first" });
    await client.request("steer", { message: "change direction" });
    await client.request("follow_up", { message: "do this afterwards" });
    const events = await queueUpdate;
    const queue = [...events]
      .reverse()
      .find((event) => event.type === "queue_update") as JsonObject;
    assert.deepEqual(queue.steering, ["change direction"]);
    assert.deepEqual(queue.followUp, ["do this afterwards"]);
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
      ].every((type) => events.some((event) => event.type === type)),
    );
    await client.request("prompt", { text: "exercise reducer fixtures" });
    const events = await allFixtureEvents;
    const extensionRequest = events.find(
      (event) => event.type === "extension_ui_request",
    ) as JsonObject;
    assert.equal(extensionRequest.method, "confirm");
    assert.equal(extensionRequest.id, "ext_fake_dialog_1");
    assert.equal(extensionRequest.title, "Fake confirm");
    assert.equal(extensionRequest.timeout, 5_000);
    assert.equal(
      (
        (events.find((event) => event.type === "queue_update") as JsonObject)
          .followUp as unknown[]
      ).length,
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
    timeoutMs: 5_000,
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
