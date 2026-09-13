#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

function parseArgs(argv) {
  const options = {
    prompt: undefined,
    project: undefined,
    piBinary: process.env.PI_DECK_PI_BINARY,
    keepTemp: false,
    timeoutMs: Number(process.env.PI_DECK_REAL_SMOKE_TIMEOUT_MS ?? 120_000),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prompt") {
      options.prompt = requireValue(argv, ++index, arg);
    } else if (arg === "--project") {
      options.project = requireValue(argv, ++index, arg);
    } else if (arg === "--pi") {
      options.piBinary = requireValue(argv, ++index, arg);
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(requireValue(argv, ++index, arg));
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function usage() {
  console.log(`Real Pi RPC smoke test

Usage:
  npm run smoke:real
  npm run smoke:real:prompt
  node scripts/smoke-real-pi.mjs [--prompt "message"] [--project dir] [--pi path]

Default smoke starts a real temp pi --mode rpc session with an isolated temp agent dir,
calls get_state/get_messages, and verifies the worker is not streaming. Prompt smoke uses
Pi's default/user agent dir so configured auth/models are available, sends a prompt, and
waits for agent_end. Set PI_DECK_REAL_SMOKE_ISOLATED_AGENT=1 to force temp agent isolation.
`);
}

function requireValue(argv, index, optionName) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function commandInPath(command) {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.stdout?.split(/\r?\n/).find(Boolean);
}

function resolvePiBinary(explicitPath) {
  const candidates = [
    explicitPath,
    commandInPath("pi"),
    "/usr/local/bin/pi",
    "/opt/homebrew/bin/pi",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(path.resolve(candidate));
      if (statSync(resolved).isFile()) {
        return resolved;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("Could not find pi. Pass --pi /absolute/path/to/pi.");
}

function makeRequest(id, type, params = {}) {
  return JSON.stringify({ id, type, ...params });
}

async function runSmoke(options) {
  const piBinary = resolvePiBinary(options.piBinary);
  const root = mkdtempSync(path.join(tmpdir(), "pi-deck-real-smoke-"));
  const project = options.project
    ? realpathSync(path.resolve(options.project))
    : path.join(root, "project");
  const useIsolatedAgent =
    !options.prompt || process.env.PI_DECK_REAL_SMOKE_ISOLATED_AGENT === "1";
  const agentDir = useIsolatedAgent
    ? path.join(root, "agent")
    : process.env.PI_CODING_AGENT_DIR;

  if (!options.project) {
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(project, { recursive: true }),
    );
  }
  if (agentDir) {
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(agentDir, { recursive: true }),
    );
  }

  console.log("Real Pi RPC smoke");
  console.log(`  Pi:      ${piBinary}`);
  console.log(`  Project: ${project}`);
  console.log(
    `  Agent:   ${agentDir ?? "Pi default (~/.pi/agent or configured env)"}`,
  );
  console.log(`  Prompt:  ${options.prompt ? "yes" : "no"}`);

  const workerEnv = { ...process.env };
  if (agentDir) {
    workerEnv.PI_CODING_AGENT_DIR = agentDir;
  } else {
    delete workerEnv.PI_CODING_AGENT_DIR;
  }

  const child = spawn(piBinary, ["--mode", "rpc"], {
    cwd: project,
    env: workerEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const responses = new Map();
  const events = [];
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (line.trim().length === 0) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      events.push({ type: "parse_error", line, error: String(error) });
      return;
    }
    if (record.type === "response") {
      responses.set(record.id, record);
    } else {
      events.push(record);
    }
  });

  const timeoutAt = Date.now() + options.timeoutMs;
  const waitUntil = async (predicate, label) => {
    while (Date.now() < timeoutAt) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  try {
    child.stdin.write(`${makeRequest("state-1", "get_state")}\n`);
    await waitUntil(() => responses.has("state-1"), "get_state response");
    const stateResponse = responses.get("state-1");
    assertSuccessfulResponse(stateResponse, "get_state");
    console.log(`  Session: ${stateResponse.data?.sessionFile ?? "unknown"}`);

    child.stdin.write(`${makeRequest("messages-1", "get_messages")}\n`);
    await waitUntil(() => responses.has("messages-1"), "get_messages response");
    assertSuccessfulResponse(responses.get("messages-1"), "get_messages");

    if (options.prompt) {
      child.stdin.write(
        `${makeRequest("prompt-1", "prompt", { message: options.prompt })}\n`,
      );
      await waitUntil(
        () => responses.has("prompt-1"),
        "prompt acceptance response",
      );
      assertSuccessfulResponse(responses.get("prompt-1"), "prompt");
      await waitUntil(
        () => events.some((event) => event.type === "agent_end"),
        "agent_end event",
      );
      child.stdin.write(
        `${makeRequest("messages-after-prompt", "get_messages")}\n`,
      );
      await waitUntil(
        () => responses.has("messages-after-prompt"),
        "post-prompt get_messages response",
      );
      assertSuccessfulResponse(
        responses.get("messages-after-prompt"),
        "post-prompt get_messages",
      );
      assertSuccessfulAssistantOutput(
        responses.get("messages-after-prompt")?.data,
        "prompt",
      );
      console.log("  Prompt events: agent_end and assistant output observed");
    }

    await runNativeForkSmoke({
      piBinary,
      project,
      workerEnv,
      timeoutAt,
      sourceState: stateResponse.data,
      prompt: options.prompt,
    });

    child.stdin.write(`${makeRequest("state-2", "get_state")}\n`);
    await waitUntil(() => responses.has("state-2"), "final get_state response");
    const finalState = responses.get("state-2");
    assertSuccessfulResponse(finalState, "final get_state");
    if (
      finalState.data?.isStreaming === true ||
      finalState.data?.isAgentActive === true
    ) {
      throw new Error("Final get_state still reports active/streaming work");
    }

    console.log("PASS real Pi RPC smoke");
  } finally {
    await terminateAndWait(child);
    if (!options.keepTemp) {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.log(`Kept temp root: ${root}`);
    }
    if (stderr.join("").trim()) {
      console.error("Worker stderr:");
      console.error(stderr.join("").trim());
    }
  }
}

async function runNativeForkSmoke({
  piBinary,
  project,
  workerEnv,
  timeoutAt,
  sourceState,
  prompt,
}) {
  const sourceFile = sourceState?.sessionFile;
  const sourceId = sourceState?.sessionId;
  if (typeof sourceFile !== "string" || typeof sourceId !== "string") {
    throw new Error(
      "Source get_state did not report a session file and identity",
    );
  }
  // A no-prompt RPC worker reports its planned session path before Pi writes
  // a header. Seed the documented v3 header only for this isolated smoke so
  // native --fork has a real persisted source without provider credentials.
  if (!existsSync(sourceFile)) {
    mkdirSync(path.dirname(sourceFile), { recursive: true, mode: 0o700 });
    writeFileSync(
      sourceFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: sourceId,
        timestamp: new Date().toISOString(),
        cwd: project,
      })}\n`,
      { mode: 0o600 },
    );
  }
  const canonicalSource = realpathSync(sourceFile);
  // Snapshot only after any source prompt completes: from this point onward
  // every byte difference must be attributable to an unsafe fork child.
  const sourceBytes = readFileSync(canonicalSource);

  const child = spawn(piBinary, ["--mode", "rpc", "--fork", canonicalSource], {
    cwd: project,
    env: workerEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  const events = [];
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const record = JSON.parse(line);
      if (record.type === "response") responses.set(record.id, record);
      else events.push(record);
    } catch {
      // The request timeout below reports a useful failure without trusting
      // malformed child output as a successful fork.
    }
  });
  const waitUntil = async (predicate, label) => {
    while (Date.now() < timeoutAt) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for native fork ${label}`);
  };
  try {
    child.stdin.write(`${makeRequest("fork-state", "get_state")}\n`);
    await waitUntil(() => responses.has("fork-state"), "get_state response");
    const state = responses.get("fork-state");
    assertSuccessfulResponse(state, "native fork get_state");
    const forkFile = state.data?.sessionFile;
    const forkId = state.data?.sessionId;
    if (typeof forkFile !== "string" || typeof forkId !== "string") {
      throw new Error("Native fork did not report a session file and identity");
    }
    if (realpathSync(forkFile) === canonicalSource || forkId === sourceId) {
      throw new Error("Native fork reused the source session identity");
    }
    if (
      state.data?.isStreaming === true ||
      state.data?.isAgentActive === true
    ) {
      throw new Error("Native fork started with active/streaming work");
    }
    child.stdin.write(`${makeRequest("fork-messages", "get_messages")}\n`);
    await waitUntil(
      () => responses.has("fork-messages"),
      "get_messages response",
    );
    assertSuccessfulResponse(
      responses.get("fork-messages"),
      "native fork get_messages",
    );

    // Authenticated prompt smoke additionally proves a child-only turn never
    // changes the exact source bytes. The no-prompt CI smoke still exercises
    // the real native --fork protocol without requiring provider credentials.
    if (prompt) {
      child.stdin.write(
        `${makeRequest("fork-prompt", "prompt", { message: `${prompt} (fork child only)` })}\n`,
      );
      await waitUntil(() => responses.has("fork-prompt"), "prompt acceptance");
      assertSuccessfulResponse(
        responses.get("fork-prompt"),
        "native fork prompt",
      );
      await waitUntil(
        () => events.some((event) => event.type === "agent_end"),
        "agent_end",
      );
      child.stdin.write(
        `${makeRequest("fork-messages-after-prompt", "get_messages")}\n`,
      );
      await waitUntil(
        () => responses.has("fork-messages-after-prompt"),
        "post-prompt get_messages response",
      );
      const messages = responses.get("fork-messages-after-prompt");
      assertSuccessfulResponse(
        messages,
        "native fork post-prompt get_messages",
      );
      assertSuccessfulAssistantOutput(messages.data, "native fork prompt");
    }
    if (!readFileSync(canonicalSource).equals(sourceBytes)) {
      throw new Error(
        "Native fork child-only work changed the source JSONL bytes",
      );
    }
    console.log(
      "  Native fork: distinct identity and source-byte isolation verified",
    );
  } finally {
    await terminateAndWait(child);
    rl.close();
    if (stderr.join("").trim()) {
      console.error("Native fork stderr:");
      console.error(stderr.join("").trim());
    }
  }
}

async function terminateAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await exited;
}

function assertSuccessfulAssistantOutput(data, label) {
  const messages = Array.isArray(data)
    ? data
    : Array.isArray(data?.messages)
      ? data.messages
      : [];
  const assistant = messages.findLast(
    (message) => message?.role === "assistant",
  );
  const content = Array.isArray(assistant?.content)
    ? assistant.content.map((part) => part?.text ?? "").join("")
    : assistant?.content;
  if (
    !assistant ||
    assistant.status === "error" ||
    assistant.stopReason === "error" ||
    typeof content !== "string" ||
    content.trim().length === 0
  ) {
    throw new Error(`${label} did not produce successful assistant output`);
  }
}

function assertSuccessfulResponse(record, label) {
  if (!record) {
    throw new Error(`${label} did not return a response`);
  }
  if (record.success === false || record.ok === false || record.error) {
    throw new Error(
      `${label} failed: ${record.error?.message ?? record.error}`,
    );
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  await runSmoke(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
