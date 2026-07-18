import { EventEmitter } from "node:events";
import { PiWorker } from "./piWorker.js";
import type {
  ExtensionUiResponse,
  JsonObject,
  PiAdapter,
  PiMessage,
  PiState,
  PiWorkerSpawnOptions,
  PromptInput,
  RuntimeEvent,
  RuntimeSessionId,
  Unsubscribe,
  WorkerDiagnostics,
} from "./types.js";

/**
 * Runtime-id keyed adapter for Pi workers.
 *
 * The class name is retained for now to avoid a broad rename, but it can host
 * multiple workers so real-mode new sessions can coexist while M5 scheduler work
 * remains separate.
 */
export class SinglePiAdapter implements PiAdapter {
  private readonly events = new EventEmitter();
  private readonly workers = new Map<RuntimeSessionId, PiWorker>();

  createWorker(options: PiWorkerSpawnOptions): PiWorker {
    const worker = new PiWorker(options);
    this.workers.set(worker.runtimeId, worker);
    worker.onEvent((event) => {
      this.events.emit("event", event);
      if (
        event.type === "worker_exit" &&
        this.workers.get(worker.runtimeId) === worker
      ) {
        this.workers.delete(worker.runtimeId);
      }
    });
    return worker;
  }

  workerCount(): number {
    return this.workers.size;
  }

  hasRuntime(runtimeId: RuntimeSessionId): boolean {
    return this.workers.has(runtimeId);
  }

  getWorker(runtimeId: RuntimeSessionId): PiWorker {
    const worker = this.workers.get(runtimeId);
    if (!worker) {
      throw new Error(`Unknown Pi runtime: ${runtimeId}`);
    }
    return worker;
  }

  getState(runtimeId: RuntimeSessionId): Promise<PiState> {
    return this.getWorker(runtimeId).getState();
  }

  getRuntimeStatus(runtimeId: RuntimeSessionId): Promise<PiState> {
    return this.getWorker(runtimeId).getRuntimeStatus();
  }

  getMessages(runtimeId: RuntimeSessionId): Promise<PiMessage[]> {
    return this.getWorker(runtimeId).getMessages();
  }

  prompt(runtimeId: RuntimeSessionId, input: PromptInput): Promise<void> {
    return this.getWorker(runtimeId).prompt(input);
  }

  steer(runtimeId: RuntimeSessionId, input: PromptInput): Promise<void> {
    return this.getWorker(runtimeId).steer(input);
  }

  followUp(runtimeId: RuntimeSessionId, input: PromptInput): Promise<void> {
    return this.getWorker(runtimeId).followUp(input);
  }

  abort(runtimeId: RuntimeSessionId): Promise<void> {
    return this.getWorker(runtimeId).abort();
  }

  respondToExtensionUi(
    runtimeId: RuntimeSessionId,
    response: ExtensionUiResponse,
  ): Promise<void> {
    return this.getWorker(runtimeId).respondToExtensionUi(response);
  }

  request(
    runtimeId: RuntimeSessionId,
    command: string,
    params?: JsonObject,
  ): Promise<unknown> {
    return this.getWorker(runtimeId).request(command, params);
  }

  async closeSession(runtimeId: RuntimeSessionId): Promise<void> {
    const worker = this.getWorker(runtimeId);
    await worker.closeSession();
    this.workers.delete(runtimeId);
  }

  /** Remove a worker that has already emitted its process-exit event. */
  forgetExitedWorker(runtimeId: RuntimeSessionId): void {
    this.workers.delete(runtimeId);
  }

  onEvent(listener: (event: RuntimeEvent) => void): Unsubscribe {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  diagnostics(runtimeId: RuntimeSessionId): WorkerDiagnostics {
    return this.getWorker(runtimeId).getDiagnostics();
  }
}
