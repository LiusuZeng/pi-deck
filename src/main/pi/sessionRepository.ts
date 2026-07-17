import fs from "node:fs/promises";
import path from "node:path";
import type { ChatSessionSummary } from "../../shared/types.js";

export interface ScanSessionRepositoryOptions {
  sessionDir: string;
  projectCwd: string;
  maxDepth?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
  maxWallTimeMs?: number;
}

export interface ScanSessionRepositoryResult {
  sessions: ChatSessionSummary[];
  diagnostics: string[];
}

/** The filesystem and Pi-header checks required before a session can be deleted. */
export interface ValidateSessionDeletionOptions {
  sessionFile: string;
  sessionDir: string;
  projectCwd: string;
}

export type SessionDeletionValidationResult =
  | { ok: true; sessionFile: string }
  | { ok: false; reason: string };

interface ParsedSessionFile {
  sessionId?: string;
  cwd?: string;
  title?: string;
  preview?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  messageCount: number;
  bytesRead: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_BYTES_PER_FILE = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const DEFAULT_MAX_WALL_TIME_MS = 15_000;
const DELETE_HEADER_MAX_BYTES = 64 * 1024;

/**
 * Validates a renderer-supplied path against the active Pi configuration.
 *
 * Session references are presentation metadata, not deletion authority.  This
 * deliberately rechecks the canonical directory, file type, extension, and
 * on-disk Pi session header immediately before deletion.
 */
export async function validateSessionForDeletion(
  options: ValidateSessionDeletionOptions,
): Promise<SessionDeletionValidationResult> {
  let sessionDir: string;
  let projectCwd: string;
  let sessionFile: string;
  try {
    [sessionDir, projectCwd, sessionFile] = await Promise.all([
      fs.realpath(options.sessionDir),
      fs.realpath(options.projectCwd),
      fs.realpath(options.sessionFile),
    ]);
  } catch {
    return {
      ok: false,
      reason: "session file, directory, or project is unavailable",
    };
  }

  let sessionDirStat: Awaited<ReturnType<typeof fs.stat>>;
  let sessionFileStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    [sessionDirStat, sessionFileStat] = await Promise.all([
      fs.stat(sessionDir),
      fs.lstat(sessionFile),
    ]);
  } catch {
    return {
      ok: false,
      reason: "session file or directory could not be inspected",
    };
  }
  if (!sessionDirStat.isDirectory()) {
    return {
      ok: false,
      reason: "configured session directory is not a directory",
    };
  }
  if (!sessionFileStat.isFile()) {
    return { ok: false, reason: "session path is not a regular file" };
  }
  if (!sessionFile.endsWith(".jsonl")) {
    return {
      ok: false,
      reason: "session file does not have a .jsonl extension",
    };
  }
  if (!isStrictDescendant(sessionFile, sessionDir)) {
    return {
      ok: false,
      reason: "session file is outside the configured session directory",
    };
  }

  const header = await readPiSessionHeader(sessionFile);
  if (header === undefined) {
    return {
      ok: false,
      reason: "session file does not have a valid Pi session header",
    };
  }
  let headerCwd: string;
  try {
    headerCwd = await fs.realpath(header.cwd);
  } catch {
    return { ok: false, reason: "session header project is unavailable" };
  }
  if (headerCwd !== projectCwd) {
    return { ok: false, reason: "session belongs to a different project" };
  }

  return { ok: true, sessionFile };
}

