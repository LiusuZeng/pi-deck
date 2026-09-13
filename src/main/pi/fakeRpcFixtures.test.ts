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

test("fake RPC persists a one-shot terminal error in live and reloaded sessions", async () => {
  const directory = tempDir("pi-deck-fake-rpc-error-");
  const sessionFile = path.join(directory, "error.jsonl");
  const onceFile = path.join(directory, "failed-once");
  const args = [
    "--session",
    sessionFile,
    "--prompt-error-prefix",
    "trigger provider error",
    "--prompt-error-once-file",
    onceFile,
  ];
  let liveMessages: JsonObject[];
  const client = spawnFakeRpc(args);
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
    assert.equal(assistantMessage.id, "msg_assistant_1");
    assert.equal(assistantMessage.stopReason, "error");
    assert.equal(
      nestedError.errorMessage,
      "Usage limit reached for fake provider.",
    );
    assert.equal(agentEnd.willRetry, false);
    assert.equal("status" in agentEnd, false);
    assert.deepEqual(terminalMessages.at(-1), assistantMessage);

    const messages = (await client.request("get_messages")) as JsonObject;
    liveMessages = messages.messages as JsonObject[];
    assert.equal(liveMessages.length, 3);
    assert.deepEqual(liveMessages.at(-1), assistantMessage);

    const persisted = fs
      .readFileSync(sessionFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { message?: JsonObject })
      .find((record) => record.message?.id === "msg_assistant_1")?.message;
    assert.deepEqual(persisted, assistantMessage);
  } finally {
    client.close();
  }

  const reloaded = spawnFakeRpc(args);
  try {
    const messages = (await reloaded.request("get_messages")) as JsonObject;
    const reloadedMessages = messages.messages as JsonObject[];
    assert.deepEqual(
      reloadedMessages.map((message) => message.id),
      ["msg_user_1", "msg_assistant_1"],
    );
    assert.deepEqual(reloadedMessages.at(-1), liveMessages!.at(-1));
  } finally {
    reloaded.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fake RPC emits a production-shaped OpenAI Codex auth-expiry failure", async () => {
  const client = spawnFakeRpc([
    "--production-shaped",
    "--openai-codex-auth-expired",
  ]);
  try {
    const terminal = waitForEvents(client, (events) =>
      events.some((event) => event.type === "agent_end"),
    );
    await client.request("prompt", { message: "continue durable work" });
    const update = (await terminal).find(
      (event) => event.type === "message_update",
    ) as JsonObject;
    const assistant = update.message as JsonObject;
    assert.equal(assistant.provider, "openai-codex");
    assert.equal(
      assistant.errorMessage,
      "Provided authentication token is expired.",
    );
    assert.equal((update.assistantMessageEvent as JsonObject).type, "error");
  } finally {
    client.close();
  }
});

