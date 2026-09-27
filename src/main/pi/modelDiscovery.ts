import { execFile } from "node:child_process";

import { chatModelSummarySchema } from "../../shared/ipcSchemas.js";
import type {
  ChatListModelsResult,
  ChatModelSummary,
} from "../../shared/types.js";
import { PiWorker } from "./piWorker.js";

const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const RUNTIME_DISCOVERY_COMMANDS = [
  "get_state",
  "get_available_models",
  "get_available_thinking_levels",
] as const;

type RuntimeDiscoveryCommand = (typeof RUNTIME_DISCOVERY_COMMANDS)[number];

/**
 * Retains every successful RPC discovery field when one sibling command
 * fails. Main can then supplement missing inventory with `--list-models`
 * without discarding an authoritative active model or thinking default.
 */
export class PiRuntimeModelDiscoveryError extends Error {
  readonly name = "PiRuntimeModelDiscoveryError";

  constructor(
    readonly failedCommands: readonly RuntimeDiscoveryCommand[],
    readonly partialResult: ChatListModelsResult,
    cause: unknown,
  ) {
    super(
      `Pi runtime model discovery command(s) failed: ${failedCommands.join(", ")}${
        cause === undefined
          ? ""
          : ` (${cause instanceof Error ? cause.message : String(cause)})`
      }`,
      { cause },
    );
  }
}

/**
 * Neither discovery path produced inventory or authoritative runtime state.
 * Callers surface this failure instead of fabricating a model or thinking
 * default from the optional thinking-level-list response.
 */
export class PiModelDiscoveryUnavailableError extends AggregateError {
  readonly name = "PiModelDiscoveryUnavailableError";

  constructor(
    readonly runtimeFailure: unknown,
    readonly fallbackFailure: unknown,
  ) {
    super(
      [runtimeFailure, fallbackFailure],
      "Pi model discovery failed: runtime RPC returned no usable inventory or authoritative state, and --list-models failed.",
    );
  }
}

