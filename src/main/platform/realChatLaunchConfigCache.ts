import { stat } from "node:fs/promises";
import {
  getEffectivePiConfigSettingsPaths,
  resolveEffectivePiConfig,
  resolvePiBinary,
  type AppPiSettings,
  type EffectivePiConfigResult,
  type PiBinaryResolution,
} from "./piEnvironment.js";

export interface RealChatLaunchConfigCacheOptions {
  appSettings: AppPiSettings;
  env: NodeJS.ProcessEnv;
  projectCwd: string;
}

interface FileSnapshot {
  path: string;
  state: "present" | "missing" | "error";
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  mode?: number;
  errorCode?: string;
}

interface CachedBinary {
  inputKey: string;
  snapshot: FileSnapshot;
  resolution: PiBinaryResolution;
}

interface CachedEffectiveConfig {
  binaryKey: string;
  settingsKey: string;
  effective: EffectivePiConfigResult;
}

/**
 * Process-lifetime cache for real-Pi launch preflight.
 *
 * A cached binary is re-statted before reuse, so replacing it forces another
 * canonicalization/version validation. Effective config entries additionally
 * track both Pi settings files. This deliberately does not cache failures:
 * fixing an installation or settings file is immediately retryable.
 */
export class RealChatLaunchConfigCache {
  private cachedBinary: CachedBinary | undefined;
  private generation = 0;
  private readonly binaryInFlight = new Map<
    string,
    Promise<PiBinaryResolution>
  >();
  private readonly effectiveConfigs = new Map<string, CachedEffectiveConfig>();
  private readonly effectiveInFlight = new Map<
    string,
    Promise<EffectivePiConfigResult>
  >();

  constructor(
    private readonly dependencies: {
      resolvePiBinary?: typeof resolvePiBinary;
      resolveEffectivePiConfig?: typeof resolveEffectivePiConfig;
    } = {},
  ) {}

  async resolve(
    options: RealChatLaunchConfigCacheOptions,
  ): Promise<EffectivePiConfigResult> {
    const binary = await this.getBinary(options);
    if (!binary.ok || binary.piBinary === undefined) {
      throw binaryResolutionError(binary);
    }

    const settingsSnapshots = await snapshotFiles(
      getEffectivePiConfigSettingsPaths(options),
    );
    const settingsKey = stableStringify({
      projectCwd: options.projectCwd,
      appSettings: options.appSettings,
      env: options.env,
      settingsSnapshots,
    });
    const binaryKey = stableStringify({
      piBinary: binary.piBinary,
      version: binary.version,
      snapshot: await snapshotFile(binary.piBinary),
    });
    const cached = this.effectiveConfigs.get(settingsKey);
    if (cached !== undefined && cached.binaryKey === binaryKey) {
      return cached.effective;
    }

    const inFlightKey = `${settingsKey}\u0000${binaryKey}`;
    const pending = this.effectiveInFlight.get(inFlightKey);
    if (pending !== undefined) {
      return pending;
    }

    const generation = this.generation;
    const resolveConfig =
      this.dependencies.resolveEffectivePiConfig ?? resolveEffectivePiConfig;
    const promise = resolveConfig({
      piBinary: binary.piBinary,
      appSettings: options.appSettings,
      env: options.env,
      cwd: options.projectCwd,
    }).then((effective) => {
      if (this.generation === generation) {
        this.effectiveConfigs.set(settingsKey, {
          binaryKey,
          settingsKey,
          effective,
        });
      }
      return effective;
    });
    this.effectiveInFlight.set(inFlightKey, promise);
    try {
      return await promise;
    } finally {
      this.effectiveInFlight.delete(inFlightKey);
    }
  }

  /** Explicit refresh hook for diagnostics or callers that changed inputs. */
  clear(): void {
    this.generation += 1;
    this.cachedBinary = undefined;
    this.binaryInFlight.clear();
    this.effectiveConfigs.clear();
    this.effectiveInFlight.clear();
  }

  private async getBinary(
    options: RealChatLaunchConfigCacheOptions,
  ): Promise<PiBinaryResolution> {
    const inputKey = stableStringify({
      piBinaryPath: options.appSettings.piBinaryPath,
      piBinary: options.appSettings.piBinary,
      env: options.env,
    });
    const cached = this.cachedBinary;
    if (cached !== undefined && cached.inputKey === inputKey) {
      const currentSnapshot = await snapshotFile(cached.resolution.piBinary!);
      if (sameSnapshot(cached.snapshot, currentSnapshot)) {
        return cached.resolution;
      }
    }

    const pending = this.binaryInFlight.get(inputKey);
    if (pending !== undefined) {
      return pending;
    }

    const generation = this.generation;
    const resolveBinary = this.dependencies.resolvePiBinary ?? resolvePiBinary;
    const promise = resolveBinary({
      appSettings: options.appSettings,
      env: options.env,
    }).then(async (resolution) => {
      if (
        this.generation === generation &&
        resolution.ok &&
        resolution.piBinary !== undefined
      ) {
        this.cachedBinary = {
          inputKey,
          snapshot: await snapshotFile(resolution.piBinary),
          resolution,
        };
      }
      return resolution;
    });
    this.binaryInFlight.set(inputKey, promise);
    try {
      return await promise;
    } finally {
      this.binaryInFlight.delete(inputKey);
    }
  }
}

async function snapshotFiles(paths: string[]): Promise<FileSnapshot[]> {
  return Promise.all(paths.map((filePath) => snapshotFile(filePath)));
}

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
  try {
    const file = await stat(filePath);
    return {
      path: filePath,
      state: "present",
      dev: file.dev,
      ino: file.ino,
      size: file.size,
      mtimeMs: file.mtimeMs,
      mode: file.mode,
    };
  } catch (error) {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    return {
      path: filePath,
      state: errorCode === "ENOENT" ? "missing" : "error",
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  }
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function binaryResolutionError(resolution: PiBinaryResolution): Error {
  const details = resolution.diagnostics
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .join("; ");
  return new Error(
    `Real Pi backend requested but no usable pi binary was found. ${details}`,
  );
}
