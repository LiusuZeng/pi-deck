import { describe, expect, it, vi } from "vitest";
import { runtimeTotalTokensFromSessionStats } from "../pi/runtimeUsage.js";
import {
  TaskSessionOrchestrator,
  type TaskSessionLaunch,
} from "./taskSessionOrchestrator.js";
import {
  collectTaskSessionTerminalData,
  taskSessionStatsCollectionTimeoutMs,
} from "./taskSessionTerminalData.js";

type Worker = { close(): void };

function terminalize(
  launch: TaskSessionLaunch<string>,
  getSessionStats: () => Promise<unknown>,
): void {
  void collectTaskSessionTerminalData({
    getMessages: async () => [],
    getSessionStats,
  }).then(({ sessionStats }) => {
    const totalTokens = runtimeTotalTokensFromSessionStats(sessionStats);
    if (totalTokens !== undefined)
      launch.callbacks.telemetry({ reportedTotalTokens: totalTokens });
    launch.callbacks.completed();
  });
}

function setup(
  getSessionStats: (taskNumber: number) => Promise<unknown>,
  taskCount = 1,
) {
  let liveWorkers = 0;
  const closed: number[] = [];
  const launches: number[] = [];
  const synthesized: Array<{
    tasks: readonly { taskNumber: number; totalTokens?: number }[];
  }> = [];
  const orchestrator = new TaskSessionOrchestrator<string, Worker>({
    plan: () => ({
      contextSummary: "context",
      tasks: Array.from({ length: taskCount }, (_, index) => ({
        generatedName: `task ${index + 1}`,
        brief: "brief",
      })),
    }),
    resolveWorkerSettings: () => ({}),
    createWorker: (launch) => {
      launches.push(launch.taskNumber);
      liveWorkers += 1;
      terminalize(launch, () => getSessionStats(launch.taskNumber));
      return {
        close: () => {
          liveWorkers -= 1;
          closed.push(launch.taskNumber);
        },
      };
    },
    hasGlobalCapacity: () => liveWorkers < 1,
    synthesize: ({ tasks }) => synthesized.push({ tasks }),
    onState: () => undefined,
  });
  orchestrator.addParent("parent", { mode: "parallel" });
  return { closed, launches, orchestrator, synthesized };
}

describe("task-session terminal data", () => {
  it("bounds hanging stats so terminal synthesis and the worker slot proceed with unknown usage", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<unknown>(() => undefined);
      const { closed, launches, orchestrator, synthesized } = setup(
        () => never,
        2,
      );
      await orchestrator.submit("parent", "prompt");
      await vi.advanceTimersByTimeAsync(
        taskSessionStatsCollectionTimeoutMs * 2,
      );

      expect(launches).toEqual([1, 2]);
      expect(closed).toEqual([1, 2]);
      expect(synthesized).toHaveLength(1);
      expect(synthesized[0]?.tasks).toEqual([
        expect.objectContaining({ taskNumber: 1 }),
        expect.objectContaining({ taskNumber: 2 }),
      ]);
      expect(
        synthesized[0]?.tasks.every((task) => task.totalTokens === undefined),
      ).toBe(true);
      expect(
        orchestrator
          .exportState("parent")
          .plans[0]?.tasks.every((task) => task.totalTokens === undefined),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes promptly available final Pi stats before terminal synthesis", async () => {
    vi.useFakeTimers();
    try {
      const { orchestrator, synthesized } = setup(async () => ({
        tokens: { total: 115 },
      }));
      await orchestrator.submit("parent", "prompt");
      await vi.advanceTimersByTimeAsync(0);

      expect(synthesized).toHaveLength(1);
      expect(synthesized[0]?.tasks[0]).toMatchObject({ totalTokens: 115 });
      expect(
        orchestrator.exportState("parent").plans[0]?.tasks[0],
      ).toMatchObject({
        totalTokens: 115,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
