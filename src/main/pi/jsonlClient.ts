import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type {
  ChildProcess,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { spawn } from "node:child_process";
import type {
  JsonObject,
  JsonValue,
  RpcErrorPayload,
  RpcEventRecord,
  RpcResponseRecord,
} from "./types.js";

export interface JsonlParseError {
  line: string;
  message: string;
  cause?: unknown;
}

// A get_messages response can legitimately contain several base64-encoded
// images (each imported image is bounded at 20 MiB). Keep framing bounded while
// leaving enough headroom for supported histories until image payloads move to
// opaque main-owned tokens.
export const DEFAULT_MAX_JSONL_LINE_BYTES = 256 * 1024 * 1024;

const MAX_EXIT_SUMMARY_CHARS = 1024;
const MAX_EXIT_COMMAND_CHARS = 2 * 1024;
const MAX_EXIT_STDERR_CHARS = 8 * 1024;
const MAX_EXIT_DIAGNOSTIC_CHARS = 12 * 1024;
const EXIT_STDERR_GRACE_MS = 50;
const SENSITIVE_OPTION =
  /^--?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|cookie|credential|pass(?:word|wd)?|secret|token)$/i;

function boundedHead(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n[...${omitted} chars omitted...]`;
}

function boundedTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `[...${omitted} chars omitted...]\n${value.slice(-maxChars)}`;
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[-_]?key|access[-_]?token|auth(?:orization)?|cookie|credential|pass(?:word|wd)?|secret|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/:\/\/([^\s/:@]+):([^\s/@]+)@/g, "://$1:[REDACTED]@");
}

function formatChildCommand(command: string, args: string[]): string {
  let redactNext = false;
  const values = [command, ...args].map((value, index) => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    if (index > 0) {
      const equals = value.indexOf("=");
      const option = equals === -1 ? value : value.slice(0, equals);
      if (SENSITIVE_OPTION.test(option)) {
        if (equals === -1) {
          redactNext = true;
          return value;
        }
        return `${option}=[REDACTED]`;
      }
    }
    return value;
  });
  const rendered = values.map((value) => JSON.stringify(value)).join(" ");
  return boundedHead(redactDiagnosticText(rendered), MAX_EXIT_COMMAND_CHARS);
}

export interface JsonlFramingParserOptions {
  onRecord: (record: JsonValue) => void;
  onMalformed: (error: JsonlParseError) => void;
  /**
   * Maximum UTF-8 byte length of one record, excluding its LF delimiter and
   * optional CR before that delimiter.
   * This also bounds the retained unterminated-record buffer, aside from one
   * pending CR byte while waiting to see whether the next byte is LF.
   */
  maxLineBytes?: number;
  /** @internal Test instrumentation for deterministic framing complexity checks. */
  onFramingScan?: (characters: number) => void;
}

/**
 * Strict LF-delimited JSONL parser.
 *
 * This parser deliberately does not use node:readline because readline treats
 * Unicode line/paragraph separators as line terminators in some modes. JSONL is
 * framed only by byte LF ("\n") here, so U+2028/U+2029 inside JSON strings are
 * valid payload characters. StringDecoder preserves UTF-8 code points split
 * across chunk boundaries.
 */
export class JsonlFramingParser {
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxLineBytes: number;
  // Preserve the unterminated record as decoded chunks. Joining only when a
  // delimiter arrives avoids repeatedly copying or flattening accumulated text.
  private lineSegments: string[] = [];
  private lineBytes = 0;
  private discardingOversizedLine = false;

  constructor(private readonly options: JsonlFramingParserOptions) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes <= 0) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
  }

  push(chunk: Buffer | string): void {
    this.drainText(
      typeof chunk === "string" ? chunk : this.decoder.write(chunk),
    );
  }

  end(): void {
    this.drainText(this.decoder.end());
    if (this.discardingOversizedLine) {
      return;
    }
    if (this.lineBytes > this.maxLineBytes) {
      this.resetLine();
      this.reportOversizedLine();
      return;
    }
    if (this.lineSegments.length > 0) {
      const line = this.materializeLine();
      this.resetLine();
      this.options.onMalformed({
        line,
        message: "Incomplete JSONL record at EOF",
      });
    }
  }

  private drainText(text: string): void {
    if (text.length === 0) {
      return;
    }

    let cursor = 0;
    let lineStart = 0;
    let scanned = 0;
    while (cursor < text.length) {
      scanned += 1;
      if (text.charCodeAt(cursor) !== 0x0a) {
        cursor += 1;
        continue;
      }

      if (this.discardingOversizedLine) {
        this.discardingOversizedLine = false;
      } else {
        this.appendLineSegment(text.slice(lineStart, cursor));
        this.parseBufferedLine();
      }
      cursor += 1;
      lineStart = cursor;
    }
    this.options.onFramingScan?.(scanned);

    if (this.discardingOversizedLine) {
      return;
    }

    this.appendLineSegment(text.slice(lineStart));
    if (
      this.lineBytes > this.maxLineBytes &&
      !(
        this.lineBytes === this.maxLineBytes + 1 &&
        this.lineEndsWithCarriageReturn()
      )
    ) {
      this.resetLine();
      this.discardingOversizedLine = true;
      this.reportOversizedLine();
    }
  }

  private appendLineSegment(segment: string): void {
    if (segment.length === 0) {
      return;
    }
    this.lineSegments.push(segment);
    this.lineBytes += Buffer.byteLength(segment, "utf8");
  }

  private parseBufferedLine(): void {
    const rawLineBytes = this.lineBytes;
    const rawLine = this.materializeLine();
    this.resetLine();

    const hasCarriageReturn = rawLine.endsWith("\r");
    const line = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
    const lineBytes = hasCarriageReturn ? rawLineBytes - 1 : rawLineBytes;
    if (lineBytes > this.maxLineBytes) {
      this.reportOversizedLine();
      return;
    }
    this.parseLine(line);
  }

  private materializeLine(): string {
    if (this.lineSegments.length === 1) {
      return this.lineSegments[0]!;
    }
    return this.lineSegments.join("");
  }

  private lineEndsWithCarriageReturn(): boolean {
    const lastSegment = this.lineSegments.at(-1);
    return lastSegment?.endsWith("\r") ?? false;
  }

  private resetLine(): void {
    this.lineSegments = [];
    this.lineBytes = 0;
  }

  private reportOversizedLine(): void {
    this.options.onMalformed({
      // Do not retain attacker-controlled oversized output in diagnostics.
      line: "",
      message: `JSONL record exceeds maximum size of ${this.maxLineBytes} bytes`,
    });
  }

  private parseLine(line: string, prefix?: string): void {
    try {
      this.options.onRecord(JSON.parse(line) as JsonValue);
    } catch (cause) {
      const causeMessage =
        cause instanceof Error ? cause.message : String(cause);
      this.options.onMalformed({
        line,
        message: prefix ? `${prefix}: ${causeMessage}` : causeMessage,
        cause,
      });
    }
  }
}

export class DiagnosticRingBuffer {
  private value = "";

  constructor(private readonly maxChars = 64 * 1024) {}

  append(text: string): void {
    this.value += text;
    if (this.value.length > this.maxChars) {
      this.value = this.value.slice(this.value.length - this.maxChars);
    }
  }

  snapshot(): string {
    return this.value;
  }
}

export type JsonlRpcCommandProtocol = "command-field" | "type-field";

export interface JsonlRpcClientOptions {
  requestTimeoutMs?: number;
  /** Deadline for a response-less notification write to reach stdin. */
  notificationTimeoutMs?: number;
  stderrBufferBytes?: number;
  /** Maximum UTF-8 byte length of one stdout JSONL record. */
  maxLineBytes?: number;
  malformedOutputIsFatal?: boolean;
  commandProtocol?: JsonlRpcCommandProtocol;
}

interface PendingRequest {
  id: string;
  command: string;
  resolve: (value: JsonValue) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  possibleDispatch: boolean;
}

interface PendingNotificationWrite {
  reject: (reason: Error) => void;
}

export interface JsonlRpcClientFatalEvent {
  reason: "malformed_output";
  error: Error;
}

export interface JsonlRpcClientEvents {
  event: [RpcEventRecord];
  diagnostic: [string];
  /** A write-side stream failure that leaves child termination unconfirmed. */
  transportError: [Error];
  fatal: [JsonlRpcClientFatalEvent];
  close: [{ code: number | null; signal: NodeJS.Signals | null }];
}

export type JsonlRpcDeliveryStatus = "unknown" | "not-dispatched";

export class JsonlRpcDeliveryError extends Error {
  readonly deliveryStatus: JsonlRpcDeliveryStatus;

  constructor(message: string, deliveryStatus: JsonlRpcDeliveryStatus) {
    super(message);
    this.name = "JsonlRpcDeliveryError";
    this.deliveryStatus = deliveryStatus;
  }
}

/** A notification deadline leaves queued stdin bytes' delivery unknown. */
export class JsonlRpcNotificationTimeoutError extends JsonlRpcDeliveryError {
  /** Retained for callers that predate the shared delivery-status contract. */
  readonly deliveryUnknown = true;

  constructor(timeoutMs: number) {
    super(
      `RPC notification write timed out after ${timeoutMs}ms; delivery status is unknown`,
      "unknown",
    );
    this.name = "JsonlRpcNotificationTimeoutError";
  }
}

/**
 * Class identity can be lost when an error crosses a bundled Electron module
 * boundary. Keep delivery classification explicit and structural so that
 * boundary does not turn uncertain prompt receipt into a safe rejection.
 */
export function isUnknownJsonlRpcDeliveryError(
  error: unknown,
): error is { message: string; deliveryStatus: "unknown" } {
  // Errors arriving from Electron's bundled module context do not necessarily
  // inherit this realm's Error.prototype. Do not use instanceof here: the
  // explicit, schema-validated status is the delivery contract.
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { deliveryStatus?: unknown }).deliveryStatus === "unknown"
  );
}

export class JsonlRpcError extends Error {
  readonly code?: string;
  readonly details?: JsonValue;

  constructor(message: string, payload?: RpcErrorPayload | string) {
    super(message);
    this.name = "JsonlRpcError";
    if (typeof payload === "object" && payload !== null) {
      if (payload.code !== undefined) {
        this.code = payload.code;
      }
      if (payload.details !== undefined) {
        this.details = payload.details;
      }
    }
  }
}

export class JsonlRpcClient extends EventEmitter {
  readonly stderr: DiagnosticRingBuffer;
  private readonly requestTimeoutMs: number;
  private readonly notificationTimeoutMs: number;
  private readonly malformedOutputIsFatal: boolean;
  private readonly commandProtocol: JsonlRpcCommandProtocol;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingNotificationWrites = new Map<
    symbol,
    PendingNotificationWrite
  >();
  private readonly parser: JsonlFramingParser;
  private closed = false;
  private transportFatalError: Error | undefined;
  private exitCode: number | null = null;
  private signal: NodeJS.Signals | null = null;
  private closeEmitted = false;
  private closeRequested = false;
  private fatalError: Error | undefined;
  private exitFinalizationTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly child: ChildProcess,
    options: JsonlRpcClientOptions = {},
    private readonly commandDiagnostic?: string,
  ) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.notificationTimeoutMs =
      options.notificationTimeoutMs ?? this.requestTimeoutMs;
    this.malformedOutputIsFatal = options.malformedOutputIsFatal ?? true;
    this.commandProtocol = options.commandProtocol ?? "type-field";
    this.stderr = new DiagnosticRingBuffer(
      options.stderrBufferBytes ?? 64 * 1024,
    );
    this.parser = new JsonlFramingParser({
      onRecord: (record) => this.handleRecord(record),
      onMalformed: (error) => this.handleMalformed(error),
      ...(options.maxLineBytes === undefined
        ? {}
        : { maxLineBytes: options.maxLineBytes }),
    });

    child.stdout?.on("data", (chunk: Buffer) => this.parser.push(chunk));
    child.stdout?.on("end", () => this.parser.end());
    if (typeof child.stdin?.on === "function") {
      child.stdin.on("error", (error: Error) => {
        this.handleStdinFailure(error, "RPC stdin stream error");
      });
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderr.append(text);
      this.emit("diagnostic", text);
    });
    // A queued write can fail after its callback's caller has timed out (for
    // example when quarantining a stalled worker closes its stdin). Keep this
    // listener for the stream's whole lifetime: Writable emits an unhandled
    // "error" otherwise, and the callback is not a substitute for observing
    // later stream errors.
    const stdin = child.stdin;
    if (stdin && typeof stdin.on === "function") {
      stdin.on("error", (error) => {
        this.emit("diagnostic", `RPC stdin error: ${error.message}`);
      });
    }
    child.on("error", (error) => {
      // A spawn failure has no process exit event to wait for. It is still a
      // terminal lifecycle event: consumers must release capacity exactly as
      // they would after a normal child exit, and only once.
      this.closeOnce(
        null,
        null,
        this.withUnexpectedExitDiagnostics(
          `RPC subprocess error: ${error.message}`,
        ),
      );
    });
    child.on("exit", (code, signal) => {
      if (this.closeEmitted) return;

      // The process is no longer usable even while its final stderr is still
      // draining. Latch that fact synchronously and disarm request deadlines so
      // they cannot obscure the known exit status during the grace period.
      this.markClosed(code, signal);

      const summary = `RPC subprocess exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      if (this.closeRequested || this.pending.size === 0) {
        this.closeOnce(code, signal, summary);
        return;
      }

      // A descendant can inherit the child's pipes and postpone "close"
      // indefinitely. Give direct-child stderr a short opportunity to drain,
      // but reject pending requests from the known exit instead of waiting for
      // inherited descriptors or the request timeout.
      const finalize = (): void => {
        this.closeOnce(
          code,
          signal,
          this.withUnexpectedExitDiagnostics(summary),
        );
      };
      if (child.stderr?.readableEnded) {
        finalize();
        return;
      }
      child.stderr?.once("end", finalize);
      this.exitFinalizationTimer = setTimeout(finalize, EXIT_STDERR_GRACE_MS);
    });
    // Usually "close" wins and includes all final stderr. The exit fallback
    // above only wins when inherited stdio keeps this event from arriving.
    child.on("close", (code, signal) => {
      const summary = `RPC subprocess exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.closeOnce(
        code,
        signal,
        this.closeRequested
          ? summary
          : this.withUnexpectedExitDiagnostics(summary),
      );
    });
  }

  typedOn<K extends keyof JsonlRpcClientEvents>(
    event: K,
    listener: (...args: JsonlRpcClientEvents[K]) => void,
  ): () => void {
    this.on(event, listener as (...args: unknown[]) => void);
    return () => this.off(event, listener as (...args: unknown[]) => void);
  }

  request<T extends JsonValue = JsonValue>(
    command: string,
    params?: JsonObject,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    if (
      this.transportFatalError ||
      this.closed ||
      this.child.killed ||
      !this.child.stdin ||
      this.child.stdin.destroyed
    ) {
      return Promise.reject(this.notWritableError());
    }

    const id = randomUUID();
    const record =
      this.commandProtocol === "type-field"
        ? { id, type: command, ...(params ?? {}) }
        : { id, type: "command", command, params: params ?? {} };
    const payload = JSON.stringify(record) + "\n";

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new JsonlRpcDeliveryError(
            `RPC command timed out before response: ${command}`,
            "unknown",
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        id,
        command,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        possibleDispatch: true,
      });

      try {
        this.child.stdin!.write(payload, "utf8", (error?: Error | null) => {
          if (!error) {
            return;
          }
          this.handleStdinFailure(
            error,
            `Failed to write RPC command ${command}`,
          );
        });
      } catch (error) {
        this.handleStdinFailure(
          error instanceof Error ? error : new Error(String(error)),
          `Failed to write RPC command ${command}`,
        );
      }
    });
  }

  /**
   * Write a protocol notification that deliberately has no RPC response.
   * Extension UI responses use this path: Pi resumes the blocked extension but
   * does not emit a normal command response.
   */
  send(
    record: JsonObject,
    timeoutMs = this.notificationTimeoutMs,
  ): Promise<void> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    if (
      this.transportFatalError ||
      this.closed ||
      this.child.killed ||
      !this.child.stdin ||
      this.child.stdin.destroyed
    ) {
      return Promise.reject(this.notWritableError());
    }

    const payload = JSON.stringify(record) + "\n";
    return new Promise<void>((resolve, reject) => {
      const token = Symbol("rpc-notification-write");
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingNotificationWrites.delete(token);
        callback();
      };
      const rejectOnce = (error: Error): void => settle(() => reject(error));
      this.pendingNotificationWrites.set(token, { reject: rejectOnce });

      // A write callback means Node drained its queued bytes, not that Pi
      // handled this response. If it never fires, the bytes may still be in
      // the pipe and arrive later, so callers must treat timeout as unknown
      // delivery rather than safely retrying the notification.
      const timer = setTimeout(() => {
        rejectOnce(new JsonlRpcNotificationTimeoutError(timeoutMs));
      }, timeoutMs);

      try {
        this.child.stdin!.write(payload, "utf8", (error?: Error | null) => {
          if (error) {
            this.handleStdinFailure(error, "Failed to write RPC notification");
            return;
          }
          settle(resolve);
        });
      } catch (error) {
        this.handleStdinFailure(
          error instanceof Error ? error : new Error(String(error)),
          "Failed to write RPC notification",
        );
      }
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  getExitStatus(): { code: number | null; signal: NodeJS.Signals | null } {
    return { code: this.exitCode, signal: this.signal };
  }

  close(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.closed) {
      return;
    }
    this.closeRequested = true;
    this.child.kill(signal);
  }

  private notWritableError(): Error {
    if (this.transportFatalError) {
      return new Error(this.transportFatalError.message);
    }
    return new Error("RPC subprocess is not writable");
  }

  private withUnexpectedExitDiagnostics(summary: string): string {
    const safeSummary = boundedHead(
      redactDiagnosticText(summary),
      MAX_EXIT_SUMMARY_CHARS,
    );
    const command = boundedHead(
      redactDiagnosticText(this.commandDiagnostic ?? "<unavailable>"),
      MAX_EXIT_COMMAND_CHARS,
    );
    const stderr = boundedTail(
      redactDiagnosticText(this.stderr.snapshot().trimEnd()),
      MAX_EXIT_STDERR_CHARS,
    );
    const diagnostic = `${safeSummary}; command=${command}; stderr=${stderr || "<empty>"}`;
    return boundedHead(
      redactDiagnosticText(diagnostic),
      MAX_EXIT_DIAGNOSTIC_CHARS,
    );
  }

  private closeOnce(
    code: number | null,
    signal: NodeJS.Signals | null,
    reason: string,
  ): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    if (this.exitFinalizationTimer) {
      clearTimeout(this.exitFinalizationTimer);
      this.exitFinalizationTimer = undefined;
    }
    this.markClosed(code, signal);
    this.rejectAll(new Error(reason));
    this.emit("close", { code, signal });
  }

  private handleStdinFailure(error: Error, context: string): Error {
    if (this.transportFatalError) {
      return this.transportFatalError;
    }

    const diagnostic = `${context}: ${error.message}`;
    const transportError = new Error(diagnostic);
    this.transportFatalError = transportError;
    const diagnosticLine = `${diagnostic}\n`;
    this.stderr.append(diagnosticLine);
    this.emit("diagnostic", diagnosticLine);
    this.rejectAll(transportError);

    if (!this.closed && !this.closeEmitted) {
      this.emit("transportError", transportError);
    }
    return transportError;
  }

  private markClosed(code: number | null, signal: NodeJS.Signals | null): void {
    this.closed = true;
    this.exitCode = code;
    this.signal = signal;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
  }

  private handleRecord(record: JsonValue): void {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      this.handleMalformed({
        line: JSON.stringify(record),
        message: "JSONL record must be an object",
      });
      return;
    }

    const objectRecord = record as JsonObject;
    if (objectRecord.type === "response") {
      this.handleResponse(objectRecord as unknown as RpcResponseRecord);
      return;
    }

    this.emit("event", objectRecord as RpcEventRecord);
  }

  private handleResponse(response: RpcResponseRecord): void {
    if (response.id === undefined) {
      this.emit("diagnostic", "Received RPC response without an id\n");
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.emit(
        "diagnostic",
        `Received response for unknown RPC id: ${response.id}\n`,
      );
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    const responseObject = response as unknown as JsonObject;
    if (responseObject.success === false || response.error) {
      const payload = response.error ?? "RPC command failed";
      pending.reject(new JsonlRpcError(payload, payload));
      return;
    }

    pending.resolve((responseObject.data ?? null) as JsonValue);
  }

  private handleMalformed(error: JsonlParseError): void {
    const diagnostic = `Malformed JSONL from RPC subprocess: ${error.message}\n`;
    this.stderr.append(diagnostic);
    this.emit("diagnostic", diagnostic);
    this.emit("event", {
      type: "rpc_parse_error",
      message: error.message,
    });

    if (!this.malformedOutputIsFatal || this.fatalError) {
      return;
    }

    this.fatalError = new Error(
      `Malformed JSONL from RPC subprocess: ${error.message}`,
    );
    this.markClosed(null, null);
    this.rejectAll(this.fatalError);
    this.emit("fatal", {
      reason: "malformed_output",
      error: this.fatalError,
    });
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        pending.possibleDispatch
          ? new JsonlRpcDeliveryError(error.message, "unknown")
          : error,
      );
    }
    this.pending.clear();
    for (const pending of this.pendingNotificationWrites.values()) {
      pending.reject(error);
    }
    this.pendingNotificationWrites.clear();
  }
}

export function spawnJsonlRpcClient(
  command: string,
  args: string[],
  spawnOptions: SpawnOptionsWithoutStdio,
  clientOptions?: JsonlRpcClientOptions,
): JsonlRpcClient {
  const child = spawn(command, args, {
    ...spawnOptions,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new JsonlRpcClient(
    child,
    clientOptions,
    formatChildCommand(command, args),
  );
}
