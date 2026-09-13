import { EventEmitter } from "node:events";
import { spawnJsonlRpcClient, type JsonlRpcClient } from "./jsonlClient.js";
import type {
  ExtensionUiResponse,
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
  const { text, images, ...extra } = input;
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(extra)) {
    result[key] = value as JsonValue;
  }
  if (Array.isArray(images)) {
    result.images = images.map(
      (image): JsonObject => ({
        type: "image",
        mimeType: image.mimeType,
        data: image.dataBase64,
      }),
    );
  }
  // Pi's RPC protocol accepts `message`, not the renderer's internal `text`.
  result.message = text;
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
  /** Resolves exactly when the child is terminal (or spawn itself failed). */
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(readonly options: PiWorkerSpawnOptions) {
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
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
    // Keep shutdown confirmation coupled to ChildProcess itself as well as the
    // JSONL transport event. A stream teardown must not strand ownership after
    // the OS has already confirmed the child exited.
    this.client.child.once("exit", () => this.resolveExit());

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

      // A SIGTERM may be reported by a launcher as exit code 143 instead of a
      // signal. Preserve our lifecycle intent so consumers do not mistake the
      // deliberate close for an RPC/backend crash.
      this.emitEvent({
        type: "worker_exit",
        runtimeId: this.runtimeId,
        code,
        signal,
        intentional: this.isClosingIntentionally,
      } as RuntimeEvent);
      this.resolveExit();
    });
  }

  async getState(): Promise<PiState> {
    const state = (await this.client.request("get_state")) as PiState;
    return { ...state, runtimeId: this.runtimeId };
  }

  /**
   * Lifecycle/metadata path intentionally shares only Pi's get_state RPC.
   * Keep this separate from getMessages so callers cannot accidentally turn a
   * status poll into a transcript transfer.
   */
  getRuntimeStatus(): Promise<PiState> {
    return this.getState();
  }

  getSessionStats(): Promise<unknown> {
    return this.client.request("get_session_stats");
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

  async steer(input: PromptInput): Promise<void> {
    await this.client.request("steer", toJsonObject(input));
  }

  async followUp(input: PromptInput): Promise<void> {
    await this.client.request("follow_up", toJsonObject(input));
  }

  async abort(): Promise<void> {
    await this.client.request("abort");
  }

  /** Send Pi's response-only extension UI record; no command response exists. */
  async respondToExtensionUi(response: ExtensionUiResponse): Promise<void> {
    await this.client.send({
      type: "extension_ui_response",
      ...response,
    });
  }

  async request(command: string, params?: JsonObject): Promise<unknown> {
    return this.client.request(command, params);
  }

  /**
   * Request shutdown, escalate after a bounded SIGTERM grace period, and wait
   * for terminal child confirmation. Callers must keep every runtime/session
   * ownership claim until this resolves: `ChildProcess.killed` only says that
   * a signal was sent, not that Pi has stopped writing its JSONL.
   */
  async closeAndWait(): Promise<void> {
    const child = this.client.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      await this.waitForChildExit();
      return;
    }

    // Mark intent before signalling so an immediate exit remains a clean
    // shutdown. Do not use `child.killed` as a lifecycle predicate: it flips
    // after SIGTERM even when the child ignores that signal.
    this.isClosingIntentionally = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // The process can race us to exit; the terminal promise below is the
      // authoritative outcome in either case.
    }

    const escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Keep waiting. A failed kill is not proof that the process exited.
        }
      }
    }, this.killGraceMs);
    try {
      await this.waitForChildExit();
    } finally {
      clearTimeout(escalation);
    }
  }

  /** Backward-compatible lifecycle entry point. */
  closeSession(): Promise<void> {
    return this.closeAndWait();
  }

  private waitForChildExit(): Promise<void> {
    const child = this.client.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
      timer.unref();
      void this.exitPromise.then(() => {
        clearInterval(timer);
        resolve();
      });
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
