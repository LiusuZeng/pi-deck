import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it as test } from "vitest";
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

function waitForPath(file: string, timeoutMs = 5_000): Promise<void> {
  if (fs.existsSync(file)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const directory = path.dirname(file);
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for path: ${file}`));
    }, timeoutMs);
    const finish = (): void => {
      if (!fs.existsSync(file)) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    };
    const watcher = fs.watch(directory, finish);
    finish();
  });
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

test("fake RPC generic state barrier latches enabled requests until explicit release", async () => {
  const directory = tempDir("pi-deck-fake-state-barrier-");
  const barrierDir = path.join(directory, "barrier");
  const enabledFile = path.join(directory, "enabled");
  const signalFile = path.join(directory, "started");
  fs.mkdirSync(barrierDir);
  fs.writeFileSync(enabledFile, "enabled\n");
  const client = spawnFakeRpc([
    "--delay-get-state-enabled-file",
    enabledFile,
    "--get-state-barrier-dir",
    barrierDir,
    "--get-state-signal-file",
    signalFile,
  ]);
  try {
    const heldState = client.request("get_state");
    await waitForPath(signalFile);
    assert.equal(client.pendingCount, 1);

    // Marker removal affects future calls only; the request that observed it
    // remains held until the explicit release file appears.
    fs.rmSync(enabledFile);
    const immediateState = (await client.request("get_state")) as JsonObject;
    assert.equal(immediateState.sessionId, "fake-session-1");
    assert.equal(client.pendingCount, 1);

    fs.writeFileSync(path.join(barrierDir, "release-get-state"), "release\n");
    const releasedState = (await heldState) as JsonObject;
    assert.equal(releasedState.sessionId, "fake-session-1");
    assert.equal(client.pendingCount, 0);
  } finally {
    fs.writeFileSync(path.join(barrierDir, "release-get-state"), "release\n");
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fake RPC native-fork state barrier waits for an explicit release", async () => {
  const directory = tempDir("pi-deck-fake-fork-state-barrier-");
  const barrierDir = path.join(directory, "barrier");
  const sourceFile = path.join(directory, "source.jsonl");
  const targetFile = path.join(directory, "target.jsonl");
  fs.mkdirSync(barrierDir);
  fs.writeFileSync(
    sourceFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "source",
      timestamp: "2026-09-27T00:00:00.000Z",
      cwd: directory,
    })}\n`,
  );
  const client = spawnFakeRpc([
    "--fork",
    sourceFile,
    "--fork-target",
    targetFile,
    "--fork-state-barrier-dir",
    barrierDir,
  ]);
  try {
    const statePromise = client.request("get_state");
    const createdMarker = path.join(barrierDir, "target-created");
    await waitForPath(createdMarker);

    assert.equal(client.pendingCount, 1);
    assert.equal(
      fs.realpathSync(targetFile),
      fs.readFileSync(createdMarker, "utf8").trim(),
    );
    const secondState = (await client.request("get_state")) as JsonObject;
    assert.equal(
      fs.realpathSync(secondState.sessionFile as string),
      fs.realpathSync(targetFile),
    );
    assert.equal(client.pendingCount, 1);
    fs.writeFileSync(path.join(barrierDir, "release-target"), "release\n");

    const state = (await statePromise) as JsonObject;
    assert.equal(
      fs.realpathSync(state.sessionFile as string),
      fs.realpathSync(targetFile),
    );
    assert.equal(client.pendingCount, 0);
  } finally {
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fake RPC fork get_messages barrier parses and leaves native snapshots unstalled", async () => {
  const directory = tempDir("pi-deck-fake-fork-messages-barrier-");
  const barrierDir = path.join(directory, "barrier");
  const sourceFile = path.join(directory, "source.jsonl");
  const targetFile = path.join(directory, "target.jsonl");
  fs.mkdirSync(barrierDir);
  fs.writeFileSync(
    sourceFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "source",
      timestamp: "2026-09-27T00:00:00.000Z",
      cwd: directory,
    })}\n`,
  );

  const native = spawnFakeRpc(["--fork-get-messages-barrier-dir", barrierDir]);
  try {
    const messages = (await native.request("get_messages")) as JsonObject;
    assert.ok(Array.isArray(messages.messages));
    assert.equal(
      fs.existsSync(path.join(barrierDir, "snapshot-started")),
      false,
    );
    assert.equal(native.pendingCount, 0);
  } finally {
    native.close();
  }

  const fork = spawnFakeRpc([
    "--fork",
    sourceFile,
    "--fork-target",
    targetFile,
    "--fork-get-messages-barrier-dir",
    barrierDir,
  ]);
  try {
    const heldMessages = fork.request("get_messages");
    const startedFile = path.join(barrierDir, "snapshot-started");
    await waitForPath(startedFile);
    assert.equal(fork.pendingCount, 1);
    assert.equal(
      fs.readFileSync(startedFile, "utf8").trim(),
      fs.realpathSync(targetFile),
    );

    fs.writeFileSync(path.join(barrierDir, "release-snapshot"), "release\n");
    const messages = (await heldMessages) as JsonObject;
    assert.ok(Array.isArray(messages.messages));
    assert.equal(fork.pendingCount, 0);
  } finally {
    fs.writeFileSync(path.join(barrierDir, "release-snapshot"), "release\n");
    fork.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fake RPC abort cancels a held native-fork state barrier", async () => {
  const directory = tempDir("pi-deck-fake-fork-state-cancel-");
  const barrierDir = path.join(directory, "barrier");
  const sourceFile = path.join(directory, "source.jsonl");
  const targetFile = path.join(directory, "target.jsonl");
  fs.mkdirSync(barrierDir);
  fs.writeFileSync(
    sourceFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "source",
      timestamp: "2026-09-27T00:00:00.000Z",
      cwd: directory,
    })}\n`,
  );
  const client = spawnFakeRpc([
    "--fork",
    sourceFile,
    "--fork-target",
    targetFile,
    "--fork-state-barrier-dir",
    barrierDir,
  ]);
  try {
    const statePromise = client.request("get_state");
    await waitForPath(path.join(barrierDir, "target-created"));
    await client.request("abort");

    const closed = new Promise<void>((resolve) => {
      client.once("close", () => resolve());
    });
    client.close();
    await assert.rejects(statePromise, /exited|subprocess/i);
    await closed;
    assert.equal(client.pendingCount, 0);
  } finally {
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
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
    assert.equal(messages.at(-1)?.stopReason, "stop");
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

test("fake RPC clears an active-parent crash barrier after its durable follow_up", async () => {
  const directory = tempDir("pi-deck-fake-active-parent-once-");
  const barrier = path.join(directory, "activate-parent");
  const session = path.join(directory, "parent.jsonl");
  fs.writeFileSync(barrier, "active\n");
  const args = [
    "--session",
    session,
    "--active-on-start-ms",
    "100",
    "--active-on-start-enabled-file",
    barrier,
    "--clear-active-on-start-enabled-file-after-follow-up-receipt",
  ];
  const first = spawnFakeRpc(args);
  try {
    const active = (await first.request("get_state")) as {
      isStreaming?: boolean;
    };
    expect(active.isStreaming).toBe(true);
    const settled = waitForEvents(first, (events) =>
      events.some((event) => event.type === "agent_settled"),
    );
    await first.request("follow_up", { message: "durable follow-up" });
    await settled;
    expect(fs.existsSync(barrier)).toBe(false);
  } finally {
    first.close();
  }

  const recovered = spawnFakeRpc(args);
  try {
    const state = (await recovered.request("get_state")) as {
      isStreaming?: boolean;
    };
    // A quiescent recovery worker must not inherit the crash-only active turn.
    expect(state.isStreaming).toBe(false);
  } finally {
    recovered.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fake RPC consumes queued follow_up as a durable user turn", async () => {
  const directory = tempDir("pi-deck-fake-follow-up-receipt-");
  const session = path.join(directory, "parent.jsonl");
  const marker =
    "<!-- pi-deck-synthesis-delivery:v1:12345678-1234-1234-1234-123456789abc -->";
  const client = spawnFakeRpc([
    "--session",
    session,
    "--stream-delay-ms",
    "20",
  ]);
  try {
    const settled = waitForEvents(client, (events) =>
      events.some((event) => event.type === "agent_settled"),
    );
    await client.request("prompt", { message: "active parent turn" });
    await client.request("follow_up", { message: `${marker}\nqueued receipt` });
    await settled;
    const live = (await client.request("get_messages")) as {
      messages: Array<{ role?: string; content?: string }>;
    };
    expect(live.messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining(marker),
      }),
    );
  } finally {
    client.close();
  }
  const reloaded = spawnFakeRpc(["--session", session]);
  try {
    const history = (await reloaded.request("get_messages")) as {
      messages: Array<{ role?: string; content?: string }>;
    };
    assert.ok(
      history.messages.some(
        (message) =>
          message.role === "user" && message.content?.includes(marker),
      ),
    );
  } finally {
    reloaded.close();
    fs.rmSync(directory, { recursive: true, force: true });
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

test("fake RPC emits controllable extension-shaped parallel subagent snapshots", async () => {
  const directory = tempDir("pi-deck-fake-subagent-parallel-");
  const barriers = path.join(directory, "barriers");
  const sessionFile = path.join(directory, "parallel.jsonl");
  fs.mkdirSync(barriers, { recursive: true });
  const client = spawnFakeRpc([
    "--prompt-scenario",
    "subagent",
    "--subagent-activity-barrier-dir",
    barriers,
    "--session",
    sessionFile,
    "--stream-delay-ms",
    "1",
  ]);
  const received: RpcEventRecord[] = [];
  const record = (event: RpcEventRecord): void => {
    received.push(event);
  };
  client.on("event", record);
  try {
    const started = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_start"),
    );
    await client.request("prompt", {
      message: "parallel extension activity fixture",
    });
    const start = (await started).find(
      (event) => event.type === "tool_execution_start",
    ) as JsonObject;
    assert.equal(start.toolName, "subagent");
    assert.equal("partialResult" in start, false);
    assert.deepEqual(
      ((start.args as JsonObject).tasks as JsonObject[]).map((task) =>
        String(task.agent),
      ),
      ["scout", "scout", "reviewer"],
    );
    assert.equal(
      received.some((event) => event.type === "tool_execution_update"),
      false,
    );

    const firstUpdate = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_update"),
    );
    fs.writeFileSync(path.join(barriers, "parallel-update-1"), "release\n");
    const updateOne = (await firstUpdate).find(
      (event) => event.type === "tool_execution_update",
    ) as JsonObject;
    const firstPartial = updateOne.partialResult as JsonObject;
    const firstDetails = firstPartial.details as JsonObject;
    const firstResults = firstDetails.results as JsonObject[];
    assert.equal(firstDetails.mode, "parallel");
    assert.equal(firstDetails.agentScope, "user");
    assert.equal(firstDetails.projectAgentsDir, null);
    assert.equal(firstResults[0]?.exitCode, 0);
    assert.equal((firstResults[0]?.messages as unknown[]).length, 4);
    assert.equal(firstResults[1]?.exitCode, -1);

    const secondUpdate = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_update"),
    );
    fs.writeFileSync(path.join(barriers, "parallel-update-2"), "release\n");
    const updateTwo = (await secondUpdate).find(
      (event) => event.type === "tool_execution_update",
    ) as JsonObject;
    const secondResults = (
      (updateTwo.partialResult as JsonObject).details as JsonObject
    ).results as JsonObject[];
    assert.equal(secondResults[0]?.exitCode, 0);
    assert.equal(
      (secondResults[0]?.usage as JsonObject).turns as number | undefined,
      2,
    );
    assert.equal((secondResults[1]?.messages as unknown[]).length, 1);

    const finished = waitForEvents(
      client,
      (events) =>
        events.some((event) => event.type === "tool_execution_end") &&
        events.some((event) => event.type === "agent_end"),
    );
    fs.writeFileSync(path.join(barriers, "parallel-finish"), "release\n");
    const finalEvents = await finished;
    const end = finalEvents.find(
      (event) => event.type === "tool_execution_end",
    ) as JsonObject;
    const finalResult = end.result as JsonObject;
    const finalDetails = finalResult.details as JsonObject;
    const finalResults = finalDetails.results as JsonObject[];
    assert.equal("partialResult" in end, false);
    assert.deepEqual(
      finalResults.map((result) => [
        result.agent,
        result.exitCode,
        result.stopReason,
      ]),
      [
        ["scout", 0, "stop"],
        ["scout", 1, "error"],
        ["reviewer", 0, "stop"],
      ],
    );
    assert.equal(end.isError, false);

    const messages = (await client.request("get_messages")) as JsonObject;
    const persisted = messages.messages as JsonObject[];
    const toolResult = persisted.find(
      (message) => message.role === "toolResult",
    );
    assert.equal(toolResult?.toolName, "subagent");
    assert.deepEqual(toolResult?.details, finalDetails);
  } finally {
    client.off("event", record);
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fake RPC single subagent fixture publishes cumulative usage and completes", async () => {
  const directory = tempDir("pi-deck-fake-subagent-single-");
  const barriers = path.join(directory, "barriers");
  fs.mkdirSync(barriers, { recursive: true });
  const client = spawnFakeRpc([
    "--prompt-scenario",
    "subagent",
    "--subagent-activity-barrier-dir",
    barriers,
    "--stream-delay-ms",
    "1",
  ]);
  try {
    const started = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_start"),
    );
    await client.request("prompt", { message: "single success fixture" });
    const start = (await started).find(
      (event) => event.type === "tool_execution_start",
    ) as JsonObject;
    assert.deepEqual(start.args, {
      agent: "worker",
      task: "Inspect one deterministic target",
      agentScope: "user",
    });

    const first = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_update"),
    );
    fs.writeFileSync(path.join(barriers, "single-update-1"), "release\n");
    const firstUpdate = (await first).find(
      (event) => event.type === "tool_execution_update",
    ) as JsonObject;
    const firstResult = (
      ((firstUpdate.partialResult as JsonObject).details as JsonObject)
        .results as JsonObject[]
    )[0];
    assert.equal(firstResult?.exitCode, 0);
    assert.deepEqual(firstResult?.usage, {
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0002,
      contextTokens: 30,
      turns: 1,
    });

    const second = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_update"),
    );
    fs.writeFileSync(path.join(barriers, "single-update-2"), "release\n");
    const secondUpdate = (await second).find(
      (event) => event.type === "tool_execution_update",
    ) as JsonObject;
    const secondResult = (
      ((secondUpdate.partialResult as JsonObject).details as JsonObject)
        .results as JsonObject[]
    )[0];
    assert.deepEqual(secondResult?.usage, {
      input: 30,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0003,
      contextTokens: 45,
      turns: 2,
    });

    const finished = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_end"),
    );
    fs.writeFileSync(path.join(barriers, "single-finish"), "release\n");
    const end = (await finished).find(
      (event) => event.type === "tool_execution_end",
    ) as JsonObject;
    const terminal = (
      ((end.result as JsonObject).details as JsonObject).results as JsonObject[]
    )[0];
    assert.equal(terminal?.stopReason, "stop");
    assert.equal(terminal?.exitCode, 0);
  } finally {
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fake RPC cancellation leaves the child tool unresolved through actual abort", async () => {
  const directory = tempDir("pi-deck-fake-subagent-cancel-");
  const barriers = path.join(directory, "barriers");
  fs.mkdirSync(barriers, { recursive: true });
  const client = spawnFakeRpc([
    "--prompt-scenario",
    "subagent",
    "--subagent-activity-barrier-dir",
    barriers,
  ]);
  const received: RpcEventRecord[] = [];
  const record = (event: RpcEventRecord): void => {
    received.push(event);
  };
  client.on("event", record);
  try {
    const started = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_start"),
    );
    await client.request("prompt", { message: "cancellation fixture" });
    await started;

    const updated = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_update"),
    );
    fs.writeFileSync(path.join(barriers, "cancellation-update"), "release\n");
    await updated;

    const settled = waitForEvents(client, (events) =>
      events.some((event) => event.type === "agent_settled"),
    );
    await client.request("abort");
    const terminalEvents = await settled;
    assert.equal(
      terminalEvents.some(
        (event) =>
          event.type === "agent_end" &&
          (event as JsonObject).status === "aborted",
      ),
      true,
    );
    assert.equal(
      received.some((event) => event.type === "tool_execution_end"),
      false,
    );
  } finally {
    client.off("event", record);
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fake RPC emits malformed and oversized subagent edge fixtures behind gates", async () => {
  const directory = tempDir("pi-deck-fake-subagent-edge-");
  const barriers = path.join(directory, "barriers");
  fs.mkdirSync(barriers, { recursive: true });
  const client = spawnFakeRpc([
    "--prompt-scenario",
    "subagent",
    "--subagent-activity-barrier-dir",
    barriers,
    "--stream-delay-ms",
    "1",
  ]);
  try {
    const malformedStart = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_start"),
    );
    await client.request("prompt", { message: "malformed details fixture" });
    const malformedStartEvent = (await malformedStart).find(
      (event) => event.type === "tool_execution_start",
    ) as JsonObject;
    assert.deepEqual(malformedStartEvent.args, { agent: "malformed-only" });

    const malformedUpdate = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_update"),
    );
    fs.writeFileSync(path.join(barriers, "malformed-update"), "release\n");
    const malformed = (await malformedUpdate).find(
      (event) => event.type === "tool_execution_update",
    ) as JsonObject;
    assert.deepEqual((malformed.partialResult as JsonObject).details, {
      mode: "future-mode",
      results: "not-an-array",
    });
    const malformedFinished = waitForEvents(client, (events) =>
      events.some((event) => event.type === "agent_end"),
    );
    fs.writeFileSync(path.join(barriers, "malformed-finish"), "release\n");
    await malformedFinished;

    const oversizedStart = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_start"),
    );
    await client.request("prompt", { message: "oversized details fixture" });
    await oversizedStart;
    const oversizedUpdate = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_update"),
    );
    fs.writeFileSync(path.join(barriers, "oversized-update"), "release\n");
    const oversized = (await oversizedUpdate).find(
      (event) => event.type === "tool_execution_update",
    ) as JsonObject;
    const oversizedResult = (
      ((oversized.partialResult as JsonObject).details as JsonObject)
        .results as JsonObject[]
    )[0];
    assert.equal((oversizedResult?.messages as unknown[]).length, 140);
    assert.ok(String(oversizedResult?.task).length > 500);

    const oversizedFinished = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_end"),
    );
    fs.writeFileSync(path.join(barriers, "oversized-finish"), "release\n");
    await oversizedFinished;
  } finally {
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fake RPC chain fixture stops after failure and leaves the final step unrun", async () => {
  const directory = tempDir("pi-deck-fake-subagent-chain-");
  const barriers = path.join(directory, "barriers");
  fs.mkdirSync(barriers, { recursive: true });
  const client = spawnFakeRpc([
    "--prompt-scenario",
    "subagent",
    "--subagent-activity-barrier-dir",
    barriers,
    "--stream-delay-ms",
    "1",
  ]);
  try {
    const started = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_start"),
    );
    await client.request("prompt", { message: "chain failure fixture" });
    const start = (await started).find(
      (event) => event.type === "tool_execution_start",
    ) as JsonObject;
    const chain = (start.args as JsonObject).chain as JsonObject[];
    assert.deepEqual(
      chain.map((step) => step.agent),
      ["worker", "reviewer", "worker"],
    );

    const partial = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_update"),
    );
    fs.writeFileSync(path.join(barriers, "chain-update-1"), "release\n");
    const update = (await partial).find(
      (event) => event.type === "tool_execution_update",
    ) as JsonObject;
    const partialDetails = (update.partialResult as JsonObject)
      .details as JsonObject;
    assert.equal(partialDetails.mode, "chain");
    assert.equal((partialDetails.results as unknown[]).length, 1);

    const finished = waitForEvents(client, (events) =>
      events.some((event) => event.type === "tool_execution_end"),
    );
    fs.writeFileSync(path.join(barriers, "chain-finish"), "release\n");
    const end = (await finished).find(
      (event) => event.type === "tool_execution_end",
    ) as JsonObject;
    const result = end.result as JsonObject;
    const finalDetails = result.details as JsonObject;
    const results = finalDetails.results as JsonObject[];
    assert.equal(end.isError, true);
    assert.equal(finalDetails.mode, "chain");
    assert.deepEqual(
      results.map((item) => [item.step, item.exitCode, item.stopReason]),
      [
        [1, 0, "stop"],
        [2, 1, "error"],
      ],
    );
    assert.equal(
      results.some((item) => item.step === 3),
      false,
    );
  } finally {
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
