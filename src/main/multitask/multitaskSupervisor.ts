import { MultitaskManager } from "./multitaskManager.js";
import type {
  ChildTaskHandoff,
  ChildTaskSnapshot,
  MultitaskManagerOptions,
  MultitaskState,
} from "./types.js";

/** The only task state the parent/renderer needs to know about. */
export interface SupervisedTaskSnapshot {
  number: number;
  name: string;
  status: ChildTaskSnapshot["status"];
}

/** A deliberately bounded launch payload. It is never persisted or exposed. */
export interface ChildTaskBrief {
  text: string;
}

export interface NewSupervisedTask {
  number: number;
  name: string;
  brief: ChildTaskBrief;
}

export type ParentTaskNotification<ParentId> =
  | {
      type: "task-status";
      parentId: ParentId;
      task: SupervisedTaskSnapshot;
    }
  | {
      type: "task-handoff";
      parentId: ParentId;
      task: SupervisedTaskSnapshot;
      handoff: ChildTaskHandoff;
    };

/**
 * This is intentionally a tiny private runtime surface. A PiWorker adapter can
 * implement it with closeSession() and a bridge-specific input delivery call.
 * Neither the handle nor this interface is returned by the supervisor.
 */
export interface SupervisedChildWorker<Input> {
  close(): Promise<void> | void;
  provideInput?(input: Input): Promise<void> | void;
}

export interface ChildWorkerCallbacks {
  completed(handoff?: ChildTaskHandoff): void;
  failed(handoff?: ChildTaskHandoff): void;
  inputNeeded(): void;
}

export interface ChildWorkerLaunch<ParentId> {
  parentId: ParentId;
  task: { number: number; name: string; brief: ChildTaskBrief };
  callbacks: ChildWorkerCallbacks;
}

export interface MultitaskSupervisorOptions<
  ParentId,
  Input,
  Worker extends SupervisedChildWorker<Input>,
> {
  /** True only when creating another child will fit the application's capacity. */
  hasCapacity(): boolean;
  createWorker(launch: ChildWorkerLaunch<ParentId>): Promise<Worker> | Worker;
  onParentNotification(notification: ParentTaskNotification<ParentId>): void;
  /** Maximum UTF-16 code units accepted in a child brief. Defaults to 16,000. */
  maxBriefLength?: number;
}

type ParentRecord<
  ParentId,
  Input,
  Worker extends SupervisedChildWorker<Input>,
> = {
  manager: MultitaskManager<ChildTaskBrief, Input>;
  workers: Map<number, Worker>;
  drain?: Promise<void>;
  parentId: ParentId;
  maxQueuedTasks: number;
  removed?: boolean;
};

/**
 * Main-process-only coordinator for child agents belonging to any number of
 * parent sessions. Runtime handles exist solely in `workers`; all public reads
 * are projected to number/name/status snapshots.
 */
export class MultitaskSupervisor<
  ParentId,
  Input,
  Worker extends SupervisedChildWorker<Input>,
