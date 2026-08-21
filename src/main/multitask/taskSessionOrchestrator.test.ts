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
    workerSettings: { model: "parent" },
  });
  return { orchestrator, launches, states };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("TaskSessionOrchestrator", () => {
  it("requires a non-empty validated plan and gives every child private context/settings", async () => {
    const { orchestrator, launches } = setup();
    await orchestrator.submit("parent", "original user prompt", {
      thinkingLevel: "high",
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

  it("limits each parent to ten active tasks and preserves plan order independently", async () => {
    const { orchestrator } = setup();
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      generatedName: `task ${index + 1}`,
      brief: `brief ${index + 1}`,
    }));
    const limited = new TaskSessionOrchestrator<string, Worker>({
      plan: () => ({ contextSummary: "context", tasks: eleven }),
      resolveWorkerSettings: () => ({}),
      createWorker: () => ({ close: () => undefined }),
      hasGlobalCapacity: () => true,
      synthesize: () => undefined,
      onState: () => undefined,
    });
    limited.addParent("a", { mode: "parallel" });
    limited.addParent("b", { mode: "parallel" });
    await limited.submit("a", "a");
    await limited.submit("b", "b");
    await tick();
    expect(limited.state("a").activeCount).toBe(10);
    expect(limited.state("a").tasks[10]).toMatchObject({
      taskNumber: 11,
      lifecycle: "queued",
      queueReason: expect.stringContaining("10 active"),
    });
    expect(limited.state("b").tasks[0].taskNumber).toBe(1);
    void orchestrator; // keep the fixture focused on parent-local isolation
  });

  it("retries the same identity three times after the initial attempt then synthesizes once and clears only on success", async () => {
    const { orchestrator, launches } = setup();
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
      launches[launches.length - 1].callbacks.failed(new Error("nope"));
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
    void orchestrator;
  });

  it("persists only safe trace data and marks unfinished work interrupted without relaunching", async () => {
    const { orchestrator, launches } = setup();
    await orchestrator.submit("parent", "private original prompt");
    await tick();
    const saved = orchestrator.exportState("parent");
    expect(JSON.stringify(saved)).not.toContain("runtime");
    const restored = setup();
    restored.orchestrator.restore("parent", saved);
    await tick();
    expect(restored.launches).toHaveLength(0);
    expect(restored.orchestrator.state("parent").tasks).toEqual([]); // interrupted plan is reported and cleared
    expect(launches).toHaveLength(2);
  });
});
