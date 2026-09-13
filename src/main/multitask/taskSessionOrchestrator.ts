import type { MultitaskMode } from "./types.js";
import {
  synthesisDeliveryFingerprint,
  synthesisDeliveryMarker,
  synthesisDeliveryPayload,
  type SynthesisDelivery,
} from "./taskSessionSynthesisDelivery.js";

/** Initial terminal delivery attempt plus three retries. */
const maxSynthesisAttempts = 4;

export type TaskSessionLifecycle =
  | "queued"
  | "starting"
  | "running"
  | "retrying"
  | "waiting-parent"
  | "completed"
  | "failed"
  | "interrupted";

export type TaskSessionPhase = "model" | "tool" | "retrying" | "waiting";
export const taskSessionActivityLabels = [
  "Started model call",
  "Model response received",
  "Running a tool",
  "Tool step completed",
  "Retrying model call",
  "Retry completed",
  "Waiting for parent",
  "Model call completed",
] as const;
export type TaskSessionActivity = (typeof taskSessionActivityLabels)[number];

/** A payload-free update derived only from a private worker event type. */
export interface TaskSessionTelemetryUpdate {
  phase?: TaskSessionPhase;
  activity?: TaskSessionActivity;
  progress?: TaskSessionProgress;
  /** Present only when a model request lifecycle event makes it reliable. */
  modelCallIncrement?: 1;
  /** An authoritative cumulative total reported by Pi for this worker attempt. */
  reportedTotalTokens?: number;
}

export interface TaskSessionSummary {
  taskNumber: number;
  generatedName: string;
  brief: string;
  lifecycle: TaskSessionLifecycle;
  attempt: number;
  elapsedMs: number;
  /** Epoch timestamp for renderer-side live elapsed-time calculation. */
  startedAtMs?: number;
  progress?: string;
  queueReason?: string;
  phase?: TaskSessionPhase;
  modelCallCount?: number;
  totalTokens?: number;
  latestActivity?: TaskSessionActivity;
  latestActivityAtMs?: number;
}
export const taskSessionProgressLabels = [
  "Started",
  "Using a tool",
  "Tool step completed",
  "Preparing result",
  "Waiting for parent",
] as const;
export type TaskSessionProgress = (typeof taskSessionProgressLabels)[number];

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
    /** Ephemeral main-owned material; never included in durable state. */
    runtimeContext?: unknown;
  };
  callbacks: {
    completed(handoff?: { summary?: string }): void;
    failed(error?: unknown): void;
    progress(message: TaskSessionProgress): void;
    telemetry(update: TaskSessionTelemetryUpdate): void;
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
  /** Write-ahead parent-delivery outbox. It is retained after acknowledgement. */
  synthesisDelivery?: SynthesisDelivery;
  /** Number of attempted synthesis deliveries, including the initial attempt. */
  synthesisAttempts?: number;
  synthesisFailureTrace?: string;
  /** The send cap was reached after a negative authoritative receipt probe. */
  synthesisCapped?: boolean;
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
  /** Safe frozen duration retained for terminal rows across app restart. */
  terminalElapsedMs?: number;
  /** Safe final telemetry is retained, but never a live worker identity. */
  phase?: TaskSessionPhase;
  modelCallCount?: number;
  totalTokens?: number;
  latestActivity?: TaskSessionActivity;
  latestActivityAtMs?: number;
}
export interface TaskSessionOrchestratorOptions<
  ParentId,
  Worker extends TaskSessionWorker,
