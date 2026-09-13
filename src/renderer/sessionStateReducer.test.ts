import { describe, expect, it } from "vitest";
import fixture from "../../docs/state-reducer-fixtures.json" with { type: "json" };
import {
  createInitialReducedSessionState,
  isToolExecutionFailure,
  reduceSessionRuntimeEvent,
  selectSidebarIndicator,
  type ReducedSessionState,
  type RuntimeEventLike,
} from "./sessionState.js";

function applyEvents(events: RuntimeEventLike[]): ReducedSessionState {
  return events.reduce(
    (state, event) => reduceSessionRuntimeEvent(state, event),
    createInitialReducedSessionState(),
  );
}

function expectPartialObject(actual: unknown, expected: unknown): void {
  expect(actual).toMatchObject(expected as Record<string, unknown>);
}

describe("reduceSessionRuntimeEvent", () => {
  it("passes the documented reducer fixture cases", () => {
    for (const testCase of fixture.cases) {
      const state = applyEvents(testCase.events as RuntimeEventLike[]);
      const expected = testCase.expect as Record<string, unknown>;

      if (expected.baseState !== undefined) {
        expect(state.baseState, testCase.id).toBe(expected.baseState);
      }

      if (expected.overlays !== undefined) {
        expectPartialObject(state.overlays, expected.overlays);
      }

      if (expected.toolCards !== undefined) {
        expectPartialObject(state.toolCards, expected.toolCards);
      }

      if (expected.pendingExtensionUiQueue !== undefined) {
        expect(state.pendingExtensionUiQueue, testCase.id).toMatchObject(
          expected.pendingExtensionUiQueue as Record<string, unknown>[],
        );
      }

      if (expected.terminalProviderErrorObserved !== undefined) {
        expect(state.terminalProviderErrorObserved, testCase.id).toBe(
          expected.terminalProviderErrorObserved,
        );
      }

      if (expected.sidebarPriority !== undefined) {
        expect(selectSidebarIndicator(state).kind, testCase.id).toBe(
          expected.sidebarPriority === "waitingForInput"
            ? "needsInput"
            : expected.sidebarPriority,
        );
      }

      if (typeof expected.diagnosticsIncludes === "string") {
        expect(state.diagnostics.join("\n"), testCase.id).toContain(
          expected.diagnosticsIncludes,
        );
      }
    }
  });

  it("keeps isError tool failures on the tool card without requesting input", () => {
    const state = applyEvents([
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "tool-1", name: "bash" },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        isError: true,
        output: "command failed",
      },
    ]);

    expect(state.baseState).toBe("working");
    expect(state.overlays.needsUserInput).toBe(false);
    expect(state.toolCards["tool-1"]).toMatchObject({
      status: "error",
      isError: true,
      output: "command failed",
    });
    expect(selectSidebarIndicator(state).kind).toBe("working");
  });

  it("recognizes direct and rendered nested tool failure forms", () => {
    const failures: RuntimeEventLike[] = [
      { type: "tool_execution_end", status: "failed" },
      { type: "tool_execution_end", exit_code: 1 },
      { type: "tool_execution_end", output: { status: "error" } },
      { type: "tool_execution_end", output: { error: "command failed" } },
      { type: "tool_execution_end", result: { exitCode: 2 } },
      {
        type: "tool_execution_end",
        result: { output: { exit_code: 3 } },
      },
      { type: "tool_execution_end", partialResult: { code: 4 } },
      {
        type: "tool_execution_end",
        result: { status: "completed" },
        partialResult: { output: { exitCode: 5 } },
      },
      {
        type: "tool_execution_end",
        result: { output: { errorMessage: "nested command failed" } },
      },
    ];

    for (const event of failures) {
      expect(isToolExecutionFailure(event), JSON.stringify(event)).toBe(true);
    }
    expect(
      isToolExecutionFailure({ type: "tool_execution_end", exitCode: 0 }),
    ).toBe(false);
    expect(
      isToolExecutionFailure({
        type: "tool_execution_end",
        result: { output: { status: "completed", exitCode: 0 } },
      }),
    ).toBe(false);
  });

  it("clears extension UI waiting only after a response/write success event", () => {
    const waiting = applyEvents([
      {
        type: "extension_ui_request",
        requestId: "ext-1",
        method: "confirm",
      },
    ]);

    expect(waiting.baseState).toBe("waitingForInput");
    expect(waiting.overlays.needsUserInput).toBe(true);

    const cleared = reduceSessionRuntimeEvent(waiting, {
      type: "extension_ui_response_sent",
      requestId: "ext-1",
    });

    expect(cleared.baseState).toBe("working");
    expect(cleared.overlays.needsUserInput).toBe(false);
  });

  it("keeps an unplanned worker exit terminal when a raced response acknowledgement arrives", () => {
    const exited = applyEvents([
      {
        type: "extension_ui_request",
        requestId: "ext-1",
        method: "confirm",
      },
      { type: "worker_exit", intentional: false },
    ]);
    const afterLateAcknowledgement = reduceSessionRuntimeEvent(exited, {
      type: "extension_ui_response_sent",
      requestId: "ext-1",
    });

    expect(afterLateAcknowledgement).toBe(exited);
    expect(afterLateAcknowledgement).toMatchObject({
      baseState: "error",
      runtimeDetached: true,
      overlays: { needsUserInput: false },
      pendingExtensionUiQueue: [],
    });
    expect(selectSidebarIndicator(afterLateAcknowledgement).kind).toBe("error");
  });

  it("clears planned-exit extension input and ignores its late response acknowledgement", () => {
    const exited = applyEvents([
      {
        type: "extension_ui_request",
        requestId: "ext-1",
        method: "confirm",
      },
      { type: "worker_exit", intentional: true },
    ]);
    const afterLateAcknowledgement = reduceSessionRuntimeEvent(exited, {
      type: "extension_ui_response_sent",
      requestId: "ext-1",
    });

    expect(afterLateAcknowledgement).toBe(exited);
    expect(afterLateAcknowledgement).toMatchObject({
      baseState: "error",
      runtimeDetached: true,
      overlays: { needsUserInput: false },
      pendingExtensionUiQueue: [],
    });
    expect(selectSidebarIndicator(afterLateAcknowledgement).kind).toBe("error");
  });

  it("restores a production message_update provider failure after its final extension response", () => {
    const failedAssistant = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Provider quota exhausted.",
    };
    const failedWhileWaiting = applyEvents([
      { type: "agent_start" },
      {
        type: "extension_ui_request",
        requestId: "ext-1",
        method: "confirm",
      },
      {
        type: "message_update",
        message: failedAssistant,
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: failedAssistant,
        },
      },
      {
        type: "agent_end",
        messages: [failedAssistant],
        willRetry: false,
      },
    ]);

    expect(failedWhileWaiting.baseState).toBe("waitingForInput");
    expect(failedWhileWaiting.overlays).toMatchObject({
      streaming: false,
      needsUserInput: true,
    });
    expect(failedWhileWaiting.terminalProviderErrorObserved).toBe(true);
    expect(selectSidebarIndicator(failedWhileWaiting).kind).toBe("needsInput");
    expect(failedWhileWaiting.diagnostics).toContain(
      "Provider quota exhausted.",
    );

    const cleared = reduceSessionRuntimeEvent(failedWhileWaiting, {
      type: "extension_ui_response_sent",
      requestId: "ext-1",
    });
    expect(cleared.baseState).toBe("error");
    expect(cleared.overlays.needsUserInput).toBe(false);
    expect(selectSidebarIndicator(cleared).kind).toBe("error");
    expect(cleared.diagnostics).toContain("Provider quota exhausted.");
    expect(
      cleared.diagnostics.filter(
        (message) => message === "Provider quota exhausted.",
      ),
    ).toHaveLength(1);
  });

  it("keeps a failed extension response actionable while its request is pending", () => {
    const failedResponse = applyEvents([
      {
        type: "extension_ui_request",
        requestId: "ext-1",
        method: "confirm",
      },
      {
        type: "extension_ui_response_failed",
        requestId: "ext-1",
        message: "Response transport failed.",
      },
    ]);

    expect(failedResponse.baseState).toBe("waitingForInput");
    expect(failedResponse.overlays.needsUserInput).toBe(true);
    expect(selectSidebarIndicator(failedResponse).kind).toBe("needsInput");
    expect(failedResponse.diagnostics).toContain("Response transport failed.");
  });

  it("does not red-dot fire-and-forget extension UI methods", () => {
    const state = applyEvents([
      {
        type: "extension_ui_request",
        requestId: "notify-1",
        method: "notify",
      },
    ]);

    expect(state.baseState).toBe("idle");
    expect(state.overlays.needsUserInput).toBe(false);
    expect(state.pendingExtensionUiQueue).toEqual([]);
  });

  it("retains steering and follow-up queue counts while the agent is working", () => {
    const state = applyEvents([
      { type: "queue_update", steeringCount: 1, followUpCount: 2 },
      { type: "agent_start" },
      { type: "message_update", done: false },
    ]);

    expect(selectSidebarIndicator(state).kind).toBe("working");
    expect(state.overlays).toMatchObject({
      piQueuedSteeringCount: 1,
      piQueuedFollowUpCount: 2,
      streaming: true,
    });
  });

  it("keeps retryable agent_end errors working rather than terminal", () => {
    const retrying = applyEvents([
      { type: "agent_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "error", reason: "error" },
      },
      { type: "agent_end", willRetry: true },
    ]);

    expect(retrying.baseState).toBe("working");
    expect(retrying.terminalProviderErrorObserved).toBe(false);
    expect(retrying.overlays).toMatchObject({
      streaming: false,
      toolRunning: false,
      retrying: true,
      needsUserInput: false,
    });
    expect(selectSidebarIndicator(retrying).kind).toBe("retrying");

    const completed = reduceSessionRuntimeEvent(retrying, {
      type: "agent_end",
      willRetry: false,
    });
    expect(completed.baseState).toBe("idle");
    expect(completed.overlays.retrying).toBe(false);
  });

  it("keeps a production-id extension request actionable through tools and retry failure until acknowledgement", () => {
    const finalError = "Retry exhausted while extension input was pending.";
    let state = createInitialReducedSessionState();
    const events: RuntimeEventLike[] = [
      {
        type: "extension_ui_request",
        id: "ext-production-1",
        method: "confirm",
      },
      { type: "tool_execution_start", toolCallId: "tool-1", name: "bash" },
      {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        output: "checking",
      },
      { type: "tool_execution_end", toolCallId: "tool-1", output: "done" },
      { type: "agent_end", willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 1 },
      {
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError,
      },
    ];

    for (const event of events) {
      state = reduceSessionRuntimeEvent(state, event);
      expect(state).toMatchObject({
        baseState: "waitingForInput",
        overlays: { needsUserInput: true },
        pendingExtensionUiQueue: [{ requestId: "ext-production-1" }],
      });
    }

    expect(state.overlays).toMatchObject({
      toolRunning: false,
      retrying: false,
    });
    expect(state.terminalProviderErrorObserved).toBe(true);
    expect(state.diagnostics).toContain(finalError);
    expect(selectSidebarIndicator(state).kind).toBe("needsInput");

    state = reduceSessionRuntimeEvent(state, {
      type: "extension_ui_response_sent",
      requestId: "ext-production-1",
    });
    expect(state).toMatchObject({
      baseState: "error",
      overlays: { needsUserInput: false },
      pendingExtensionUiQueue: [],
    });
    expect(selectSidebarIndicator(state).kind).toBe("error");
    expect(state.diagnostics).toContain(finalError);
  });

  it("keeps auth recovery pending through nonterminal assistant results until explicit success", () => {
    const expiredAssistant = {
      role: "assistant",
      provider: "openai-codex",
      stopReason: "error",
      errorMessage: "Provided authentication token is expired.",
    };
    let state = applyEvents([
      { type: "agent_start" },
      {
        type: "message_update",
        message: expiredAssistant,
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: expiredAssistant,
        },
      },
      { type: "agent_end", messages: [expiredAssistant], willRetry: false },
    ]);
    expect(state.failureKind).toBe("auth-required");

    for (const assistant of [
      { role: "assistant", content: "Partial response" },
      { role: "assistant", stopReason: "toolUse", content: "Use a tool" },
      { role: "assistant", content: "No terminal reason" },
    ]) {
      state = reduceSessionRuntimeEvent(state, { type: "agent_start" });
      state = reduceSessionRuntimeEvent(state, {
        type: "agent_end",
        status: "completed",
        messages: [assistant],
        willRetry: false,
      });
      expect(state).toMatchObject({
        baseState: "error",
        failureKind: "auth-required",
      });
    }

    state = reduceSessionRuntimeEvent(state, { type: "agent_start" });
    state = reduceSessionRuntimeEvent(state, {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          provider: "openai-codex",
          stopReason: "stop",
          content: "Verified response",
        },
      ],
      willRetry: false,
    });
    expect(state.failureKind).toBeUndefined();
  });

  it("marks final auto-retry failure as an error", () => {
    const state = applyEvents([
      { type: "auto_retry_start", attempt: 2, maxAttempts: 2 },
      { type: "auto_retry_end", attempt: 2, status: "failed" },
    ]);

    expect(state.baseState).toBe("error");
    expect(state.overlays.retrying).toBe(false);
  });
});
