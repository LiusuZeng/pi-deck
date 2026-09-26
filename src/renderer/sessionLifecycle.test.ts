import { describe, expect, it } from "vitest";
import {
  activeSessionLifecycle,
  inactiveSessionLifecycle,
  lifecycleBaseState,
  lifecycleSessionStatus,
  terminalSessionLifecycle,
  transitionSessionLifecycle,
} from "./sessionLifecycle.js";

describe("canonical session lifecycle", () => {
  it("requires an explicit new turn to leave a terminal outcome", () => {
    const completed = terminalSessionLifecycle("completed", 100);

    expect(
      transitionSessionLifecycle(completed, {
        type: "runtimeInactive",
        settledAtMs: 200,
      }),
    ).toBe(completed);
    expect(
      transitionSessionLifecycle(completed, {
        type: "turnSettled",
        outcome: "completed",
        settledAtMs: 200,
      }),
    ).toBe(completed);
    expect(
      transitionSessionLifecycle(completed, { type: "turnStarted" }),
    ).toEqual({ phase: "active" });
  });

  it.each([
    [activeSessionLifecycle(), "completed"],
    [{ phase: "aborting" } as const, "aborted"],
  ])("repairs inactive runtime status from %o to %s", (current, outcome) => {
    expect(
      transitionSessionLifecycle(current, {
        type: "runtimeInactive",
        settledAtMs: 500,
      }),
    ).toEqual({ phase: "terminal", outcome, settledAtMs: 500 });
  });

  it("keeps Extension UI waiting as an overlay over active and terminal turns", () => {
    const completed = terminalSessionLifecycle("completed", 100);
    expect(lifecycleBaseState(activeSessionLifecycle(), true)).toBe(
      "waitingForInput",
    );
    expect(lifecycleBaseState(completed, true)).toBe("waitingForInput");
    expect(lifecycleSessionStatus(completed, false)).toBe("idle");
    expect(lifecycleBaseState(completed, false)).toBe("idle");
    expect(lifecycleBaseState(inactiveSessionLifecycle, false)).toBe("idle");
  });
});
