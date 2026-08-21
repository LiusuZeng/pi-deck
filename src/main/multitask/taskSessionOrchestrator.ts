import type { MultitaskMode } from "./types.js";

/** The renderer-safe shape shared with `multitaskTaskSummarySchema`. */
export type TaskSessionLifecycle =
  | "queued"
  | "starting"
  | "running"
  | "retrying"
  | "waiting-parent"
  | "completed"
  | "failed"
  | "interrupted";

export interface TaskSessionSummary {
  taskNumber: number;
  generatedName: string;
  brief: string;
  lifecycle: TaskSessionLifecycle;
  attempt: number;
  elapsedMs: number;
  progress?: string;
  queueReason?: string;
}

/** A planner must return at least one bounded independent task. */
export interface TaskSessionPlan {
  contextSummary: string;
  tasks: readonly { generatedName: string; brief: string }[];
}

export interface TaskSessionWorkerSettings {
  model?: string;
  thinkingLevel?: string;
  project?: string;
  runtimeConfiguration?: Readonly<Record<string, unknown>>;
}

export interface TaskSessionLaunch<ParentId> {
  parentId: ParentId;
  taskNumber: number;
  attempt: number;
  /** Private launch-only content; never included in snapshots or persistence. */
  request: {
    contextSummary: string;
    originalPrompt: string;
    brief: string;
    workerSettings: TaskSessionWorkerSettings;
  };
  callbacks: {
    completed(handoff?: { summary?: string }): void;
    failed(error?: unknown): void;
    progress(message: string): void;
    waitingForParent(): void;
  };
}

export interface TaskSessionWorker {
  close(): Promise<void> | void;
}

export interface PersistedTaskSessionState {
  version: 1;
  mode: MultitaskMode;
  nextTaskNumber: number;
  plans: readonly PersistedTaskSessionPlan[];
}

export interface PersistedTaskSessionPlan {
  planId: number;
  contextSummary: string;
  originalPrompt: string;
  synthesisReported?: boolean;
  tasks: readonly PersistedTaskSessionTask[];
}

export interface PersistedTaskSessionTask {
  taskNumber: number;
  generatedName: string;
  brief: string;
  lifecycle: TaskSessionLifecycle;
  attempt: number;
  transitions: readonly { lifecycle: TaskSessionLifecycle; attempt: number }[];
  handoffSummary?: string | undefined;
}

export interface TaskSessionOrchestratorOptions<
  ParentId,
  Worker extends TaskSessionWorker,
> {
  plan(
    parentId: ParentId,
    originalPrompt: string,
  ): Promise<TaskSessionPlan> | TaskSessionPlan;
  resolveWorkerSettings(input: {
    parentId: ParentId;
    parentSettings: TaskSessionWorkerSettings;
    promptSettings?: TaskSessionWorkerSettings;
  }): TaskSessionWorkerSettings;
  createWorker(launch: TaskSessionLaunch<ParentId>): Promise<Worker> | Worker;
  hasGlobalCapacity(): boolean;
  /** Preferred atomic capacity claim; main releases it from worker close. */
  claimGlobalCapacity?(): boolean;
  synthesize(input: {
    parentId: ParentId;
    originalPrompt: string;
    contextSummary: string;
    tasks: readonly PersistedTaskSessionTask[];
  }): Promise<void> | void;
  onState(parentId: ParentId, state: TaskSessionState): void;
  now?(): number;
  activeLimit?: number;
  maxPlanTasks?: number;
  maxContextSummaryLength?: number;
}

export interface TaskSessionState {
  mode: MultitaskMode;
  activeCount: number;
  activeLimit: number;
  tasks: readonly TaskSessionSummary[];
}

