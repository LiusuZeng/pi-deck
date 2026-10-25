import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { buildFakeRpcServer, writeFakePiShim } from "../test/fakeRpcHarness.js";
import { SinglePiAdapter } from "./pi/piAdapter.js";
import { SettingsStore } from "./settings/settingsStore.js";
import { WorkspaceUsageStore } from "./workspaces/workspaceUsage.js";

vi.mock("electron", () => ({
  app: {
    dock: { setIcon: vi.fn() },
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => "0.0.0-test",
    on: vi.fn(),
    quit: vi.fn(),
    setPath: vi.fn(),
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return [];
    }
  },
  dialog: {},
  nativeImage: { createFromPath: vi.fn() },
  nativeTheme: {
    on: vi.fn(),
    shouldUseDarkColors: false,
    themeSource: "system",
  },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
  webContents: { fromId: vi.fn() },
}));

class PlannerHarnessAdapter {
  private readonly workers = new SinglePiAdapter();
  private parentAttached = true;

  constructor(private readonly parentId: string) {}

  createWorker(options: Parameters<SinglePiAdapter["createWorker"]>[0]) {
    return this.workers.createWorker(options);
  }

  workerCount(): number {
    return this.workers.workerCount() + (this.parentAttached ? 1 : 0);
  }

  hasRuntime(runtimeId: string): boolean {
    return (
      (runtimeId === this.parentId && this.parentAttached) ||
      this.workers.hasRuntime(runtimeId)
    );
  }

  getMessages(runtimeId: string) {
    if (runtimeId === this.parentId) {
      return Promise.resolve([
        {
          id: "parent-message-1",
          role: "assistant" as const,
          content: "Existing parent context.",
          createdAt: Date.now(),
        },
      ]);
    }
    return this.workers.getMessages(runtimeId);
  }

  getRuntimeStatus(runtimeId: string) {
    if (runtimeId === this.parentId) {
      return Promise.resolve({ runtimeId, cwd: process.cwd() });
    }
    return this.workers.getRuntimeStatus(runtimeId);
  }

