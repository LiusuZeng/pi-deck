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

export async function discoverPiRuntimeModels(options: {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}): Promise<ChatListModelsResult> {
  const worker = new PiWorker({
    command: options.command,
    args: ["--mode", "rpc", ...(options.args ?? []), "--no-session"],
    cwd: options.cwd,
    env: options.env,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    commandProtocol: "type-field",
  });

  try {
    const [state, modelsResponse, thinkingLevelsResponse] = await Promise.all([
      worker.getState(),
      worker.request("get_available_models"),
      worker.request("get_available_thinking_levels"),
    ]);
    return parsePiRuntimeModelDiscovery(
      state,
      modelsResponse,
      thinkingLevelsResponse,
    );
  } finally {
    await worker.closeSession();
  }
}

export async function discoverPiModels(options: {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ChatModelSummary[]> {
  const stdout = await execFileStdout(
    options.command,
    [...(options.args ?? []), "--list-models"],
    options.cwd,
    options.env,
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
  const candidate =
    typeof value === "string"
      ? { id: value, name: value, ...(provider ? { provider } : {}) }
      : value;
  return normalizePiModelSummary(candidate);
}

function normalizePiModelSummary(
  value: unknown,
): ChatModelSummary | undefined {
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
      (activeModel.provider === undefined || model.provider === activeModel.provider),
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
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
  });
}
