import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyActivity } from "./activityInbox.js";
import {
  createInterventionTimelineItem,
  markInterventionQueued,
} from "./interventions.js";
import { emptyOverlays } from "./sessionState.js";
import {
  reduceRuntimeEvent,
  type SessionViewModel,
} from "./sessionRuntimeReducer.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
};

function session(): SessionViewModel {
  return {
    id: "runtime-1",
    workspaceId: "workspace-a",
    title: "Session",
    project: "Project",
    projectPath: "/workspace-a",
    subtitle: "Idle",
    status: "idle",
    updatedAt: "Now",
    updatedAtMs: 0,
    timeline: [],
    baseState: "idle",
    overlays: { ...emptyOverlays },
    runtimeBacked: true,
    backendMode: "real",
  };
}

describe("sessionRuntimeReducer", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000 }));
  afterEach(() => vi.useRealTimers());

  it("keeps a completed message busy through tool work until agent_end", () => {
    const completedMessage = reduceRuntimeEvent(session(), {
      type: "message_update",
      runtimeId: "runtime-1",
      messageId: "assistant-1",
      role: "assistant",
      content: "I will inspect this.",
      done: true,
    } as any);
    const runningTool = reduceRuntimeEvent(completedMessage, {
      type: "tool_execution_start",
      runtimeId: "runtime-1",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" },
    } as any);
    const ended = reduceRuntimeEvent(runningTool, {
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "success",
    } as any);

    expect(completedMessage).toMatchObject({
      status: "working",
      awaitingAgentEnd: true,
    });
    expect(runningTool).toMatchObject({
      status: "working",
      overlays: { toolRunning: true },
    });
    expect(ended).toMatchObject({
      status: "idle",
      baseState: "idle",
      lifecycle: {
        phase: "terminal",
        outcome: "completed",
        settledAtMs: 1_000,
      },
      completedAtMs: 1_000,
      awaitingAgentEnd: false,
      overlays: { streaming: false, toolRunning: false, retrying: false },
    });
    expect(ended.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-1",
          kind: "assistant",
          streaming: false,
        }),
      ]),
    );
    expect(
      classifyActivity({
        ...ended,
        workspaceName: "Workspace",
      }),
    ).toBe("completed");
  });

  it("projects delegated child outcomes separately from the parent tool phase", () => {
    const running = reduceRuntimeEvent(session(), {
      type: "tool_execution_start",
      runtimeId: "runtime-1",
      toolCallId: "delegation-1",
      toolName: "subagent",
      args: {
        tasks: [
          { agent: "one", task: "Inspect" },
          { agent: "two", task: "Review" },
        ],
      },
    } as any);
    const synthesizing = reduceRuntimeEvent(running, {
      type: "tool_execution_update",
      runtimeId: "runtime-1",
      toolCallId: "delegation-1",
      toolName: "subagent",
      partialResult: {
        content: [{ type: "text", text: "Parallel: 2/2 done, 0 running..." }],
        details: {
          mode: "parallel",
          parentPhase: "synthesizing",
          results: [
            { agent: "one", task: "Inspect", exitCode: 0 },
            { agent: "two", task: "Review", exitCode: 1 },
          ],
        },
      },
    } as any);
    const completed = reduceRuntimeEvent(synthesizing, {
      type: "tool_execution_end",
      runtimeId: "runtime-1",
      toolCallId: "delegation-1",
      // Pi may omit the repeated name at end; retain the running card identity.
      result: {
        details: {
          mode: "parallel",
          results: [
            { agent: "one", task: "Inspect", exitCode: 0 },
            { agent: "two", task: "Review", exitCode: 1 },
          ],
        },
      },
    } as any);

    expect(synthesizing.timeline).toMatchObject([
      {
        kind: "tool",
        status: "running",
        summary: "2 delegated tasks finished · 1 succeeded · 1 failed",
        delegatedStatus: {
          label: "Synthesizing results",
          tone: "working",
        },
        subagentActivity: {
          mode: "parallel",
          children: [{ state: "Waiting for activity" }, { state: "Failed" }],
        },
      },
    ]);
    expect(
      (synthesizing.timeline[0] as any).detailSections.find(
        (section: any) => section.title === "Output",
      ).content,
    ).toBe(
      "Synthesizing results\n2 delegated tasks finished · 1 succeeded · 1 failed",
    );
    expect(completed.timeline).toMatchObject([
      {
        kind: "tool",
        status: "success",
        delegatedStatus: {
          label: "Completed delegated work",
          tone: "success",
        },
        subagentActivity: {
          mode: "parallel",
          children: [{ state: "Completed" }, { state: "Failed" }],
        },
      },
    ]);
  });

  it("projects a cancelled delegated result as an error tool row", () => {
    const running = reduceRuntimeEvent(session(), {
      type: "tool_execution_start",
      runtimeId: "runtime-1",
      toolCallId: "delegation-cancelled",
      toolName: "subagent",
      args: { tasks: [{ agent: "one" }] },
    } as any);
    const cancelled = reduceRuntimeEvent(running, {
      type: "tool_execution_end",
      runtimeId: "runtime-1",
      toolCallId: "delegation-cancelled",
      // A cancelled delegated parent must never render as successful work.
      status: "aborted",
      result: {
        details: {
          results: [{ status: "cancelled", stopReason: "aborted" }],
        },
      },
    } as any);

    expect(cancelled.timeline).toMatchObject([
      {
        id: "delegation-cancelled",
        kind: "tool",
        status: "error",
        delegatedStatus: {
          label: "Delegated work cancelled",
          parentState: "cancelled",
          tone: "error",
        },
      },
    ]);
    expect(cancelled.overlays.toolRunning).toBe(false);
  });

  it("keeps concurrent delegated tool calls independent", () => {
    let projected = reduceRuntimeEvent(session(), {
      type: "tool_execution_update",
      runtimeId: "runtime-1",
      toolCallId: "delegation-a",
      toolName: "subagent",
      partialResult: {
        details: {
          parentPhase: "processing",
          results: [{ status: "completed" }],
        },
      },
    } as any);
    projected = reduceRuntimeEvent(projected, {
      type: "tool_execution_update",
      runtimeId: "runtime-1",
      toolCallId: "delegation-b",
      toolName: "subagent",
      partialResult: {
        details: {
          parentPhase: "running-children",
          results: [{ status: "running" }, { status: "failed" }],
        },
      },
    } as any);

    expect(projected.timeline).toMatchObject([
      {
        id: "delegation-a",
        delegatedStatus: { label: "Processing delegated results" },
      },
      {
        id: "delegation-b",
        delegatedStatus: { label: "Running delegated tasks" },
      },
    ]);
  });

  it("prioritizes an extension dialog over terminal lifecycle events", () => {
    const waiting = reduceRuntimeEvent(session(), {
      type: "extension_ui_request",
      runtimeId: "runtime-1",
      id: "request-1",
      method: "input",
      title: "Confirm target",
    } as any);
    const ended = reduceRuntimeEvent(waiting, {
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "error",
      errorMessage: "backend failed",
    } as any);

    expect(waiting).toMatchObject({
      status: "waiting",
      baseState: "waitingForInput",
      overlays: { needsUserInput: true },
    });
    expect(ended).toMatchObject({
      status: "waiting",
      baseState: "waitingForInput",
      providerErrorObserved: true,
      overlays: { needsUserInput: true },
    });
  });

  it.each(["extension_ui_response_sent", "extension_ui_request_timeout"])(
    "does not resurrect a completed turn after a late %s clear",
    (clearType) => {
      let current = reduceRuntimeEvent(session(), {
        type: "agent_start",
        runtimeId: "runtime-1",
      } as any);
      current = reduceRuntimeEvent(current, {
        type: "extension_ui_request",
        runtimeId: "runtime-1",
        id: "request-1",
        method: "confirm",
        title: "Continue?",
      } as any);
      current = reduceRuntimeEvent(current, {
        type: "agent_end",
        runtimeId: "runtime-1",
        status: "success",
      } as any);

      expect(current).toMatchObject({
        status: "waiting",
        lifecycle: { phase: "terminal", outcome: "completed" },
      });
      const cleared = reduceRuntimeEvent(current, {
        type: clearType,
        runtimeId: "runtime-1",
        requestId: "request-1",
      } as any);
      expect(cleared).toMatchObject({
        status: "idle",
        baseState: "idle",
        completedAtMs: 1_000,
        lifecycle: { phase: "terminal", outcome: "completed" },
        overlays: { needsUserInput: false },
      });
      expect(classifyActivity({ ...cleared, workspaceName: "Workspace" })).toBe(
        "completed",
      );

      const duplicate = reduceRuntimeEvent(cleared, {
        type: clearType,
        runtimeId: "runtime-1",
        requestId: "request-1",
      } as any);
      expect(duplicate).toBe(cleared);
    },
  );

  it("does not let a duplicate post-terminal update revive active presentation", () => {
    const completed = reduceRuntimeEvent(session(), {
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "completed",
    } as any);
    const lateMessage = reduceRuntimeEvent(completed, {
      type: "message_update",
      runtimeId: "runtime-1",
      messageId: "late-message",
      role: "assistant",
      content: "late duplicate",
      done: false,
    } as any);

    expect(lateMessage).toMatchObject({
      status: "idle",
      baseState: "idle",
      lifecycle: { phase: "terminal", outcome: "completed" },
      overlays: { streaming: false },
    });
    expect(lateMessage.timeline).toMatchObject([
      {
        id: "late-message",
        kind: "assistant",
        content: "late duplicate",
        streaming: false,
      },
    ]);
    expect(
      classifyActivity({ ...lateMessage, workspaceName: "Workspace" }),
    ).toBe("completed");
  });

  it("retains late tool details without showing a running delegated card after terminal", () => {
    const completed = reduceRuntimeEvent(session(), {
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "completed",
    } as any);
    const lateTool = reduceRuntimeEvent(completed, {
      type: "tool_execution_update",
      runtimeId: "runtime-1",
      toolCallId: "delegation-late",
      toolName: "subagent",
      partialResult: {
        content: [{ type: "text", text: "Parallel: 1/2 done, 1 running..." }],
        details: {
          parentPhase: "running-children",
          results: [{ status: "completed" }, { status: "running" }],
        },
      },
    } as any);

    expect(lateTool).toMatchObject({
      status: "idle",
      lifecycle: { phase: "terminal", outcome: "completed" },
      overlays: { toolRunning: false },
    });
    expect(lateTool.timeline).toMatchObject([
      {
        id: "delegation-late",
        kind: "tool",
        status: "collapsed",
        delegatedStatus: {
          parentState: "completed",
          label: "Completed delegated work",
          tone: "success",
          children: { queued: 0, running: 0, waiting: 0 },
        },
      },
    ]);
    expect((lateTool.timeline[0] as any).delegatedStatus.detail).not.toContain(
      "running",
    );
  });

  it("keeps completed terminal outcome immutable across a late error", () => {
    const completed = reduceRuntimeEvent(session(), {
      type: "agent_start",
      runtimeId: "runtime-1",
      runId: "turn-a",
    } as any);
    const settled = reduceRuntimeEvent(completed, {
      type: "agent_end",
      runtimeId: "runtime-1",
      runId: "turn-a",
      status: "completed",
    } as any);
    const lateError = reduceRuntimeEvent(settled, {
      type: "message_update",
      runtimeId: "runtime-1",
      messageId: "late-error",
      role: "assistant",
      content: "Useful late provider detail",
      done: true,
      error: "stale failure",
    } as any);

    expect(lateError).toMatchObject({
      status: "idle",
      baseState: "idle",
      providerErrorObserved: false,
      lifecycle: {
        phase: "terminal",
        outcome: "completed",
        turnId: "turn-a",
      },
    });
    expect(lateError.lastError).toBeUndefined();
    expect(lateError.timeline).toMatchObject([
      {
        id: "late-error",
        kind: "assistant",
        content: "Useful late provider detail",
        streaming: false,
      },
    ]);
  });

  it("uses protocol turn ids to reject stale terminal events but accepts untagged completion", () => {
    const turnA = reduceRuntimeEvent(session(), {
      type: "agent_start",
      runtimeId: "runtime-1",
      runId: "turn-a",
    } as any);
    const turnB = reduceRuntimeEvent(
      reduceRuntimeEvent(turnA, {
        type: "agent_end",
        runtimeId: "runtime-1",
        runId: "turn-a",
      } as any),
      {
        type: "agent_start",
        runtimeId: "runtime-1",
        runId: "turn-b",
      } as any,
    );

    const stale = reduceRuntimeEvent(turnB, {
      type: "agent_end",
      runtimeId: "runtime-1",
      runId: "turn-a",
      status: "error",
      error: "old failure",
    } as any);
    expect(stale).toBe(turnB);

    // Pi versions without runId cannot be safely distinguished. Accept their
    // valid completion rather than dropping all untagged agent_end events.
    const untagged = reduceRuntimeEvent(turnB, {
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "completed",
    } as any);
    expect(untagged).toMatchObject({
      status: "idle",
      lifecycle: {
        phase: "terminal",
        outcome: "completed",
        turnId: "turn-b",
      },
    });
  });

  it("keeps multiple requests waiting and resumes only a genuinely active turn", () => {
    let current = reduceRuntimeEvent(session(), {
      type: "agent_start",
      runtimeId: "runtime-1",
    } as any);
    for (const id of ["request-1", "request-2"]) {
      current = reduceRuntimeEvent(current, {
        type: "extension_ui_request",
        runtimeId: "runtime-1",
        id,
        method: "confirm",
        title: id,
      } as any);
    }
    current = reduceRuntimeEvent(current, {
      type: "extension_ui_response_sent",
      runtimeId: "runtime-1",
      requestId: "request-1",
    } as any);
    expect(current).toMatchObject({
      status: "waiting",
      pendingExtensionUiRequests: [{ id: "request-2" }],
    });

    current = reduceRuntimeEvent(current, {
      type: "extension_ui_response_sent",
      runtimeId: "runtime-1",
      requestId: "request-2",
    } as any);
    expect(current).toMatchObject({
      status: "working",
      baseState: "working",
      lifecycle: { phase: "active" },
    });
  });

  it("treats stale runtime events and unknown Extension UI clears as no-ops", () => {
    const current = session();
    expect(
      reduceRuntimeEvent(current, {
        type: "agent_start",
        runtimeId: "stale-runtime",
      } as any),
    ).toBe(current);

    const states: SessionViewModel[] = [
      current,
      {
        ...current,
        status: "error",
        baseState: "error",
        lifecycle: { phase: "terminal", outcome: "failed", settledAtMs: 1 },
      },
      {
        ...current,
        completedAtMs: 1,
        lifecycle: {
          phase: "terminal",
          outcome: "completed",
          settledAtMs: 1,
        },
      },
    ];
    for (const state of states) {
      expect(
        reduceRuntimeEvent(state, {
          type: "extension_ui_response_sent",
          runtimeId: "runtime-1",
          requestId: "missing",
        } as any),
      ).toBe(state);
    }
  });

  it("keeps retry active, records final failure, and records abort completion", () => {
    const retrying = reduceRuntimeEvent(session(), {
      type: "agent_end",
      runtimeId: "runtime-1",
      willRetry: true,
    } as any);
    expect(retrying).toMatchObject({
      lifecycle: { phase: "active" },
      overlays: { retrying: true },
    });
    const failed = reduceRuntimeEvent(retrying, {
      type: "auto_retry_end",
      runtimeId: "runtime-1",
      success: false,
      finalError: "retry exhausted",
    } as any);
    expect(failed).toMatchObject({
      status: "error",
      lifecycle: { phase: "terminal", outcome: "failed" },
    });

    const aborted = reduceRuntimeEvent(
      {
        ...session(),
        status: "aborting",
        lifecycle: { phase: "aborting" },
        overlays: { ...emptyOverlays, streaming: true, toolRunning: true },
        timeline: [
          {
            id: "assistant-aborted",
            kind: "assistant",
            content: "Partial response",
            createdAt: "10:00",
            streaming: true,
          },
        ],
      },
      {
        type: "agent_end",
        runtimeId: "runtime-1",
        messages: [],
        willRetry: false,
      } as any,
    );
    expect(aborted).toMatchObject({
      status: "idle",
      lifecycle: { phase: "terminal", outcome: "aborted" },
      completedAtMs: 1_000,
      overlays: { streaming: false, toolRunning: false, retrying: false },
      timeline: [{ id: "assistant-aborted", streaming: false }],
    });

    const failedDespiteAbort = reduceRuntimeEvent(
      {
        ...session(),
        status: "aborting",
        lifecycle: { phase: "aborting" },
      },
      {
        type: "agent_end",
        runtimeId: "runtime-1",
        error: "Provider failed while aborting.",
        messages: [{ role: "assistant", stopReason: "aborted" }],
        willRetry: false,
      } as any,
    );
    expect(failedDespiteAbort).toMatchObject({
      status: "error",
      lifecycle: { phase: "terminal", outcome: "failed" },
    });
  });

  it("preserves usage while a real-shaped abort leaves id-less user evidence for snapshot refresh", () => {
    const intervention = markInterventionQueued(
      createInterventionTimelineItem({
        id: "steer-aborted",
        interventionKind: "steer",
        content: "Stop after this change",
        createdAt: "10:00",
      }),
    );
    const aborted = reduceRuntimeEvent(
      {
        ...session(),
        status: "working",
        baseState: "working",
        overlays: { ...emptyOverlays, streaming: true },
        timeline: [intervention],
      },
      {
        type: "agent_end",
        runtimeId: "runtime-1",
        messages: [
          { role: "user", content: "Stop after this change" },
          {
            role: "assistant",
            stopReason: "aborted",
            errorMessage: "Request aborted by user.",
            usage: { input: 21, output: 3, cacheRead: 2 },
          },
        ],
        willRetry: false,
      } as any,
    );

    expect(aborted).toMatchObject({
      lifecycle: { phase: "terminal", outcome: "aborted" },
      status: "idle",
      overlays: { streaming: false },
      usageStats: { inputTokens: 21, outputTokens: 3, cacheReadTokens: 2 },
      timeline: [{ id: "steer-aborted", status: "queued" }],
    });
  });

  it("reconciles queue content and treats a count reset as accepted, not consumed", () => {
    const sending = {
      ...session(),
      status: "working" as const,
      baseState: "working" as const,
      timeline: [
        createInterventionTimelineItem({
          id: "steer-1",
          interventionKind: "steer",
          content: "Focus the tests",
          createdAt: "10:00",
        }),
      ],
    };
    const queued = reduceRuntimeEvent(sending, {
      type: "queue_update",
      runtimeId: "runtime-1",
      steering: ["Focus the tests"],
      followUp: [],
    } as any);
    const countOnlyReset = reduceRuntimeEvent(queued, {
      type: "queue_update",
      runtimeId: "runtime-1",
      steeringCount: 0,
      followUpCount: 0,
    } as any);
    const explicitRemoval = reduceRuntimeEvent(queued, {
      type: "queue_update",
      runtimeId: "runtime-1",
      steering: [],
      followUp: [],
    } as any);

    expect(queued.timeline[0]).toMatchObject({ status: "queued" });
    expect(countOnlyReset.timeline[0]).toMatchObject({ status: "accepted" });
    expect(explicitRemoval.timeline[0]).toMatchObject({ status: "accepted" });
    expect(explicitRemoval.overlays.piQueuedSteeringCount).toBe(0);
  });

  it("uses a durable user message to consume the same intervention item", () => {
    const current = {
      ...session(),
      status: "working" as const,
      baseState: "working" as const,
      timeline: [
        markInterventionQueued(
          createInterventionTimelineItem({
            id: "steer-1",
            interventionKind: "steer",
            content: "Focus the tests",
            createdAt: "10:00",
          }),
        ),
      ],
    };
    const consumed = reduceRuntimeEvent(current, {
      type: "message_update",
      runtimeId: "runtime-1",
      messageId: "durable-steer-1",
      role: "user",
      content: "Focus the tests",
      done: true,
    } as any);

    expect(consumed.timeline).toHaveLength(1);
    expect(consumed.timeline[0]).toMatchObject({
      id: "steer-1",
      kind: "intervention",
      status: "consumed",
      durableMessageId: "durable-steer-1",
    });
  });

  it("matches durable duplicate text in local timeline order during a snapshot race", () => {
    const current = {
      ...session(),
      status: "working" as const,
      baseState: "working" as const,
      timeline: [
        {
          id: "local-old",
          kind: "user" as const,
          content: "Same text",
          createdAt: "09:59",
        },
        markInterventionQueued(
          createInterventionTimelineItem({
            id: "steer-1",
            interventionKind: "steer",
            content: "Same text",
            createdAt: "10:00",
          }),
        ),
        {
          id: "local-future",
          kind: "user" as const,
          content: "Same text",
          createdAt: "10:02",
        },
      ],
    };
    const reconciled = reduceRuntimeEvent(current, {
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "success",
      messages: [
        { id: "durable-old", role: "user", content: "Same text" },
        {
          id: "durable-intervention",
          role: "user",
          content: "Same text",
        },
      ],
    } as any);

    expect(reconciled.timeline[1]).toMatchObject({
      id: "steer-1",
      status: "consumed",
      durableMessageId: "durable-intervention",
    });
    expect(reconciled.timeline).toHaveLength(3);
  });

  it("uses durable agent_end messages, but not agent_end alone, as consumption evidence", () => {
    const interventionItem = markInterventionQueued(
      createInterventionTimelineItem({
        id: "follow-up-1",
        interventionKind: "followUp",
        content: "Summarize afterward",
        createdAt: "10:00",
      }),
    );
    const endedWithoutEvidence = reduceRuntimeEvent(
      {
        ...session(),
        status: "working",
        baseState: "working",
        timeline: [interventionItem],
      },
      { type: "agent_end", runtimeId: "runtime-1", status: "success" } as any,
    );
    const endedWithEvidence = reduceRuntimeEvent(
      {
        ...session(),
        status: "working",
        baseState: "working",
        timeline: [interventionItem],
      },
      {
        type: "agent_end",
        runtimeId: "runtime-1",
        status: "success",
        messages: [
          {
            id: "durable-follow-up-1",
            role: "user",
            content: "Summarize afterward",
          },
        ],
      } as any,
    );

    expect(endedWithoutEvidence.timeline[0]).toMatchObject({
      status: "queued",
    });
    expect(endedWithEvidence.timeline[0]).toMatchObject({
      status: "consumed",
      durableMessageId: "durable-follow-up-1",
    });
  });

  it("projects cumulative subagent updates by tool call without cross-call leakage", () => {
    const args = {
      tasks: [
        { agent: "worker", task: "Inspect A" },
        { agent: "worker", task: "Inspect B" },
      ],
    };
    const startedA = reduceRuntimeEvent(session(), {
      type: "tool_execution_start",
      runtimeId: "runtime-1",
      toolCallId: "subagent-a",
      toolName: "subagent",
      args,
    } as any);
    const startedBoth = reduceRuntimeEvent(startedA, {
      type: "tool_execution_start",
      runtimeId: "runtime-1",
      toolCallId: "subagent-b",
      toolName: "subagent",
      args: { agent: "reviewer", task: "Review separately" },
    } as any);
    const updatedA = reduceRuntimeEvent(startedBoth, {
      type: "tool_execution_update",
      runtimeId: "runtime-1",
      toolCallId: "subagent-a",
      toolName: "subagent",
      args,
      partialResult: {
        details: {
          mode: "parallel",
          results: [
            {
              agent: "worker",
              task: "Inspect A",
              exitCode: 0,
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "toolCall", name: "read", arguments: {} }],
                },
              ],
              usage: { turns: 1, input: 10, output: 0 },
            },
            {
              agent: "worker",
              task: "Inspect B",
              exitCode: -1,
              messages: [],
              usage: { turns: 0, input: 0, output: 0 },
            },
          ],
        },
      },
    } as any);

    const callA = updatedA.timeline.find((item) => item.id === "subagent-a");
    const callB = updatedA.timeline.find((item) => item.id === "subagent-b");
    expect(callA).toMatchObject({
      kind: "tool",
      subagentActivity: {
        mode: "parallel",
        children: [
          { index: 0, state: "Activity observed", agent: "worker" },
          { index: 1, state: "Waiting for activity", agent: "worker" },
        ],
      },
    });
    expect(callB).toMatchObject({
      kind: "tool",
      subagentActivity: {
        mode: "single",
        children: [{ index: 0, agent: "reviewer", history: [] }],
      },
    });
  });

  it("retains final subagent details and terminalizes only on tool end", () => {
    const args = { agent: "worker", task: "Finish" };
    const partial = reduceRuntimeEvent(session(), {
      type: "tool_execution_update",
      runtimeId: "runtime-1",
      toolCallId: "subagent-final",
      toolName: "subagent",
      args,
      partialResult: {
        details: {
          mode: "single",
          results: [
            {
              agent: "worker",
              task: "Finish",
              exitCode: 0,
              messages: [],
              usage: { turns: 0, input: 0, output: 0 },
            },
          ],
        },
      },
    } as any);
    const ended = reduceRuntimeEvent(partial, {
      type: "tool_execution_end",
      runtimeId: "runtime-1",
      toolCallId: "subagent-final",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          results: [
            {
              agent: "worker",
              task: "Finish",
              exitCode: 0,
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "Public handoff" }],
                },
              ],
              usage: { turns: 1, input: 4, output: 2 },
            },
          ],
        },
      },
      isError: false,
    } as any);

    expect(
      (partial.timeline[0] as any).subagentActivity.children[0].state,
    ).toBe("Waiting for activity");
    expect(
      (ended.timeline[0] as any).subagentActivity.children[0],
    ).toMatchObject({
      state: "Completed",
      completedTurns: 1,
      latest: "Public handoff",
    });
  });

  it.each([false, true])(
    "finalizes parent abort without erasing known failures (production event: %s)",
    (production) => {
      const args = {
        tasks: [
          { agent: "failed", task: "Known failure" },
          { agent: "active", task: "Still working" },
        ],
      };
      const running = reduceRuntimeEvent(session(), {
        type: "tool_execution_update",
        runtimeId: "runtime-1",
        toolCallId: "subagent-abort",
        toolName: "subagent",
        args,
        partialResult: {
          details: {
            mode: "parallel",
            results: [
              {
                agent: "failed",
                task: "Known failure",
                exitCode: 1,
                errorMessage: "failed",
                messages: [],
                usage: zeroUsage,
              },
              {
                agent: "active",
                task: "Still working",
                exitCode: -1,
                messages: [],
                usage: zeroUsage,
              },
            ],
          },
        },
      } as any);
      const aborted = reduceRuntimeEvent({ ...running, status: "aborting" }, {
        type: "agent_end",
        runtimeId: "runtime-1",
        ...(production
          ? { messages: [], willRetry: false }
          : { status: "aborted" }),
      } as any);

      expect(
        (aborted.timeline[0] as any).subagentActivity.children.map(
          (child: any) => child.state,
        ),
      ).toEqual(["Failed", "Interrupted"]);
      expect(aborted).toMatchObject({
        status: "idle",
        overlays: { toolRunning: false },
        timeline: [{ status: "error" }],
      });
    },
  );

  it("finalizes unresolved children on worker exit and ignores stale updates", () => {
    const args = { agent: "worker", task: "In flight" };
    const running = reduceRuntimeEvent(session(), {
      type: "tool_execution_start",
      runtimeId: "runtime-1",
      toolCallId: "subagent-exit",
      toolName: "subagent",
      args,
    } as any);
    const exited = reduceRuntimeEvent(running, {
      type: "worker_exit",
      runtimeId: "runtime-1",
      intentional: false,
      code: 1,
    } as any);
    const stale = reduceRuntimeEvent(exited, {
      type: "tool_execution_update",
      runtimeId: "runtime-1",
      toolCallId: "subagent-exit",
      toolName: "subagent",
      args,
      partialResult: {
        details: {
          mode: "single",
          results: [
            {
              agent: "worker",
              task: "In flight",
              exitCode: 0,
              messages: [{ role: "assistant", content: "late" }],
              usage: { turns: 1, input: 1 },
            },
          ],
        },
      },
    } as any);

    expect((exited.timeline[0] as any).subagentActivity.children[0].state).toBe(
      "Interrupted",
    );
    expect(stale).toBe(exited);
    expect(
      reduceRuntimeEvent(exited, {
        type: "tool_execution_end",
        runtimeId: "runtime-1",
        toolCallId: "subagent-exit",
        toolName: "subagent",
        args,
        result: {
          details: {
            mode: "single",
            results: [
              {
                agent: "worker",
                task: "In flight",
                exitCode: 0,
                messages: [{ role: "assistant", content: "too late" }],
                usage: { turns: 1, input: 1 },
              },
            ],
          },
        },
      } as any),
    ).toBe(exited);
  });

  it("settles a missing tool end as unknown rather than completed", () => {
    const running = reduceRuntimeEvent(session(), {
      type: "tool_execution_update",
      runtimeId: "runtime-1",
      toolCallId: "subagent-settled",
      toolName: "subagent",
      args: { agent: "worker", task: "Maybe done" },
      partialResult: {
        details: {
          mode: "single",
          results: [
            {
              agent: "worker",
              task: "Maybe done",
              exitCode: 0,
              messages: [{ role: "assistant", content: "progress" }],
              usage: { turns: 1, input: 1 },
            },
          ],
        },
      },
    } as any);
    const settled = reduceRuntimeEvent(running, {
      type: "agent_settled",
      runtimeId: "runtime-1",
    } as any);

    expect(settled).toMatchObject({
      status: "idle",
      overlays: { toolRunning: false },
      timeline: [
        {
          status: "collapsed",
          subagentActivity: { children: [{ state: "Unknown" }] },
        },
      ],
    });
  });

  it("detaches an intentional worker exit into a resumable saved row", () => {
    const exited = reduceRuntimeEvent(
      {
        ...session(),
        status: "working",
        baseState: "working",
        sessionFile: "/workspace-a/session.jsonl",
        pendingExtensionUiRequests: [
          { id: "request-1", method: "confirm", title: "Continue?" },
        ],
      },
      {
        type: "worker_exit",
        runtimeId: "runtime-1",
        intentional: true,
        code: 143,
      } as any,
    );

    expect(exited).toMatchObject({
      status: "idle",
      baseState: "idle",
      runtimeBacked: false,
      resumeBacked: true,
      pendingExtensionUiRequests: [],
      overlays: { needsUserInput: false },
    });
  });
});
