import { describe, expect, it } from "vitest";
import {
  projectSubagentActivity,
  redactCommonSecrets,
} from "./subagentActivity.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  contextTokens: 0,
  turns: 0,
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    agent: "worker",
    task: "Inspect the renderer",
    exitCode: 0,
    messages: [],
    usage: zeroUsage,
    ...overrides,
  };
}

function details(mode: "single" | "parallel" | "chain", results: unknown[]) {
  return {
    mode,
    results,
    agentScope: "user",
    projectAgentsDir: null,
  };
}

describe("projectSubagentActivity", () => {
  it("seeds single activity and never treats partial exitCode 0 as complete", () => {
    const waiting = projectSubagentActivity({
      toolName: "subagent",
      args: { agent: "worker", task: "Inspect the renderer" },
      phase: "running",
    });
    const observed = projectSubagentActivity({
      toolName: "subagent",
      args: { agent: "worker", task: "Inspect the renderer" },
      details: details("single", [
        result({
          messages: [
            { role: "system", content: "secret system prompt" },
            { role: "user", content: "password=user-secret" },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "private chain of thought" },
                {
                  type: "toolCall",
                  name: "read",
                  arguments: { apiKey: "sk-abcdefghijklmnop" },
                },
                {
                  type: "text",
                  text: "Found the reducer. Bearer top-secret-credential",
                },
              ],
            },
            {
              role: "toolResult",
              content: "raw output password=tool-secret",
            },
          ],
          usage: { ...zeroUsage, turns: 1, input: 25, output: 5 },
        }),
      ]),
      phase: "running",
      previous: waiting,
    });

    expect(waiting?.children[0]).toMatchObject({
      index: 0,
      state: "Waiting for activity",
      agent: "worker",
      task: "Inspect the renderer",
    });
    expect(observed?.children[0]).toMatchObject({
      state: "Activity observed",
      completedTurns: 1,
      usage: { inputTokens: 25, outputTokens: 5, totalTokens: 30 },
      history: [
        { kind: "tool", label: "read" },
        {
          kind: "text",
          text: "Found the reducer. Bearer [REDACTED]",
        },
      ],
    });
    expect(JSON.stringify(observed)).not.toContain("chain of thought");
    expect(JSON.stringify(observed)).not.toContain("user-secret");
    expect(JSON.stringify(observed)).not.toContain("tool-secret");
    expect(JSON.stringify(observed)).not.toContain("abcdefghijklmnop");
  });

  it("uses true terminal evidence and keeps unknown zero usage pending", () => {
    const partial = projectSubagentActivity({
      toolName: "subagent",
      args: { agent: "worker", task: "Do work" },
      details: details("single", [result()]),
      phase: "running",
    });
    const terminal = projectSubagentActivity({
      toolName: "subagent",
      args: { agent: "worker", task: "Do work" },
      details: details("single", [result({ model: "safe-model" })]),
      phase: "terminal",
      previous: partial,
    });

    expect(partial?.children[0]).toMatchObject({
      state: "Waiting for activity",
    });
    expect(partial?.children[0]?.usage).toBeUndefined();
    expect(partial?.children[0]?.completedTurns).toBeUndefined();
    expect(terminal?.children[0]).toMatchObject({
      state: "Completed",
      model: "safe-model",
    });
    expect(terminal?.children[0]?.usage).toBeUndefined();
  });

  it("keeps duplicate parallel agent names distinct and replaces cumulative snapshots", () => {
    const args = {
      tasks: [
        { agent: "worker", task: "First task" },
        { agent: "worker", task: "Second task" },
      ],
    };
    const first = projectSubagentActivity({
      toolName: "subagent",
      args,
      details: details("parallel", [
        result({
          task: "First task",
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", name: "grep", arguments: {} }],
            },
          ],
          usage: { ...zeroUsage, turns: 1, input: 10 },
        }),
        result({ task: "Second task", exitCode: -1 }),
      ]),
      phase: "running",
    });
    const second = projectSubagentActivity({
      toolName: "subagent",
      args,
      details: details("parallel", [
        result({
          task: "First task",
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", name: "grep", arguments: {} }],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "First is done" }],
            },
          ],
          usage: { ...zeroUsage, turns: 2, input: 14 },
        }),
        result({
          task: "Second task",
          exitCode: -1,
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", name: "read", arguments: {} }],
            },
          ],
          usage: { ...zeroUsage, turns: 1, input: 7 },
        }),
      ]),
      phase: "running",
      previous: first,
    });

    expect(
      second?.children.map(({ index, agent, task }) => ({
        index,
        agent,
        task,
      })),
    ).toEqual([
      { index: 0, agent: "worker", task: "First task" },
      { index: 1, agent: "worker", task: "Second task" },
    ]);
    expect(second?.children[0]?.history).toEqual([
      { kind: "tool", label: "grep" },
      { kind: "text", text: "First is done" },
    ]);
    expect(second?.children[0]?.completedTurns).toBe(2);
    expect(second?.children[1]?.history).toEqual([
      { kind: "tool", label: "read" },
    ]);
  });

  it("seeds every chain step and marks later steps Not run after failure", () => {
    const activity = projectSubagentActivity({
      toolName: "subagent",
      args: {
        chain: [
          { agent: "worker", task: "Implement" },
          { agent: "reviewer", task: "Review {previous}" },
          { agent: "worker", task: "Fix findings" },
        ],
      },
      details: details("chain", [
        result({ agent: "worker", task: "Implement", step: 1, exitCode: 0 }),
        result({
          agent: "reviewer",
          task: "Review output",
          step: 2,
          exitCode: 1,
          stopReason: "error",
          errorMessage: "Review failed; api_key=very-secret-value",
        }),
      ]),
      phase: "terminal",
    });

    expect(
      activity?.children.map((child) => [child.step, child.state]),
    ).toEqual([
      [1, "Completed"],
      [2, "Failed"],
      [3, "Not run"],
    ]);
    expect(JSON.stringify(activity)).not.toContain("very-secret-value");
  });

  it("distinguishes interruption, failure, and unknown terminal results", () => {
    const activity = projectSubagentActivity({
      toolName: "subagent",
      args: {
        tasks: [
          { agent: "a", task: "abort" },
          { agent: "b", task: "fail" },
          { agent: "c", task: "unknown" },
          { agent: "d", task: "missing" },
        ],
      },
      details: details("parallel", [
        result({ agent: "a", task: "abort", stopReason: "aborted" }),
        result({ agent: "b", task: "fail", exitCode: 2 }),
        result({ agent: "c", task: "unknown", exitCode: -1 }),
      ]),
      phase: "terminal",
      parentInterrupted: false,
    });

    expect(activity?.children.map((child) => child.state)).toEqual([
      "Interrupted",
      "Failed",
      "Unknown",
      "Unknown",
    ]);
  });

  it("retains last-observed time across identical cumulative snapshots", () => {
    const args = { agent: "worker", task: "Observe progress" };
    const liveDetails = details("single", [
      result({
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", name: "read", arguments: {} }],
          },
        ],
        usage: { ...zeroUsage, turns: 1, input: 4 },
      }),
    ]);
    const first = projectSubagentActivity({
      toolName: "subagent",
      args,
      details: liveDetails,
      phase: "running",
      observedAtMs: 1_000,
    });
    const heartbeat = projectSubagentActivity({
      toolName: "subagent",
      args,
      details: liveDetails,
      phase: "running",
      observedAtMs: 9_000,
      previous: first,
    });
    const progressed = projectSubagentActivity({
      toolName: "subagent",
      args,
      details: details("single", [
        result({
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", name: "read", arguments: {} }],
            },
            { role: "assistant", content: "A new public update" },
          ],
          usage: { ...zeroUsage, turns: 2, input: 7 },
        }),
      ]),
      phase: "running",
      observedAtMs: 12_000,
      previous: heartbeat,
    });

    expect(first?.children[0]?.lastObservedAtMs).toBe(1_000);
    expect(heartbeat?.children[0]?.lastObservedAtMs).toBe(1_000);
    expect(progressed?.children[0]?.lastObservedAtMs).toBe(12_000);
    expect(
      projectSubagentActivity({
        toolName: "subagent",
        args,
        details: liveDetails,
        phase: "terminal",
      })?.children[0]?.lastObservedAtMs,
    ).toBeUndefined();
  });

  it("does not alias explicit chain steps or complete malformed results", () => {
    const activity = projectSubagentActivity({
      toolName: "subagent",
      args: {
        chain: [
          { agent: "first", task: "First" },
          { agent: "second", task: "Second" },
        ],
      },
      details: details("chain", [
        result({ agent: "second", task: "Second", step: 2, exitCode: 0 }),
      ]),
      phase: "terminal",
    });
    const malformed = projectSubagentActivity({
      toolName: "subagent",
      args: { agent: "worker", task: "Task" },
      details: details("single", [{ exitCode: 0 }]),
      phase: "terminal",
    });

    expect(activity?.children.map((child) => child.state)).toEqual([
      "Unknown",
      "Completed",
    ]);
    expect(activity?.children[0]).toMatchObject({
      agent: "first",
      task: "First",
    });
    expect(malformed?.children[0]?.state).toBe("Unknown");
  });

  it("redacts credential-shaped tool names and bounds oversized public fields", () => {
    const boundarySecret = `${"x".repeat(1_190)} sk-abcdefghijklmnop trailing`;
    const activity = projectSubagentActivity({
      toolName: "subagent",
      args: { agent: "worker", task: "Inspect" },
      details: details("single", [
        result({
          agent: `${"a".repeat(100_000)} sk-abcdefghijklmnop`,
          task: `${"t".repeat(490)} sk-abcdefghijklmnop trailing`,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "toolCall", name: "sk-abcdefghijklmnop" },
                { type: "text", text: boundarySecret },
              ],
            },
          ],
        }),
      ]),
      phase: "running",
      observedAtMs: 1,
    });
    const serialized = JSON.stringify(activity);

    expect(activity?.children[0]?.history[0]).toEqual({
      kind: "tool",
      label: "Tool",
    });
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(serialized.length).toBeLessThan(10_000);
  });

  it("isolates projections by call, handles malformed input, and bounds history", () => {
    const first = projectSubagentActivity({
      toolName: "subagent",
      args: { agent: "alpha", task: "A" },
      details: details("single", [
        result({
          agent: "alpha",
          task: "A",
          messages: Array.from({ length: 200 }, (_, index) => ({
            role: "assistant",
            content: [
              { type: "text", text: `entry-${index}-${"x".repeat(2_000)}` },
            ],
          })),
        }),
      ]),
      phase: "running",
    });
    const second = projectSubagentActivity({
      toolName: "subagent",
      args: { agent: "beta", task: "B" },
      phase: "running",
    });

    expect(first?.children[0]?.agent).toBe("alpha");
    expect(second?.children[0]).toMatchObject({
      agent: "beta",
      history: [],
    });
    expect(first?.children[0]?.history.length).toBeLessThanOrEqual(24);
    expect(JSON.stringify(first).length).toBeLessThan(10_000);
    expect(
      projectSubagentActivity({
        toolName: "subagent",
        args: { agent: "only-one-field" },
        details: { mode: "future", results: "not-an-array" },
        phase: "running",
      }),
    ).toBeUndefined();
    expect(
      projectSubagentActivity({
        toolName: "other-tool",
        details: details("single", [result()]),
        phase: "terminal",
      }),
    ).toBeUndefined();
  });
});

it("redacts common credential forms without claiming arbitrary secret detection", () => {
  expect(
    redactCommonSecrets(
      'sk-abcdefghijklmnop ghp_abcdefghijklmnop AKIA1234567890ABCDEF password=hunter2 "OPENAI_API_KEY": "obvious-secret"',
    ),
  ).toBe(
    '[REDACTED] [REDACTED] [REDACTED] password=[REDACTED] "OPENAI_API_KEY": [REDACTED]',
  );
});
