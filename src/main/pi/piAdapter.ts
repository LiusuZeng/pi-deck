import { EventEmitter } from "node:events";
import { PiWorker } from "./piWorker.js";
import type {
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
 * Minimal single-process adapter for M2.
 *
 * The public methods already use runtime ids so this can grow into a multi-worker
 * adapter in M5 without exposing JSONL/protocol details to renderer-facing code.
 */
export class SinglePiAdapter implements PiAdapter {
  private readonly events = new EventEmitter();
  private readonly workers = new Map<RuntimeSessionId, PiWorker>();

  createWorker(options: PiWorkerSpawnOptions): PiWorker {
    if (this.workers.size >= 1) {
      throw new Error("SinglePiAdapter supports only one worker in M2");
    }
    const worker = new PiWorker(options);
    this.workers.set(worker.runtimeId, worker);
    worker.onEvent((event) => this.events.emit("event", event));
    return worker;
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

  getMessages(runtimeId: RuntimeSessionId): Promise<PiMessage[]> {
    return this.getWorker(runtimeId).getMessages();
  }

  prompt(runtimeId: RuntimeSessionId, input: PromptInput): Promise<void> {
    return this.getWorker(runtimeId).prompt(input);
  }

  abort(runtimeId: RuntimeSessionId): Promise<void> {
    return this.getWorker(runtimeId).abort();
  }

  async closeSession(runtimeId: RuntimeSessionId): Promise<void> {
    const worker = this.getWorker(runtimeId);
    await worker.closeSession();
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