> {
  private readonly parents = new Map<
    ParentId,
    ParentRecord<ParentId, Input, Worker>
  >();
  private readonly maxBriefLength: number;

  constructor(
    private readonly options: MultitaskSupervisorOptions<
      ParentId,
      Input,
      Worker
    >,
  ) {
    this.maxBriefLength = options.maxBriefLength ?? 16_000;
    if (!Number.isSafeInteger(this.maxBriefLength) || this.maxBriefLength < 1) {
      throw new Error("maxBriefLength must be a positive safe integer.");
    }
  }

  addParent(parentId: ParentId, options: MultitaskManagerOptions): void {
    if (this.parents.has(parentId))
      throw new Error("Parent is already registered.");
    this.parents.set(parentId, {
      parentId,
      manager: new MultitaskManager<ChildTaskBrief, Input>(options),
      workers: new Map(),
      maxQueuedTasks: options.maxQueuedTasks,
    });
  }

  /** Close all private children and retire this parent permanently. */
  async removeParent(parentId: ParentId): Promise<void> {
    const parent = this.parents.get(parentId);
    if (!parent) return;
    parent.removed = true;
    this.parents.delete(parentId);
    await parent.drain?.catch(() => undefined);
    await Promise.all([...parent.workers.values()].map(closeQuietly));
    parent.workers.clear();
    for (const id of this.parents.keys()) void this.schedule(id);
  }

  /** Queue a bounded brief. Starting is scheduled asynchronously. */
  enqueue(parentId: ParentId, task: NewSupervisedTask): SupervisedTaskSnapshot {
    this.validateBrief(task.brief);
    const parent = this.parent(parentId);
    const snapshot = parent.manager.enqueue({
      number: task.number,
      name: task.name,
      request: { text: task.brief.text },
    });
    this.notifyStatus(parentId, snapshot);
    void this.schedule(parentId);
    return publicSnapshot(snapshot);
  }

  snapshots(parentId: ParentId): SupervisedTaskSnapshot[] {
    return this.parent(parentId).manager.snapshots().map(publicSnapshot);
  }

  mode(parentId: ParentId): MultitaskManagerOptions["mode"] {
    return this.parent(parentId).manager.mode;
  }

  /** Returns the atomic, renderer-safe parent task projection. */
  state(parentId: ParentId): {
    mode: MultitaskManagerOptions["mode"];
    tasks: SupervisedTaskSnapshot[];
  } {
    const parent = this.parent(parentId);
    return {
      mode: parent.manager.mode,
      tasks: parent.manager.snapshots().map(publicSnapshot),
    };
  }

  setMode(parentId: ParentId, mode: MultitaskManagerOptions["mode"]): void {
    const parent = this.parent(parentId);
    parent.manager.setMode(mode);
    // Disabling parallel work is intentionally non-destructive: running
    // children finish, while work that has not started is cancelled.
    if (mode === "sequential") {
      for (const task of parent.manager.snapshots()) {
        if (task.status === "queued") {
          const cancelled = parent.manager.cancel(task.number, {
            summary: "Cancelled because parallel multitasking was disabled.",
          });
          this.notifyStatus(parentId, cancelled);
          if (cancelled.terminalHandoff)
            this.notifyHandoff(parentId, cancelled, cancelled.terminalHandoff);
        }
      }
    }
  }

  /** Persist only manager state: briefs, input, and all worker handles stay private. */
  exportState(parentId: ParentId): MultitaskState {
    return this.parent(parentId).manager.exportState();
  }

  /**
   * Routes input only through the main process to the waiting child selected by
   * task number. Callers never receive a worker or a child runtime identity.
   */
  async provideInput(
    parentId: ParentId,
    number: number,
    input: Input,
  ): Promise<SupervisedTaskSnapshot> {
    const parent = this.parent(parentId);
    const worker = parent.workers.get(number);
    if (!worker?.provideInput) {
      throw new Error(`Child task ${number} is not available for input.`);
    }
    const running = parent.manager.resumeWithInput(number);
    this.notifyStatus(parentId, running);
    try {
      await worker.provideInput(input);
      return publicSnapshot(parent.manager.get(number) ?? running);
    } catch (error) {
      await this.terminal(parent, number, "failed", failureHandoff(error));
      throw error;
    }
  }

  /** Wait until currently queued starts have been attempted for this parent. */
  schedule(parentId: ParentId): Promise<void> {
    const parent = this.parent(parentId);
    const previous = parent.drain ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.drain(parent));
    parent.drain = next;
    return next;
  }

  /**
   * Closes any live private workers, then rehydrates saved state. Rehydration
   * changes saved live tasks to cancelled interruption handoffs while retaining
   * existing terminal handoffs.
   */
  async resume(parentId: ParentId, state?: MultitaskState): Promise<void> {
    const parent = this.parent(parentId);
    // Do not let an in-flight factory install a new handle after resuming.
    await parent.drain?.catch(() => undefined);
    await Promise.all(
      [...parent.workers.values()].map((worker) => closeQuietly(worker)),
    );
    parent.workers.clear();
    const saved = state ?? parent.manager.exportState();
    parent.manager = MultitaskManager.rehydrate<ChildTaskBrief, Input>(saved, {
      maxQueuedTasks: parent.maxQueuedTasks,
    });
    for (const snapshot of parent.manager.snapshots()) {
      this.notifyStatus(parentId, snapshot);
      if (snapshot.terminalHandoff)
        this.notifyHandoff(parentId, snapshot, snapshot.terminalHandoff);
    }
  }

  private async drain(
    parent: ParentRecord<ParentId, Input, Worker>,
  ): Promise<void> {
    while (!parent.removed && this.options.hasCapacity()) {
      const start = parent.manager.startNext(true);
      if (!start) return;
      try {
        // Factories may report an event synchronously while constructing a
        // worker. Hold it until the private handle has been retained.
        let ready = false;
        const pending: (() => void)[] = [];
        const afterReady = (action: () => void): void => {
          if (ready) action();
          else pending.push(action);
        };
        const worker = await this.options.createWorker({
          parentId: parent.parentId,
          task: {
            number: start.number,
            name: start.name,
            brief: start.request,
          },
          callbacks: {
            completed: (handoff) =>
              afterReady(
                () =>
                  void this.terminal(
                    parent,
                    start.number,
                    "completed",
                    handoff,
                  ),
              ),
            failed: (handoff) =>
              afterReady(
                () =>
                  void this.terminal(parent, start.number, "failed", handoff),
              ),
            inputNeeded: () =>
              afterReady(() => this.waitForInput(parent, start.number)),
          },
        });
        if (parent.removed || this.parents.get(parent.parentId) !== parent) {
          await closeQuietly(worker);
          return;
        }
        parent.workers.set(start.number, worker);
        ready = true;
        pending.splice(0).forEach((action) => action());
        this.notifyStatus(parent.parentId, parent.manager.get(start.number)!);
      } catch (error) {
        const snapshot = parent.manager.fail(
          start.number,
          failureHandoff(error),
        );
        this.notifyStatus(parent.parentId, snapshot);
        if (snapshot.terminalHandoff) {
          this.notifyHandoff(
            parent.parentId,
            snapshot,
            snapshot.terminalHandoff,
          );
        }
      }
    }
  }

  private waitForInput(
    parent: ParentRecord<ParentId, Input, Worker>,
    number: number,
  ): void {
    try {
      const snapshot = parent.manager.markWaitingForInput(number);
      this.notifyStatus(parent.parentId, snapshot);
    } catch {
      // Ignore duplicate/late bridge events from a worker already being closed.
    }
  }

  private async terminal(
    parent: ParentRecord<ParentId, Input, Worker>,
    number: number,
    status: "completed" | "failed",
    handoff?: ChildTaskHandoff,
  ): Promise<void> {
    if (parent.removed) return;
    const worker = parent.workers.get(number);
    if (!worker) return;
    parent.workers.delete(number);
    let snapshot: ChildTaskSnapshot;
    try {
      snapshot =
        status === "completed"
          ? parent.manager.complete(number, handoff)
          : parent.manager.fail(number, handoff);
    } catch {
      return;
    } finally {
      await closeQuietly(worker);
    }
    this.notifyStatus(parent.parentId, snapshot);
    if (snapshot.terminalHandoff)
      this.notifyHandoff(parent.parentId, snapshot, snapshot.terminalHandoff);
    // Capacity is shared by every parent, so a child finishing for one parent
    // must wake queues belonging to all other parents too.
    for (const parentId of this.parents.keys()) void this.schedule(parentId);
  }

  private parent(parentId: ParentId): ParentRecord<ParentId, Input, Worker> {
    const parent = this.parents.get(parentId);
    if (!parent) throw new Error("Parent is not registered.");
    return parent;
  }

  private validateBrief(brief: ChildTaskBrief): void {
    if (!brief || typeof brief.text !== "string" || !brief.text.trim()) {
      throw new Error("Child task brief must contain text.");
    }
    if (brief.text.length > this.maxBriefLength) {
      throw new Error(
        `Child task brief exceeds ${this.maxBriefLength} characters.`,
      );
    }
  }

  private notifyStatus(parentId: ParentId, task: ChildTaskSnapshot): void {
    this.options.onParentNotification({
      type: "task-status",
      parentId,
      task: publicSnapshot(task),
    });
  }

  private notifyHandoff(
    parentId: ParentId,
    task: ChildTaskSnapshot,
    handoff: ChildTaskHandoff,
  ): void {
    this.options.onParentNotification({
      type: "task-handoff",
      parentId,
      task: publicSnapshot(task),
      handoff: { ...handoff },
    });
  }
}

function publicSnapshot(task: ChildTaskSnapshot): SupervisedTaskSnapshot {
  return { number: task.number, name: task.name, status: task.status };
}

function failureHandoff(error: unknown): ChildTaskHandoff {
  return {
    summary:
      error instanceof Error ? error.message : "Child worker failed to start.",
  };
}

async function closeQuietly(worker: {
  close(): Promise<void> | void;
}): Promise<void> {
  try {
    await worker.close();
  } catch {
    // Terminal status is more important than a best-effort process cleanup error.
  }
}
