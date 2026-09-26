import assert from "node:assert/strict";
import { it as test } from "vitest";
import { spawnFakeRpc } from "../../test/fakeRpcHarness.js";
import {
  JsonlRpcClient,
  JsonlRpcError,
  type JsonlRpcClientOptions,
  spawnJsonlRpcClient,
} from "./jsonlClient.js";
import type { RpcEventRecord } from "./types.js";

function spawnFake(
  args: string[] = [],
  options: JsonlRpcClientOptions = {},
): JsonlRpcClient {
  return spawnFakeRpc(args, options);
}

function waitForEvent(
  client: JsonlRpcClient,
  predicate: (event: RpcEventRecord) => boolean,
  timeoutMs = 5_000,
): Promise<RpcEventRecord> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for RPC event"));
    }, timeoutMs);
    const listener = (event: RpcEventRecord): void => {
      if (!predicate(event)) {
        return;
      }
      cleanup();
      resolve(event);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off("event", listener);
    };
    client.on("event", listener);
  });
}

test("JSONL RPC client matches responses by request id", async () => {
  const client = spawnFake();
  try {
    const state = await client.request("get_state");
    assert.equal((state as { sessionId?: string }).sessionId, "fake-session-1");
    assert.equal(client.pendingCount, 0);
  } finally {
    client.close();
  }
});

test("JSONL RPC client routes non-response records as async events", async () => {
  const client = spawnFake(["--stream-delay-ms", "1"]);
  const events: string[] = [];
  client.on("event", (event: RpcEventRecord) => events.push(event.type));
  try {
    await client.request("prompt", { text: "hello" });
    await waitForEvent(client, (event) => event.type === "agent_end");
    assert.ok(events.includes("agent_start"));
    assert.ok(events.includes("message_update"));
    assert.ok(events.includes("agent_end"));
  } finally {
    client.close();
  }
});

test("JSONL RPC client reports command and captured stderr on unexpected exit", async () => {
  const client = spawnFake(["--stderr-on-start", "--exit-after-first-command"]);
  await assert.rejects(client.request("get_state"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /exited \(code=42, signal=null\)/);
    assert.match(error.message, /command=.*fakeRpcServer\.cjs/);
    assert.match(error.message, /stderr=.*deterministic stderr diagnostic/);
    return true;
  });
  assert.equal(client.pendingCount, 0);
});

test("unexpected-exit diagnostics are bounded and redact command and stderr secrets", async () => {
  const secret = "never-print-this-secret";
  const script =
    'process.stderr.write("x".repeat(20_000) + "\\ntoken=" + process.argv.at(-1) + "\\n"); process.exit(7)';
  const client = spawnJsonlRpcClient(
    process.execPath,
    ["-e", script, "--", "--api-key", secret],
    { cwd: process.cwd(), env: process.env },
  );

  await assert.rejects(client.request("get_state"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /exited \(code=7, signal=null\)/);
    assert.match(error.message, /command=.*--api-key/);
    assert.match(error.message, /stderr=.*chars omitted.*\[REDACTED\]/s);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.ok(
      error.message.length < 12_000,
      "exit diagnostic must stay bounded",
    );
    return true;
  });
});

test("JSONL RPC client rejects exact Pi RPC error responses", async () => {
  const client = spawnFake();
  try {
    await assert.rejects(
      client.request("unknown_command"),
      (error: unknown) => {
        assert.ok(error instanceof JsonlRpcError);
        assert.equal(error.code, undefined);
        assert.match(error.message, /unknown_command/);
        return true;
      },
    );
    assert.equal(client.pendingCount, 0);
  } finally {
    client.close();
  }
});

test("JSONL RPC client times out command responses and clears pending request", async () => {
  const client = spawnFake(["--ignore-command", "get_state"]);
  try {
    await assert.rejects(
      client.request("get_state", undefined, 20),
      /timed out/i,
    );
    assert.equal(client.pendingCount, 0);
  } finally {
    client.close();
  }
});

test("JSONL RPC client captures stderr diagnostics", async () => {
  const client = spawnFake(["--stderr-on-start"]);
  try {
    await client.request("get_state");
    assert.match(client.stderr.snapshot(), /deterministic stderr diagnostic/);
  } finally {
    client.close();
  }
});

test("JSONL RPC client treats malformed output as fatal and emits parse error event", async () => {
  const client = spawnFake(["--malformed-on-start"]);
  const parseError = waitForEvent(
    client,
    (event) => event.type === "rpc_parse_error",
  );
  const event = await parseError;
  assert.match(String(event.message), /Malformed|Expected|Unexpected|JSON/i);
  assert.match(client.stderr.snapshot(), /Malformed JSONL/);
});

test("JSONL RPC client treats an oversized record as fatal by default", async () => {
  const client = spawnFake([], { maxLineBytes: 1 });
  try {
    const parseError = waitForEvent(
      client,
      (event) => event.type === "rpc_parse_error",
    );
    const request = client.request("get_state");
    const event = await parseError;
    assert.match(String(event.message), /exceeds maximum size of 1 bytes/i);
    await assert.rejects(request, /Malformed JSONL/i);
    assert.match(client.stderr.snapshot(), /Malformed JSONL/);
  } finally {
    client.close();
  }
});
