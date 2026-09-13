import { describe, expect, it } from "vitest";
import { synthesisDeliveryPayload } from "./taskSessionSynthesisDelivery.js";
import {
  TaskSessionOrchestrator,
  isPersistedTaskSessionState,
  taskSessionProgressForWorkerEventType,
  taskSessionTelemetryForWorkerEventType,
  type PersistedTaskSessionState,
  type TaskSessionLaunch,
  type TaskSessionLifecycle,
} from "./taskSessionOrchestrator.js";

type Worker = { close(): void };
function setup(capacity = 20) {
  const launches: TaskSessionLaunch<string>[] = [];
  const states: ReturnType<TaskSessionOrchestrator<string, Worker>["state"]>[] =
    [];
  let workers = 0;
  const receipts = new Set<string>();
  const orchestrator = new TaskSessionOrchestrator<string, Worker>({
    plan: () => ({
      contextSummary: "relevant parent history",
      tasks: [
        { generatedName: "one", brief: "first task" },
        { generatedName: "two", brief: "second task" },
      ],
    }),
    resolveWorkerSettings: ({ parentSettings, promptSettings }) => ({
      ...parentSettings,
      ...promptSettings,
    }),
    createWorker: (launch) => {
      launches.push(launch);
      workers++;
      return {
        close: () => {
          workers--;
        },
      };
    },
    hasGlobalCapacity: () => workers < capacity,
    synthesize: async ({ delivery, markDispatched }) => {
      await markDispatched();
      receipts.add(delivery.id);
    },
    hasSynthesisDelivery: ({ delivery }) => receipts.has(delivery.id),
    onState: (_parent, state) => states.push(state),
  });
  orchestrator.addParent("parent", {
    mode: "parallel",
    workerSettings: {
      model: "parent",
      runtimeConfiguration: { private: true },
    },
  });
  return { orchestrator, launches, states };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function persistedState(
  lifecycle: TaskSessionLifecycle | readonly TaskSessionLifecycle[],
  options: { synthesisAttempts?: number; synthesisReported?: boolean } = {},
): PersistedTaskSessionState {
  const lifecycles = typeof lifecycle === "string" ? [lifecycle] : lifecycle;
  return {
    version: 1,
    mode: "parallel",
    nextTaskNumber: lifecycles.length + 1,
    plans: [
      {
        planId: 1,
        contextSummary: "restored context",
        originalPrompt: "restored prompt",
        ...(options.synthesisAttempts !== undefined
          ? { synthesisAttempts: options.synthesisAttempts }
          : {}),
        ...(options.synthesisReported ? { synthesisReported: true } : {}),
        tasks: lifecycles.map((savedLifecycle, index) => ({
          taskNumber: index + 1,
          generatedName: `task ${index + 1}`,
          brief: `brief ${index + 1}`,
          lifecycle: savedLifecycle,
          attempt: 1,
          transitions: [{ lifecycle: savedLifecycle, attempt: 1 }],
          ...(savedLifecycle === "completed" ? { handoffSummary: "done" } : {}),
        })),
      },
    ],
  };
}
function setupRestore(
  synthesize: () => void | Promise<void>,
  onState: () => void = () => undefined,
) {
  const launches: TaskSessionLaunch<string>[] = [];
  const receipts = new Set<string>();
  const orchestrator = new TaskSessionOrchestrator<string, Worker>({
    plan: () => ({
      contextSummary: "context",
      tasks: [{ generatedName: "one", brief: "brief" }],
    }),
    resolveWorkerSettings: () => ({}),
    createWorker: (launch) => {
      launches.push(launch);
      return { close: () => undefined };
    },
    hasGlobalCapacity: () => true,
    synthesize: async (input) => {
      await input.markDispatched();
      await synthesize();
      receipts.add(input.delivery.id);
    },
    hasSynthesisDelivery: ({ delivery }) => receipts.has(delivery.id),
    scheduleSynthesisRetry: () => undefined,
    onState,
  });
  orchestrator.addParent("parent", { mode: "parallel" });
  return { orchestrator, launches };
}

describe("TaskSessionOrchestrator", () => {
  it("requires a validated plan and gives every child private context/settings", async () => {
    const { orchestrator, launches } = setup();
    await orchestrator.submit("parent", "original user prompt", {
      thinkingLevel: "high",
      runtimeConfiguration: { transient: true },
    });
    await tick();
    expect(launches).toHaveLength(2);
    expect(launches[0].request).toEqual({
      contextSummary: "relevant parent history",
      originalPrompt: "original user prompt",
      brief: "first task",
      workerSettings: { model: "parent", thinkingLevel: "high" },
    });
    expect(JSON.stringify(orchestrator.state("parent"))).not.toContain(
      "original user prompt",
    );
  });

  it("limits each parent to ten active tasks and prioritizes a reserved retry at that limit", async () => {
    const launches: TaskSessionLaunch<string>[] = [];
    let workers = 0;
    const ten = Array.from({ length: 11 }, (_, index) => ({
      generatedName: `task ${index + 1}`,
      brief: `brief ${index + 1}`,
    }));
    const limited = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({ contextSummary: "context", tasks: ten }),
      resolveWorkerSettings: () => ({}),
      createWorker: (launch) => {
        launches.push(launch);
        workers++;
        return {
          close: () => {
            workers--;
          },
        };
      },
      hasGlobalCapacity: () => workers < 10,
      synthesize: () => undefined,
      onState: () => undefined,
    });
    limited.addParent("a", { mode: "parallel" });
    await limited.submit("a", "a");
    await tick();
    expect(limited.state("a").activeCount).toBe(10);
    launches[0].callbacks.failed(new Error("retry"));
    await tick();
    await tick();
    expect(
      launches.map(({ taskNumber, attempt }) => [taskNumber, attempt]),
    ).toContainEqual([1, 2]);
    expect(launches.filter((launch) => launch.taskNumber === 11)).toHaveLength(
      0,
    );
    expect(limited.state("a").activeCount).toBe(10);
  });

  it("makes exactly three retries after the initial attempt then synthesizes once", async () => {
    const { launches } = setup();
    let reports = 0;
    let receipt = false;
    const reporter = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: (launch) => {
        launches.push(launch);
        return { close: () => undefined };
      },
      hasGlobalCapacity: () => true,
      synthesize: async ({ markDispatched }) => {
        await markDispatched();
        reports++;
        receipt = true;
      },
      hasSynthesisDelivery: () => receipt,
      onState: () => undefined,
    });
    reporter.addParent("parent", { mode: "parallel" });
    await reporter.submit("parent", "prompt");
    for (let index = 0; index < 4; index++) {
      await tick();
      launches.at(-1)!.callbacks.failed(new Error("nope"));
    }
    await tick();
    await tick();
    expect(
      launches.map((launch) => [launch.taskNumber, launch.attempt]),
    ).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
    ]);
    expect(reports).toBe(1);
    expect(reporter.state("parent").tasks).toEqual([]);
  });

  it("retains a durable terminal trace after successful synthesis but clears it from state", async () => {
    const { orchestrator, launches } = setup();
    await orchestrator.submit(
      "parent",
      "private original prompt",
      { project: "p" },
      {
        input: {
          text: "ephemeral attachment path /private/secret.txt",
          images: [{ data: "SECRET_BASE64", mimeType: "image/png" }],
        },
      },
    );
    await tick();
    expect(launches[0].request.runtimeContext).toMatchObject({
      input: { text: expect.stringContaining("/private/secret.txt") },
    });
    launches[0].callbacks.completed({ summary: "done\nraw" });
    launches[1].callbacks.completed({ summary: "done" });
    await tick();
    await tick();
    expect(orchestrator.state("parent").tasks).toEqual([]);
    const saved = orchestrator.exportState("parent");
    expect(saved.plans[0]).toMatchObject({
      originalPrompt: "private original prompt",
      contextSummary: "relevant parent history",
      promptSettings: { project: "p" },
      synthesisReported: true,
    });
    expect(saved.plans[0].tasks[0]).toMatchObject({
      attempt: 1,
      lifecycle: "completed",
      handoffSummary: "done raw",
    });
    expect(saved.plans[0].tasks[0].transitions[0].at).toEqual(
      expect.any(Number),
    );
    expect(saved.workerSettings).toEqual({ model: "parent" });
    expect(JSON.stringify(saved)).not.toContain("runtimeConfiguration");
    expect(JSON.stringify(saved)).not.toContain("/private/secret.txt");
    expect(JSON.stringify(saved)).not.toContain("SECRET_BASE64");
  });

  it("keeps one reserved restored synthesis across repeated reconciliation", async () => {
    let resolveDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    let deliveryStarted = false;
    let deliveries = 0;
    let current: ReturnType<typeof setupRestore> | undefined;
    const publications: {
      state: PersistedTaskSessionState;
      deliveryStarted: boolean;
    }[] = [];
    const restored = setupRestore(
      () => {
        deliveryStarted = true;
        deliveries++;
        return delivery;
      },
      () => {
        if (current)
          publications.push({
            state: current.orchestrator.exportState("parent"),
            deliveryStarted,
          });
      },
    );
    current = restored;

    const saved = persistedState("completed");
    restored.orchestrator.restore("parent", saved);
    // A duplicate reconciliation can see the pre-reservation store snapshot.
    // It must retain the in-flight plan instead of launching a second report.
    restored.orchestrator.restore("parent", saved);

    await tick();
    const reservation = publications.find(
      ({ state }) => state.plans[0]?.synthesisAttempts === 1,
    );
    expect(reservation).toMatchObject({
      deliveryStarted: false,
      state: { plans: [{ synthesisAttempts: 1 }] },
    });
    expect(reservation?.state.plans[0]?.synthesisReported).toBeUndefined();
    expect(restored.orchestrator.state("parent").tasks).toHaveLength(1);
    expect(deliveries).toBe(1);

    resolveDelivery();
    await tick();
    const reported = restored.orchestrator.exportState("parent");
    expect(reported.plans[0]).toMatchObject({
      synthesisAttempts: 1,
      synthesisReported: true,
    });
    restored.orchestrator.restore("parent", reported);
    await tick();
    expect(deliveries).toBe(1);
  });

  it("synthesizes restored all-failed terminal plans without relaunching workers", async () => {
    let reports = 0;
    const restored = setupRestore(() => {
      reports++;
    });
    restored.orchestrator.restore(
      "parent",
      persistedState(["failed", "failed"], { synthesisAttempts: 1 }),
    );
    await tick();
    expect(restored.launches).toHaveLength(0);
    expect(reports).toBe(1);
    expect(restored.orchestrator.state("parent").tasks).toEqual([]);
    expect(restored.orchestrator.exportState("parent").plans[0]).toMatchObject({
      synthesisAttempts: 2,
      synthesisReported: true,
    });
  });

  it("marks mixed restored work interrupted without synthesizing or relaunching", async () => {
    let reports = 0;
    const restored = setupRestore(() => {
      reports++;
    });
    restored.orchestrator.restore(
      "parent",
      persistedState(["completed", "running"]),
    );
    await tick();
    restored.orchestrator.scheduleAll();
    await tick();
    expect(restored.launches).toHaveLength(0);
    expect(restored.orchestrator.state("parent").tasks).toMatchObject([
      { lifecycle: "completed" },
      { lifecycle: "interrupted" },
    ]);
    expect(reports).toBe(0);
    const reconciled = restored.orchestrator.exportState("parent");
    const interruptedTransitions = reconciled.plans[0]!.tasks[1]!.transitions;
    restored.orchestrator.restore("parent", reconciled);
    await tick();
    expect(restored.launches).toHaveLength(0);
    expect(reports).toBe(0);
    expect(
      restored.orchestrator.exportState("parent").plans[0]!.tasks[1]!
        .transitions,
    ).toEqual(interruptedTransitions);

    const rerestored = setupRestore(() => {
      reports++;
    });
    rerestored.orchestrator.restore(
      "parent",
      restored.orchestrator.exportState("parent"),
    );
    await tick();
    expect(rerestored.launches).toHaveLength(0);
    expect(rerestored.orchestrator.state("parent").tasks).toMatchObject([
      { lifecycle: "completed" },
      { lifecycle: "interrupted" },
    ]);
    expect(reports).toBe(0);
  });

  it("does not duplicate synthesis for restored reported plans", async () => {
    let reports = 0;
    const restored = setupRestore(() => {
      reports++;
    });
    restored.orchestrator.restore(
      "parent",
      persistedState("completed", {
        synthesisAttempts: 1,
        synthesisReported: true,
      }),
    );
    await tick();
    restored.orchestrator.scheduleAll();
    await tick();
    expect(restored.launches).toHaveLength(0);
    expect(reports).toBe(0);
  });

  it("does not make a fifth synthesis attempt for restored terminal plans at the cap", async () => {
    let reports = 0;
    const restored = setupRestore(() => {
      reports++;
    });
    restored.orchestrator.restore(
      "parent",
      persistedState("completed", { synthesisAttempts: 4 }),
    );
    await tick();
    restored.orchestrator.scheduleAll();
    restored.orchestrator.scheduleAll();
    await tick();
    expect(restored.launches).toHaveLength(0);
    expect(reports).toBe(0);
    expect(restored.orchestrator.exportState("parent").plans[0]).toMatchObject({
      synthesisAttempts: 4,
    });
  });

  it("projects generic live progress, ticks from a stable start timestamp, and freezes terminal elapsed time", async () => {
    const launches: TaskSessionLaunch<string>[] = [];
    let now = 1_000;
    const orchestrator = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: (launch) => {
        launches.push(launch);
        return { close: () => undefined };
      },
      hasGlobalCapacity: () => true,
      synthesize: () => {
        throw new Error("retain terminal row");
      },
      scheduleSynthesisRetry: () => undefined,
      onState: () => undefined,
      now: () => now,
    });
    orchestrator.addParent("parent", { mode: "parallel" });
    await orchestrator.submit("parent", "private prompt");
    await tick();
    launches[0].callbacks.progress("Using a tool");
    now = 6_500;
    expect(orchestrator.state("parent").tasks[0]).toMatchObject({
      startedAtMs: 1_000,
      elapsedMs: 5_500,
      progress: "Using a tool",
    });
    expect(JSON.stringify(orchestrator.exportState("parent"))).not.toContain(
      "Using a tool",
    );
    launches[0].callbacks.failed(new Error("private failure"));
    await tick();
    await tick();
    now = 7_500;
    expect(orchestrator.state("parent").tasks[0]).toMatchObject({
      lifecycle: "running",
      startedAtMs: 6_500,
      elapsedMs: 1_000,
    });
    // Exhaust retries to retain a terminal row while synthesis fails.
    launches.at(-1)!.callbacks.failed(new Error("private failure"));
    await tick();
    await tick();
    now = 9_500;
    launches.at(-1)!.callbacks.failed(new Error("private failure"));
    await tick();
    await tick();
    now = 12_500;
    launches.at(-1)!.callbacks.failed(new Error("private failure"));
    await tick();
    await tick();
    const terminalElapsed = orchestrator.state("parent").tasks[0].elapsedMs;
    now = 30_000;
    expect(orchestrator.state("parent").tasks[0]).toMatchObject({
      lifecycle: "failed",
      elapsedMs: terminalElapsed,
    });
    expect(orchestrator.state("parent").tasks[0].startedAtMs).toBeUndefined();
    const restored = setup();
    restored.orchestrator.restore("parent", orchestrator.exportState("parent"));
    expect(restored.orchestrator.state("parent").tasks[0]).toMatchObject({
      lifecycle: "failed",
      elapsedMs: terminalElapsed,
    });
  });

  it("reduces independent, payload-free telemetry without inventing usage", async () => {
    const launches: TaskSessionLaunch<string>[] = [];
    let now = 1_000;
    const orchestrator = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [
          { generatedName: "one", brief: "brief one" },
          { generatedName: "two", brief: "brief two" },
        ],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: (launch) => {
        launches.push(launch);
        return { close: () => undefined };
      },
      hasGlobalCapacity: () => true,
      synthesize: () => {
        throw new Error("retain terminal rows");
      },
      scheduleSynthesisRetry: () => undefined,
      onState: () => undefined,
      now: () => now,
    });
    orchestrator.addParent("parent", { mode: "parallel" });
    await orchestrator.submit("parent", "private prompt");
    await tick();

    launches[0].callbacks.telemetry({
      phase: "model",
      activity: "Started model call",
      modelCallIncrement: 1,
    });
    now = 2_000;
    launches[0].callbacks.telemetry({
      phase: "tool",
      activity: "Running a tool",
    });
    launches[1].callbacks.telemetry({
      phase: "retrying",
      activity: "Retrying model call",
      modelCallIncrement: 1,
      reportedTotalTokens: 40,
    });
    const [first, second] = orchestrator.state("parent").tasks;
    expect(first).toMatchObject({
      phase: "tool",
      modelCallCount: 1,
      latestActivity: "Running a tool",
      latestActivityAtMs: 2_000,
    });
    // No stats report means pending/unknown, never a fabricated zero.
    expect(first?.totalTokens).toBeUndefined();
    expect(second).toMatchObject({
      phase: "retrying",
      modelCallCount: 1,
      totalTokens: 40,
    });
    // An explicit Pi zero is still authoritative; only missing stats are pending.
    launches[0].callbacks.telemetry({ reportedTotalTokens: 0 });
    expect(orchestrator.state("parent").tasks[0]?.totalTokens).toBe(0);

    // A stale stats response cannot reduce the cumulative per-attempt total.
    launches[1].callbacks.telemetry({ reportedTotalTokens: 10 });
    expect(orchestrator.state("parent").tasks[1]?.totalTokens).toBe(40);
    launches[0].callbacks.completed();
    await tick();
    const terminal = orchestrator.state("parent").tasks[0];
    expect(terminal).toMatchObject({
      lifecycle: "completed",
      modelCallCount: 1,
      latestActivity: "Running a tool",
    });
    expect(terminal?.totalTokens).toBe(0);
    // A delayed stats continuation belongs to a closed attempt and must not
    // mutate its terminal accounting.
    launches[0].callbacks.telemetry({ reportedTotalTokens: 99 });
    expect(orchestrator.state("parent").tasks[0]?.totalTokens).toBe(0);
    // Terminal safe telemetry survives a relaunch, while nonterminal private
    // counters are deliberately not reconstructed as live state.
    const saved = orchestrator.exportState("parent");
    expect(saved.plans[0]?.tasks[0]).toMatchObject({
      phase: "tool",
      modelCallCount: 1,
      latestActivity: "Running a tool",
    });
    expect(saved.plans[0]?.tasks[1]).not.toHaveProperty("modelCallCount");
    const restored = setup();
    restored.orchestrator.restore("parent", saved);
    expect(restored.orchestrator.state("parent").tasks[0]).toMatchObject({
      lifecycle: "completed",
      modelCallCount: 1,
      latestActivity: "Running a tool",
    });
    expect(restored.orchestrator.state("parent").tasks[1]).not.toHaveProperty(
      "modelCallCount",
    );
  });

  it("maps child event types to allowlisted generic progress without event payloads", () => {
    expect(taskSessionProgressForWorkerEventType("agent_start")).toBe(
      "Started",
    );
    expect(taskSessionProgressForWorkerEventType("tool_execution_update")).toBe(
      "Using a tool",
    );
    expect(taskSessionProgressForWorkerEventType("tool_execution_end")).toBe(
      "Tool step completed",
    );
    expect(taskSessionProgressForWorkerEventType("message_update")).toBe(
      "Preparing result",
    );
    expect(taskSessionProgressForWorkerEventType("extension_ui_request")).toBe(
      "Waiting for parent",
    );
    expect(
      taskSessionProgressForWorkerEventType("worker_exit"),
    ).toBeUndefined();
    expect(taskSessionTelemetryForWorkerEventType("agent_start")).toEqual({
      phase: "model",
      activity: "Started model call",
      modelCallIncrement: 1,
    });
    expect(
      taskSessionTelemetryForWorkerEventType("tool_execution_start"),
    ).toEqual({
      phase: "tool",
      activity: "Running a tool",
    });
    expect(taskSessionTelemetryForWorkerEventType("auto_retry_start")).toEqual({
      phase: "retrying",
      activity: "Retrying model call",
      modelCallIncrement: 1,
    });
    expect(
      taskSessionTelemetryForWorkerEventType("extension_ui_request"),
    ).toEqual({
      phase: "waiting",
      activity: "Waiting for parent",
    });
    expect(
      taskSessionTelemetryForWorkerEventType("thinking_delta"),
    ).toBeUndefined();
  });

  it("persists safe parent defaults and exposes replacement worker-settings APIs", () => {
    const { orchestrator } = setup();
    expect(orchestrator.getWorkerSettings("parent")).toEqual({
      model: "parent",
    });
    orchestrator.updateWorkerSettings("parent", {
      thinkingLevel: "high",
      runtimeConfiguration: { no: "persist" },
    });
    expect(orchestrator.getWorkerSettings("parent")).toEqual({
      thinkingLevel: "high",
    });
    expect(orchestrator.exportState("parent").workerSettings).toEqual({
      thinkingLevel: "high",
    });
  });

  it("returns capacity-denied worker creation to its prior queue state without consuming an attempt", async () => {
    const launches: TaskSessionLaunch<string>[] = [];
    const states: ReturnType<
      TaskSessionOrchestrator<string, Worker>["state"]
    >[] = [];
    let denied = true;
    const orchestrator = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: (launch) => {
        if (denied) throw new Error("worker pool full");
        launches.push(launch);
        return { close: () => undefined };
      },
      hasGlobalCapacity: () => true,
      isCapacityUnavailable: (error) =>
        error instanceof Error && error.message === "worker pool full",
      synthesize: () => undefined,
      onState: (_parent, state) => states.push(state),
    });
    orchestrator.addParent("parent", { mode: "parallel" });
    await orchestrator.submit("parent", "prompt");
    await tick();
    expect(orchestrator.state("parent").tasks[0]).toMatchObject({
      lifecycle: "queued",
      attempt: 1,
      queueReason: expect.stringContaining("unavailable"),
    });
    expect(launches).toHaveLength(0);
    denied = false;
    await tick();
    expect(launches).toHaveLength(0); // Capacity denial pauses draining until scheduleAll.
    orchestrator.scheduleAll();
    await tick();
    expect(launches.map((launch) => launch.attempt)).toEqual([1]);
    expect(states.at(-1)?.tasks[0].queueReason).toBeUndefined();
  });

  it("retries failed synthesis delivery three times on an injected scheduler and persists its trace", async () => {
    const launches: TaskSessionLaunch<string>[] = [];
    const retries: (() => void)[] = [];
    let reports = 0;
    const orchestrator = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: (launch) => {
        launches.push(launch);
        return { close: () => undefined };
      },
      hasGlobalCapacity: () => true,
      hasSynthesisDelivery: () => false,
      synthesize: async ({ markDispatched }) => {
        await markDispatched();
        reports++;
        throw new Error("delivery unavailable");
      },
      scheduleSynthesisRetry: (callback, delay) => {
        expect(delay).toBe(0);
        retries.push(callback);
      },
      synthesisRetryDelayMs: 0,
      onState: () => undefined,
    });
    orchestrator.addParent("parent", { mode: "parallel" });
    await orchestrator.submit("parent", "prompt");
    await tick();
    launches[0].callbacks.completed();
    for (let index = 0; index < 3; index++) {
      await tick();
      await tick();
      expect(retries).toHaveLength(1);
      retries.shift()!();
    }
    await tick();
    await tick();
    await tick();
    await tick();
    expect(reports).toBe(4);
    // The cap decision gets one receipt-only reconciliation; it must not send.
    expect(retries).toHaveLength(1);
    retries.shift()!();
    await tick();
    expect(reports).toBe(4);
    expect(retries).toHaveLength(0);
    expect(orchestrator.state("parent").tasks).toHaveLength(1);
    expect(orchestrator.exportState("parent").plans[0]).toMatchObject({
      synthesisAttempts: 4,
      synthesisCapped: true,
      synthesisFailureTrace:
        "Synthesis send-attempt cap reached without a durable parent receipt.",
    });
  });

  it("retries a pending terminal synthesis when scheduleAll is requested", async () => {
    const launches: TaskSessionLaunch<string>[] = [];
    let failDelivery = true;
    let reports = 0;
    let receipt = false;
    const orchestrator = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: (launch) => {
        launches.push(launch);
        return { close: () => undefined };
      },
      hasGlobalCapacity: () => true,
      synthesize: async ({ markDispatched }) => {
        await markDispatched();
        reports++;
        if (failDelivery) throw new Error("offline");
        receipt = true;
      },
      hasSynthesisDelivery: () => receipt,
      scheduleSynthesisRetry: () => undefined,
      onState: () => undefined,
    });
    orchestrator.addParent("parent", { mode: "parallel" });
    await orchestrator.submit("parent", "prompt");
    await tick();
    launches[0].callbacks.completed();
    await tick();
    expect(orchestrator.state("parent").tasks).toHaveLength(1);
    failDelivery = false;
    orchestrator.scheduleAll();
    await tick();
    expect(reports).toBe(2);
    expect(orchestrator.state("parent").tasks).toEqual([]);
  });

  it("uses a durable write-ahead record before it dispatches a parent synthesis", async () => {
    const events: string[] = [];
    const persisted: PersistedTaskSessionState[] = [];
    let receipt = false;
    const reporter = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      persistSynthesisDelivery: (_parent, state) => {
        events.push("persist");
        persisted.push(state);
      },
      synthesize: async ({ delivery, markDispatched }) => {
        await markDispatched();
        events.push("dispatch");
        receipt = true;
        expect(delivery).toMatchObject({
          attempt: 1,
          state: "dispatching",
          payload: expect.stringContaining(
            "<!-- pi-deck-synthesis-delivery:v1:",
          ),
          payloadFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(events).toContain("persist");
      },
      hasSynthesisDelivery: () => receipt,
      onState: () => undefined,
    });
    reporter.addParent("parent", { mode: "parallel" });
    reporter.restore("parent", persistedState("completed"));
    await tick();
    await tick();
    expect(events.indexOf("persist")).toBeLessThan(events.indexOf("dispatch"));
    expect(persisted[0]?.plans[0]?.synthesisDelivery).toMatchObject({
      attempt: 0,
      state: "dispatching",
    });
    expect(
      persisted.some(
        (state) => state.plans[0]?.synthesisDelivery?.attempt === 1,
      ),
    ).toBe(true);
  });

  it("does not dispatch when the write-ahead persistence barrier fails", async () => {
    const retries: (() => void)[] = [];
    let dispatches = 0;
    const reporter = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      persistSynthesisDelivery: () => {
        throw new Error("disk full");
      },
      synthesize: () => {
        dispatches++;
      },
      scheduleSynthesisRetry: (retry) => retries.push(retry),
      synthesisRetryDelayMs: 0,
      onState: () => undefined,
    });
    reporter.addParent("parent", { mode: "parallel" });
    reporter.restore("parent", persistedState("completed"));
    await tick();
    expect(dispatches).toBe(0);
    expect(retries).toHaveLength(1);
    expect(reporter.exportState("parent").plans[0]).toMatchObject({
      synthesisDelivery: { state: "dispatching", attempt: 0 },
      synthesisFailureTrace: "disk full",
    });
    expect(
      reporter.exportState("parent").plans[0]?.synthesisAttempts,
    ).toBeUndefined();
  });

  it("fails closed when receipt history cannot be inspected", async () => {
    const retries: (() => void)[] = [];
    let dispatches = 0;
    const reporter = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      persistSynthesisDelivery: () => undefined,
      hasSynthesisDelivery: () => {
        throw new Error("history unavailable");
      },
      synthesize: () => {
        dispatches++;
      },
      scheduleSynthesisRetry: (retry) => retries.push(retry),
      synthesisRetryDelayMs: 0,
      onState: () => undefined,
    });
    reporter.addParent("parent", { mode: "parallel" });
    reporter.restore("parent", persistedState("completed"));
    await tick();
    const delivery = reporter.exportState("parent").plans[0]?.synthesisDelivery;
    expect(dispatches).toBe(0);
    expect(retries).toHaveLength(1);
    expect(delivery).toMatchObject({ state: "dispatching", attempt: 0 });
    retries[0]!();
    await tick();
    expect(
      reporter.exportState("parent").plans[0]?.synthesisDelivery,
    ).toMatchObject({
      id: delivery?.id,
      payload: delivery?.payload,
      payloadFingerprint: delivery?.payloadFingerprint,
      attempt: 0,
    });
    expect(dispatches).toBe(0);
  });

  it("recovers a persisted dispatching delivery from its Pi receipt without resending", async () => {
    let dispatches = 0;
    let saved!: PersistedTaskSessionState;
    const first = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      persistSynthesisDelivery: (_parent, state) => {
        saved = state;
      },
      synthesize: async ({ markDispatched }) => {
        await markDispatched();
        return new Promise<void>(() => undefined);
      },
      hasSynthesisDelivery: () => false,
      onState: () => undefined,
    });
    first.addParent("parent", { mode: "parallel" });
    first.restore("parent", persistedState("completed"));
    await tick();
    expect(saved.plans[0]?.synthesisDelivery).toMatchObject({
      state: "dispatching",
      attempt: 1,
    });

    const recovered = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      hasSynthesisDelivery: () => true,
      persistSynthesisDelivery: (_parent, state) => {
        saved = state;
      },
      synthesize: () => {
        dispatches++;
      },
      onState: () => undefined,
    });
    recovered.addParent("parent", { mode: "parallel" });
    recovered.restore("parent", saved);
    await tick();
    await tick();
    expect(dispatches).toBe(0);
    expect(recovered.exportState("parent").plans[0]).toMatchObject({
      synthesisReported: true,
      synthesisDelivery: { state: "delivered", attempt: 1 },
    });
  });

  it("does not consume sends for preflight failures and reuses the exact outbox payload", async () => {
    const retries: (() => void)[] = [];
    const deliveries: string[] = [];
    const reporter = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      hasSynthesisDelivery: () => false,
      synthesize: ({ delivery }) => {
        deliveries.push(delivery.payload);
        throw new Error("parent unavailable during preflight");
      },
      scheduleSynthesisRetry: (retry) => retries.push(retry),
      synthesisRetryDelayMs: 0,
      onState: () => undefined,
    });
    reporter.addParent("parent", { mode: "parallel" });
    reporter.restore("parent", persistedState("completed"));
    await tick();
    retries.shift()!();
    await tick();
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries).size).toBe(1);
    const plan = reporter.exportState("parent").plans[0]!;
    expect(plan.synthesisAttempts).toBeUndefined();
    expect(plan.synthesisDelivery).toMatchObject({
      attempt: 0,
      state: "dispatching",
    });
  });

  it("probes an exhausted cap before failing it and accepts its durable receipt", async () => {
    let sends = 0;
    let probes = 0;
    const delivery = synthesisDeliveryPayload({
      id: "12345678-1234-1234-1234-123456789abc",
      attempt: 4,
      originalPrompt: "restored prompt",
      tasks: persistedState("completed").plans[0]!.tasks,
    });
    const saved = persistedState("completed", { synthesisAttempts: 4 });
    saved.plans[0]!.synthesisDelivery = delivery;
    const receiptAware = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      hasSynthesisDelivery: () => (probes++, true),
      synthesize: () => {
        sends++;
      },
      onState: () => undefined,
    });
    receiptAware.addParent("parent", { mode: "parallel" });
    receiptAware.restore("parent", saved);
    await tick();
    expect(probes).toBe(1);
    expect(sends).toBe(0);
    expect(receiptAware.exportState("parent").plans[0]).toMatchObject({
      synthesisReported: true,
      synthesisDelivery: { state: "delivered", attempt: 4 },
    });
  });

  it("retries a capped delivery when its authoritative receipt probe is unavailable", async () => {
    const retries: (() => void)[] = [];
    let probes = 0;
    let sends = 0;
    const saved = persistedState("completed", { synthesisAttempts: 4 });
    saved.plans[0]!.synthesisDelivery = synthesisDeliveryPayload({
      attempt: 4,
      originalPrompt: "restored prompt",
      tasks: saved.plans[0]!.tasks,
    });
    const reporter = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      hasSynthesisDelivery: () => {
        probes++;
        if (probes === 1) throw new Error("history unavailable");
        return true;
      },
      synthesize: () => {
        sends++;
      },
      scheduleSynthesisRetry: (retry) => retries.push(retry),
      synthesisRetryDelayMs: 0,
      onState: () => undefined,
    });
    reporter.addParent("parent", { mode: "parallel" });
    reporter.restore("parent", saved);
    await tick();
    expect(retries).toHaveLength(1);
    retries.shift()!();
    await tick();
    await tick();
    expect(sends).toBe(0);
    expect(reporter.exportState("parent").plans[0]).toMatchObject({
      synthesisReported: true,
      synthesisDelivery: { state: "delivered", attempt: 4 },
    });
  });

  it("reconciles after the final delivered-state persistence barrier fails", async () => {
    const retries: (() => void)[] = [];
    let writes = 0;
    let persistFails = true;
    let receipt = false;
    let sends = 0;
    const reporter = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      persistSynthesisDelivery: () => {
        writes++;
        if (persistFails && writes >= 4) throw new Error("disk full");
      },
      hasSynthesisDelivery: () => receipt,
      synthesize: async ({ markDispatched }) => {
        sends++;
        await markDispatched();
        receipt = true;
      },
      scheduleSynthesisRetry: (retry) => retries.push(retry),
      synthesisRetryDelayMs: 0,
      onState: () => undefined,
    });
    reporter.addParent("parent", { mode: "parallel" });
    reporter.restore("parent", persistedState("completed"));
    await tick();
    await tick();
    expect(retries).toHaveLength(1);
    persistFails = false;
    retries.shift()!();
    await tick();
    await tick();
    expect(sends).toBe(1);
    expect(reporter.state("parent").tasks).toEqual([]);
  });

  it("recognizes a pre-outbox report with its historical payload instead of resending", async () => {
    let sends = 0;
    const saved = persistedState("completed", { synthesisAttempts: 1 });
    const legacyPayload =
      "Task-session synthesis for: restored prompt\n\n#1 task 1: done";
    const reporter = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "context",
        tasks: [{ generatedName: "one", brief: "brief" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      hasSynthesisDelivery: ({ delivery }) =>
        delivery.payload === legacyPayload,
      synthesize: () => {
        sends++;
      },
      onState: () => undefined,
    });
    reporter.addParent("parent", { mode: "parallel" });
    reporter.restore("parent", saved);
    await tick();
    await tick();
    expect(sends).toBe(0);
    const migrated = reporter.exportState("parent");
    expect(isPersistedTaskSessionState(migrated)).toBe(true);
    expect(migrated.plans[0]).toMatchObject({
      synthesisReported: true,
      synthesisDelivery: {
        attempt: 1,
        state: "delivered",
        payload: legacyPayload,
        legacy: true,
      },
    });
  });

  it("fails closed with a fingerprint diagnostic instead of regenerating corrupt payload", () => {
    const saved = persistedState("completed");
    saved.plans[0]!.synthesisDelivery = {
      ...synthesisDeliveryPayload({
        id: "12345678-1234-1234-1234-123456789abc",
        attempt: 0,
        originalPrompt: "restored prompt",
        tasks: saved.plans[0]!.tasks,
      }),
      payloadFingerprint: "0".repeat(64),
    };
    const restored = setupRestore(() => undefined);
    expect(() => restored.orchestrator.restore("parent", saved)).toThrow(
      /fingerprint mismatch/,
    );
    expect(restored.launches).toHaveLength(0);
  });

  it("requires releasable capacity claims and releases a failed worker creation", async () => {
    expect(
      () =>
        new TaskSessionOrchestrator<string, Worker>({
          plan: () => ({
            contextSummary: "x",
            tasks: [{ generatedName: "x", brief: "x" }],
          }),
          resolveWorkerSettings: () => ({}),
          createWorker: () => ({ close: () => undefined }),
          hasGlobalCapacity: () => true,
          claimGlobalCapacity: () => true,
          synthesize: () => undefined,
          onState: () => undefined,
        }),
    ).toThrow("matching releaseGlobalCapacity");
    let claims = 0;
    const guarded = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({
        contextSummary: "x",
        tasks: [{ generatedName: "x", brief: "x" }],
      }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => {
        throw new Error("create failed");
      },
      hasGlobalCapacity: () => claims === 0,
      claimGlobalCapacity: () => (claims++, true),
      releaseGlobalCapacity: () => {
        claims--;
      },
      synthesize: () => undefined,
      onState: () => undefined,
    });
    guarded.addParent("parent", { mode: "parallel" });
    await guarded.submit("parent", "x");
    await tick();
    expect(claims).toBe(0);
  });
});
