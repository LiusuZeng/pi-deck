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

  it("recognizes failed status and non-zero shell exits as tool-card failures", () => {
    expect(
      isToolExecutionFailure({ type: "tool_execution_end", status: "failed" }),
    ).toBe(true);
    expect(
      isToolExecutionFailure({ type: "tool_execution_end", exit_code: 1 }),
    ).toBe(true);
    expect(
      isToolExecutionFailure({ type: "tool_execution_end", exitCode: 0 }),
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
