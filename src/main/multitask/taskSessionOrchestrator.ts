import type { MultitaskMode } from "./types.js";

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
export interface TaskSessionPlan {
  contextSummary: string;
  tasks: readonly { generatedName: string; brief: string }[];
}
/** Only these durable, non-runtime settings are retained. */
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
  /** Parent defaults are safe settings only (no runtime/session data). */
  workerSettings?: TaskSessionWorkerSettings;
  plans: readonly PersistedTaskSessionPlan[];
}
export interface PersistedTaskSessionPlan {
  planId: number;
  contextSummary: string;
  originalPrompt: string;
  /** Per-prompt safe settings, retained so resolution precedence is reproducible. */
  promptSettings?: TaskSessionWorkerSettings;
  synthesisReported?: boolean;
  tasks: readonly PersistedTaskSessionTask[];
}
export interface PersistedTaskSessionTask {
  taskNumber: number;
  generatedName: string;
  brief: string;
  lifecycle: TaskSessionLifecycle;
  attempt: number;
  transitions: readonly {
    lifecycle: TaskSessionLifecycle;
    attempt: number;
    at?: number;
  }[];
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
  /** Atomic claim. Supplying this requires `releaseGlobalCapacity`; the orchestrator releases every claim it owns. */
  claimGlobalCapacity?(): boolean;
  releaseGlobalCapacity?(): void;
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
  capacityClaimed?: boolean;
};
type Plan = Omit<PersistedTaskSessionPlan, "tasks"> & {
  tasks: Task[];
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
    this.now = options.now ?? Date.now;
    this.maxPlanTasks = options.maxPlanTasks ?? 100;
    this.maxContextSummaryLength = options.maxContextSummaryLength ?? 16_000;
    if (
      !Number.isSafeInteger(this.activeLimit) ||
      this.activeLimit < 1 ||
      !Number.isSafeInteger(this.maxPlanTasks) ||
      this.maxPlanTasks < 1 ||
      !Number.isSafeInteger(this.maxContextSummaryLength) ||
      this.maxContextSummaryLength < 1
    )
      throw new Error("Task-session bounds must be positive safe integers.");
    if (
      Boolean(options.claimGlobalCapacity) !==
      Boolean(options.releaseGlobalCapacity)
    )
      throw new Error(
        "Global capacity claims require a matching releaseGlobalCapacity callback.",
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
      parentSettings: safeSettings(input.workerSettings),
      nextTaskNumber: 1,
      nextPlanId: 1,
      plans: [],
    });
  }
  getWorkerSettings(parentId: ParentId): TaskSessionWorkerSettings {
    return structuredClone(this.parent(parentId).parentSettings);
  }
  /** Replaces parent defaults; running workers retain their launch settings. */
  updateWorkerSettings(
    parentId: ParentId,
    settings: TaskSessionWorkerSettings,
  ): void {
    const parent = this.parent(parentId);
    parent.parentSettings = safeSettings(settings);
    this.publish(parent);
  }
  async submit(
    parentId: ParentId,
    originalPrompt: string,
    promptSettings?: TaskSessionWorkerSettings,
  ): Promise<readonly TaskSessionSummary[]> {
    const parent = this.parent(parentId);
    const cleanPrompt = safeText(originalPrompt, this.maxContextSummaryLength);
    const cleanPromptSettings = promptSettings
      ? safeSettings(promptSettings)
      : undefined;
    const planned = await this.options.plan(parentId, cleanPrompt);
    validatePlan(planned, this.maxPlanTasks, this.maxContextSummaryLength);
    if (parent.removed || this.parents.get(parentId) !== parent)
      throw new Error("Parent is not registered.");
    // Validate precedence before making the plan observable.
    this.options.resolveWorkerSettings(
      workerSettingsInput(parentId, parent.parentSettings, cleanPromptSettings),
    );
    const record: Plan = {
      planId: parent.nextPlanId++,
      contextSummary: safeText(
        planned.contextSummary,
        this.maxContextSummaryLength,
      ),
      originalPrompt: cleanPrompt,
      tasks: planned.tasks.map((item) =>
        task(parent.nextTaskNumber++, item, this.now()),
      ),
      ...(cleanPromptSettings ? { promptSettings: cleanPromptSettings } : {}),
    };
    parent.plans.push(record);
    this.publish(parent);
    void this.schedule(parent);
    return this.state(parentId).tasks;
  }
  state(parentId: ParentId): TaskSessionState {
    const parent = this.parent(parentId);
    const tasks = visibleTasks(parent);
    const activeCount = tasks.filter(isActive).length;
    return {
      mode: parent.mode,
      activeCount,
      activeLimit: this.activeLimit,
      tasks: tasks.map((entry) =>
        summary(
          entry,
          this.now(),
          activeCount >= this.activeLimit,
          this.activeLimit,
        ),
      ),
    };
  }
  setMode(parentId: ParentId, mode: MultitaskMode): void {
    const parent = this.parent(parentId);
    parent.mode = mode;
    this.publish(parent);
    void this.schedule(parent);
  }
  scheduleAll(): void {
    for (const parent of this.parents.values()) void this.schedule(parent);
  }
  exportState(parentId: ParentId): PersistedTaskSessionState {
    const parent = this.parent(parentId);
    return {
      version: 1,
      mode: parent.mode,
      nextTaskNumber: parent.nextTaskNumber,
      workerSettings: safeSettings(parent.parentSettings),
      plans: parent.plans.map((plan) => ({
        planId: plan.planId,
        contextSummary: safeText(
          plan.contextSummary,
          this.maxContextSummaryLength,
        ),
        originalPrompt: safeText(
          plan.originalPrompt,
          this.maxContextSummaryLength,
        ),
        ...(plan.promptSettings
          ? { promptSettings: safeSettings(plan.promptSettings) }
          : {}),
        ...(plan.synthesisReported ? { synthesisReported: true } : {}),
        tasks: plan.tasks.map(persistTask),
      })),
    };
  }
  /** Restore is deliberately passive: unfinished work is recorded as interrupted, never synthesized or relaunched. */
  restore(parentId: ParentId, state: PersistedTaskSessionState): void {
    validatePersisted(state, this.maxPlanTasks, this.maxContextSummaryLength);
    const parent = this.parent(parentId);
    parent.mode = state.mode;
    parent.parentSettings = safeSettings(state.workerSettings);
    parent.nextTaskNumber = state.nextTaskNumber;
    parent.nextPlanId = Math.max(
      1,
      ...state.plans.map((plan) => plan.planId + 1),
    );
    parent.plans = state.plans.map((plan) => ({
      ...plan,
      originalPrompt: safeText(
        plan.originalPrompt,
        this.maxContextSummaryLength,
      ),
      contextSummary: safeText(
        plan.contextSummary,
        this.maxContextSummaryLength,
      ),
      ...(plan.promptSettings
        ? { promptSettings: safeSettings(plan.promptSettings) }
        : {}),
      ...(plan.synthesisReported ? { synthesized: true } : {}),
      tasks: plan.tasks.map((saved) =>
        !isTerminal(saved)
          ? {
              ...saved,
              lifecycle: "interrupted",
              transitions: [
                ...saved.transitions,
                transition("interrupted", saved.attempt, this.now()),
              ],
              handoffSummary: "Task session interrupted after restart.",
            }
          : { ...saved },
      ),
    }));
    this.publish(parent);
  }
  async removeParent(parentId: ParentId): Promise<void> {
    const parent = this.parents.get(parentId);
    if (!parent) return;
    parent.removed = true;
    this.parents.delete(parentId);
    await parent.drain?.catch(() => undefined);
    await Promise.all(allTasks(parent).map((entry) => this.closeEntry(entry)));
  }
  private schedule(parent: Parent<ParentId>): Promise<void> {
    const next = (parent.drain ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.drain(parent));
    parent.drain = next;
    return next;
  }
  private async drain(parent: Parent<ParentId>): Promise<void> {
    while (!parent.removed && this.options.hasGlobalCapacity()) {
      const activeCount = allTasks(parent).filter(isActive).length;
      // Retrying is active in UI but has released its worker slot. Reserve it first;
      // it may refill that slot at the limit, while queued work may not exceed it.
      const entry =
        allTasks(parent).find((item) => item.lifecycle === "retrying") ??
        (activeCount < this.activeLimit
          ? allTasks(parent).find((item) => item.lifecycle === "queued")
          : undefined);
      if (
        !entry ||
        (parent.mode === "sequential" &&
          activeCount > (entry.lifecycle === "retrying" ? 1 : 0))
      )
        break;
      if (
        this.options.claimGlobalCapacity &&
        !this.options.claimGlobalCapacity()
      )
        break;
      entry.capacityClaimed = Boolean(this.options.claimGlobalCapacity);
      entry.lifecycle = "starting";
      entry.attempt += 1;
      entry.startedAt = this.now();
      entry.transitions = [
        ...entry.transitions,
        transition("starting", entry.attempt, this.now()),
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
        const attempt = entry.attempt;
        const worker = await this.options.createWorker({
          parentId: parent.parentId,
          taskNumber: entry.taskNumber,
          attempt,
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
                    attempt,
                    handoff?.summary,
                  ),
              ),
            failed: (error) =>
              afterReady(
                () => void this.fail(parent, plan, entry, attempt, error),
              ),
            progress: (message) =>
              afterReady(() => {
                if (entry.attempt === attempt && !isTerminal(entry)) {
                  entry.progress = safeLine(message);
                  this.publish(parent);
                }
              }),
            waitingForParent: () =>
              afterReady(() => {
                if (entry.attempt === attempt && !isTerminal(entry)) {
                  entry.lifecycle = "waiting-parent";
                  entry.transitions = [
                    ...entry.transitions,
                    transition("waiting-parent", attempt, this.now()),
                  ];
                  this.publish(parent);
                }
              }),
          },
        });
        if (parent.removed || this.parents.get(parent.parentId) !== parent) {
          await closeQuietly(worker);
          this.releaseClaim(entry);
          return;
        }
        entry.worker = worker;
        entry.lifecycle = "running";
        entry.transitions = [
          ...entry.transitions,
          transition("running", attempt, this.now()),
        ];
        ready = true;
        pending.splice(0).forEach((fn) => fn());
        this.publish(parent);
      } catch (error) {
        await this.fail(parent, plan, entry, entry.attempt, error);
      }
    }
  }
  private async closeEntry(entry: Task): Promise<void> {
    await closeQuietly(entry.worker);
    delete entry.worker;
    this.releaseClaim(entry);
  }
  private releaseClaim(entry: Task): void {
    if (entry.capacityClaimed) {
      entry.capacityClaimed = false;
      this.options.releaseGlobalCapacity?.();
    }
  }
  private async fail(
    parent: Parent<ParentId>,
    plan: Plan,
    entry: Task,
    attempt: number,
    error?: unknown,
  ): Promise<void> {
    if (
      parent.removed ||
      this.parents.get(parent.parentId) !== parent ||
      entry.attempt !== attempt ||
      isTerminal(entry)
    )
      return;
    await this.closeEntry(entry);
    entry.handoffSummary = safeLine(
      error instanceof Error ? error.message : "Task session failed.",
    );
    entry.lifecycle = attempt <= 3 ? "retrying" : "failed";
    entry.transitions = [
      ...entry.transitions,
      transition(entry.lifecycle, attempt, this.now()),
    ];
    this.publish(parent);
    if (entry.lifecycle === "retrying") void this.schedule(parent);
    else await this.synthesizeTerminalPlans(parent, plan);
  }
  private async finish(
    parent: Parent<ParentId>,
    plan: Plan,
    entry: Task,
    attempt: number,
    handoff?: string,
  ): Promise<void> {
    if (
      parent.removed ||
      this.parents.get(parent.parentId) !== parent ||
      entry.attempt !== attempt ||
      isTerminal(entry)
    )
      return;
    await this.closeEntry(entry);
    entry.lifecycle = "completed";
    entry.handoffSummary = handoff ? safeLine(handoff) : undefined;
    entry.transitions = [
      ...entry.transitions,
      transition("completed", attempt, this.now()),
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
        this.publish(parent);
      } catch {
        /* Retain terminal trace; caller may explicitly retry after restart or submit work. */
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
  now: number,
): Task {
  return {
    taskNumber,
    generatedName: safeLine(brief.generatedName),
    brief: safeLine(brief.brief),
    lifecycle: "queued",
    attempt: 0,
    transitions: [transition("queued", 0, now)],
  };
}
function transition(
  lifecycle: TaskSessionLifecycle,
  attempt: number,
  at: number,
) {
  return { lifecycle, attempt, at };
}
function allTasks<ParentId>(parent: Parent<ParentId>): Task[] {
  return parent.plans.flatMap((plan) => plan.tasks);
}
function visibleTasks<ParentId>(parent: Parent<ParentId>): Task[] {
  return parent.plans
    .filter((plan) => !plan.synthesisReported)
    .flatMap((plan) => plan.tasks);
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
  activeLimit: number,
): TaskSessionSummary {
  const queueReason =
    entry.lifecycle === "queued"
      ? limited
        ? `Queued: this parent has reached its ${activeLimit} active task-session limit.`
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
    capacityClaimed: _capacityClaimed,
    ...safe
  } = task;
  return structuredClone({
    ...safe,
    generatedName: safeLine(safe.generatedName),
    brief: safeLine(safe.brief),
    ...(safe.handoffSummary
      ? { handoffSummary: safeLine(safe.handoffSummary) }
      : {}),
  });
}
function safeText(value: string, max: number): string {
  return typeof value === "string"
    ? value.replace(/\u0000/g, "").slice(0, max)
    : "";
}
function safeLine(value: string): string {
  return (
    safeText(value, 1024)
      .replace(/[\r\n]+/g, " ")
      .trim() || "Task session update."
  );
}
function safeSettings(
  settings: TaskSessionWorkerSettings | undefined,
): TaskSessionWorkerSettings {
  if (!settings) return {};
  const result: TaskSessionWorkerSettings = {};
  for (const key of ["model", "thinkingLevel", "project"] as const)
    if (typeof settings[key] === "string" && settings[key].trim())
      result[key] = safeLine(settings[key]);
  return result;
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
  for (const item of plan.tasks)
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
function validatePersisted(
  state: PersistedTaskSessionState,
  maxPlanTasks: number,
  maxContextSummaryLength: number,
): void {
  if (
    !state ||
    state.version !== 1 ||
    (state.mode !== "parallel" && state.mode !== "sequential") ||
    !Number.isSafeInteger(state.nextTaskNumber) ||
    state.nextTaskNumber < 1 ||
    !Array.isArray(state.plans)
  )
    throw new Error("Invalid persisted task-session state.");
  const planIds = new Set<number>();
  const taskNumbers = new Set<number>();
  for (const plan of state.plans) {
    if (
      !Number.isSafeInteger(plan.planId) ||
      plan.planId < 1 ||
      planIds.has(plan.planId) ||
      typeof plan.originalPrompt !== "string"
    )
      throw new Error("Invalid persisted task-session state.");
    planIds.add(plan.planId);
    validatePlan(
      {
        contextSummary: plan.contextSummary,
        tasks: plan.tasks.map((entry: PersistedTaskSessionTask) => ({
          generatedName: entry.generatedName,
          brief: entry.brief,
        })),
      },
      maxPlanTasks,
      maxContextSummaryLength,
    );
    for (const entry of plan.tasks) {
      if (
        !Number.isSafeInteger(entry.taskNumber) ||
        taskNumbers.has(entry.taskNumber) ||
        !Number.isSafeInteger(entry.attempt) ||
        entry.attempt < 0 ||
        !isLifecycle(entry.lifecycle) ||
        !Array.isArray(entry.transitions) ||
        entry.transitions.some(
          (item: {
            lifecycle: TaskSessionLifecycle;
            attempt: number;
            at?: number;
          }) =>
            !item ||
            !isLifecycle(item.lifecycle) ||
            !Number.isSafeInteger(item.attempt) ||
            item.attempt < 0 ||
            (item.at !== undefined &&
              (!Number.isSafeInteger(item.at) || item.at < 0)),
        )
      )
        throw new Error("Invalid persisted task-session state.");
      taskNumbers.add(entry.taskNumber);
    }
  }
}
function isLifecycle(value: unknown): value is TaskSessionLifecycle {
  return (
    typeof value === "string" &&
    [
      "queued",
      "starting",
      "running",
      "retrying",
      "waiting-parent",
      "completed",
      "failed",
      "interrupted",
    ].includes(value)
  );
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
    /* best-effort cleanup */
  }
}