> {
  plan(
    parentId: ParentId,
    originalPrompt: string,
    runtimeContext?: unknown,
  ): Promise<TaskSessionPlan> | TaskSessionPlan;
  resolveWorkerSettings(input: {
    parentId: ParentId;
    parentSettings: TaskSessionWorkerSettings;
    promptSettings?: TaskSessionWorkerSettings;
  }): TaskSessionWorkerSettings;
  createWorker(launch: TaskSessionLaunch<ParentId>): Promise<Worker> | Worker;
  hasGlobalCapacity(parentId: ParentId): boolean;
  /** Identifies a createWorker rejection caused by worker capacity, rather than task failure. */
  isCapacityUnavailable?(error: unknown): boolean;
  /** Atomic claim. Supplying this requires `releaseGlobalCapacity`; the orchestrator releases every claim it owns. */
  claimGlobalCapacity?(): boolean;
  releaseGlobalCapacity?(): void;
  /**
   * Dispatch the exact write-ahead payload. This is called only after persist
   * has durably recorded its `dispatching` state.
   */
  synthesize(input: {
    parentId: ParentId;
    originalPrompt: string;
    contextSummary: string;
    tasks: readonly PersistedTaskSessionTask[];
    delivery: SynthesisDelivery;
    /** Durably reserve a bounded send immediately before the parent boundary. */
    markDispatched(): Promise<void>;
  }): Promise<void> | void;
  /** Pi transcript history is the acknowledgement authority, never an RPC ack. */
  hasSynthesisDelivery(input: {
    parentId: ParentId;
    delivery: SynthesisDelivery;
  }): Promise<boolean> | boolean;
  /** Must durably save this snapshot before a parent turn may be dispatched. */
  persistSynthesisDelivery?(
    parentId: ParentId,
    state: PersistedTaskSessionState,
  ): Promise<void> | void;
  /** Injectable timer hook for bounded terminal synthesis retries. */
  scheduleSynthesisRetry?(callback: () => void, delayMs: number): void;
  synthesisRetryDelayMs?: number;
  /** Maximum exponential reconciliation delay; retries never consume send quota. */
  synthesisRetryMaxDelayMs?: number;
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
  /** Captured at terminal transition so terminal elapsed time never advances. */
  terminalElapsedMs?: number;
  worker?: TaskSessionWorker;
  progress?: string;
  queueReason?: string;
  phase?: TaskSessionPhase;
  modelCallCount?: number;
  latestActivity?: TaskSessionActivity;
  latestActivityAt?: number;
  /** Per-attempt Pi totals prevent retry reconciliation from double counting. */
  reportedTokensByAttempt?: Map<number, number>;
  /** Safe terminal/reloaded total when the private worker is no longer present. */
  totalTokens?: number;
  capacityClaimed?: boolean;
};
type Plan = Omit<PersistedTaskSessionPlan, "tasks"> & {
  tasks: Task[];
  runtimeContext?: unknown;
  synthesizing?: boolean;
  synthesized?: boolean;
  synthesisEligible?: boolean;
  synthesisRetryScheduled?: boolean;
  /** Runtime-only reconciliation failures, used solely for bounded backoff. */
  synthesisReconciliationFailures?: number;
};

/** Restore has three mutually-exclusive outcomes. Only terminal pending plans
 * may cross the parent reporting boundary; interrupted work is retained solely
 * for traceability and reported plans are permanently suppressed. */
type RestoreReconciliationState =
  | "interrupted"
  | "terminal-pending-synthesis"
  | "reported";
