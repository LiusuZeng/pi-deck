import { EventEmitter } from "node:events";
import { spawnJsonlRpcClient, type JsonlRpcClient } from "./jsonlClient.js";
import type {
  JsonObject,
  JsonValue,
  PiMessage,
  PiState,
  PiWorkerSpawnOptions,
  PromptInput,
  RuntimeDiagnosticEvent,
  RuntimeEvent,
  RuntimeSessionId,
  Unsubscribe,
  WorkerDiagnostics,
} from "./types.js";

function generateRuntimeId(): RuntimeSessionId {
  return `runtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function toJsonObject(input: PromptInput): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] = value as JsonValue;
  }
  if (Array.isArray(input.images)) {
    result.images = input.images.map(
      (image): JsonObject => ({
        type: "image",
        mimeType: image.mimeType,
        data: image.dataBase64,
      }),
    );
  }
  // Pi RPC uses `message`; older fake/test fixtures use `text`. Send both at
  // this adapter boundary so the renderer can keep one `text` contract while
  // real `pi --mode rpc` receives the documented field.
  if (typeof input.text === "string" && result.message === undefined) {
    result.message = input.text;
  }
  return result;
}

export type PiWorkerHealth = "starting" | "healthy" | "unhealthy" | "closed";

export class PiWorker {
  readonly runtimeId: RuntimeSessionId;
  readonly client: JsonlRpcClient;
  readonly pid: number | undefined;
  private readonly events = new EventEmitter();
  private readonly recentDiagnostics: RuntimeDiagnosticEvent[] = [];
  private readonly killGraceMs: number;
  private health: PiWorkerHealth = "starting";
  private exitCode: number | null | undefined;
  private signal: NodeJS.Signals | null | undefined;
  private isClosingIntentionally = false;

  constructor(readonly options: PiWorkerSpawnOptions) {
    this.runtimeId = options.runtimeId ?? generateRuntimeId();
    this.killGraceMs = options.killGraceMs ?? 2_000;
    const args = options.args ?? ["--mode", "rpc"];
    const clientOptions: {
      requestTimeoutMs?: number;
      stderrBufferBytes?: number;
      commandProtocol?: "command-field" | "type-field";
    } = {};
    if (options.requestTimeoutMs !== undefined) {
      clientOptions.requestTimeoutMs = options.requestTimeoutMs;
    }
    if (options.stderrBufferBytes !== undefined) {
      clientOptions.stderrBufferBytes = options.stderrBufferBytes;
    }
    if (options.commandProtocol !== undefined) {
      clientOptions.commandProtocol = options.commandProtocol;
    }

    this.client = spawnJsonlRpcClient(
      options.command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
      },
      clientOptions,
    );
    this.pid = this.client.child.pid;
    this.health = "healthy";

    this.client.typedOn("event", (event) => {
      this.emitEvent({
        ...(event as JsonObject),
        runtimeId: this.runtimeId,
      } as RuntimeEvent);
    });
    this.client.typedOn("diagnostic", (message) => {
      this.addDiagnostic("warn", message.trimEnd() || "RPC diagnostic");
    });
    this.client.typedOn("close", ({ code, signal }) => {
      this.exitCode = code;
      this.signal = signal;

      if (this.isClosingIntentionally) {
        this.health = "closed";
        this.addDiagnostic(
          "info",
          `RPC worker closed (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
      } else {
        this.health = code === 0 ? "closed" : "unhealthy";
        const level = code === 0 ? "info" : "error";
        this.addDiagnostic(
          level,
          `RPC worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
      }

      this.emitEvent({
        type: "worker_exit",
        runtimeId: this.runtimeId,
        code,
        signal,
      } as RuntimeEvent);
    });
  }

  async getState(): Promise<PiState> {
    const state = (await this.client.request("get_state")) as PiState;
    return { ...state, runtimeId: this.runtimeId };
  }

  async getMessages(): Promise<PiMessage[]> {
    const response = await this.client.request("get_messages");
    const messages = Array.isArray(response)
      ? response
      : response &&
          typeof response === "object" &&
          !Array.isArray(response) &&
          Array.isArray(response.messages)
        ? response.messages
        : undefined;
    if (!messages) {
      throw new Error("RPC get_messages returned a non-array result");
    }
    return messages as PiMessage[];
  }

  async prompt(input: PromptInput): Promise<void> {
    await this.client.request("prompt", toJsonObject(input));
  }

  async abort(): Promise<void> {
    await this.client.request("abort");
  }

  async request(command: string, params?: JsonObject): Promise<unknown> {
    return this.client.request(command, params);
  }

  async closeSession(): Promise<void> {
    if (this.health === "closed") {
      return;
    }
    this.health = "closed";
    this.isClosingIntentionally = true;

    const child = this.client.child;
    if (child.exitCode !== null || child.signalCode !== null || child.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      const timer = setTimeout(() => {
        if (
          child.exitCode === null &&
          child.signalCode === null &&
          !child.killed
        ) {
          child.kill("SIGKILL");
        }
        resolve();
      }, this.killGraceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      child.kill("SIGTERM");
    });
  }

  onEvent(listener: (event: RuntimeEvent) => void): Unsubscribe {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  getDiagnostics(): WorkerDiagnostics {
    const diagnostics: WorkerDiagnostics = {
      runtimeId: this.runtimeId,
      healthy: this.health === "healthy" || this.health === "starting",
      stderr: this.client.stderr.snapshot(),
      recentDiagnostics: [...this.recentDiagnostics],
    };
    if (this.pid !== undefined) {
      diagnostics.pid = this.pid;
    }
    if (this.exitCode !== undefined) {
      diagnostics.exitCode = this.exitCode;
    }
    if (this.signal !== undefined) {
      diagnostics.signal = this.signal;
    }
    return diagnostics;
  }

  private emitEvent(event: RuntimeEvent): void {
    this.events.emit("event", event);
  }

  private addDiagnostic(
    level: RuntimeDiagnosticEvent["level"],
    message: string,
  ): void {
    const diagnostic: RuntimeDiagnosticEvent = {
      type: "diagnostic",
      runtimeId: this.runtimeId,
      level,
      message,
      timestamp: Date.now(),
    };
    this.recentDiagnostics.push(diagnostic);
    if (this.recentDiagnostics.length > 100) {
      this.recentDiagnostics.shift();
    }
    this.emitEvent(diagnostic);
  }
}
