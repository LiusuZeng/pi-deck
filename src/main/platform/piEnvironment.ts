const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

export type TrustOverride = "approve" | "no-approve";
export type SessionDirSource =
  | "app"
  | "env"
  | "globalSettings"
  | "projectSettings"
  | "default"
  | "candidate";
export type ImageSettingSource =
  | "app"
  | "globalSettings"
  | "projectSettings"
  | "projectCandidate"
  | "default";
export type PiBinaryResolutionSource = "app" | "path" | "shell" | "common";

export interface EffectivePiConfig {
  piBinary: string;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  sessionDir?: string | undefined;
  sessionDirSource: SessionDirSource;
  imageSettings: {
    blockImages: boolean;
    autoResize: boolean;
    sources: {
      blockImages: ImageSettingSource;
      autoResize: ImageSettingSource;
    };
    candidateWarnings: string[];
  };
  trustOverride?: TrustOverride | undefined;
}

export interface AppPiSettings {
  piBinaryPath?: string;
  piBinary?: string;
  agentDir?: string;
  sessionDir?: string;
  images?: {
    blockImages?: boolean;
    autoResize?: boolean;
  };
}

export interface DiagnosticMessage {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface EnvDiagnosticSummary {
  keys: Record<string, string>;
  pathEntries: string[];
}

export interface PiBinaryAttempt {
  source: PiBinaryResolutionSource;
  candidate?: string;
  command?: string;
  success: boolean;
  error?: string;
}

export interface PiVersionResult {
  ok: boolean;
  version?: string | undefined;
  stdout: string;
  stderr: string;
  error?: string | undefined;
}

export interface PiBinaryResolution {
  ok: boolean;
  piBinary?: string | undefined;
  source?: PiBinaryResolutionSource | undefined;
  version?: string | undefined;
  versionResult?: PiVersionResult | undefined;
  attempts: PiBinaryAttempt[];
  diagnostics: DiagnosticMessage[];
  envSummary: EnvDiagnosticSummary;
}

export interface ResolvePiBinaryOptions {
  appSettings?: AppPiSettings;
  env?: NodeJS.ProcessEnv;
  commonPaths?: string[];
  shellPath?: string;
  homeDir?: string;
  timeoutMs?: number;
}

export interface ResolveEffectivePiConfigOptions {
  piBinary: string;
  appSettings?: AppPiSettings;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  trustOverride?: TrustOverride;
}

export interface EffectivePiConfigResult {
  config: EffectivePiConfig;
  diagnostics: DiagnosticMessage[];
  envSummary: EnvDiagnosticSummary;
  workerArgs: string[];
  projectSessionDirCandidate?: string | undefined;
}

interface NarrowSettings {
  sessionDir?: string;
  images?: {
    blockImages?: boolean;
    autoResize?: boolean;
  };
}

interface ParsedSettings {
  path: string;
  baseDir: string;
  settings: NarrowSettings;
  diagnostics: DiagnosticMessage[];
}

const DEFAULT_COMMON_PI_PATHS = [
  "/opt/homebrew/bin/pi",
  "/usr/local/bin/pi",
  "~/.local/bin/pi",
];

const SECRET_KEY_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASS|AUTH|COOKIE|CREDENTIAL|PRIVATE|API[_-]?KEY|ACCESS[_-]?KEY|SESSION|OAUTH)/i;
const REDACTED = "<redacted>";

export function redactEnv(env: NodeJS.ProcessEnv): EnvDiagnosticSummary {
  const keys: Record<string, string> = {};
  Object.keys(env || {})
    .sort()
    .forEach(function (key: string): void {
      const value = env[key];
      if (value === undefined) {
        return;
      }
      keys[key] = SECRET_KEY_PATTERN.test(key)
        ? REDACTED
        : summarizeEnvValue(key, value);
    });
  return {
    keys: keys,
    pathEntries: splitPath(env && env.PATH ? env.PATH : ""),
  };
}

function summarizeEnvValue(key: string, value: string): string {
  if (key === "PATH") {
    return splitPath(value).join(path.delimiter);
  }
  if (value.length > 200) {
    return value.slice(0, 197) + "...";
  }
  return value;
}

function splitPath(value: string): string[] {
  if (!value) {
    return [];
  }
  return value.split(path.delimiter).filter(function (entry: string): boolean {
    return entry.length > 0;
  });
}

function expandHome(inputPath: string, homeDir: string): string {
  if (inputPath === "~") {
    return homeDir;
  }
  if (inputPath.indexOf("~/") === 0) {
    return path.join(homeDir, inputPath.slice(2));
  }
  return inputPath;
}