type Task = PersistedTaskSessionTask & {
  startedAt?: number;
  worker?: TaskSessionWorker;
  progress?: string;
};
type Plan = Omit<PersistedTaskSessionPlan, "tasks"> & {
  tasks: Task[];
  promptSettings?: TaskSessionWorkerSettings;
  synthesizing?: boolean;
  synthesized?: boolean;
};
type Parent<ParentId> = {
  parentId: ParentId;
  mode: MultitaskMode;
  parentSettings: TaskSessionWorkerSettings;
  nextTaskNumber: number;
  nextPlanId: number;
  plans: Plan[];
  removed?: boolean;
  drain?: Promise<void>;
};

/**
 * Parent-scoped deterministic task-session domain. It owns no Electron or Pi
 * runtime details, so main can inject planning, launching, reporting, and
 * persistence at its boundary.
 */
export class TaskSessionOrchestrator<
  ParentId,
  Worker extends TaskSessionWorker,
> {
  private readonly parents = new Map<ParentId, Parent<ParentId>>();
  private readonly activeLimit: number;
  private readonly now: () => number;
  private readonly maxPlanTasks: number;
  private readonly maxContextSummaryLength: number;

  constructor(
    private readonly options: TaskSessionOrchestratorOptions<ParentId, Worker>,
  ) {
    this.activeLimit = options.activeLimit ?? 10;
    if (!Number.isSafeInteger(this.activeLimit) || this.activeLimit < 1)
      throw new Error("activeLimit must be a positive safe integer.");
    this.now = options.now ?? Date.now;
    this.maxPlanTasks = options.maxPlanTasks ?? 100;
    this.maxContextSummaryLength = options.maxContextSummaryLength ?? 16_000;
    if (
      !Number.isSafeInteger(this.maxPlanTasks) ||
      this.maxPlanTasks < 1 ||
      !Number.isSafeInteger(this.maxContextSummaryLength) ||
      this.maxContextSummaryLength < 1
    )
      throw new Error(
        "Task-session plan bounds must be positive safe integers.",
      );
  }

  addParent(
    parentId: ParentId,
    input: { mode: MultitaskMode; workerSettings?: TaskSessionWorkerSettings },
  ): void {
    if (this.parents.has(parentId))
      throw new Error("Parent is already registered.");
    this.parents.set(parentId, {
      parentId,
      mode: input.mode,
      parentSettings: { ...input.workerSettings },
      nextTaskNumber: 1,
      nextPlanId: 1,
      plans: [],
    });
  }

  async submit(
    parentId: ParentId,
    originalPrompt: string,
    promptSettings?: TaskSessionWorkerSettings,
  ): Promise<readonly TaskSessionSummary[]> {
    const parent = this.parent(parentId);
    const plan = await this.options.plan(parentId, originalPrompt);
    validatePlan(plan, this.maxPlanTasks, this.maxContextSummaryLength);
    const record: Plan = {
      planId: parent.nextPlanId++,
      contextSummary: plan.contextSummary,
      originalPrompt,
      tasks: plan.tasks.map((brief) => task(parent.nextTaskNumber++, brief)),
      ...(promptSettings ? { promptSettings } : {}),
    };
    parent.plans.push(record);
    // Resolve before private launch so invalid settings cannot partially start a plan.
    void this.options.resolveWorkerSettings(
      workerSettingsInput(parentId, parent.parentSettings, promptSettings),
    );
    this.publish(parent);
    void this.schedule(parent, promptSettings);
    return this.state(parentId).tasks;
  }

  state(parentId: ParentId): TaskSessionState {
    const parent = this.parent(parentId);
    const activeCount = allTasks(parent).filter(isActive).length;
    return {
      mode: parent.mode,
      activeCount,
      activeLimit: this.activeLimit,
      tasks: allTasks(parent).map((entry) =>
        summary(entry, this.now(), activeCount >= this.activeLimit),
      ),
    };
  }

  setMode(parentId: ParentId, mode: MultitaskMode): void {
    this.parent(parentId).mode = mode;
    this.publish(this.parent(parentId));
  }

  /** Main calls this after any global worker slot is released. */
  scheduleAll(): void {
    for (const parent of this.parents.values()) void this.schedule(parent);
  }

  exportState(parentId: ParentId): PersistedTaskSessionState {
    const parent = this.parent(parentId);
    return {
      version: 1,
      mode: parent.mode,
      nextTaskNumber: parent.nextTaskNumber,
      plans: parent.plans.map((plan) => ({
        planId: plan.planId,
        contextSummary: plan.contextSummary,
        originalPrompt: plan.originalPrompt,
        ...(plan.synthesisReported ? { synthesisReported: true } : {}),
        tasks: plan.tasks.map(persistTask),
      })),
    };
  }

  /** Recovery is terminal-only: unfinished private sessions are never launched. */
  restore(parentId: ParentId, state: PersistedTaskSessionState): void {
    validatePersisted(state);
    const parent = this.parent(parentId);
    parent.mode = state.mode;
    parent.nextTaskNumber = state.nextTaskNumber;
    parent.nextPlanId = Math.max(
      1,
      ...state.plans.map((plan) => plan.planId + 1),
    );
    parent.plans = state.plans.map((plan) => ({
      ...plan,
      ...(plan.synthesisReported ? { synthesized: true } : {}),
      tasks: plan.tasks.map((saved) =>
        !isTerminal(saved)
          ? {
              ...saved,
              lifecycle: "interrupted",
              transitions: [
                ...saved.transitions,
                { lifecycle: "interrupted", attempt: saved.attempt },
              ],
              handoffSummary: "Task session interrupted after restart.",
            }
          : { ...saved },
      ),
    }));
    this.publish(parent);
    void this.synthesizeTerminalPlans(parent);
  }

  async removeParent(parentId: ParentId): Promise<void> {
    const parent = this.parents.get(parentId);
    if (!parent) return;
    parent.removed = true;
    this.parents.delete(parentId);
    await parent.drain?.catch(() => undefined);
    await Promise.all(
      allTasks(parent).map(async (entry) => {
        if (entry.worker) await closeQuietly(entry.worker);
      }),
    );
  }

  private schedule(
    parent: Parent<ParentId>,
    promptSettings?: TaskSessionWorkerSettings,
  ): Promise<void> {
    const next = (parent.drain ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.drain(parent, promptSettings));
    parent.drain = next;
    return next;
  }

  private async drain(
    parent: Parent<ParentId>,
    promptSettings?: TaskSessionWorkerSettings,
  ): Promise<void> {
    while (
      !parent.removed &&
      allTasks(parent).filter(isActive).length < this.activeLimit &&
      this.options.hasGlobalCapacity()
    ) {
      const entry = allTasks(parent).find(
        (candidate) =>
          candidate.lifecycle === "queued" ||
          candidate.lifecycle === "retrying",
      );
      if (!entry) break;
      if (
        this.options.claimGlobalCapacity &&
        !this.options.claimGlobalCapacity()
      )
        break;
      entry.lifecycle = "starting";
      entry.attempt += 1;
      entry.startedAt = this.now();
      entry.transitions = [
        ...entry.transitions,
        { lifecycle: "starting", attempt: entry.attempt },
      ];
      this.publish(parent);
      const plan = parent.plans.find((candidate) =>
        candidate.tasks.includes(entry),
      )!;
      try {
        const settings = this.options.resolveWorkerSettings(
          workerSettingsInput(
            parent.parentId,
            parent.parentSettings,
            plan.promptSettings,
          ),
        );
        let ready = false;
        const pending: (() => void)[] = [];
        const afterReady = (fn: () => void) =>
          ready ? fn() : pending.push(fn);
        const worker = await this.options.createWorker({
          parentId: parent.parentId,
          taskNumber: entry.taskNumber,
          attempt: entry.attempt,
          request: {
            contextSummary: plan.contextSummary,
            originalPrompt: plan.originalPrompt,
            brief: entry.brief,
            workerSettings: settings,
          },
          callbacks: {
            completed: (handoff) =>
              afterReady(
                () =>
                  void this.finish(
                    parent,
                    plan,
                    entry,
                    "completed",
                    handoff?.summary,
                  ),
              ),
            failed: (error) =>
              afterReady(() => void this.fail(parent, plan, entry, error)),
            progress: (message) =>
              afterReady(() => {
                entry.progress = safeLine(message);
                this.publish(parent);
              }),
            waitingForParent: () =>
              afterReady(() => {
                entry.lifecycle = "waiting-parent";
                entry.transitions = [
                  ...entry.transitions,
                  { lifecycle: "waiting-parent", attempt: entry.attempt },
                ];
                this.publish(parent);
              }),
          },
        });
        if (parent.removed || this.parents.get(parent.parentId) !== parent) {
          await closeQuietly(worker);
          return;
        }
        entry.worker = worker;
        entry.lifecycle = "running";
        entry.transitions = [
          ...entry.transitions,
          { lifecycle: "running", attempt: entry.attempt },
        ];
        ready = true;
        pending.splice(0).forEach((fn) => fn());
        this.publish(parent);
      } catch (error) {
        await this.fail(parent, plan, entry, error);
      }
    }
  }

  private async fail(
    parent: Parent<ParentId>,
    plan: Plan,
    entry: Task,
    error?: unknown,
  ): Promise<void> {
    if (parent.removed || this.parents.get(parent.parentId) !== parent) return;
    await closeQuietly(entry.worker);
    delete entry.worker;
    entry.handoffSummary = safeLine(
      error instanceof Error ? error.message : "Task session failed.",
    );
    entry.lifecycle = entry.attempt <= 3 ? "retrying" : "failed";
    entry.transitions = [
      ...entry.transitions,
      { lifecycle: entry.lifecycle, attempt: entry.attempt },
    ];
    this.publish(parent);
    if (entry.lifecycle === "retrying") void this.schedule(parent);
    else await this.synthesizeTerminalPlans(parent, plan);
  }

  private async finish(
    parent: Parent<ParentId>,
    plan: Plan,
    entry: Task,
    lifecycle: "completed",
    handoff?: string,
  ): Promise<void> {
    if (parent.removed || this.parents.get(parent.parentId) !== parent) return;
    await closeQuietly(entry.worker);
    delete entry.worker;
    entry.lifecycle = lifecycle;
    entry.handoffSummary = handoff ? safeLine(handoff) : undefined;
    entry.transitions = [
      ...entry.transitions,
      { lifecycle, attempt: entry.attempt },
    ];
    this.publish(parent);
    await this.synthesizeTerminalPlans(parent, plan);
    void this.schedule(parent);
  }

  private async synthesizeTerminalPlans(
    parent: Parent<ParentId>,
    only?: Plan,
  ): Promise<void> {
    for (const plan of only ? [only] : parent.plans) {
      if (
        plan.synthesizing ||
        plan.synthesized ||
        !plan.tasks.every(isTerminal)
      )
        continue;
      plan.synthesizing = true;
      try {
        if (parent.removed || this.parents.get(parent.parentId) !== parent)
          return;
        await this.options.synthesize({
          parentId: parent.parentId,
          originalPrompt: plan.originalPrompt,
          contextSummary: plan.contextSummary,
          tasks: plan.tasks.map(persistTask),
        });
        plan.synthesized = true;
        plan.synthesisReported = true;
        parent.plans = parent.plans.filter((candidate) => candidate !== plan);
        this.publish(parent);
      } finally {
        plan.synthesizing = false;
      }
    }
  }

  private publish(parent: Parent<ParentId>): void {
    if (!parent.removed)
      this.options.onState(parent.parentId, this.state(parent.parentId));
  }
  private parent(parentId: ParentId): Parent<ParentId> {
    const parent = this.parents.get(parentId);
    if (!parent) throw new Error("Parent is not registered.");
    return parent;
  }
}

