import { describe, expect, test } from "vitest";
import {
  TASK_SESSION_PLANNER_MAX_TASKS,
  buildTaskSessionPlannerPrompt,
  fallbackTaskSessionPlan,
  parseTaskSessionPlannerResponse,
  resolveTaskSessionPlannerTimeoutMs,
  TASK_SESSION_PLANNER_TIMEOUT_MS,
} from "./taskSessionPlanner.js";

describe("task-session planner", () => {
  test("parses a fenced plan and normalizes task lines", () => {
    const plan = parseTaskSessionPlannerResponse(`Here is the plan:
\`\`\`json
{"contextSummary":"Compare countries", "tasks":[{"generatedName":"France\\nresearch", "brief":"Research\\nFrance"},{"generatedName":"Japan", "brief":"Research Japan"},{"generatedName":"Brazil", "brief":"Research Brazil"}]}
\`\`\``);
    expect(plan).toEqual({
      contextSummary: "Compare countries",
      tasks: [
        { generatedName: "France research", brief: "Research France" },
        { generatedName: "Japan", brief: "Research Japan" },
        { generatedName: "Brazil", brief: "Research Brazil" },
      ],
    });
  });

  test("finds plain JSON surrounded by model prose", () => {
    expect(
      parseTaskSessionPlannerResponse(
        'Result: {"contextSummary":"x","tasks":[{"generatedName":"A","brief":"Do A"}]} thanks',
      ),
    ).toMatchObject({
      contextSummary: "x",
      tasks: [{ generatedName: "A" }],
    });
  });

  test("extracts the first balanced object despite quoted and trailing braces", () => {
    expect(
      parseTaskSessionPlannerResponse(
        'Model note: {"contextSummary":"brace } in a quoted string","tasks":[{"generatedName":"A","brief":"Do { A }"}]} trailing } prose',
      ),
    ).toMatchObject({
      contextSummary: "brace } in a quoted string",
      tasks: [{ generatedName: "A", brief: "Do { A }" }],
    });
  });

  test("uses a bounded planner timeout default", () => {
    expect(resolveTaskSessionPlannerTimeoutMs(undefined)).toBe(
      TASK_SESSION_PLANNER_TIMEOUT_MS,
    );
    expect(resolveTaskSessionPlannerTimeoutMs("25")).toBe(25);
    expect(resolveTaskSessionPlannerTimeoutMs("0")).toBe(
      TASK_SESSION_PLANNER_TIMEOUT_MS,
    );
    expect(resolveTaskSessionPlannerTimeoutMs("not-a-number")).toBe(
      TASK_SESSION_PLANNER_TIMEOUT_MS,
    );
  });

  test("rejects malformed and oversized plans", () => {
    expect(() => parseTaskSessionPlannerResponse("not json")).toThrow();
    const tasks = Array.from(
      { length: TASK_SESSION_PLANNER_MAX_TASKS + 1 },
      () => ({ generatedName: "A", brief: "B" }),
    );
    expect(() =>
      parseTaskSessionPlannerResponse(
        JSON.stringify({ contextSummary: "x", tasks }),
      ),
    ).toThrow("task count");
  });

  test("prompt asks for strict independently executable fanout and fallback remains one task", () => {
    expect(
      buildTaskSessionPlannerPrompt({
        originalPrompt: "Compare France, Japan, and Brazil",
        parentContext: "",
      }),
    ).toContain("three country tasks");
    expect(
      fallbackTaskSessionPlan("Do the thing", "SECRET parent transcript"),
    ).toEqual({
      contextSummary:
        "Planning was unavailable; use only the original request and assigned task brief.",
      tasks: [
        {
          generatedName: "Do the thing",
          brief:
            "Independently complete the requested work, verify it, and report a concise result.",
        },
      ],
    });
  });
});