type Parent<ParentId> = {
  parentId: ParentId;
  mode: MultitaskMode;
  parentSettings: TaskSessionWorkerSettings;
  nextTaskNumber: number;
  nextPlanId: number;
  plans: Plan[];
  removed?: boolean;
  capacityBlocked?: boolean;
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
    for (const [name, value] of [
      ["Synthesis retry delay", options.synthesisRetryDelayMs],
      ["Synthesis retry maximum delay", options.synthesisRetryMaxDelayMs],
    ] as const)
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new Error(`${name} must be a non-negative safe integer.`);
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
    runtimeContext?: unknown,
  ): Promise<readonly TaskSessionSummary[]> {
    const parent = this.parent(parentId);
    const cleanPrompt = safeText(originalPrompt, this.maxContextSummaryLength);
    const cleanPromptSettings = promptSettings
      ? safeSettings(promptSettings)
      : undefined;
    const planned = await this.options.plan(
      parentId,
      cleanPrompt,
      runtimeContext,
    );
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
      ...(runtimeContext !== undefined ? { runtimeContext } : {}),
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
    for (const parent of this.parents.values()) {
      parent.capacityBlocked = false;
      void this.schedule(parent);
      void this.synthesizeTerminalPlans(parent);
    }
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
        ...(plan.synthesisDelivery
          ? { synthesisDelivery: structuredClone(plan.synthesisDelivery) }
          : {}),
        ...(plan.synthesisAttempts
          ? { synthesisAttempts: plan.synthesisAttempts }
          : {}),
        ...(plan.synthesisFailureTrace
          ? { synthesisFailureTrace: safeLine(plan.synthesisFailureTrace) }
          : {}),
        ...(plan.synthesisCapped ? { synthesisCapped: true } : {}),
        tasks: plan.tasks.map(persistTask),
      })),
    };
  }
  /**
   * Reconcile durable task state without ever resuming private workers.
   *
   * - unfinished work becomes interrupted and is never scheduled;
   * - all-terminal, unreported plans schedule exactly their remaining parent
   *   synthesis/report action; and
   * - reported plans remain inert.
   *
   * Production calls this once per attached runtime, but retaining an in-flight
   * reservation also makes repeated reconciliation safe before persistence
   * observes that reservation or report marker.
   */
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
    const existingPlans = new Map(
      parent.plans.map((plan) => [plan.planId, plan]),
    );
    parent.plans = state.plans.map((saved) => {
      const existing = existingPlans.get(saved.planId);
      // A restore can be retried before the state-store observes our durable
      // reservation. Keep the live plan object so the in-flight delivery (or
      // its one bounded timer) cannot be orphaned and duplicated.
      if (
        existing?.synthesizing ||
        existing?.synthesized ||
        existing?.synthesisRetryScheduled
      )
        return existing;
      return restoredPlan(saved, this.now(), this.maxContextSummaryLength);
    });
    this.publish(parent);
    void this.synthesizeTerminalPlans(parent);
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
    while (
      !parent.removed &&
      !parent.capacityBlocked &&
      this.options.hasGlobalCapacity(parent.parentId)
    ) {
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
      const priorLifecycle: "queued" | "retrying" =
        entry.lifecycle === "retrying" ? "retrying" : "queued";
      entry.capacityClaimed = Boolean(this.options.claimGlobalCapacity);
      entry.lifecycle = "starting";
      delete entry.queueReason;
      delete entry.progress;
      delete entry.terminalElapsedMs;
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
            ...(plan.runtimeContext !== undefined
              ? { runtimeContext: plan.runtimeContext }
              : {}),
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
                if (
                  entry.attempt === attempt &&
                  !isTerminal(entry) &&
                  isTaskSessionProgress(message)
                ) {
                  entry.progress = message;
                  this.publish(parent);
                }
              }),
            telemetry: (update) =>
              afterReady(() => {
                if (
                  entry.attempt !== attempt ||
                  isTerminal(entry) ||
                  !isTaskSessionTelemetryUpdate(update)
                )
                  return;
                let changed = false;
                if (update.progress && entry.progress !== update.progress) {
                  entry.progress = update.progress;
                  changed = true;
                }
                if (update.phase && entry.phase !== update.phase) {
                  entry.phase = update.phase;
                  changed = true;
                }
                const now = this.now();
                if (
                  update.activity &&
                  (entry.latestActivity !== update.activity ||
                    entry.latestActivityAt === undefined ||
                    now - entry.latestActivityAt >= 1_000)
                ) {
                  entry.latestActivity = update.activity;
                  entry.latestActivityAt = now;
                  changed = true;
                }
                if (update.modelCallIncrement) {
                  entry.modelCallCount =
                    (entry.modelCallCount ?? 0) + update.modelCallIncrement;
                  changed = true;
                }
                if (update.reportedTotalTokens !== undefined) {
                  const totals = (entry.reportedTokensByAttempt ??= new Map());
                  const previous = totals.get(attempt) ?? 0;
                  // Pi stats are cumulative per worker; retain only monotonic reports.
                  if (update.reportedTotalTokens >= previous) {
                    totals.set(attempt, update.reportedTotalTokens);
                    entry.totalTokens = [...totals.values()].reduce(
                      (total, value) => total + value,
                      0,
                    );
                    changed = true;
                  }
                }
                if (changed) this.publish(parent);
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
        if (this.options.isCapacityUnavailable?.(error)) {
          await this.returnCapacityDeniedTask(parent, entry, priorLifecycle);
          return;
        }
        await this.fail(parent, plan, entry, entry.attempt, error);
      }
    }
  }
  private async returnCapacityDeniedTask(
    parent: Parent<ParentId>,
    entry: Task,
    priorLifecycle: "queued" | "retrying",
  ): Promise<void> {
    await this.closeEntry(entry);
    entry.lifecycle = priorLifecycle;
    entry.attempt -= 1;
    delete entry.startedAt;
    entry.queueReason =
      "Queued: worker capacity was unavailable. Waiting for the next global scheduling pass.";
    parent.capacityBlocked = true;
    this.publish(parent);
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
    delete entry.queueReason;
    entry.handoffSummary = safeLine(
      error instanceof Error ? error.message : "Task session failed.",
    );
    entry.lifecycle = attempt <= 3 ? "retrying" : "failed";
    if (isTerminal(entry))
      entry.terminalElapsedMs = elapsedSinceStart(entry, this.now());
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
    delete entry.queueReason;
    entry.lifecycle = "completed";
    entry.terminalElapsedMs = elapsedSinceStart(entry, this.now());
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
        plan.synthesisEligible === false ||
        !plan.tasks.every(isTerminal)
      )
        continue;
      plan.synthesizing = true;
      let retrySynthesis = false;
      try {
        // The immutable payload is written once. Never regenerate it on retry:
        // the persisted marker and SHA-256 fingerprint are the recovery
        // contract, not a rendering convenience.
        if (!plan.synthesisDelivery) {
          plan.synthesisDelivery = synthesisDeliveryPayload({
            attempt: plan.synthesisAttempts ?? 0,
            originalPrompt: plan.originalPrompt,
            tasks: plan.tasks.map(persistTask),
          });
          this.publish(parent);
          await this.persistSynthesisDelivery(parent);
        }
        if (parent.removed || this.parents.get(parent.parentId) !== parent)
          return;
        const delivery = plan.synthesisDelivery;
        if (!delivery) throw new Error("Synthesis delivery record was lost.");

        // Receipt is always checked first, including when the send cap is
        // already exhausted. Missing/unavailable history is deliberately a
        // retriable failure, never an acknowledgement.
        if (await this.hasSynthesisReceipt(parent, delivery)) {
          await this.markSynthesisDelivered(parent, plan, delivery);
          continue;
        }
        if (
          plan.synthesisCapped ||
          (plan.synthesisAttempts ?? 0) >= maxSynthesisAttempts
        ) {
          plan.synthesisCapped = true;
          plan.synthesisFailureTrace =
            "Synthesis send-attempt cap reached without a durable parent receipt.";
          this.publish(parent);
          // Await this final trace/state. A failed final write must reconcile
          // again; clear the runtime latch so it cannot strand terminal rows.
          try {
            await this.persistSynthesisDelivery(parent);
          } catch (error) {
            delete plan.synthesisCapped;
            throw error;
          }
          continue;
        }

        let dispatched = false;
        const markDispatched = async () => {
          if (dispatched) return;
          dispatched = true;
          const previousAttempts = plan.synthesisAttempts;
          const previousDeliveryAttempt = delivery.attempt;
          const attempts = (previousAttempts ?? 0) + 1;
          plan.synthesisAttempts = attempts;
          delivery.attempt = attempts;
          plan.synthesisDelivery = delivery;
          this.publish(parent);
          // A process death after the parent boundary must still recover the
          // exact capped-send reservation and probe its receipt before retry.
          // If this pre-boundary write fails, undo it: persistence failures do
          // not consume a send that never reached the parent.
          try {
            await this.persistSynthesisDelivery(parent);
          } catch (error) {
            if (previousAttempts === undefined) delete plan.synthesisAttempts;
            else plan.synthesisAttempts = previousAttempts;
            delivery.attempt = previousDeliveryAttempt;
            this.publish(parent);
            throw error;
          }
        };
        await this.options.synthesize({
          parentId: parent.parentId,
          originalPrompt: plan.originalPrompt,
          contextSummary: plan.contextSummary,
          tasks: plan.tasks.map(persistTask),
          delivery,
          markDispatched,
        });
        if (!dispatched)
          throw new Error(
            "Synthesis completed without crossing the parent dispatch boundary.",
          );

        // RPC acceptance and agent completion are not receipts. The exact
        // durable marker must be visible after prompt/follow_up settlement.
        if (!(await this.hasSynthesisReceipt(parent, delivery)))
          throw new Error(
            "Parent synthesis settled without a durable receipt.",
          );
        await this.markSynthesisDelivered(
          parent,
          plan,
          plan.synthesisDelivery ?? delivery,
        );
      } catch (error) {
        plan.synthesisFailureTrace = safeLine(
          error instanceof Error
            ? error.message
            : "Task-session synthesis delivery failed.",
        );
        plan.synthesisReconciliationFailures =
          (plan.synthesisReconciliationFailures ?? 0) + 1;
        this.publish(parent);
        // Preserve failure diagnostics whenever storage is available. A failed
        // persistence barrier is itself retried with bounded backoff and never
        // licenses a send.
        try {
          await this.persistSynthesisDelivery(parent);
        } catch {
          // The scheduled reconciliation below retains the in-memory trace.
        }
        retrySynthesis = !parent.removed && !plan.synthesisCapped;
      } finally {
        plan.synthesizing = false;
      }
      if (retrySynthesis) this.scheduleSynthesisRetry(parent, plan);
    }
  }
  private async hasSynthesisReceipt(
    parent: Parent<ParentId>,
    delivery: SynthesisDelivery,
  ): Promise<boolean> {
    return this.options.hasSynthesisDelivery({
      parentId: parent.parentId,
      delivery,
    });
  }
  private async markSynthesisDelivered(
    parent: Parent<ParentId>,
    plan: Plan,
    delivery: SynthesisDelivery,
  ): Promise<void> {
    plan.synthesisDelivery = { ...delivery, state: "delivered" };
    this.publish(parent);
    await this.persistSynthesisDelivery(parent);
    plan.synthesized = true;
    plan.synthesisReported = true;
    delete plan.runtimeContext;
    delete plan.synthesisFailureTrace;
    delete plan.synthesisReconciliationFailures;
    this.publish(parent);
    await this.persistSynthesisDelivery(parent);
  }
  private async persistSynthesisDelivery(
    parent: Parent<ParentId>,
  ): Promise<void> {
    await this.options.persistSynthesisDelivery?.(
      parent.parentId,
      this.exportState(parent.parentId),
    );
  }
  private scheduleSynthesisRetry(parent: Parent<ParentId>, plan: Plan): void {
    if (plan.synthesisRetryScheduled) return;
    plan.synthesisRetryScheduled = true;
    const retry = () => {
      plan.synthesisRetryScheduled = false;
      if (!parent.removed && this.parents.get(parent.parentId) === parent)
        void this.synthesizeTerminalPlans(parent, plan);
    };
    const baseDelayMs = this.options.synthesisRetryDelayMs ?? 1_000;
    const exponent = Math.min(plan.synthesisReconciliationFailures ?? 0, 16);
    const delayMs = Math.min(
      baseDelayMs * 2 ** exponent,
      this.options.synthesisRetryMaxDelayMs ?? 30_000,
    );
    if (this.options.scheduleSynthesisRetry)
      this.options.scheduleSynthesisRetry(retry, delayMs);
    else setTimeout(retry, delayMs);
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
function restoredPlan(
  saved: PersistedTaskSessionPlan,
  now: number,
  maxContextSummaryLength: number,
): Plan {
  const reconciliation = restoreReconciliationState(saved);
  return {
    ...saved,
    originalPrompt: safeText(saved.originalPrompt, maxContextSummaryLength),
    contextSummary: safeText(saved.contextSummary, maxContextSummaryLength),
    ...(saved.promptSettings
      ? { promptSettings: safeSettings(saved.promptSettings) }
      : {}),
    ...(reconciliation === "reported" ? { synthesized: true } : {}),
    synthesisEligible: reconciliation === "terminal-pending-synthesis",
    tasks: saved.tasks.map((task) => {
      // A prior restore already made this durable transition. Do not append an
      // identical transition every time the parent is reconciled.
      if (reconciliation === "interrupted" && !isTerminal(task))
        return {
          ...task,
          lifecycle: "interrupted",
          transitions: [
            ...task.transitions,
            transition("interrupted", task.attempt, now),
          ],
          handoffSummary: "Task session interrupted after restart.",
        };
      return {
        ...task,
        ...(task.latestActivityAtMs !== undefined
          ? { latestActivityAt: task.latestActivityAtMs }
          : {}),
      };
    }),
  };
}

function restoreReconciliationState(
  plan: PersistedTaskSessionPlan,
): RestoreReconciliationState {
  if (plan.synthesisReported) return "reported";
  return plan.tasks.some(
    (task) => !isTerminal(task) || task.lifecycle === "interrupted",
  )
    ? "interrupted"
    : "terminal-pending-synthesis";
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
    entry.queueReason ??
    (entry.lifecycle === "queued"
      ? limited
        ? `Queued: this parent has reached its ${activeLimit} active task-session limit.`
        : "Queued: waiting for worker capacity."
      : undefined);
  const totalTokens = totalReportedTokens(entry) ?? entry.totalTokens;
  return {
    taskNumber: entry.taskNumber,
    generatedName: entry.generatedName,
    brief: entry.brief,
    lifecycle: entry.lifecycle,
    attempt: Math.max(1, entry.attempt),
    elapsedMs: entry.terminalElapsedMs ?? elapsedSinceStart(entry, now),
    ...(!isTerminal(entry) && entry.startedAt !== undefined
      ? { startedAtMs: entry.startedAt }
      : {}),
    ...(entry.progress ? { progress: entry.progress } : {}),
    ...(queueReason ? { queueReason } : {}),
    ...(entry.phase ? { phase: entry.phase } : {}),
    ...(entry.modelCallCount !== undefined
      ? { modelCallCount: entry.modelCallCount }
      : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(entry.latestActivity
      ? {
          latestActivity: entry.latestActivity,
          latestActivityAtMs: entry.latestActivityAt ?? now,
        }
      : {}),
  };
}
function persistTask(task: Task): PersistedTaskSessionTask {
  const {
    startedAt: _startedAt,
    worker: _worker,
    progress: _progress,
    queueReason: _queueReason,
    phase: _phase,
    modelCallCount: _modelCallCount,
    latestActivity: _latestActivity,
    latestActivityAt: _latestActivityAt,
    latestActivityAtMs: _latestActivityAtMs,
    reportedTokensByAttempt: _reportedTokensByAttempt,
    totalTokens: _totalTokens,
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
    ...(isTerminal(task) && task.phase ? { phase: task.phase } : {}),
    ...(isTerminal(task) && task.modelCallCount !== undefined
      ? { modelCallCount: task.modelCallCount }
      : {}),
    ...(isTerminal(task) && task.totalTokens !== undefined
      ? { totalTokens: task.totalTokens }
      : {}),
    ...(isTerminal(task) && task.latestActivity
      ? { latestActivity: task.latestActivity }
      : {}),
    ...(isTerminal(task) && task.latestActivityAt !== undefined
      ? { latestActivityAtMs: task.latestActivityAt }
      : {}),
  });
}
function elapsedSinceStart(
  entry: Pick<Task, "startedAt">,
  now: number,
): number {
  return entry.startedAt === undefined ? 0 : Math.max(0, now - entry.startedAt);
}

/**
 * Allowlisted, payload-free status labels for private child-worker events.
 * Never pass event data through this boundary: it can include transcript,
 * tool arguments/output, runtime IDs, or session details.
 */
function totalReportedTokens(entry: Task): number | undefined {
  const values = [...(entry.reportedTokensByAttempt?.values() ?? [])];
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0)
    : undefined;
}