  closeSession(runtimeId: string): Promise<void> {
    if (runtimeId === this.parentId) {
      this.parentAttached = false;
      return Promise.resolve();
    }
    return this.workers.closeSession(runtimeId);
  }
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("task-session planner usage accounting", () => {
  const previousFakeServer = process.env.PI_DECK_TEST_FAKE_RPC_SERVER;
  const previousSkipBootstrap = process.env.PI_DECK_SKIP_BOOTSTRAP_FOR_TESTS;
  let roots: string[] = [];

  beforeEach(() => {
    process.env.PI_DECK_SKIP_BOOTSTRAP_FOR_TESTS = "1";
    process.env.PI_DECK_TEST_FAKE_RPC_SERVER = buildFakeRpcServer();
    roots = [];
  });

  afterEach(() => {
    if (previousFakeServer === undefined) {
      delete process.env.PI_DECK_TEST_FAKE_RPC_SERVER;
    } else {
      process.env.PI_DECK_TEST_FAKE_RPC_SERVER = previousFakeServer;
    }
    if (previousSkipBootstrap === undefined) {
      delete process.env.PI_DECK_SKIP_BOOTSTRAP_FOR_TESTS;
    } else {
      process.env.PI_DECK_SKIP_BOOTSTRAP_FOR_TESTS = previousSkipBootstrap;
    }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("accounts valid, fallback, failed, and partial-cost fake planner attempts", async () => {
    const { __taskSessionPlannerTestHooks } = await import("./main.js");
    const root = mkdtempSync(path.join(tmpdir(), "pi-deck-planner-main-"));
    roots.push(root);
    const sessionFile = path.join(root, "parent.jsonl");
    writeFileSync(sessionFile, "");
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const parentId = "parent-planner-main";
    const harnessAdapter = new PlannerHarnessAdapter(parentId);
    const adapter = harnessAdapter as unknown as SinglePiAdapter;
    const settings = new SettingsStore(root);
    const usageStore = new WorkspaceUsageStore(root);
    const setPlannerFixture = (name: string, args: string[] = []) => {
      const shim = path.join(root, `${name}.cjs`);
      writeFakePiShim(shim, args);
      process.env.PI_DECK_TEST_FAKE_RPC_SERVER = shim;
    };
    const usage = () =>
      usageStore.getWorkspaceUsage({
        workspaceId,
        sessionFiles: [sessionFile],
      });
    let cancelNextPlanner = false;
    let clearUsageOwnershipOnCancel = false;
    __taskSessionPlannerTestHooks.configurePlannerRuntime({
      adapter,
      workspaceUsageStore: usageStore,
      parentId,
      cwd: process.cwd(),
      workspaceId,
      sessionFile,
      onPlannerWorkerCreated: (worker) => {
        worker.onEvent((event) => {
          if (!cancelNextPlanner || event.type !== "agent_start") return;
          cancelNextPlanner = false;
          // Exercise the same parent cancellation registry used by close,
          // delete, and app teardown rather than directly aborting a worker.
          __taskSessionPlannerTestHooks.cancelPlannerRuntime(parentId);
          if (clearUsageOwnershipOnCancel) {
            clearUsageOwnershipOnCancel = false;
            // A real parent close then drops these maps while the private child
            // is still finishing its SIGTERM terminal event.
            __taskSessionPlannerTestHooks.clearPlannerUsageOwnership(parentId);
          }
        });
      },
    });

    try {
      setPlannerFixture("valid", [
        "--response-text",
        '{"contextSummary":"Validated plan","tasks":[{"generatedName":"Task one","brief":"Implement the focused change."}]}',
      ]);
      const validPlan = await __taskSessionPlannerTestHooks.planTaskSession(
        adapter,
        settings,
        parentId,
        "Split this request into private tasks.",
      );
      assert.deepEqual(validPlan, {
        contextSummary: "Validated plan",
        tasks: [
          { generatedName: "Task one", brief: "Implement the focused change." },
        ],
      });
      await eventually(
        async () => (await usage()).totalTokens === 115,
        "valid planner usage was not persisted",
      );

      setPlannerFixture("malformed", ["--response-text", "not JSON"]);
      const malformedPlan = await __taskSessionPlannerTestHooks.planTaskSession(
        adapter,
        settings,
        parentId,
        "Malformed planner responses still need a fallback.",
      );
      assert.equal(
        malformedPlan.contextSummary.startsWith("Planning was unavailable"),
        true,
      );
      await eventually(
        async () => (await usage()).totalTokens === 230,
        "fallback planner usage was not persisted",
      );

      setPlannerFixture("failed", ["--prompt-scenario", "error"]);
      const failedPlan = await __taskSessionPlannerTestHooks.planTaskSession(
        adapter,
        settings,
        parentId,
        "A reported provider failure still consumed planning work.",
      );
      assert.equal(
        failedPlan.contextSummary.startsWith("Planning was unavailable"),
        true,
      );
      await eventually(
        async () => (await usage()).totalTokens === 345,
        "failed planner usage was not persisted",
      );

      setPlannerFixture("partial-cost", [
        "--omit-usage-cost",
        "--response-text",
        '{"contextSummary":"Partial cost","tasks":[{"generatedName":"Task two","brief":"Keep the reported partial cost."}]}',
      ]);
      await __taskSessionPlannerTestHooks.planTaskSession(
        adapter,
        settings,
        parentId,
        "Plan a partial-cost attempt.",
      );
      await eventually(
        async () => (await usage()).totalTokens === 460,
        "partial-cost planner usage was not persisted",
      );
      const totals = await usage();
      assert.deepEqual(
        { ...totals, knownCostUsd: undefined },
        {
          inputTokens: 400,
          outputTokens: 40,
          cacheReadTokens: 20,
          cacheWriteTokens: 0,
          totalTokens: 460,
          knownCostUsd: undefined,
          contributorsWithCost: 3,
          contributorsWithoutCost: 1,
        },
      );
      assert.equal(totals.knownCostUsd, 0.05 * 3);

      // Pi emits agent_end({ willRetry: true }) for an attempt boundary. The
      // planner must remain alive for the final response and retain both
      // reported attempts in its one private-worker usage snapshot. Distinct
      // run ids must still count separately when a provider reuses message ids.
      setPlannerFixture("retry", [
        "--planner-retry-with-usage",
        "--planner-retry-reused-message-id",
        "--planner-repeat-terminal-observation",
        "--production-shaped",
        "--response-text",
        '{"contextSummary":"Retry complete","tasks":[{"generatedName":"Task retry","brief":"Use the final response."}]}',
      ]);
      const retriedPlan = await __taskSessionPlannerTestHooks.planTaskSession(
        adapter,
        settings,
        parentId,
        "A retrying planner must not be closed at its first agent_end.",
      );
      assert.deepEqual(retriedPlan, {
        contextSummary: "Retry complete",
        tasks: [
          { generatedName: "Task retry", brief: "Use the final response." },
        ],
      });
      await eventually(
        async () => (await usage()).totalTokens === 690,
        "retrying planner attempts were not both persisted",
      );

      // Pi can repeat a retry terminal event without a run/message id of its
      // own. Its stable assistant message id must still make the repeated
      // observation idempotent, while the final run remains a second attempt.
      setPlannerFixture("idless-terminal-retry", [
        "--planner-retry-with-usage",
        "--planner-retry-without-terminal-ids",
        "--planner-repeat-terminal-observation",
        "--production-shaped",
        "--response-text",
        '{"contextSummary":"Idless retry complete","tasks":[{"generatedName":"Task idless retry","brief":"Do not double-count the retry event."}]}',
      ]);
      const idlessRetryPlan =
        await __taskSessionPlannerTestHooks.planTaskSession(
          adapter,
          settings,
          parentId,
          "A repeated retry event without terminal ids is still one attempt.",
        );
      assert.deepEqual(idlessRetryPlan, {
        contextSummary: "Idless retry complete",
        tasks: [
          {
            generatedName: "Task idless retry",
            brief: "Do not double-count the retry event.",
          },
        ],
      });
      await eventually(
        async () => (await usage()).totalTokens === 920,
        "idless repeated retry terminal event was double-counted",
      );

      // Event-level usage and the later transcript describe the same terminal
      // turn, so the latter must not duplicate the authoritative event total.
      setPlannerFixture("fieldless-terminal-event-usage-with-transcript", [
        "--planner-fieldless-terminal-event-usage",
        "--response-text",
        '{"contextSummary":"Event usage","tasks":[{"generatedName":"Task event usage","brief":"Keep the terminal event authoritative."}]}',
      ]);
      const eventUsagePlan =
        await __taskSessionPlannerTestHooks.planTaskSession(
          adapter,
          settings,
          parentId,
          "A fieldless terminal event and transcript are one model turn.",
        );
      assert.deepEqual(eventUsagePlan, {
        contextSummary: "Event usage",
        tasks: [
          {
            generatedName: "Task event usage",
            brief: "Keep the terminal event authoritative.",
          },
        ],
      });
      await eventually(
        async () => (await usage()).totalTokens === 1035,
        "event-level usage was duplicated by its terminal transcript",
      );

      // A fieldless terminal event can itself contain provider usage. Capture
      // it synchronously even when its worker exits and get_messages fails
      // during teardown.
      setPlannerFixture("fieldless-terminal-event-usage", [
        "--planner-fieldless-terminal-event-usage",
        "--planner-exit-after-terminal-event-usage",
        "--fail-command",
        "get_messages",
      ]);
      const fieldlessEventUsagePlan =
        await __taskSessionPlannerTestHooks.planTaskSession(
          adapter,
          settings,
          parentId,
          "A fieldless terminal event still reports model usage.",
        );
      assert.equal(
        fieldlessEventUsagePlan.contextSummary.startsWith(
          "Planning was unavailable",
        ),
        true,
      );
      await eventually(
        async () => (await usage()).totalTokens === 1150,
        "fieldless terminal event usage was lost after transcript failure",
      );

      // A cancellation can race a completed-looking terminal response. Its
      // reported work still belongs in usage, but the late plan must not cause
      // parent-close code to schedule tasks.
      cancelNextPlanner = true;
      setPlannerFixture("cancelled-with-valid-terminal-plan", [
        "--abort-with-valid-plan",
        "--response-text",
        '{"contextSummary":"Late plan","tasks":[{"generatedName":"Must not schedule","brief":"The parent was closed."}]}',
      ]);
      const cancelledWithValidPlan =
        await __taskSessionPlannerTestHooks.planTaskSession(
          adapter,
          settings,
          parentId,
          "Cancellation must reject a terminal plan.",
        );
      assert.equal(
        cancelledWithValidPlan.contextSummary.startsWith(
          "Planning was unavailable",
        ),
        true,
      );
      await eventually(
        async () => (await usage()).totalTokens === 1265,
        "cancelled planner's late terminal usage was not persisted",
      );

      // Pi can put a complete private response in agent_end while omitting its
      // usage. The terminal transcript remains authoritative and must be
      // reconciled before close rather than silently recording no snapshot.
      setPlannerFixture("content-bearing-terminal-without-usage", [
        "--production-shaped",
        "--planner-terminal-without-usage",
        "--response-text",
        '{"contextSummary":"Transcript usage","tasks":[{"generatedName":"Task transcript","brief":"Use the authoritative usage."}]}',
      ]);
      const transcriptUsagePlan =
        await __taskSessionPlannerTestHooks.planTaskSession(
          adapter,
          settings,
          parentId,
          "Reconcile content-bearing terminal messages.",
        );
      assert.deepEqual(transcriptUsagePlan, {
        contextSummary: "Transcript usage",
        tasks: [
          {
            generatedName: "Task transcript",
            brief: "Use the authoritative usage.",
          },
        ],
      });
      await eventually(
        async () => (await usage()).totalTokens === 1380,
        "content-bearing terminal event did not reconcile transcript usage",
      );

      cancelNextPlanner = true;
      clearUsageOwnershipOnCancel = true;
      setPlannerFixture("cancelled-with-fieldless-usage", [
        // Abort emits a fieldless terminal event while get_messages retains
        // this reported turn. Parent cancellation must preserve that RPC until
        // planner accounting has captured the provider's usage.
        "--abort-with-fieldless-usage",
        "--stream-delay-ms",
        "1000",
      ]);
      const cancelledWithUsage =
        await __taskSessionPlannerTestHooks.planTaskSession(
          adapter,
          settings,
          parentId,
          "Cancelled planning can still report model usage.",
        );
      assert.equal(
        cancelledWithUsage.contextSummary.startsWith(
          "Planning was unavailable",
        ),
        true,
      );
      await eventually(
        async () => (await usage()).totalTokens === 1495,
        "cancelled planner's reported terminal usage was not persisted",
      );
      await eventually(
        () => adapter.workerCount() === 1,
        "private planners were not closed",
      );

      cancelNextPlanner = true;
      setPlannerFixture("cancelled-without-usage", [
        "--stream-delay-ms",
        "1000",
      ]);
      const cancelledWithoutUsage =
        await __taskSessionPlannerTestHooks.planTaskSession(
          adapter,
          settings,
          parentId,
          "Cancellation without provider usage must remain unknown.",
        );
      assert.equal(
        cancelledWithoutUsage.contextSummary.startsWith(
          "Planning was unavailable",
        ),
        true,
      );
      await eventually(
        () => adapter.workerCount() === 1,
        "usage-less planner cancellation was not closed",
      );
      assert.equal((await usage()).totalTokens, 1495);

      // Task-worker and parent-synthesis snapshots use the same parent
      // ownership path but distinct keys, so they must aggregate with the
      // planner rather than replace or duplicate its terminal contribution.
      const reportedUsage = {
        id: "task-or-synthesis-usage",
        role: "assistant",
        content: "private output is intentionally not persisted",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 5,
          cacheWriteTokens: 0,
          totalTokens: 115,
          totalCostUsd: 0.05,
        },
      };
      await usageStore.recordSessionMessagesUsage({
        workspaceId,
        sessionFile,
        sessionKey: `${parentId}:private:task-worker`,
        source: "parallel",
        messages: [reportedUsage],
      });
      await usageStore.recordSessionMessagesUsage({
        workspaceId,
        sessionFile,
        sessionKey: parentId,
        source: "session",
        messages: [reportedUsage],
      });
      const aggregated = await usage();
      assert.equal(aggregated.totalTokens, 1725);
      assert.ok(Math.abs(aggregated.knownCostUsd - 0.7) < Number.EPSILON);
      assert.equal(
        (
          await new WorkspaceUsageStore(root).getWorkspaceUsage({
            workspaceId,
            sessionFiles: [sessionFile],
          })
        ).totalTokens,
        1725,
      );

      assert.equal(
        readFileSync(usageStore.storeFile, "utf8").includes(
          "Split this request",
        ),
        false,
      );
    } finally {
      await __taskSessionPlannerTestHooks.resetPlannerRuntime(parentId);
      await adapter.closeSession(parentId).catch(() => undefined);
    }
  });

  it("preserves delayed planner usage-store persistence across parent deletion", async () => {
    const { __taskSessionPlannerTestHooks } = await import("./main.js");
    const root = mkdtempSync(path.join(tmpdir(), "pi-deck-planner-delete-"));
    roots.push(root);
    const sessionFile = path.join(root, "parent.jsonl");
    writeFileSync(sessionFile, "");
    const workspaceId = "33333333-3333-4333-8333-333333333333";
    const parentId = "parent-planner-delete";
    const adapter = new PlannerHarnessAdapter(
      parentId,
    ) as unknown as SinglePiAdapter;
    const settings = new SettingsStore(root);
    const usageStore = new WorkspaceUsageStore(root);
    const upsertSnapshot = (usageStore as any).upsertSnapshot.bind(usageStore);
    let releasePersistence: () => void = () => undefined;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    // Make the actual private-planner write outlive its bounded close wait.
    // Parent deletion must freeze the late snapshot rather than hiding it
    // behind the now-deleted session owner.
    const recordUsageSpy = vi
      .spyOn(usageStore as any, "upsertSnapshot")
      .mockImplementation(async (...args: any[]) => {
        await persistenceGate;
        await upsertSnapshot(...args);
      });
    const shim = path.join(root, "fieldless-abort.cjs");
    writeFakePiShim(shim, [
      "--abort-with-fieldless-usage",
      "--stream-delay-ms",
      "1000",
    ]);
    process.env.PI_DECK_TEST_FAKE_RPC_SERVER = shim;
    let closeParent: Promise<void> | undefined;
    __taskSessionPlannerTestHooks.configurePlannerRuntime({
      adapter,
      workspaceUsageStore: usageStore,
      parentId,
      cwd: process.cwd(),
      workspaceId,
      sessionFile,
      onPlannerWorkerCreated: (worker) => {
        worker.onEvent((event) => {
          if (event.type !== "agent_start" || closeParent !== undefined) return;
          // Model close/delete: closeAttachedChatRuntime must retain the parent
          // accounting owner through the fieldless abort terminal event.
          closeParent =
            __taskSessionPlannerTestHooks.closePlannerParent(parentId);
        });
      },
    });

    try {
      const planner = __taskSessionPlannerTestHooks.runTaskSessionPlanner(
        adapter,
        settings,
        parentId,
        "Account this planner before deleting its parent session.",
      );
      const plannerFailure = assert.rejects(
        planner,
        /Task-session planner was cancelled/,
      );
      await eventually(
        () => closeParent !== undefined,
        "planner parent close did not begin",
      );
      await plannerFailure;
      await closeParent;
      await usageStore.freezeSessionUsage({ workspaceId, sessionFile });
      // The close path has now timed out its accounting wait and deletion has
      // frozen the parent. Let the captured write complete afterward.
      releasePersistence();
      await eventually(
        async () =>
          (
            await usageStore.getWorkspaceUsage({
              workspaceId,
              sessionFiles: [],
            })
          ).totalTokens === 115,
        "late planner usage was hidden behind the deleted parent session",
      );
      const frozenUsage = await usageStore.getWorkspaceUsage({
        workspaceId,
        sessionFiles: [],
      });
      assert.equal(frozenUsage.totalTokens, 115);
      assert.equal(frozenUsage.knownCostUsd, 0.05);
      assert.equal(adapter.workerCount(), 0);
    } finally {
      releasePersistence();
      recordUsageSpy.mockRestore();
      await __taskSessionPlannerTestHooks.resetPlannerRuntime(parentId);
      await adapter.closeSession(parentId).catch(() => undefined);
    }
  });
});