export async function discoverPiRuntimeModels(options: {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ChatListModelsResult> {
  options.signal?.throwIfAborted();
  const worker = new PiWorker({
    command: options.command,
    args: ["--mode", "rpc", ...(options.args ?? []), "--no-session"],
    cwd: options.cwd,
    env: options.env,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    commandProtocol: "type-field",
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= worker.closeSession());
  const onAbort = (): void => {
    void close();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // A failed inventory command must not discard a slower successful state
    // response. Every request remains bounded by PiWorker's existing request
    // timeout, while cancellation still closes the worker immediately.
    const results = await Promise.allSettled([
      worker.getState(),
      worker.request("get_available_models"),
      worker.request("get_available_thinking_levels"),
    ]);
    options.signal?.throwIfAborted();
    const values = results.map((result) =>
      result.status === "fulfilled" ? result.value : undefined,
    );
    const partialResult = parsePiRuntimeModelDiscovery(
      values[0],
      values[1],
      values[2],
    );
    const failedCommands = results.flatMap((result, index) =>
      result.status === "rejected" ? [RUNTIME_DISCOVERY_COMMANDS[index]!] : [],
    );
    if (failedCommands.length > 0) {
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      throw new PiRuntimeModelDiscoveryError(
        failedCommands,
        partialResult,
        firstFailure?.reason,
      );
    }
    return partialResult;
  } finally {
    // Keep ownership until OS-confirmed exit, including cancellation while an
    // RPC request is pending. Sending SIGTERM alone is not terminal evidence.
    try {
      await close();
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    options.signal?.throwIfAborted();
  }
}

export async function discoverPiModels(options: {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ChatModelSummary[]> {
  const stdout = await execFileStdout(
    options.command,
    [...(options.args ?? []), "--list-models"],
    options.cwd,
    options.env,
    options.signal,
  );
  return parsePiModelList(stdout);
}

export function parsePiRuntimeModelDiscovery(
  state: unknown,
  modelsResponse: unknown,
  thinkingLevelsResponse: unknown,
): ChatListModelsResult {
  const stateRecord = asRecord(state);
  const modelsRecord = asRecord(modelsResponse);
  const thinkingLevelsRecord = asRecord(thinkingLevelsResponse);
  const models = Array.isArray(modelsRecord?.models)
    ? modelsRecord.models.flatMap((value) => {
        const parsed = normalizePiModelSummary(value);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  const activeModel = mergeActiveModel(
    parseActiveModel(
      stateRecord?.model,
      typeof stateRecord?.provider === "string"
        ? stateRecord.provider
        : undefined,
    ),
    models,
  );
  const thinkingLevels = Array.isArray(thinkingLevelsRecord?.levels)
    ? thinkingLevelsRecord.levels.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];

  return {
    models,
    ...(activeModel !== undefined ? { activeModel } : {}),
    ...(typeof stateRecord?.thinkingLevel === "string"
      ? { thinkingLevel: stateRecord.thinkingLevel }
      : {}),
    thinkingLevels,
  };
}

export function mergePiRuntimeDiscoveryWithModelFallback(
  runtime: ChatListModelsResult,
  fallbackModels: ChatModelSummary[],
): ChatListModelsResult {
  const models = runtime.models.length > 0 ? runtime.models : fallbackModels;
  const activeModel = mergeActiveModel(runtime.activeModel, models);
  return {
    ...runtime,
    models,
    ...(activeModel === undefined ? {} : { activeModel }),
  };
}

export function partialPiRuntimeModelDiscovery(
  error: unknown,
): ChatListModelsResult | undefined {
  return error instanceof PiRuntimeModelDiscoveryError
    ? error.partialResult
    : undefined;
}

/**
 * Recover a failed runtime probe without discarding successful sibling RPCs.
 * A usable runtime inventory is authoritative and needs no CLI supplement. If
 * inventory is missing, `--list-models` may supply it; if that also fails, an
 * active model or thinking level from get_state is still returned. With
 * neither inventory nor usable state, discovery fails explicitly.
 */
export async function recoverPiRuntimeModelDiscovery(
  runtimeFailure: unknown,
  discoverFallbackModels: () => Promise<ChatModelSummary[]>,
): Promise<ChatListModelsResult> {
  const partialResult = partialPiRuntimeModelDiscovery(runtimeFailure);
  if (partialResult !== undefined && partialResult.models.length > 0) {
    return partialResult;
  }

  try {
    const fallbackModels = await discoverFallbackModels();
    return mergePiRuntimeDiscoveryWithModelFallback(
      partialResult ?? { models: [], thinkingLevels: [] },
      fallbackModels,
    );
  } catch (fallbackFailure) {
    if (
      partialResult !== undefined &&
      (partialResult.activeModel !== undefined ||
        partialResult.thinkingLevel !== undefined)
    ) {
      return partialResult;
    }
    throw new PiModelDiscoveryUnavailableError(runtimeFailure, fallbackFailure);
  }
}

export function parsePiModelList(stdout: string): ChatModelSummary[] {
  const lines = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex(
    (line) => /\bprovider\b/i.test(line) && /\bmodel\b/i.test(line),
  );
  if (headerIndex === -1) {
    return [];
  }

  return lines.slice(headerIndex + 1).flatMap((line) => {
    const columns = line.split(/\s{2,}/);
    if (columns.length < 6) {
      return [];
    }
    const [provider, id, context, , thinking, images] = columns;
    if (!provider || !id) {
      return [];
    }
    const contextWindow = parseCompactCount(context);
    return [
      {
        id,
        name: id,
        provider,
        reasoning: thinking?.toLowerCase() === "yes",
        input: images?.toLowerCase() === "yes" ? ["text", "image"] : ["text"],
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      },
    ];
  });
}

function parseActiveModel(
  value: unknown,
  provider: string | undefined,
): ChatModelSummary | undefined {
  const record = asRecord(value);
  const candidate =
    typeof value === "string"
      ? { id: value, name: value, ...(provider ? { provider } : {}) }
      : record !== undefined &&
          provider !== undefined &&
          typeof record.provider !== "string"
        ? { ...record, provider }
        : value;
  return normalizePiModelSummary(candidate);
}

function normalizePiModelSummary(value: unknown): ChatModelSummary | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }

  const supportedThinkingLevels = parseStringArray(
    record.supportedThinkingLevels,
  );
  const normalized =
    supportedThinkingLevels === undefined
      ? record
      : {
          ...record,
          reasoning: supportedThinkingLevels.some((level) => level !== "off"),
          thinkingLevelMap: thinkingLevelMapForSupportedLevels(
            supportedThinkingLevels,
            record.thinkingLevelMap,
          ),
        };
  const parsed = chatModelSummarySchema.safeParse(normalized);
  return parsed.success ? parsed.data : undefined;
}

function mergeActiveModel(
  activeModel: ChatModelSummary | undefined,
  models: ChatModelSummary[],
): ChatModelSummary | undefined {
  if (activeModel === undefined) {
    return undefined;
  }
  const exactMatch = models.find(
    (model) =>
      model.id === activeModel.id &&
      (activeModel.provider === undefined ||
        model.provider === activeModel.provider),
  );
  if (exactMatch === undefined) {
    return activeModel;
  }
  return {
    ...exactMatch,
    ...activeModel,
    reasoning: activeModel.reasoning ?? exactMatch.reasoning,
    thinkingLevelMap:
      activeModel.thinkingLevelMap ?? exactMatch.thinkingLevelMap,
  };
}

function thinkingLevelMapForSupportedLevels(
  supportedThinkingLevels: string[],
  existingValue: unknown,
): Record<string, string | null> {
  const supported = new Set(supportedThinkingLevels);
  const existing = asRecord(existingValue) ?? {};
  return Object.fromEntries(
    PI_THINKING_LEVELS.map((level) => {
      if (!supported.has(level)) {
        return [level, null];
      }
      const mapped = existing[level];
      return [level, typeof mapped === "string" ? mapped : level];
    }),
  );
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCompactCount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/^([\d.]+)([KMG])?$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  const multiplier =
    match[2]?.toUpperCase() === "G"
      ? 1_000_000_000
      : match[2]?.toUpperCase() === "M"
        ? 1_000_000
        : match[2]?.toUpperCase() === "K"
          ? 1_000
          : 1;
  return Math.round(amount * multiplier);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function execFileStdout(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      // Do not use execFile's AbortSignal option: its abort callback can settle
      // before child exit. This operation owns the child until the close callback.
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 2_000);
    };
    const child = execFile(
      command,
      args,
      {
        cwd,
        env,
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        clearTimeout(escalation);
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        if (error) {
          reject(
            new Error(
              `Unable to list Pi models: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
