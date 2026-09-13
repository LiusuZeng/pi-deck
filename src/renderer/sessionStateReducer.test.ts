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

  it("restores terminal provider failure when the final extension request clears", () => {
    const failedWhileWaiting = applyEvents([
      {
        type: "extension_ui_request",
        requestId: "ext-1",
        method: "confirm",
      },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "Provider quota exhausted.",
          },
        ],
        willRetry: false,
      },
    ]);

    expect(failedWhileWaiting.baseState).toBe("waitingForInput");
    expect(failedWhileWaiting.terminalProviderErrorObserved).toBe(true);
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

  it("marks final auto-retry failure as an error", () => {
    const state = applyEvents([
      { type: "auto_retry_start", attempt: 2, maxAttempts: 2 },
      { type: "auto_retry_end", attempt: 2, status: "failed" },
    ]);

    expect(state.baseState).toBe("error");
    expect(state.overlays.retrying).toBe(false);
  });
});
