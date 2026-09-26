import { describe, expect, it } from "vitest";
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