test("fake RPC auth expiry is one-shot across replacement workers", async () => {
  const directory = tempDir("pi-deck-fake-auth-once-");
  const marker = path.join(directory, "auth-expired.marker");
  const args = [
    "--production-shaped",
    "--openai-codex-auth-expired",
    "--openai-codex-auth-expired-once-file",
    marker,
    "--stream-delay-ms",
    "1",
  ];
  const failed = spawnFakeRpc(args);
  try {
    const terminal = waitForEvents(failed, (events) =>
      events.some((event) => event.type === "agent_end"),
    );
    await failed.request("prompt", { message: "first attempt" });
    const update = (await terminal).find(
      (event) => event.type === "message_update",
    ) as JsonObject;
    assert.equal(
      (update.message as JsonObject).errorMessage,
      "Provided authentication token is expired.",
    );
    assert.ok(fs.existsSync(marker));
  } finally {
    failed.close();
  }

  const recovered = spawnFakeRpc(args);
  try {
    const terminal = waitForEvents(recovered, (events) =>
      events.some((event) => event.type === "agent_end"),
    );
    await recovered.request("prompt", { message: "verified after repair" });
    const events = await terminal;
    assert.ok(events.some((event) => event.type === "agent_end"));
    const completed = events.find(
      (event) => event.type === "agent_end",
    ) as JsonObject;
    const messages = completed.messages as JsonObject[];
    assert.equal(
      messages.at(-1)?.content,
      "I’ll review the workspace and summarize the next steps.",
    );
  } finally {
    recovered.close();
    fs.rmSync(directory, { recursive: true, force: true });
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

test("fake RPC streaming-scroll scenario emits delayed tool updates before completion", async () => {
  const client = spawnFakeRpc([
    "--stream-delay-ms",
    "1",
    "--prompt-scenario",
    "tool-stream-scroll",
  ]);
  try {
    const streamFixture = waitForEvents(
      client,
      (events) =>
        events.filter(
          (event) =>
            event.type === "tool_execution_update" &&
            (event as JsonObject).toolCallId ===
              "tool_scroll_streaming_command",
        ).length === 8 &&
        events.some(
          (event) =>
            event.type === "tool_execution_end" &&
            (event as JsonObject).toolCallId ===
              "tool_scroll_streaming_command",
        ) &&
        events.some(
          (event) =>
            event.type === "message_update" &&
            typeof (event as JsonObject).content === "string" &&
            ((event as JsonObject).content as string).includes(
              "Fake response to:",
            ),
        ),
    );
    await client.request("prompt", { text: "exercise scroll stream fixture" });
    const events = await streamFixture;
    const updateIndex = events.findIndex(
      (event) =>
        event.type === "tool_execution_update" &&
        (event as JsonObject).toolCallId === "tool_scroll_streaming_command",
    );
    const toolEndIndex = events.findIndex(
      (event) =>
        event.type === "tool_execution_end" &&
        (event as JsonObject).toolCallId === "tool_scroll_streaming_command",
    );
    const finalMessageIndex = events.findIndex(
      (event) =>
        event.type === "message_update" &&
        typeof (event as JsonObject).content === "string" &&
        ((event as JsonObject).content as string).includes("Fake response to:"),
    );
    const updates = events.filter(
      (event) =>
        event.type === "tool_execution_update" &&
        (event as JsonObject).toolCallId === "tool_scroll_streaming_command",
    );
    assert.equal(updates.length, 8);
    assert.ok(updateIndex >= 0);
    assert.ok(toolEndIndex > updateIndex);
    assert.ok(finalMessageIndex > toolEndIndex);
  } finally {
    client.close();
  }
});

test("fake RPC command failure fixture exposes stderr and exit code", async () => {
  const client = spawnFakeRpc([
    "--stream-delay-ms",
    "1",
    "--prompt-scenario",
    "tool-error",
  ]);
  try {
    const toolEnd = waitForEvents(client, (events) =>
      events.some(
        (event) =>
          event.type === "tool_execution_end" &&
          (event as JsonObject).status === "error",
      ),
    );
    await client.request("prompt", { text: "exercise failed command fixture" });
    const events = await toolEnd;
    const failedToolEnd = events.find(
      (event) =>
        event.type === "tool_execution_end" &&
        (event as JsonObject).status === "error",
    ) as JsonObject | undefined;
    assert.equal(failedToolEnd?.toolName, "bash");
    assert.deepEqual(failedToolEnd?.args, {
      command: "npm test -- --run fake-failure.test.ts",
    });
    assert.equal(failedToolEnd?.stderr, "fake command failed on stderr");
    assert.equal(failedToolEnd?.exitCode, 1);
  } finally {
    client.close();
  }
});

test("fake RPC can emit a failed tool before a pending extension request", async () => {
  const client = spawnFakeRpc([
    "--stream-delay-ms",
    "1",
    "--prompt-scenario",
    "tool-error-extension-ui",
  ]);
  try {
    const promptEvents = waitForEvents(
      client,
      (events) =>
        events.some(
          (event) =>
            event.type === "tool_execution_end" &&
            (event as JsonObject).status === "error",
        ) && events.some((event) => event.type === "extension_ui_request"),
    );
    await client.request("prompt", { text: "request approval after failure" });
    const events = await promptEvents;
    const failedToolIndex = events.findIndex(
      (event) =>
        event.type === "tool_execution_end" &&
        (event as JsonObject).status === "error",
    );
    const requestIndex = events.findIndex(
      (event) => event.type === "extension_ui_request",
    );

    assert.ok(failedToolIndex >= 0);
    assert.ok(requestIndex > failedToolIndex);
  } finally {
    client.close();
  }
});

test("fake RPC retains extension response handling across a production-shaped provider error", async () => {
  const client = spawnFakeRpc([
    "--stream-delay-ms",
    "1",
    "--prompt-scenario",
    "extension-ui-error",
  ]);
  const received: RpcEventRecord[] = [];
  const onEvent = (event: RpcEventRecord): void => {
    received.push(event);
  };
  client.on("event", onEvent);
  try {
    const promptEvents = waitForEvents(
      client,
      (events) =>
        events.some((event) => event.type === "extension_ui_request") &&
        events.some(
          (event) =>
            event.type === "message_update" &&
            (
              (event as JsonObject).assistantMessageEvent as
                | JsonObject
                | undefined
            )?.type === "error",
        ) &&
        events.some((event) => event.type === "agent_end"),
    );
    await client.request("prompt", { text: "request approval then fail" });
    const events = await promptEvents;
    const request = events.find(
      (event) => event.type === "extension_ui_request",
    ) as JsonObject;
    const requestIndex = events.indexOf(request as RpcEventRecord);
    const updateIndex = events.findIndex(
      (event) => event.type === "message_update",
    );
    const agentEndIndex = events.findIndex(
      (event) => event.type === "agent_end",
    );
    const update = events[updateIndex] as JsonObject;
    const failedAssistant = update.message as JsonObject;
    const agentEnd = events[agentEndIndex] as JsonObject;

    assert.ok(requestIndex >= 0);
    assert.ok(updateIndex > requestIndex);
    assert.ok(agentEndIndex > updateIndex);
    assert.equal(failedAssistant.stopReason, "error");
    assert.equal(
      failedAssistant.errorMessage,
      "Fake provider failed after requesting extension input.",
    );
    assert.equal(agentEnd.willRetry, false);
    assert.equal("status" in agentEnd, false);
    assert.deepEqual(agentEnd.messages, [failedAssistant]);

    // The terminal error must not make the fake reject the still-pending
    // dialog response or fabricate a later successful agent_end.
    await client.send({ type: "extension_ui_response", id: request.id });
    await delay(10);
    assert.equal(
      received.filter((event) => event.type === "agent_end").length,
      1,
    );
  } finally {
    client.off("event", onEvent);
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
