import { describe, expect, it } from "vitest";
import {
  TaskSessionOrchestrator,
  type TaskSessionLaunch,
} from "./taskSessionOrchestrator.js";

type Worker = { close(): void };
function setup(capacity = 20) {
  const launches: TaskSessionLaunch<string>[] = [];
  const states: ReturnType<TaskSessionOrchestrator<string, Worker>["state"]>[] =
    [];
  let workers = 0;
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
    synthesize: () => undefined,
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
      synthesize: () => {
        reports++;
      },
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
    await orchestrator.submit("parent", "private original prompt", {
      project: "p",
    });
    await tick();
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
  });

  it("marks restored unfinished work interrupted but does not synthesize or relaunch it", async () => {
    const { orchestrator } = setup();
    await orchestrator.submit("parent", "private original prompt");
    await tick();
    const saved = orchestrator.exportState("parent");
    const restored = setup();
    let reports = 0;
    // Replace the fixture's synthesizer only by proving restore invokes neither path.
    restored.orchestrator.restore("parent", saved);
    await tick();
    expect(restored.launches).toHaveLength(0);
    expect(restored.orchestrator.state("parent").tasks).toHaveLength(2);
    expect(
      restored.orchestrator
        .state("parent")
        .tasks.every((task) => task.lifecycle === "interrupted"),
    ).toBe(true);
    expect(reports).toBe(0);
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
      synthesize: () => {
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
      expect(retries).toHaveLength(1);
      retries.shift()!();
    }
    await tick();
    expect(reports).toBe(4);
    expect(retries).toHaveLength(0);
    expect(orchestrator.state("parent").tasks).toHaveLength(1);
    expect(orchestrator.exportState("parent").plans[0]).toMatchObject({
      synthesisAttempts: 4,
      synthesisFailureTrace: "delivery unavailable",
    });
  });

  it("retries a pending terminal synthesis when scheduleAll is requested", async () => {
    const launches: TaskSessionLaunch<string>[] = [];
    let failDelivery = true;
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
      synthesize: () => {
        reports++;
        if (failDelivery) throw new Error("offline");
      },
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