/**
 * This reducer intentionally receives an event type, never its private payload.
 * Its activity labels are a fixed allowlist so reasoning, tool arguments and
 * tool output cannot cross the child-worker boundary.
 */
export function taskSessionTelemetryForWorkerEventType(
  eventType: string,
): TaskSessionTelemetryUpdate | undefined {
  switch (eventType) {
    case "agent_start":
      return {
        phase: "model",
        activity: "Started model call",
        modelCallIncrement: 1,
      };
    case "message_update":
      return { phase: "model", activity: "Model response received" };
    case "tool_execution_start":
    case "tool_execution_update":
      return { phase: "tool", activity: "Running a tool" };
    case "tool_execution_end":
      return { phase: "tool", activity: "Tool step completed" };
    case "auto_retry_start":
      return {
        phase: "retrying",
        activity: "Retrying model call",
        modelCallIncrement: 1,
      };
    case "auto_retry_end":
      return { phase: "model", activity: "Retry completed" };
    case "extension_ui_request":
      return { phase: "waiting", activity: "Waiting for parent" };
    case "agent_settled":
    case "agent_end":
      return { phase: "model", activity: "Model call completed" };
    default:
      return undefined;
  }
}

export function taskSessionProgressForWorkerEventType(
  eventType: string,
): TaskSessionProgress | undefined {
  switch (eventType) {
    case "agent_start":
      return "Started";
    case "tool_execution_start":
    case "tool_execution_update":
      return "Using a tool";
    case "tool_execution_end":
      return "Tool step completed";
    case "message_update":
    case "agent_settled":
    case "agent_end":
      return "Preparing result";
    case "extension_ui_request":
      return "Waiting for parent";
    default:
      return undefined;
  }
}