export async function scanSessionRepository(
  options: ScanSessionRepositoryOptions,
): Promise<ScanSessionRepositoryResult> {
  const diagnostics: string[] = [];
  const sessions: ChatSessionSummary[] = [];
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxWallTimeMs = options.maxWallTimeMs ?? DEFAULT_MAX_WALL_TIME_MS;
  const projectCwd = await canonicalOrResolved(options.projectCwd);
  const sessionDir = await canonicalOrResolved(options.sessionDir);
  const startedAt = Date.now();
  let seenFiles = 0;
  let totalBytesRead = 0;
  let stoppedForByteCap = false;
  let stoppedForTimeCap = false;

  function shouldStopScanning(): boolean {
    if (seenFiles >= maxFiles) {
      return true;
    }
    if (stoppedForByteCap || stoppedForTimeCap) {
      return true;
    }
    if (Date.now() - startedAt > maxWallTimeMs) {
      stoppedForTimeCap = true;
      diagnostics.push(
        `Stopped session scan after ${maxWallTimeMs}ms wall-time limit.`,
      );
      return true;
    }
    return false;
  }

  async function walk(directory: string, depth: number): Promise<void> {
    if (shouldStopScanning()) {
      return;
    }
    if (depth > maxDepth) {
      diagnostics.push(
        `Skipped ${directory}: max scan depth ${maxDepth} reached.`,
      );
      return;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push(
        `Could not read session directory ${directory}: ${errorMessage(error)}`,
      );
      return;
    }

    for (const entry of entries) {
      if (shouldStopScanning()) {
        if (seenFiles >= maxFiles) {
          diagnostics.push(`Stopped session scan after ${maxFiles} files.`);
        }
        return;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const remainingBytes = maxTotalBytes - totalBytesRead;
      if (remainingBytes <= 0) {
        stoppedForByteCap = true;
        diagnostics.push(
          `Stopped session scan after reading ${maxTotalBytes} bytes.`,
        );
        return;
      }

      seenFiles += 1;
      const result = await summarizeSessionFile(
        entryPath,
        projectCwd,
        Math.min(maxBytesPerFile, remainingBytes),
        diagnostics,
      );
      totalBytesRead += result.bytesRead;
      const summary = result.summary;
      if (totalBytesRead >= maxTotalBytes) {
        stoppedForByteCap = true;
        diagnostics.push(
          `Stopped session scan after reading ${maxTotalBytes} bytes.`,
        );
      }
      if (summary !== undefined) {
        sessions.push(summary);
      }
    }
  }

  await walk(sessionDir, 0);
  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return { sessions, diagnostics };
}

async function summarizeSessionFile(
  filePath: string,
  projectCwd: string,
  maxBytes: number,
  diagnostics: string[],
): Promise<{ summary?: ChatSessionSummary; bytesRead: number }> {
  let canonicalFile: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    canonicalFile = await fs.realpath(filePath);
    stat = await fs.stat(canonicalFile);
  } catch (error) {
    diagnostics.push(
      `Could not inspect session file ${filePath}: ${errorMessage(error)}`,
    );
    return { bytesRead: 0 };
  }

  const parsed = await parseSessionFile(canonicalFile, maxBytes, diagnostics);
  const cwd = parsed.cwd ? await canonicalOrResolved(parsed.cwd) : undefined;
  if (cwd !== projectCwd) {
    return { bytesRead: parsed.bytesRead };
  }

  const updatedAtMs = parsed.updatedAtMs ?? stat.mtimeMs;
  const createdAtMs = parsed.createdAtMs ?? stat.birthtimeMs;
  return {
    bytesRead: parsed.bytesRead,
    summary: {
      id: canonicalFile,
      sessionFile: canonicalFile,
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      cwd,
      title: parsed.title ?? path.basename(canonicalFile, ".jsonl"),
      updatedAtMs,
      createdAtMs,
      messageCount: parsed.messageCount,
      ...(parsed.preview ? { preview: parsed.preview } : {}),
    },
  };
}

interface PiSessionHeader {
  cwd: string;
}

async function readPiSessionHeader(
  filePath: string,
): Promise<PiSessionHeader | undefined> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(DELETE_HEADER_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .split(/\r?\n/, 1)[0];
      if (firstLine === undefined || firstLine.length === 0) {
        return undefined;
      }
      const record = JSON.parse(firstLine) as unknown;
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        return undefined;
      }
      const header = record as Record<string, unknown>;
      return header.type === "session" &&
        typeof header.id === "string" &&
        header.id.length > 0 &&
        typeof header.cwd === "string" &&
        header.cwd.length > 0
        ? { cwd: header.cwd }
        : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function isStrictDescendant(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function parseSessionFile(
  filePath: string,
  maxBytes: number,
  diagnostics: string[],
): Promise<ParsedSessionFile> {
  let content: string;
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      content = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    diagnostics.push(
      `Could not read session file ${filePath}: ${errorMessage(error)}`,
    );
    return { messageCount: 0, bytesRead: 0 };
  }

  const parsed: ParsedSessionFile = {
    messageCount: 0,
    bytesRead: Buffer.byteLength(content),
  };
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    ingestRecord(parsed, record as Record<string, unknown>);
  }
  return parsed;
}

function ingestRecord(
  parsed: ParsedSessionFile,
  record: Record<string, unknown>,
): void {
  const timestamp = parseTimestamp(record.timestamp);
  if (timestamp !== undefined) {
    parsed.updatedAtMs = Math.max(parsed.updatedAtMs ?? 0, timestamp);
  }

  if (record.type === "session") {
    if (typeof record.id === "string") {
      parsed.sessionId = record.id;
    }
    if (typeof record.cwd === "string") {
      parsed.cwd = record.cwd;
    }
    if (timestamp !== undefined) {
      parsed.createdAtMs = timestamp;
    }
    return;
  }

  if (record.type !== "message") {
    return;
  }
  parsed.messageCount += 1;
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return;
  }
  const messageRecord = message as Record<string, unknown>;
  const text = extractTextContent(messageRecord.content);
  if (!text) {
    return;
  }
  if (parsed.preview === undefined) {
    parsed.preview = text;
  }
  if (messageRecord.role === "user" && parsed.title === undefined) {
    parsed.title = summarize(text, 80);
  }
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((item): string[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") {
      return [record.text];
    }
    return [];
  });
  return parts.length > 0 ? summarize(parts.join("\n"), 180) : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function summarize(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

async function canonicalOrResolved(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
