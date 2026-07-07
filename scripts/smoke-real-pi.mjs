#!/usr/bin/env node
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
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
      console.log("  Prompt events: agent_end observed");
    }

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
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 1_000).unref();
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