function isTaskSessionProgress(value: unknown): value is TaskSessionProgress {
  return taskSessionProgressLabels.includes(value as TaskSessionProgress);
}
function isTaskSessionTelemetryUpdate(
  value: TaskSessionTelemetryUpdate,
): boolean {
  return (
    (value.phase === undefined ||
      ["model", "tool", "retrying", "waiting"].includes(value.phase)) &&
    (value.activity === undefined ||
      taskSessionActivityLabels.includes(value.activity)) &&
    (value.progress === undefined || isTaskSessionProgress(value.progress)) &&
    (value.modelCallIncrement === undefined ||
      value.modelCallIncrement === 1) &&
    (value.reportedTotalTokens === undefined ||
      (Number.isSafeInteger(value.reportedTotalTokens) &&
        value.reportedTotalTokens >= 0))
  );
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
export function isPersistedTaskSessionState(
  value: unknown,
  maxPlanTasks = 100,
  maxContextSummaryLength = 16_000,
): value is PersistedTaskSessionState {
  try {
    validatePersisted(
      value as PersistedTaskSessionState,
      maxPlanTasks,
      maxContextSummaryLength,
    );
    return true;
  } catch {
    return false;
  }
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
      plan.synthesisDelivery &&
      typeof plan.synthesisDelivery.payload === "string" &&
      typeof plan.synthesisDelivery.payloadFingerprint === "string" &&
      synthesisDeliveryFingerprint(plan.synthesisDelivery.payload) !==
        plan.synthesisDelivery.payloadFingerprint
    )
      throw new Error(
        "Invalid persisted task-session state: synthesis delivery fingerprint mismatch.",
      );
    if (
      !Number.isSafeInteger(plan.planId) ||
      plan.planId < 1 ||
      planIds.has(plan.planId) ||
      typeof plan.originalPrompt !== "string" ||
      (plan.synthesisAttempts !== undefined &&
        (!Number.isSafeInteger(plan.synthesisAttempts) ||
          plan.synthesisAttempts < 0 ||
          plan.synthesisAttempts > maxSynthesisAttempts)) ||
      (plan.synthesisDelivery !== undefined &&
        !isSynthesisDelivery(plan.synthesisDelivery)) ||
      (plan.synthesisFailureTrace !== undefined &&
        typeof plan.synthesisFailureTrace !== "string") ||
      (plan.synthesisCapped !== undefined && plan.synthesisCapped !== true) ||
      (plan.synthesisCapped === true &&
        (plan.synthesisAttempts ?? 0) < maxSynthesisAttempts)
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
        (entry.terminalElapsedMs !== undefined &&
          (!Number.isSafeInteger(entry.terminalElapsedMs) ||
            entry.terminalElapsedMs < 0)) ||
        (entry.phase !== undefined &&
          !["model", "tool", "retrying", "waiting"].includes(entry.phase)) ||
        (entry.modelCallCount !== undefined &&
          (!Number.isSafeInteger(entry.modelCallCount) ||
            entry.modelCallCount < 1)) ||
        (entry.totalTokens !== undefined &&
          (!Number.isSafeInteger(entry.totalTokens) ||
            entry.totalTokens < 0)) ||
        (entry.latestActivity !== undefined &&
          !taskSessionActivityLabels.includes(entry.latestActivity)) ||
        (entry.latestActivityAtMs !== undefined &&
          (!Number.isSafeInteger(entry.latestActivityAtMs) ||
            entry.latestActivityAtMs < 0)) ||
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
function isSynthesisDelivery(value: unknown): value is SynthesisDelivery {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as SynthesisDelivery).id === "string" &&
    (value as SynthesisDelivery).id.length >= 8 &&
    Number.isSafeInteger((value as SynthesisDelivery).attempt) &&
    (value as SynthesisDelivery).attempt >= 0 &&
    typeof (value as SynthesisDelivery).payload === "string" &&
    typeof (value as SynthesisDelivery).payloadFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test((value as SynthesisDelivery).payloadFingerprint) &&
    (value as SynthesisDelivery).payload.includes(
      synthesisDeliveryMarker((value as SynthesisDelivery).id),
    ) &&
    synthesisDeliveryFingerprint((value as SynthesisDelivery).payload) ===
      (value as SynthesisDelivery).payloadFingerprint &&
    ((value as SynthesisDelivery).state === "dispatching" ||
      (value as SynthesisDelivery).state === "delivered")
  );
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
