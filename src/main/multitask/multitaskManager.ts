import type {
  ChildTaskHandoff,
  ChildTaskSnapshot,
  ChildTaskStart,
  ChildTaskStatus,
  InternalChildTask,
  MultitaskManagerOptions,
  MultitaskState,
  NewChildTask,
  TerminalChildTaskStatus,
} from "./types.js";

const LIVE_STATUSES = new Set<ChildTaskStatus>([
  "queued",
  "running",
  "waiting-input",
]);
const TERMINAL_STATUSES = new Set<ChildTaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export class MultitaskQueueFullError extends Error {
  constructor(readonly maxQueuedTasks: number) {
    super(`The child task queue is full (maximum ${maxQueuedTasks}).`);
    this.name = "MultitaskQueueFullError";
  }
}

export class UnknownChildTaskError extends Error {
  constructor(readonly number: number) {
    super(`No child task exists with number ${number}.`);
    this.name = "UnknownChildTaskError";
  }
}

export class InvalidChildTaskTransitionError extends Error {
  constructor(
    readonly number: number,
    readonly from: ChildTaskStatus,
    readonly to: ChildTaskStatus,
  ) {
    super(`Child task ${number} cannot transition from ${from} to ${to}.`);
    this.name = "InvalidChildTaskTransitionError";
  }
}

/**
 * In-memory scheduling state for exactly one parent session.
 *
 * Runtime allocation is deliberately outside this class: the caller supplies
 * whether a worker slot is available to `startNext`. The class also never
 * accepts or stores child runtime/session identifiers.
 */
export class MultitaskManager<Request = unknown, Input = unknown> {
  private readonly tasks = new Map<number, InternalChildTask<Request, Input>>();
  private highestNumber = 0;

  constructor(private readonly options: MultitaskManagerOptions) {
    validateOptions(options);
  }

  static rehydrate<Request = unknown, Input = unknown>(
    state: MultitaskState,
    options: Pick<MultitaskManagerOptions, "maxQueuedTasks">,
  ): MultitaskManager<Request, Input> {
    validateState(state);
    const manager = new MultitaskManager<Request, Input>({
      mode: state.mode,
      ...options,
    });
    for (const saved of state.tasks) {
      const status = LIVE_STATUSES.has(saved.status)
        ? "cancelled"
        : saved.status;
      const handoff = LIVE_STATUSES.has(saved.status)
        ? {
            summary: "Child task interrupted during session resume.",
            details: "It was not restarted automatically.",
          }
        : copyHandoff(saved.terminalHandoff);
      manager.insertRestored({
        number: saved.number,
        name: saved.name,
        status,
        ...(handoff ? { terminalHandoff: handoff } : {}),
      });
    }
    return manager;
  }

  get mode(): MultitaskManagerOptions["mode"] {
    return this.options.mode;
  }

  setMode(mode: MultitaskManagerOptions["mode"]): void {
    if (mode !== "parallel" && mode !== "sequential")
      throw new Error("Multitask mode must be parallel or sequential.");
    this.options.mode = mode;
  }

  enqueue(task: NewChildTask<Request>): ChildTaskSnapshot {
    validateNewTask(task);
    if (this.queuedCount() >= this.options.maxQueuedTasks) {
      throw new MultitaskQueueFullError(this.options.maxQueuedTasks);
    }
    if (task.number <= this.highestNumber || this.tasks.has(task.number)) {
      throw new Error(
        "Child task numbers must be unique and strictly monotonic.",
      );
    }
    if ([...this.tasks.values()].some((entry) => entry.name === task.name)) {
      throw new Error(`Child task name is already in use: ${task.name}`);
    }
    const stored: InternalChildTask<Request, Input> = {
      number: task.number,
      name: task.name,
      status: "queued",
      request: task.request,
    };
    this.tasks.set(task.number, stored);
    this.highestNumber = task.number;
    return snapshot(stored);
  }

  /** Alias that reads naturally at call sites which create a task. */
  add(task: NewChildTask<Request>): ChildTaskSnapshot {
    return this.enqueue(task);
  }

  /**
   * Claims the oldest queued task when the caller has already established that
   * a worker slot is available. A sequential manager waits for every live
   * predecessor, including one awaiting input.
   */
  startNext(
    slotAvailable: boolean,
  ): ChildTaskStart<Request, Input> | undefined {
    if (
      !slotAvailable ||
      (this.mode === "sequential" && this.hasActiveTask())
    ) {
      return undefined;
    }
    const next = [...this.tasks.values()].find(
      (task) => task.status === "queued",
    );
    if (!next) return undefined;
    next.status = "running";
    // `request` only disappears after rehydration, where no task is startable.
    return {
      number: next.number,
      name: next.name,
      request: next.request as Request,
      ...(next.input !== undefined ? { input: next.input } : {}),
    };
  }

  markWaitingForInput(number: number): ChildTaskSnapshot {
    return this.transition(number, "running", "waiting-input");
  }

