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

export interface JsonlFramingParserOptions {
  onRecord: (record: JsonValue) => void;
  onMalformed: (error: JsonlParseError) => void;
  /**
   * Maximum UTF-8 byte length of one record, excluding its LF delimiter and
   * optional CR before that delimiter.
   * This also bounds the retained unterminated-record buffer.
   */
  maxLineBytes?: number;
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
  private buffer = "";
  private bufferBytes = 0;
  private discardingOversizedLine = false;

  constructor(private readonly options: JsonlFramingParserOptions) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes <= 0) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
  }

  push(chunk: Buffer | string): void {
    this.append(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
    this.drainCompleteLines();
  }

  end(): void {
    this.append(this.decoder.end());
    this.drainCompleteLines();
    if (this.discardingOversizedLine) {
      return;
    }
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      this.bufferBytes = 0;
      this.options.onMalformed({
        line,
        message: "Incomplete JSONL record at EOF",
      });
    }
  }

  private append(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.buffer += text;
    this.bufferBytes += Buffer.byteLength(text, "utf8");
  }

  private drainCompleteLines(): void {
    let cursor = 0;
    let lineStart = 0;
    while (cursor < this.buffer.length) {
      if (this.buffer.charCodeAt(cursor) !== 0x0a) {
        cursor += 1;
        continue;
      }

      const rawLine = this.buffer.slice(lineStart, cursor);
      const rawLineBytes = Buffer.byteLength(rawLine, "utf8");
      this.bufferBytes -= rawLineBytes + 1; // Include the LF delimiter.
      cursor += 1;
      lineStart = cursor;

      if (this.discardingOversizedLine) {
        this.discardingOversizedLine = false;
        continue;
      }

      const hasCarriageReturn = rawLine.endsWith("\r");
      const line = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
      const lineBytes = hasCarriageReturn ? rawLineBytes - 1 : rawLineBytes;
      if (lineBytes > this.maxLineBytes) {
        this.reportOversizedLine();
        continue;
      }
      this.parseLine(line);
    }

    // Do not repeatedly slice the whole remaining buffer for every record.
    this.buffer = this.buffer.slice(lineStart);
    if (this.discardingOversizedLine) {
      this.buffer = "";
      this.bufferBytes = 0;
      return;
    }
    if (this.bufferBytes > this.maxLineBytes) {
      this.buffer = "";
      this.bufferBytes = 0;
      this.discardingOversizedLine = true;
      this.reportOversizedLine();
    }
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
}

export interface JsonlRpcClientEvents {
  event: [RpcEventRecord];
  diagnostic: [string];
  close: [{ code: number | null; signal: NodeJS.Signals | null }];
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
  private readonly malformedOutputIsFatal: boolean;
  private readonly commandProtocol: JsonlRpcCommandProtocol;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly parser: JsonlFramingParser;
  private closed = false;
  private exitCode: number | null = null;
  private signal: NodeJS.Signals | null = null;

  constructor(
    readonly child: ChildProcess,
    options: JsonlRpcClientOptions = {},
  ) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
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
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderr.append(text);
      this.emit("diagnostic", text);
    });
    child.on("error", (error) => {
      this.rejectAll(new Error(`RPC subprocess error: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      this.exitCode = code;
      this.signal = signal;
      this.rejectAll(
        new Error(
          `RPC subprocess exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
      this.emit("close", { code, signal });
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
    if (
      this.closed ||
      this.child.killed ||
      !this.child.stdin ||
      this.child.stdin.destroyed
    ) {
      return Promise.reject(new Error("RPC subprocess is not writable"));
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
        reject(new Error(`RPC command timed out before response: ${command}`));
      }, timeoutMs);

      this.pending.set(id, {
        id,
        command,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.child.stdin!.write(payload, "utf8", (error?: Error | null) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(
            new Error(
              `Failed to write RPC command ${command}: ${error.message}`,
            ),
          );
        }
      });
    });
  }

  /**
   * Write a protocol notification that deliberately has no RPC response.
   * Extension UI responses use this path: Pi resumes the blocked extension but
   * does not emit a normal command response.
   */
  send(record: JsonObject): Promise<void> {
    if (
      this.closed ||
      this.child.killed ||
      !this.child.stdin ||
      this.child.stdin.destroyed
    ) {
      return Promise.reject(new Error("RPC subprocess is not writable"));
    }

    const payload = JSON.stringify(record) + "\n";
    return new Promise<void>((resolve, reject) => {
      this.child.stdin!.write(payload, "utf8", (error?: Error | null) => {
        if (error) {
          reject(
            new Error(`Failed to write RPC notification: ${error.message}`),
          );
          return;
        }
        resolve();
      });
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
    this.child.kill(signal);
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

    if (this.malformedOutputIsFatal) {
      this.rejectAll(
        new Error(`Malformed JSONL from RPC subprocess: ${error.message}`),
      );
      if (!this.child.killed) {
        this.child.kill("SIGTERM");
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
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
  return new JsonlRpcClient(child, clientOptions);
}
