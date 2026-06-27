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

export interface JsonlFramingParserOptions {
  onRecord: (record: JsonValue) => void;
  onMalformed: (error: JsonlParseError) => void;
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
  private buffer = "";

  constructor(private readonly options: JsonlFramingParserOptions) {}

  push(chunk: Buffer | string): void {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drainCompleteLines();
  }

  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      this.options.onMalformed({
        line,
        message: "Incomplete JSONL record at EOF",
      });
    }
  }

  private drainCompleteLines(): void {
    let lfIndex = this.buffer.indexOf("\n");
    while (lfIndex !== -1) {
      let line = this.buffer.slice(0, lfIndex);
      this.buffer = this.buffer.slice(lfIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.parseLine(line);
      lfIndex = this.buffer.indexOf("\n");
    }
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
    this.commandProtocol = options.commandProtocol ?? "command-field";
    this.stderr = new DiagnosticRingBuffer(
      options.stderrBufferBytes ?? 64 * 1024,
    );
    this.parser = new JsonlFramingParser({
      onRecord: (record) => this.handleRecord(record),
      onMalformed: (error) => this.handleMalformed(error),
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
    if (
      response.ok === false ||
      responseObject.success === false ||
      response.error
    ) {
      const payload = response.error;
      const message =
        typeof payload === "object" && payload !== null
          ? payload.message
          : String(payload ?? "RPC command failed");
      pending.reject(new JsonlRpcError(message, payload));
      return;
    }

    pending.resolve(
      (response.result ?? responseObject.data ?? null) as JsonValue,
    );
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
