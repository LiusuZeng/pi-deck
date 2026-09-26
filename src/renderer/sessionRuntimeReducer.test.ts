import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyActivity } from "./activityInbox.js";
import { emptyOverlays } from "./sessionState.js";
import {
  reduceRuntimeEvent,
  type SessionViewModel,
} from "./sessionRuntimeReducer.js";

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
    expect(
      classifyActivity({ ...lateMessage, workspaceName: "Workspace" }),
    ).toBe("completed");
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
      { ...session(), status: "aborting", lifecycle: { phase: "aborting" } },
      {
        type: "agent_end",
        runtimeId: "runtime-1",
        status: "aborted",
      } as any,
    );
    expect(aborted).toMatchObject({
      status: "idle",
      lifecycle: { phase: "terminal", outcome: "aborted" },
      completedAtMs: 1_000,
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