function resolveUserPath(
  inputPath: string,
  baseDir: string | undefined,
  homeDir: string,
): string {
  const expanded = expandHome(inputPath, homeDir);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(baseDir || process.cwd(), expanded);
}

function executableAccess(candidate: string): Promise<void> {
  return new Promise(function (
    resolve: () => void,
    reject: (err: Error) => void,
  ): void {
    fs.access(candidate, fs.constants.X_OK, function (err: Error | null): void {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function fileExists(candidate: string): Promise<boolean> {
  return new Promise(function (resolve: (exists: boolean) => void): void {
    fs.access(candidate, fs.constants.F_OK, function (err: Error | null): void {
      resolve(!err);
    });
  });
}

function realpath(candidate: string): Promise<string> {
  return new Promise(function (
    resolve: (resolvedPath: string) => void,
    reject: (err: Error) => void,
  ): void {
    fs.realpath(
      candidate,
      function (err: Error | null, resolvedPath: string): void {
        if (err) {
          reject(err);
        } else {
          resolve(resolvedPath);
        }
      },
    );
  });
}

function execFilePromise(
  file: string,
  args: string[],
  options: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise(function (
    resolve: (value: { stdout: string; stderr: string }) => void,
    reject: (err: any) => void,
  ): void {
    childProcess.execFile(
      file,
      args,
      options,
      function (err: any, stdout: any, stderr: any): void {
        const out =
          stdout === undefined || stdout === null ? "" : String(stdout);
        const errOut =
          stderr === undefined || stderr === null ? "" : String(stderr);
        if (err) {
          err.stdout = out;
          err.stderr = errOut;
          reject(err);
        } else {
          resolve({ stdout: out, stderr: errOut });
        }
      },
    );
  });
}

export async function runPiVersion(
  piBinary: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<PiVersionResult> {
  try {
    const result = await execFilePromise(piBinary, ["--version"], {
      env: env || process.env,
      timeout: timeoutMs || 10000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const version =
      (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || undefined;
    return {
      ok: true,
      version: version,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (err) {
    const anyErr = err as any;
    return {
      ok: false,
      stdout: String(anyErr.stdout || "").trim(),
      stderr: String(anyErr.stderr || "").trim(),
      error: anyErr && anyErr.message ? String(anyErr.message) : String(err),
    };
  }
}

export async function resolvePiBinary(
  options?: ResolvePiBinaryOptions,
): Promise<PiBinaryResolution> {
  const opts = options || {};
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || os.homedir();
  const attempts: PiBinaryAttempt[] = [];
  const diagnostics: DiagnosticMessage[] = [];
  const timeoutMs = opts.timeoutMs || 10000;
  const configured =
    opts.appSettings &&
    (opts.appSettings.piBinaryPath || opts.appSettings.piBinary);

  if (configured) {
    const configuredExpanded = expandHome(configured, homeDir);
    if (!path.isAbsolute(configuredExpanded)) {
      attempts.push({
        source: "app",
        candidate: configured,
        success: false,
        error: "Configured Pi binary path must be absolute.",
      });
    } else {
      const resolved = await validateCandidate(
        "app",
        configuredExpanded,
        env,
        attempts,
        timeoutMs,
      );
      if (resolved) {
        return successfulResolution(resolved, attempts, diagnostics, env);
      }
    }
  }

  const pathCandidate = await lookupInPath(env.PATH || "");
  if (pathCandidate) {
    const resolvedFromPath = await validateCandidate(
      "path",
      pathCandidate,
      env,
      attempts,
      timeoutMs,
    );
    if (resolvedFromPath) {
      return successfulResolution(resolvedFromPath, attempts, diagnostics, env);
    }
  } else {
    attempts.push({
      source: "path",
      command: "PATH lookup",
      success: false,
      error: "pi was not found in PATH.",
    });
  }

  const shellPath = opts.shellPath || "/bin/zsh";
  try {
    const shellResult = await execFilePromise(
      shellPath,
      ["-lc", "command -v pi"],
      {
        env: env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    );
    const shellCandidate = shellResult.stdout.trim().split(/\r?\n/)[0];
    if (shellCandidate) {
      const resolvedFromShell = await validateCandidate(
        "shell",
        shellCandidate,
        env,
        attempts,
        timeoutMs,
      );
      if (resolvedFromShell) {
        return successfulResolution(
          resolvedFromShell,
          attempts,
          diagnostics,
          env,
        );
      }
    } else {
      attempts.push({
        source: "shell",
        command: shellPath + " -lc 'command -v pi'",
        success: false,
        error: "Login shell did not return a pi path.",
      });
    }
  } catch (err) {
    attempts.push({
      source: "shell",
      command: shellPath + " -lc 'command -v pi'",
      success: false,
      error: errorMessage(err),
    });
  }

  const commonPaths = opts.commonPaths || DEFAULT_COMMON_PI_PATHS;
  for (let i = 0; i < commonPaths.length; i += 1) {
    const candidate = expandHome(commonPaths[i]!, homeDir);
    const exists = await fileExists(candidate);
    if (!exists) {
      attempts.push({
        source: "common",
        candidate: candidate,
        success: false,
        error: "Path does not exist.",
      });
      continue;
    }
    const resolvedFromCommon = await validateCandidate(
      "common",
      candidate,
      env,
      attempts,
      timeoutMs,
    );
    if (resolvedFromCommon) {
      return successfulResolution(
        resolvedFromCommon,
        attempts,
        diagnostics,
        env,
      );
    }
  }

  diagnostics.push({
    level: "error",
    code: "PI_BINARY_NOT_FOUND",
    message:
      "Could not resolve a working pi binary. Configure an absolute pi binary path, fix PATH, or install pi in a common location.",
  });
  return {
    ok: false,
    attempts: attempts,
    diagnostics: diagnostics,
    envSummary: redactEnv(env),
  };
}

async function lookupInPath(pathValue: string): Promise<string | undefined> {
  const entries = splitPath(pathValue);
  for (let i = 0; i < entries.length; i += 1) {
    const candidate = path.join(entries[i], "pi");
    try {
      await executableAccess(candidate);
      return candidate;
    } catch (_err) {
      // keep looking
    }
  }
  return undefined;
}

async function validateCandidate(
  source: PiBinaryResolutionSource,
  candidate: string,
  env: NodeJS.ProcessEnv,
  attempts: PiBinaryAttempt[],
  timeoutMs: number,
): Promise<
  | {
      piBinary: string;
      source: PiBinaryResolutionSource;
      versionResult: PiVersionResult;
    }
  | undefined
> {
  try {
    await executableAccess(candidate);
    const canonical = await realpath(candidate);
    const versionResult = await runPiVersion(canonical, env, timeoutMs);
    if (!versionResult.ok) {
      attempts.push({
        source: source,
        candidate: candidate,
        success: false,
        error:
          "Resolved candidate but `pi --version` failed: " +
          (versionResult.error || versionResult.stderr || "unknown error"),
      });
      return undefined;
    }
    attempts.push({ source: source, candidate: canonical, success: true });
    return {
      piBinary: canonical,
      source: source,
      versionResult: versionResult,
    };
  } catch (err) {
    attempts.push({
      source: source,
      candidate: candidate,
      success: false,
      error: errorMessage(err),
    });
    return undefined;
  }
}

function successfulResolution(
  resolved: {
    piBinary: string;
    source: PiBinaryResolutionSource;
    versionResult: PiVersionResult;
  },
  attempts: PiBinaryAttempt[],
  diagnostics: DiagnosticMessage[],
  env: NodeJS.ProcessEnv,
): PiBinaryResolution {
  diagnostics.push({
    level: "info",
    code: "PI_BINARY_RESOLVED",
    message: "Resolved pi binary from " + resolved.source + ".",
    details: {
      piBinary: resolved.piBinary,
      version: resolved.versionResult.version,
    },
  });
  return {
    ok: true,
    piBinary: resolved.piBinary,
    source: resolved.source,
    version: resolved.versionResult.version,
    versionResult: resolved.versionResult,
    attempts: attempts,
    diagnostics: diagnostics,
    envSummary: redactEnv(env),
  };
}

export async function resolveEffectivePiConfig(
  options: ResolveEffectivePiConfigOptions,
): Promise<EffectivePiConfigResult> {
  const env: NodeJS.ProcessEnv = Object.assign({}, options.env || process.env);
  const homeDir = options.homeDir || os.homedir();
  const appSettings = options.appSettings || {};
  const diagnostics: DiagnosticMessage[] = [];
  const cwd = options.cwd
    ? resolveUserPath(options.cwd, undefined, homeDir)
    : process.cwd();
  const trustOverride = options.trustOverride;

  let agentDir: string;
  if (appSettings.agentDir) {
    agentDir = resolveUserPath(appSettings.agentDir, undefined, homeDir);
    env.PI_CODING_AGENT_DIR = agentDir;
  } else if (env.PI_CODING_AGENT_DIR) {
    agentDir = resolveUserPath(env.PI_CODING_AGENT_DIR, undefined, homeDir);
  } else {
    agentDir = path.join(homeDir, ".pi", "agent");
  }

  const globalSettings = await parseSettingsFile(
    path.join(agentDir, "settings.json"),
    agentDir,
  );
  diagnostics.push.apply(diagnostics, globalSettings.diagnostics);

  const projectPiDir = path.join(cwd, ".pi");
  const projectSettings = await parseSettingsFile(
    path.join(projectPiDir, "settings.json"),
    projectPiDir,
  );
  diagnostics.push.apply(diagnostics, projectSettings.diagnostics);

  const projectSettingsAuthoritative = trustOverride === "approve";
  let projectSessionDirCandidate: string | undefined;
  if (projectSettings.settings.sessionDir) {
    projectSessionDirCandidate = resolveUserPath(
      projectSettings.settings.sessionDir,
      projectSettings.baseDir,
      homeDir,
    );
  }

  let sessionDir: string | undefined;
  let sessionDirSource: SessionDirSource;
  const workerArgs: string[] = [];
  if (appSettings.sessionDir) {
    sessionDir = resolveUserPath(appSettings.sessionDir, undefined, homeDir);
    sessionDirSource = "app";
    workerArgs.push("--session-dir", sessionDir);
  } else if (env.PI_CODING_AGENT_SESSION_DIR) {
    sessionDir = resolveUserPath(
      env.PI_CODING_AGENT_SESSION_DIR,
      undefined,
      homeDir,
    );
    sessionDirSource = "env";
  } else if (projectSettingsAuthoritative && projectSessionDirCandidate) {
    sessionDir = projectSessionDirCandidate;
    sessionDirSource = "projectSettings";
  } else if (globalSettings.settings.sessionDir) {
    sessionDir = resolveUserPath(
      globalSettings.settings.sessionDir,
      globalSettings.baseDir,
      homeDir,
    );
    sessionDirSource = "globalSettings";
  } else {
    sessionDir = path.join(agentDir, "sessions");
    sessionDirSource = "default";
  }

  if (!projectSettingsAuthoritative && projectSessionDirCandidate) {
    diagnostics.push({
      level: "warning",
      code: "PROJECT_SESSION_DIR_CANDIDATE",
      message:
        "Project .pi/settings.json contains sessionDir, but project settings are only authoritative for Trust this run. The directory is a candidate and must not be scanned automatically.",
      details: candidateDetails(projectSessionDirCandidate, cwd, agentDir),
    });
  }

  const imageResolution = resolveImageSettings(
    appSettings,
    globalSettings.settings,
    projectSettings.settings,
    projectSettingsAuthoritative,
    diagnostics,
  );

  const config: EffectivePiConfig = {
    piBinary: options.piBinary,
    env: env,
    agentDir: agentDir,
    sessionDir: sessionDir,
    sessionDirSource: sessionDirSource,
    imageSettings: imageResolution,
    trustOverride: trustOverride,
  };

  diagnostics.push({
    level: "info",
    code: "EFFECTIVE_PI_CONFIG_RESOLVED",
    message: "Resolved EffectivePiConfig.",
    details: {
      piBinary: config.piBinary,
      agentDir: config.agentDir,
      sessionDir: config.sessionDir,
      sessionDirSource: config.sessionDirSource,
      imageSettings: config.imageSettings,
      trustOverride: config.trustOverride,
    },
  });

  return {
    config: config,
    diagnostics: diagnostics,
    envSummary: redactEnv(env),
    workerArgs: workerArgs,
    projectSessionDirCandidate: projectSessionDirCandidate,
  };
}

function candidateDetails(
  candidate: string,
  cwd: string,
  agentDir: string,
): Record<string, unknown> {
  return {
    candidate: candidate,
    outsideProject: !isPathInside(candidate, cwd),
    outsideAgentDir: !isPathInside(candidate, agentDir),
  };
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative.indexOf("..") !== 0 && !path.isAbsolute(relative))
  );
}

function resolveImageSettings(
  appSettings: AppPiSettings,
  globalSettings: NarrowSettings,
  projectSettings: NarrowSettings,
  projectSettingsAuthoritative: boolean,
  diagnostics: DiagnosticMessage[],
): EffectivePiConfig["imageSettings"] {
  let blockImages = false;
  let blockImagesSource: ImageSettingSource = "default";
  let autoResize = true;
  let autoResizeSource: ImageSettingSource = "default";
  const candidateWarnings: string[] = [];

  if (
    globalSettings.images &&
    typeof globalSettings.images.blockImages === "boolean"
  ) {
    blockImages = globalSettings.images.blockImages;
    blockImagesSource = "globalSettings";
  }
  if (
    globalSettings.images &&
    typeof globalSettings.images.autoResize === "boolean"
  ) {
    autoResize = globalSettings.images.autoResize;
    autoResizeSource = "globalSettings";
  }

  if (projectSettings.images) {
    if (projectSettingsAuthoritative) {
      if (typeof projectSettings.images.blockImages === "boolean") {
        blockImages = projectSettings.images.blockImages;
        blockImagesSource = "projectSettings";
      }
      if (typeof projectSettings.images.autoResize === "boolean") {
        autoResize = projectSettings.images.autoResize;
        autoResizeSource = "projectSettings";
      }
    } else {
      if (projectSettings.images.blockImages === true) {
        blockImages = true;
        blockImagesSource = "projectCandidate";
        candidateWarnings.push(
          "Applied project candidate images.blockImages=true conservatively because project trust is delegated/default.",
        );
      } else if (projectSettings.images.blockImages === false) {
        candidateWarnings.push(
          "Ignored project candidate images.blockImages=false because project settings are not authoritative without Trust this run.",
        );
      }

      if (projectSettings.images.autoResize === true) {
        autoResize = true;
        autoResizeSource = "projectCandidate";
        candidateWarnings.push(
          "Applied project candidate images.autoResize=true conservatively because project trust is delegated/default.",
        );
      } else if (projectSettings.images.autoResize === false) {
        candidateWarnings.push(
          "Ignored project candidate images.autoResize=false because project settings are not authoritative without Trust this run.",
        );
      }
    }
  }

  if (
    appSettings.images &&
    typeof appSettings.images.blockImages === "boolean"
  ) {
    blockImages = appSettings.images.blockImages;
    blockImagesSource = "app";
  }
  if (
    appSettings.images &&
    typeof appSettings.images.autoResize === "boolean"
  ) {
    autoResize = appSettings.images.autoResize;
    autoResizeSource = "app";
  }

  for (let i = 0; i < candidateWarnings.length; i += 1) {
    diagnostics.push({
      level: "warning",
      code: "PROJECT_IMAGE_SETTING_CANDIDATE",
      message: candidateWarnings[i]!,
    });
  }

  return {
    blockImages: blockImages,
    autoResize: autoResize,
    sources: {
      blockImages: blockImagesSource,
      autoResize: autoResizeSource,
    },
    candidateWarnings: candidateWarnings,
  };
}

async function parseSettingsFile(
  settingsPath: string,
  baseDir: string,
): Promise<ParsedSettings> {
  const diagnostics: DiagnosticMessage[] = [];
  const parsed: ParsedSettings = {
    path: settingsPath,
    baseDir: baseDir,
    settings: {},
    diagnostics: diagnostics,
  };
  const exists = await fileExists(settingsPath);
  if (!exists) {
    return parsed;
  }
  try {
    const raw = await readFile(settingsPath);
    const json = JSON.parse(raw);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      diagnostics.push({
        level: "warning",
        code: "SETTINGS_PARSE_IGNORED",
        message: "Settings file is not a JSON object.",
        details: { path: settingsPath },
      });
      return parsed;
    }
    const obj = json as Record<string, unknown>;
    if (typeof obj.sessionDir === "string") {
      parsed.settings.sessionDir = obj.sessionDir;
    }
    const images = obj.images;
    if (images && typeof images === "object" && !Array.isArray(images)) {
      const imageObj = images as Record<string, unknown>;
      parsed.settings.images = {};
      if (typeof imageObj.blockImages === "boolean") {
        parsed.settings.images.blockImages = imageObj.blockImages;
      }
      if (typeof imageObj.autoResize === "boolean") {
        parsed.settings.images.autoResize = imageObj.autoResize;
      }
    }
    return parsed;
  } catch (err) {
    diagnostics.push({
      level: "warning",
      code: "SETTINGS_PARSE_ERROR",
      message:
        "Could not parse settings file; ignoring narrow preflight settings from this file.",
      details: { path: settingsPath, error: errorMessage(err) },
    });
    return parsed;
  }
}

function readFile(filePath: string): Promise<string> {
  return new Promise(function (
    resolve: (value: string) => void,
    reject: (err: Error) => void,
  ): void {
    fs.readFile(
      filePath,
      "utf8",
      function (err: Error | null, data: string): void {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      },
    );
  });
}

function errorMessage(err: unknown): string {
  const anyErr = err as any;
  if (anyErr && anyErr.message !== undefined) {
    return String(anyErr.message);
  }
  return String(err);
}