  /** Supplies parent-mediated input and requeues the task; it never contacts a child. */
  provideInput(number: number, input: Input): ChildTaskSnapshot {
    const task = this.require(number);
    if (task.status !== "waiting-input") {
      throw new InvalidChildTaskTransitionError(number, task.status, "queued");
    }
    if (this.queuedCount() >= this.options.maxQueuedTasks) {
      throw new MultitaskQueueFullError(this.options.maxQueuedTasks);
    }
    task.input = input;
    task.status = "queued";
    return snapshot(task);
  }

  /**
   * Marks an existing, still-owned child as running after its main-process
   * supervisor has delivered requested input. Unlike `provideInput`, this
   * does not requeue or replace the child runtime.
   */
  resumeWithInput(number: number): ChildTaskSnapshot {
    return this.transition(number, "waiting-input", "running");
  }

  complete(number: number, handoff?: ChildTaskHandoff): ChildTaskSnapshot {
    return this.toTerminal(number, "completed", handoff);
  }

  fail(number: number, handoff?: ChildTaskHandoff): ChildTaskSnapshot {
    return this.toTerminal(number, "failed", handoff);
  }

  cancel(number: number, handoff?: ChildTaskHandoff): ChildTaskSnapshot {
    return this.toTerminal(number, "cancelled", handoff);
  }

  get(number: number): ChildTaskSnapshot | undefined {
    const task = this.tasks.get(number);
    return task ? snapshot(task) : undefined;
  }

  snapshots(): ChildTaskSnapshot[] {
    return [...this.tasks.values()].map(snapshot);
  }

  /** Persistence-safe export: no request, input, or runtime identity is retained. */
  exportState(): MultitaskState {
    return { mode: this.mode, tasks: this.snapshots() };
  }

  private toTerminal(
    number: number,
    target: TerminalChildTaskStatus,
    handoff?: ChildTaskHandoff,
  ): ChildTaskSnapshot {
    const task = this.require(number);
    if (!LIVE_STATUSES.has(task.status)) {
      throw new InvalidChildTaskTransitionError(number, task.status, target);
    }
    task.status = target;
    if (handoff) task.terminalHandoff = { ...handoff };
    else delete task.terminalHandoff;
    delete task.request;
    delete task.input;
    return snapshot(task);
  }

  private transition(
    number: number,
    from: ChildTaskStatus,
    to: ChildTaskStatus,
  ): ChildTaskSnapshot {
    const task = this.require(number);
    if (task.status !== from) {
      throw new InvalidChildTaskTransitionError(number, task.status, to);
    }
    task.status = to;
    return snapshot(task);
  }

  private require(number: number): InternalChildTask<Request, Input> {
    const task = this.tasks.get(number);
    if (!task) throw new UnknownChildTaskError(number);
    return task;
  }

  private queuedCount(): number {
    return [...this.tasks.values()].filter((task) => task.status === "queued")
      .length;
  }

  private hasActiveTask(): boolean {
    return [...this.tasks.values()].some(
      (task) => task.status === "running" || task.status === "waiting-input",
    );
  }

  private insertRestored(task: InternalChildTask<Request, Input>): void {
    if (this.tasks.has(task.number) || task.number <= this.highestNumber) {
      throw new Error(
        "Saved child task numbers must be unique and strictly monotonic.",
      );
    }
    if ([...this.tasks.values()].some((entry) => entry.name === task.name)) {
      throw new Error(`Saved child task name is already in use: ${task.name}`);
    }
    this.tasks.set(task.number, task);
    this.highestNumber = task.number;
  }
}

function snapshot(task: ChildTaskSnapshot): ChildTaskSnapshot {
  const base = { number: task.number, name: task.name, status: task.status };
  return task.terminalHandoff
    ? { ...base, terminalHandoff: { ...task.terminalHandoff } }
    : base;
}

function copyHandoff(
  handoff: ChildTaskHandoff | undefined,
): ChildTaskHandoff | undefined {
  return handoff ? { ...handoff } : undefined;
}

function validateOptions(options: MultitaskManagerOptions): void {
  if (options.mode !== "parallel" && options.mode !== "sequential") {
    throw new Error("Multitask mode must be parallel or sequential.");
  }
  if (
    !Number.isSafeInteger(options.maxQueuedTasks) ||
    options.maxQueuedTasks < 1
  ) {
    throw new Error("maxQueuedTasks must be a positive safe integer.");
  }
}

function validateNewTask(task: NewChildTask<unknown>): void {
  validateTaskIdentity(task);
}

function validateTaskIdentity(
  task: Pick<ChildTaskSnapshot, "number" | "name">,
): void {
  if (!Number.isSafeInteger(task.number) || task.number < 1) {
    throw new Error("Child task number must be a positive safe integer.");
  }
  if (!task.name.trim()) throw new Error("Child task name must not be empty.");
}

function validateState(state: MultitaskState): void {
  if (!state || !Array.isArray(state.tasks))
    throw new Error("Invalid multitask state.");
  if (state.mode !== "parallel" && state.mode !== "sequential") {
    throw new Error("Invalid multitask state mode.");
  }
  for (const task of state.tasks) {
    validateTaskIdentity(task);
    if (
      !LIVE_STATUSES.has(task.status) &&
      !TERMINAL_STATUSES.has(task.status)
    ) {
      throw new Error("Invalid child task status in saved state.");
    }
  }
}
