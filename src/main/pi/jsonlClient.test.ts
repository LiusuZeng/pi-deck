import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { it as test, vi } from "vitest";
import { spawnFakeRpc } from "../../test/fakeRpcHarness.js";
import {
  JsonlRpcClient,
  JsonlRpcDeliveryError,
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

interface DriverResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function runBrokenStdinDriver(
  mode: "request" | "send",
): Promise<DriverResult> {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-deck-stdin-driver-"));
  try {
    const entry = path.join(directory, "driver.ts");
    const outfile = path.join(directory, "driver.cjs");
    const jsonlClientPath = fileURLToPath(
      new URL("./jsonlClient.ts", import.meta.url),
    );
    writeFileSync(
      entry,
      `
        import { spawnJsonlRpcClient } from ${JSON.stringify(jsonlClientPath)};

        process.on("uncaughtExceptionMonitor", (error) => {
          const code = error && typeof error === "object" && "code" in error ? error.code : "";
          console.error("UNCAUGHT", code, error instanceof Error ? error.message : String(error));
        });
        process.on("unhandledRejection", (error) => {
          console.error("UNHANDLED_REJECTION", error instanceof Error ? error.message : String(error));
          process.exitCode = 3;
        });

        const childScript = ${JSON.stringify(`
          require("node:fs").closeSync(0);
          process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
          setTimeout(() => process.exit(0), 400);
        `)};
        const client = spawnJsonlRpcClient(
          process.execPath,
          ["-e", childScript],
          { cwd: process.cwd(), env: process.env },
          { requestTimeoutMs: 1_000 },
        );

        const ready = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("ready timeout")), 1_000);
          client.on("event", (event) => {
            if (event.type === "ready") {
              clearTimeout(timer);
              resolve(undefined);
            }
          });
        });

        async function main() {
          await ready;
          try {
            if (process.argv[2] === "request") {
              await client.request("get_state", undefined, 1_000);
            } else {
              await client.send({ type: "extension_ui_response", id: "review", value: "answer" });
            }
            console.log("unexpected-success");
            process.exitCode = 4;
          } catch (error) {
            console.log("handled", process.argv[2], error instanceof Error ? error.message : String(error));
          }

          try {
            await client.request("after_failure", undefined, 1_000);
            console.log("unexpected-future-success");
            process.exitCode = 5;
          } catch (error) {
            console.log("future-rejected", error instanceof Error ? error.message : String(error));
          }

          await new Promise((resolve) => client.child.once("exit", resolve));
        }

        main().catch((error) => {
          console.error("DRIVER_FAILED", error instanceof Error ? error.stack : String(error));
          process.exitCode = 2;
        });
      `,
      "utf8",
    );
    buildSync({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node26",
    });

    return await new Promise<DriverResult>((resolve, reject) => {
      const child = spawn(process.execPath, [outfile, mode], {
        cwd: process.cwd(),
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("broken stdin driver timed out"));
      }, 5_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    // The response and terminal event may arrive in the same stdout chunk.
    // Subscribe before sending, not after the request promise resumes.
    const ended = waitForEvent(client, (event) => event.type === "agent_end");
    await Promise.all([client.request("prompt", { text: "hello" }), ended]);
    assert.ok(events.includes("agent_start"));
    assert.ok(events.includes("message_update"));
    assert.ok(events.includes("agent_end"));
  } finally {
    client.close();
  }
});

test("JSONL RPC client routes completion coalesced with the prompt response", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    killed: false,
    kill(): boolean {
      this.killed = true;
      return true;
    },
    stdin: {
      destroyed: false,
      write(
        payload: string,
        _encoding: string,
        callback: (error?: Error | null) => void,
      ): boolean {
        const { id } = JSON.parse(payload) as { id: string };
        // One synchronous data event guarantees there is no promise/microtask
        // boundary between the response and terminal event.
        stdout.emit(
          "data",
          Buffer.from(
            [
              { id, type: "response", command: "prompt", success: true },
              { type: "agent_start" },
              { type: "message_update", content: "hello" },
              { type: "agent_end" },
            ]
              .map((record) => JSON.stringify(record) + "\n")
              .join(""),
          ),
        );
        callback();
        return true;
      },
    },
  }) as unknown as ChildProcess;
  const client = new JsonlRpcClient(child);
  const events: string[] = [];
  client.on("event", (event: RpcEventRecord) => events.push(event.type));
  try {
    const ended = waitForEvent(client, (event) => event.type === "agent_end");
    const response = client.request("prompt", { text: "hello" });
    assert.deepEqual(events, ["agent_start", "message_update", "agent_end"]);
    await Promise.all([response, ended]);
    assert.equal(client.pendingCount, 0);
    assert.equal(client.listenerCount("event"), 1);
  } finally {
    client.close();
  }
});

