import { describe, expect, it } from "vitest";
import {
  projectDelegatedStatus,
  projectDelegatedToolStatus,
} from "./delegatedStatus.js";

describe("projectDelegatedStatus", () => {
  it.each([
    {
      name: "children running",
      input: {
        parentState: "running" as const,
        children: { total: 3, running: 2, succeeded: 1 },
      },
      label: "Running delegated tasks",
      detail: "2 of 3 delegated tasks active · 1 succeeded",
      tone: "working",
    },
    {
      name: "children finished while parent processes",
      input: {
        parentState: "running" as const,
        parentPhase: "processing",
        children: { total: 3, succeeded: 3 },
      },
      label: "Processing delegated results",
      detail: "3 delegated tasks finished · 3 succeeded",
      tone: "working",
    },
    {
      name: "explicit synthesis",
      input: {
        parentState: "running" as const,
        parentPhase: "synthesizing",
        children: { total: 3, succeeded: 3 },
      },
      label: "Synthesizing results",
      detail: "3 delegated tasks finished · 3 succeeded",
      tone: "working",
    },
    {
      name: "explicit review",
      input: {
        parentState: "running" as const,
        parentPhase: "reviewing",
        children: { total: 2, succeeded: 2 },
      },
      label: "Reviewing delegated results",
      detail: "2 delegated tasks finished · 2 succeeded",
      tone: "working",
    },
    {
      name: "explicit validation",
      input: {
        parentState: "running" as const,
        parentPhase: "validation",
        children: { total: 2, succeeded: 2 },
      },
      label: "Validating delegated results",
      detail: "2 delegated tasks finished · 2 succeeded",
      tone: "working",
    },
    {
      name: "synthesis retry",
      input: {
        parentState: "running" as const,
        parentPhase: "synthesis-retry",
        children: { total: 2, succeeded: 2 },
      },
      label: "Retrying final response",
      detail: "2 delegated tasks finished · 2 succeeded",
      tone: "working",
    },
    {
      name: "mixed child outcomes",
      input: {
        parentState: "running" as const,
        parentPhase: "collecting",
        children: { total: 4, succeeded: 2, failed: 1, cancelled: 1 },
      },
      label: "Collecting delegated results",
      detail:
        "4 delegated tasks finished · 2 succeeded · 1 failed · 1 cancelled",
      tone: "working",
    },
    {
      name: "parent completed",
      input: {
        parentState: "completed" as const,
        children: { total: 3, succeeded: 3 },
      },
      label: "Completed delegated work",
      detail: "3 delegated tasks finished · 3 succeeded",
      tone: "success",
    },
    {
      name: "parent failed after children",
      input: {
        parentState: "failed" as const,
        children: { total: 3, succeeded: 3 },
      },
      label: "Delegated work failed",
      detail: "3 delegated tasks finished · 3 succeeded",
      tone: "error",
    },
  ])("projects $name independently", ({ input, label, detail, tone }) => {
    expect(projectDelegatedStatus(input)).toMatchObject({
      label,
      detail,
      tone,
    });
  });

  it("does not invent synthesis or completion when only terminal children are known", () => {
    expect(
      projectDelegatedStatus({
        parentState: "running",
        children: { total: 2, succeeded: 1, failed: 1 },
      }),
    ).toMatchObject({
      label: "Processing delegated results",
      detail: "2 delegated tasks finished · 1 succeeded · 1 failed",
      tone: "working",
    });
  });

  it("keeps independent operation projections independent", () => {
    const processing = projectDelegatedStatus({
      parentState: "running",
      parentPhase: "processing",
      children: { total: 2, succeeded: 2 },
    });
    const failing = projectDelegatedStatus({
      parentState: "failed",
      children: { total: 1, failed: 1 },
    });

    expect(processing.label).toBe("Processing delegated results");
    expect(processing.tone).toBe("working");
    expect(failing.label).toBe("Delegated work failed");
    expect(failing.detail).toBe("1 delegated task finished · 1 failed");
  });
});

describe("projectDelegatedToolStatus", () => {
  it("uses structured parent phases and child outcomes from subagent updates", () => {
    const projection = projectDelegatedToolStatus({
      type: "tool_execution_update",
      toolName: "subagent",
      toolCallId: "delegation-a",
      partialResult: {
        content: [{ type: "text", text: "backend detail" }],
        details: {
          mode: "parallel",
          parentPhase: "synthesizing",
          results: [
            { status: "completed" },
            { status: "failed" },
            { status: "cancelled" },
          ],
        },
      },
    });

    expect(projection).toMatchObject({
      label: "Synthesizing results",
      detail:
        "3 delegated tasks finished · 1 succeeded · 1 failed · 1 cancelled",
      tone: "working",
      parentState: "running",
    });
  });

  it("replaces the legacy done/running text with honest fallback copy", () => {
    const projection = projectDelegatedToolStatus({
      type: "tool_execution_update",
      toolName: "subagent",
      args: { tasks: [{}, {}, {}] },
      partialResult: {
        content: [{ type: "text", text: "Parallel: 3/3 done, 0 running..." }],
        details: {
          mode: "parallel",
          results: [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 1 }],
        },
      },
    });

    expect(projection).toMatchObject({
      label: "Processing delegated results",
      detail: "3 delegated tasks finished · 2 succeeded · 1 failed",
      tone: "working",
    });
    expect(`${projection?.label} ${projection?.detail}`).not.toContain("done");
  });

  it("requires an authoritative tool end before displaying Completed", () => {
    const shared = {
      toolName: "subagent",
      result: {
        details: {
          parentPhase: "completed",
          results: [{ exitCode: 0 }, { exitCode: 0 }],
        },
      },
    };
    const stillRunning = projectDelegatedToolStatus({
      ...shared,
      type: "tool_execution_update",
      partialResult: shared.result,
    });
    const ended = projectDelegatedToolStatus({
      ...shared,
      type: "tool_execution_end",
    });

    expect(stillRunning?.label).not.toContain("Completed");
    expect(stillRunning?.tone).toBe("working");
    expect(ended).toMatchObject({
      label: "Completed delegated work",
      tone: "success",
    });
  });

  it("projects parent failure and cancellation separately from mixed children", () => {
    const details = {
      results: [
        { exitCode: 0 },
        { exitCode: 1 },
        { exitCode: 143, stopReason: "aborted" },
      ],
    };
    expect(
      projectDelegatedToolStatus({
        type: "tool_execution_end",
        toolName: "subagent",
        result: { isError: true, details },
      }),
    ).toMatchObject({
      label: "Delegated work failed",
      detail:
        "3 delegated tasks finished · 1 succeeded · 1 failed · 1 cancelled",
    });
    expect(
      projectDelegatedToolStatus({
        type: "tool_execution_end",
        toolName: "subagent",
        status: "aborted",
        result: { details },
      }),
    ).toMatchObject({ label: "Delegated work cancelled" });
  });

  it("does not project ordinary tools", () => {
    expect(
      projectDelegatedToolStatus({
        type: "tool_execution_update",
        toolName: "read",
      }),
    ).toBeUndefined();
  });
});
