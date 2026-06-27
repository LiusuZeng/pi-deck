import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChildProcess } from "node:child_process";
import { spawnJsonlRpcClient, type JsonlRpcClient } from "../pi/jsonlClient.js";
import type { JsonObject, JsonValue } from "../pi/types.js";
import {
  type DiagnosticMessage,
  type EffectivePiConfig,
  redactEnv,
} from "./piEnvironment.js";

export const MINIMAL_RPC_SMOKE_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-approve",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--offline",
];

export interface RpcSmokeTestOptions {
  config: Pick<EffectivePiConfig, "piBinary" | "env">;
  version?: string | undefined;
  force?: boolean | undefined;
  timeoutMs?: number | undefined;
  tempRoot?: string | undefined;
}

export interface RpcSmokeTestResult {
  ok: boolean;
  cacheKey: string;
  fromCache: boolean;
  piBinary: string;
  version?: string | undefined;
  args: string[];
  tempCwd?: string | undefined;
  state?: JsonValue | undefined;
  stderr: string;
  stdoutRecords: JsonValue[];
  diagnostics: DiagnosticMessage[];
  noSessionFilesCreated: boolean;
  createdFiles: string[];
  envSummary: ReturnType<typeof redactEnv>;
  error?: string | undefined;
}

const smokeCache = new Map<string, RpcSmokeTestResult>();

export function clearRpcSmokeTestCache(): void {
  smokeCache.clear();
}

export function smokeCacheKey(piBinary: string, version?: string): string {
  return `${piBinary}\u0000${version ?? "unknown"}`;
}

export async function runMinimalRpcSmokeTest(
  options: RpcSmokeTestOptions,
): Promise<RpcSmokeTestResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cacheKey = smokeCacheKey(options.config.piBinary, options.version);
  if (!options.force && smokeCache.has(cacheKey)) {
    return { ...smokeCache.get(cacheKey)!, fromCache: true };
  }

  let tempCwd: string | undefined;
  let client: JsonlRpcClient | undefined;
  const diagnostics: DiagnosticMessage[] = [];
  const stdoutRecords: JsonValue[] = [];
  let stderr = "";
  let state: JsonValue | undefined;
  let ok = false;
  let error: string | undefined;
  let createdFiles: string[] = [];
  let noSessionFilesCreated = true;

  try {
    tempCwd = await fs.mkdtemp(
      path.join(options.tempRoot ?? os.tmpdir(), "pi-deck-rpc-smoke-"),
    );
    client = spawnJsonlRpcClient(
      options.config.piBinary,
      MINIMAL_RPC_SMOKE_ARGS,
      {
        cwd: tempCwd,
        env: options.config.env,
      },
      {
        requestTimeoutMs: timeoutMs,
        stderrBufferBytes: 64 * 1024,
      },
    );
    client.on("event", (record) => stdoutRecords.push(record as JsonObject));

    state = await client.request("get_state", {}, timeoutMs);
    if (state === undefined || state === null) {
      throw new Error("get_state returned no state payload.");
    }

    ok = true;
    diagnostics.push({
      level: "info",
      code: "RPC_SMOKE_OK",
      message: "Minimal no-resource/no-session RPC smoke test succeeded.",
    });
  } catch (cause) {
    error = errorMessage(cause);
    diagnostics.push({
      level: "error",
      code: "RPC_SMOKE_FAILED",
      message: "Minimal RPC smoke test failed.",
      details: { error },
    });
  } finally {
    if (client) {
      stderr = client.stderr.snapshot();
      await closeClient(client);
      stderr = client.stderr.snapshot();
    }
    if (tempCwd) {
      createdFiles = await listFilesSafe(tempCwd);
      noSessionFilesCreated = createdFiles.every(
        (entry) => entry.indexOf("sessions") < 0 && !/\.jsonl$/i.test(entry),
      );
      if (!noSessionFilesCreated) {
        ok = false;
        diagnostics.push({
          level: "error",
          code: "RPC_SMOKE_SESSION_SIDE_EFFECT",
          message:
            "Smoke test created session-looking files even though --no-session was used.",
          details: { createdFiles },
        });
      }
      await fs.rm(tempCwd, { recursive: true, force: true });
    }
  }

  const result: RpcSmokeTestResult = {
    ok,
    cacheKey,
    fromCache: false,
    piBinary: options.config.piBinary,
    version: options.version,
    args: [...MINIMAL_RPC_SMOKE_ARGS],
    tempCwd,
    state,
    stderr,
    stdoutRecords,
    diagnostics,
    noSessionFilesCreated,
    createdFiles,
    envSummary: redactEnv(options.config.env),
    error,
  };

  if (ok) {
    smokeCache.set(cacheKey, result);
  }
  return result;
}

function closeClient(client: JsonlRpcClient): Promise<void> {
  return new Promise((resolve) => {
    const child: ChildProcess = client.child;
    if (child.exitCode !== null || child.signalCode !== null || child.killed) {
      resolve();
      return;
    }

    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        resolve();
      }
    };
    const killTimer = setTimeout(() => {
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        !child.killed
      ) {
        child.kill("SIGKILL");
      }
      finish();
    }, 1_000);

    child.once("exit", finish);
    client.close("SIGTERM");
  });
}

async function listFilesSafe(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(dir, entry);
      found.push(path.relative(root, absolute));
      try {
        const stat = await fs.lstat(absolute);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await walk(absolute);
        }
      } catch {
        // Ignore cleanup/listing races.
      }
    }
  }

  await walk(root);
  return found;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