test("broken RPC stdin is contained on the request path", async () => {
  const result = await runBrokenStdinDriver("request");

  assert.equal(
    result.code,
    0,
    `driver stderr:\n${result.stderr}\ndriver stdout:\n${result.stdout}`,
  );
  assert.match(
    result.stdout,
    /handled request .*EPIPE|handled request .*stdin/i,
  );
  assert.match(
    result.stdout,
    /future-rejected .*EPIPE|future-rejected .*stdin/i,
  );
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event|UNCAUGHT/);
  assert.equal(result.signal, null);
});

test("broken RPC stdin is contained on the notification path", async () => {
  const result = await runBrokenStdinDriver("send");

  assert.equal(
    result.code,
    0,
    `driver stderr:\n${result.stderr}\ndriver stdout:\n${result.stdout}`,
  );
  assert.match(result.stdout, /handled send .*EPIPE|handled send .*stdin/i);
  assert.match(
    result.stdout,
    /future-rejected .*EPIPE|future-rejected .*stdin/i,
  );
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event|UNCAUGHT/);
  assert.equal(result.signal, null);
});

test("stdin stream failure rejects pending and future writes without fabricating close", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const writeCallbacks: Array<(error?: Error | null) => void> = [];
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write(
      _payload: string,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ): boolean {
      writeCallbacks.push(callback);
      return false;
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill(): boolean {
      this.killed = true;
      return true;
    },
  }) as unknown as ChildProcess;
  const client = new JsonlRpcClient(child, { requestTimeoutMs: 1_000 });
  const transportErrors: Error[] = [];
  const closes: Array<{ code: number | null; signal: NodeJS.Signals | null }> =
    [];
  client.typedOn("transportError", (error) => transportErrors.push(error));
  client.typedOn("close", (status) => closes.push(status));

  const request = client.request("get_state");
  const notification = client.send({
    type: "extension_ui_response",
    id: "review",
  });

  stdin.emit(
    "error",
    Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
  );

  await assert.rejects(request, /EPIPE/);
  await assert.rejects(notification, /EPIPE/);
  assert.equal(client.pendingCount, 0);
  assert.equal(transportErrors.length, 1);
  assert.deepEqual(closes, []);

  await assert.rejects(client.request("future"), /EPIPE/);
  await assert.rejects(client.send({ type: "future" }), /EPIPE/);

  for (const callback of writeCallbacks) {
    callback(new Error("late write EPIPE"));
  }
  stdin.emit("error", new Error("duplicate EPIPE"));
  assert.equal(transportErrors.length, 1);
  assert.deepEqual(closes, []);

  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  assert.deepEqual(closes, [{ code: 0, signal: null }]);
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

test("exit latches status and disarms deadlines while final stderr drains", async () => {
  vi.useFakeTimers();
  try {
    const stdout = new EventEmitter();
    const stderr = Object.assign(new EventEmitter(), { readableEnded: false });
    const stdin = {
      destroyed: false,
      write(
        _payload: string,
        _encoding: string,
        callback: (error?: Error | null) => void,
      ): boolean {
        callback();
        return true;
      },
    };
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill(): boolean {
        this.killed = true;
        return true;
      },
    }) as unknown as ChildProcess;
    const client = new JsonlRpcClient(child, { requestTimeoutMs: 10 });
    const closes: Array<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }> = [];
    client.on("close", (status) => closes.push(status));

    const pending = client.request("get_state");
    let pendingSettled = false;
    void pending.then(
      () => {
        pendingSettled = true;
      },
      () => {
        pendingSettled = true;
      },
    );

    child.emit("exit", 7, null);

    assert.deepEqual(client.getExitStatus(), { code: 7, signal: null });
    assert.equal(client.pendingCount, 1);
    assert.deepEqual(closes, []);
    await assert.rejects(client.request("after_exit"), /not writable/i);
    await assert.rejects(client.send({ type: "after_exit" }), /not writable/i);

    await vi.advanceTimersByTimeAsync(10);
    assert.equal(
      pendingSettled,
      false,
      "the expired request deadline must be disarmed during stderr grace",
    );
    assert.equal(client.pendingCount, 1);

    stderr.emit("data", Buffer.from("final stderr evidence\n"));
    stderr.readableEnded = true;
    stderr.emit("end");

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited \(code=7, signal=null\)/);
      assert.match(error.message, /final stderr evidence/);
      assert.doesNotMatch(error.message, /timed out/i);
      return true;
    });
    assert.equal(client.pendingCount, 0);
    assert.deepEqual(closes, [{ code: 7, signal: null }]);

    child.emit("close", 7, null);
    await vi.advanceTimersByTimeAsync(100);
    assert.deepEqual(closes, [{ code: 7, signal: null }]);
  } finally {
    vi.useRealTimers();
  }
});

