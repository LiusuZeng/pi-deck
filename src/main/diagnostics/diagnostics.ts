import { mkdir, readdir, stat, truncate, unlink } from "node:fs/promises";
import path from "node:path";
import type { Dirent, Stats } from "node:fs";
import type { AppSettings, DiagnosticsSummary } from "../../shared/types.js";

const maxLogBytes = 5 * 1024 * 1024;
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const maxRecentErrors = 25;
const maxRetentionWarningLength = 500;

interface LogRetentionOptions {
  operations?: Partial<{
    stat(filePath: string): Promise<Stats>;
    truncate(filePath: string, length: number): Promise<void>;
    unlink(filePath: string): Promise<void>;
  }>;
  onWarning?(message: string): void;
}

export interface DiagnosticsRecorder {
  recordError(message: string): void;
}

export class DiagnosticsService implements DiagnosticsRecorder {
  readonly logPath: string;
  private readonly recentErrors: string[] = [];

  constructor(
    private readonly appVersion: string,
    private readonly userDataPath: string,
    private readonly retentionOptions: LogRetentionOptions = {},
  ) {
    this.logPath = path.join(userDataPath, "logs");
  }

  async initialize(): Promise<void> {
    await mkdir(this.logPath, { recursive: true });
    await applyLogRetention(this.logPath, {
      ...this.retentionOptions,
      onWarning: (message) => {
        this.recordError(message);
        this.retentionOptions.onWarning?.(message);
      },
    });
  }

  recordError(message: string): void {
    this.recentErrors.unshift(message);
    if (this.recentErrors.length > maxRecentErrors) {
      this.recentErrors.length = maxRecentErrors;
    }
  }

  getSummary(settings: AppSettings): DiagnosticsSummary {
    return {
      appVersion: this.appVersion,
      userDataPath: this.userDataPath,
      logPath: this.logPath,
      settings: redactSettings(settings),
      recentErrors: [...this.recentErrors],
    };
  }
}

export function redactSettings(settings: AppSettings): AppSettings {
  return redactObject(settings) as AppSettings;
}

function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactObject);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|api[_-]?key|auth/i.test(key)) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = redactObject(child);
    }
  }
  return redacted;
}

export async function applyLogRetention(
  logPath: string,
  options: LogRetentionOptions = {},
): Promise<void> {
  // Creating and enumerating the diagnostics directory remains an initialization
  // precondition; individual retained files are best-effort cleanup only.
  await mkdir(logPath, { recursive: true });
  const now = Date.now();
  const entries = await readdir(logPath, { withFileTypes: true });
  const operations = {
    stat,
    truncate,
    unlink,
    ...options.operations,
  };

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        applyRetentionToFile(
          logPath,
          entry,
          now,
          operations,
          options.onWarning,
        ),
      ),
  );
}

async function applyRetentionToFile(
  logPath: string,
  entry: Dirent,
  now: number,
  operations: Required<NonNullable<LogRetentionOptions["operations"]>>,
  onWarning: LogRetentionOptions["onWarning"],
): Promise<void> {
  const filePath = path.join(logPath, entry.name);
  let fileStat: Stats;
  try {
    fileStat = await operations.stat(filePath);
  } catch (error) {
    warnRetentionFailure("stat", entry.name, error, onWarning);
    return;
  }

  if (now - fileStat.mtimeMs > retentionMs) {
    try {
      await operations.unlink(filePath);
    } catch (error) {
      warnRetentionFailure("unlink", entry.name, error, onWarning);
    }
    return;
  }

  if (fileStat.size > maxLogBytes) {
    try {
      await operations.truncate(filePath, maxLogBytes);
    } catch (error) {
      warnRetentionFailure("truncate", entry.name, error, onWarning);
    }
  }
}

function warnRetentionFailure(
  operation: "stat" | "truncate" | "unlink",
  fileName: string,
  error: unknown,
  onWarning: LogRetentionOptions["onWarning"],
): void {
  if (isNotFoundError(error)) {
    return;
  }

  let message = `Diagnostic log retention ${operation} failed for ${JSON.stringify(
    fileName,
  )}: ${describeRetentionError(error)}`;
  if (message.length > maxRetentionWarningLength) {
    message = `${message.slice(0, maxRetentionWarningLength - 1)}…`;
  }

  try {
    onWarning?.(message);
  } catch {
    // Retention is best-effort; a warning sink must not make startup fail.
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function describeRetentionError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}