function task(
  taskNumber: number,
  brief: { generatedName: string; brief: string },
): Task {
  return {
    taskNumber,
    generatedName: brief.generatedName,
    brief: brief.brief,
    lifecycle: "queued",
    attempt: 0,
    transitions: [{ lifecycle: "queued", attempt: 0 }],
  };
}
function allTasks<ParentId>(parent: Parent<ParentId>): Task[] {
  return parent.plans.flatMap((plan) => plan.tasks);
}
function isActive(task: Pick<Task, "lifecycle">): boolean {
  return ["starting", "running", "retrying", "waiting-parent"].includes(
    task.lifecycle,
  );
}
function isTerminal(task: Pick<Task, "lifecycle">): boolean {
  return ["completed", "failed", "interrupted"].includes(task.lifecycle);
}
function summary(
  entry: Task,
  now: number,
  limited: boolean,
): TaskSessionSummary {
  const queueReason =
    entry.lifecycle === "queued"
      ? limited
        ? "Queued: this parent has reached its 10 active task-session limit."
        : "Queued: waiting for worker capacity."
      : undefined;
  return {
    taskNumber: entry.taskNumber,
    generatedName: entry.generatedName,
    brief: entry.brief,
    lifecycle: entry.lifecycle,
    attempt: Math.max(1, entry.attempt),
    elapsedMs: entry.startedAt ? Math.max(0, now - entry.startedAt) : 0,
    ...(entry.progress ? { progress: entry.progress } : {}),
    ...(queueReason ? { queueReason } : {}),
  };
}
function persistTask(task: Task): PersistedTaskSessionTask {
  const {
    startedAt: _startedAt,
    worker: _worker,
    progress: _progress,
    ...safe
  } = task;
  return structuredClone(safe);
}
function safeLine(value: string): string {
  return (
    value
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 1024) || "Task session update."
  );
}
function validatePlan(
  plan: TaskSessionPlan,
  maxPlanTasks = 100,
  maxContextSummaryLength = 16_000,
): void {
  if (
    !plan ||
    typeof plan.contextSummary !== "string" ||
    !plan.contextSummary.trim() ||
    plan.contextSummary.length > maxContextSummaryLength ||
    !Array.isArray(plan.tasks) ||
    plan.tasks.length < 1 ||
    plan.tasks.length > maxPlanTasks
  )
    throw new Error(
      "Task-session planner must return a context summary and one or more tasks.",
    );
  for (const item of plan.tasks) {
    if (
      !item ||
      typeof item.generatedName !== "string" ||
      typeof item.brief !== "string" ||
      !item.generatedName.trim() ||
      !item.brief.trim() ||
      !oneLine(item.generatedName) ||
      !oneLine(item.brief)
    )
      throw new Error("Task-session plan contains an invalid task brief.");
  }
}
function workerSettingsInput<ParentId>(
  parentId: ParentId,
  parentSettings: TaskSessionWorkerSettings,
  promptSettings: TaskSessionWorkerSettings | undefined,
): {
  parentId: ParentId;
  parentSettings: TaskSessionWorkerSettings;
  promptSettings?: TaskSessionWorkerSettings;
} {
  return promptSettings
    ? { parentId, parentSettings, promptSettings }
    : { parentId, parentSettings };
}
function validatePersisted(state: PersistedTaskSessionState): void {
  if (
    !state ||
    state.version !== 1 ||
    (state.mode !== "parallel" && state.mode !== "sequential") ||
    !Number.isSafeInteger(state.nextTaskNumber) ||
    state.nextTaskNumber < 1 ||
    !Array.isArray(state.plans)
  )
    throw new Error("Invalid persisted task-session state.");
  for (const plan of state.plans)
    validatePlan({
      contextSummary: plan.contextSummary,
      tasks: plan.tasks.map((entry: PersistedTaskSessionTask) => ({
        generatedName: entry.generatedName,
        brief: entry.brief,
      })),
    });
}
function oneLine(value: string): boolean {
  return value.trim().length <= 1024 && !/[\r\n]/.test(value);
}
async function closeQuietly(
  worker: TaskSessionWorker | undefined,
): Promise<void> {
  try {
    await worker?.close();
  } catch {
    /* best-effort private cleanup */
  }
}