test("exit rejects promptly when a descendant keeps inherited stdio open", async () => {
  const descendantScript =
    'require("node:net").createServer().listen(0, "127.0.0.1")';
  const script = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    descendant.once("spawn", () => {
      process.stderr.write("initial evidence\\n");
      process.stderr.write("final inherited-pipe evidence pid=" + descendant.pid + "\\n", () => process.exit(7));
    });
  `;
  const client = spawnJsonlRpcClient(
    process.execPath,
    ["-e", script],
    { cwd: process.cwd(), env: process.env },
    { requestTimeoutMs: 1_000 },
  );

  try {
    await assert.rejects(client.request("get_state"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited \(code=7, signal=null\)/);
      assert.match(error.message, /final inherited-pipe evidence/);
      assert.doesNotMatch(error.message, /timed out/i);
      return true;
    });
    assert.equal(client.pendingCount, 0);
    assert.equal(client.child.stderr?.closed, false);
  } finally {
    const pidMatch = /inherited-pipe evidence pid=(\d+)/.exec(
      client.stderr.snapshot(),
    );
    assert.ok(
      pidMatch,
      "descendant PID must be available for deterministic cleanup",
    );
    const nativeClose =
      client.child.stdout?.closed && client.child.stderr?.closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            client.child.once("close", () => resolve());
          });
    try {
      process.kill(Number(pidMatch[1]), "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await nativeClose;
  }
});

test("spawn-failure diagnostics redact secrets from the child error summary", async () => {
  const secret = "spawn-secret-123";
  const command = `https://user:${secret}@example.invalid/pi`;
  const client = spawnJsonlRpcClient(command, [], {
    cwd: process.cwd(),
    env: process.env,
  });

  await assert.rejects(client.request("get_state"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /RPC subprocess error/);
    assert.match(error.message, /https:\/\/user:\[REDACTED\]@example\.invalid/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.ok(error.message.length < 12_000);
    return true;
  });
  assert.equal(client.pendingCount, 0);
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

test("JSONL RPC client times out command responses as unknown delivery and clears pending request", async () => {
  const client = spawnFake(["--ignore-command", "get_state"]);
  try {
    await assert.rejects(
      client.request("get_state", undefined, 20),
      (error: unknown) => {
        assert.ok(error instanceof JsonlRpcDeliveryError);
        assert.equal(error.deliveryStatus, "unknown");
        assert.match(error.message, /timed out/i);
        return true;
      },
    );
    assert.equal(client.pendingCount, 0);
  } finally {
    client.close();
  }
});

test("JSONL RPC client treats a post-dispatch write callback error as unknown delivery", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    killed: false,
    kill(): boolean {
      this.killed = true;
      return true;
    },
    stdin: {
      destroyed: false,
      write(
        _payload: string,
        _encoding: string,
        callback: (error?: Error | null) => void,
      ): boolean {
        callback(new Error("EPIPE after accepting bytes"));
        return false;
      },
    },
  }) as unknown as ChildProcess;
  const client = new JsonlRpcClient(child);

  await assert.rejects(
    client.request("prompt", { text: "write failure" }),
    (error: unknown) => {
      assert.ok(error instanceof JsonlRpcDeliveryError);
      assert.equal(error.deliveryStatus, "unknown");
      assert.match(error.message, /failed to write/i);
      return true;
    },
  );
  assert.equal(client.pendingCount, 0);
});

test("fake RPC can record a prompt and disconnect before responding", async () => {
  const client = spawnFake(["--exit-after-prompt-receipt"]);
  try {
    await assert.rejects(
      client.request("prompt", { text: "accepted before disconnect" }),
      (error: unknown) => {
        assert.ok(error instanceof JsonlRpcDeliveryError);
        assert.equal(error.deliveryStatus, "unknown");
        assert.match(error.message, /exited/i);
        return true;
      },
    );
    assert.equal(client.pendingCount, 0);
  } finally {
    client.close();
  }
});

test("fake RPC can record a prompt and delay its success response past the client timeout", async () => {
  const client = spawnFake(["--delay-prompt-response-ms", "50"]);
  const diagnostics: string[] = [];
  client.on("diagnostic", (message: string) => diagnostics.push(message));
  try {
    const started = waitForEvent(
      client,
      (event) => event.type === "agent_start",
    );
    await assert.rejects(
      client.request("prompt", { text: "delayed success" }, 10),
      (error: unknown) => {
        assert.ok(error instanceof JsonlRpcDeliveryError);
        assert.equal(error.deliveryStatus, "unknown");
        return true;
      },
    );
    await started;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(diagnostics.join("\n"), /unknown RPC id/);
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

test("JSONL RPC client preserves nonfatal malformed-output mode", async () => {
  const client = spawnFake(["--malformed-on-start"], {
    malformedOutputIsFatal: false,
  });
  try {
    const parseError = waitForEvent(
      client,
      (event) => event.type === "rpc_parse_error",
    );
    await parseError;
    assert.equal(client.child.killed, false);
    const state = await client.request("get_state");
    assert.equal((state as { sessionId?: string }).sessionId, "fake-session-1");
  } finally {
    client.close();
  }
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
