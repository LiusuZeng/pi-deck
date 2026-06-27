import { mkdir, readdir, stat, truncate, unlink } from "node:fs/promises";
import path from "node:path";
import type { AppSettings, DiagnosticsSummary } from "../../shared/types.js";

const maxLogBytes = 5 * 1024 * 1024;
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const maxRecentErrors = 25;

export interface DiagnosticsRecorder {
  recordError(message: string): void;
}

export class DiagnosticsService implements DiagnosticsRecorder {
  readonly logPath: string;
  private readonly recentErrors: string[] = [];

  constructor(
    private readonly appVersion: string,
    private readonly userDataPath: string,
  ) {
    this.logPath = path.join(userDataPath, "logs");
  }

  async initialize(): Promise<void> {
    await mkdir(this.logPath, { recursive: true });
    await applyLogRetention(this.logPath);
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

export async function applyLogRetention(logPath: string): Promise<void> {
  await mkdir(logPath, { recursive: true });
  const now = Date.now();
  const entries = await readdir(logPath, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(logPath, entry.name);
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > retentionMs) {
          await unlink(filePath);
          return;
        }
        if (fileStat.size > maxLogBytes) {
          await truncate(filePath, maxLogBytes);
        }
      }),
  );
}
