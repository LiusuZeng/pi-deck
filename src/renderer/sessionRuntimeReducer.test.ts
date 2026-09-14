import { describe, expect, it } from "vitest";
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
