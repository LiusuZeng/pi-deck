import type { JsonObject } from "../types.js";

export const SUBAGENT_PRIVATE_FIXTURE_VALUES = {
  thinking: "PRIVATE_THINKING_DO_NOT_RENDER",
  system:
    "SYSTEM_SECRET_DO_NOT_RENDER sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  user: "USER_SECRET_DO_NOT_RENDER ghp_0123456789abcdefghijklmnopqrstuvwxyzABCD",
  toolOutput: "RAW_TOOL_RESULT_DO_NOT_RENDER password=hunter2",
  argumentSecret: "Bearer eyJhbGciOiJIUzI1NiJ9.fixture.signature",
  assistantSecret: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
} as const;

export interface SubagentActivityFixture {
  toolCallId: string;
  args: JsonObject;
  partialResults: JsonObject[];
  result: JsonObject;
  isError: boolean;
}

const emptyUsage = (): JsonObject => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
});

const details = (
  mode: "single" | "parallel" | "chain",
  results: JsonObject[],
): JsonObject => ({
  mode,
  agentScope: "user",
  projectAgentsDir: null,
  results,
});

function assistantMessage(
  content: JsonObject[],
  usage?: JsonObject,
): JsonObject {
  return {
    role: "assistant",
    content,
    ...(usage === undefined ? {} : { usage }),
    stopReason: "toolUse",
  };
}

function privateContextMessages(): JsonObject[] {
  return [
    { role: "system", content: SUBAGENT_PRIVATE_FIXTURE_VALUES.system },
    { role: "user", content: SUBAGENT_PRIVATE_FIXTURE_VALUES.user },
  ];
}

function firstScoutMessage(): JsonObject {
  return assistantMessage(
    [
      {
        type: "thinking",
        thinking: SUBAGENT_PRIVATE_FIXTURE_VALUES.thinking,
      },
      {
        type: "toolCall",
        id: "child-read-call",
        name: "read",
        arguments: {
          path: "/private/fixture/sessionRuntimeReducer.ts",
          authorization: SUBAGENT_PRIVATE_FIXTURE_VALUES.argumentSecret,
        },
      },
      {
        type: "text",
        text: `Located the runtime projection boundary. Credential ${SUBAGENT_PRIVATE_FIXTURE_VALUES.assistantSecret} must be redacted.`,
      },
    ],
    {
      input: 80,
      output: 20,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 105,
      cost: { total: 0.001 },
    },
  );
}

function rawToolResultMessage(): JsonObject {
  return {
    role: "toolResult",
    toolCallId: "child-read-call",
    toolName: "read",
    content: [
      { type: "text", text: SUBAGENT_PRIVATE_FIXTURE_VALUES.toolOutput },
    ],
    isError: false,
  };
}

function secondScoutMessage(): JsonObject {
  return assistantMessage(
    [
      {
        type: "toolCall",
        id: "child-grep-call",
        name: "grep",
        arguments: {
          pattern: "tool_execution_update",
          path: "/private/fixture",
        },
      },
      {
        type: "text",
        text: "Confirmed cumulative updates preserve child identity.",
      },
    ],
    {
      input: 45,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 60,
      cost: { total: 0.0005 },
    },
  );
}

function parallelResults(stage: 1 | 2 | "final"): JsonObject[] {
  const firstMessages = [
    ...privateContextMessages(),
    firstScoutMessage(),
    rawToolResultMessage(),
    ...(stage === 1 ? [] : [secondScoutMessage()]),
  ];
  const secondMessages =
    stage === 1
      ? []
      : [
          assistantMessage([
            {
              type: "toolCall",
              id: "child-review-call",
              name: "read",
              arguments: { path: "/private/fixture/privacy-contract.md" },
            },
            {
              type: "text",
              text: "Reviewed the safe activity allowlist.",
            },
          ]),
        ];
  const thirdMessages =
    stage === "final"
      ? [
          assistantMessage([
            {
              type: "text",
              text: "Verified the narrow layout contract.",
            },
          ]),
        ]
      : [];

  return [
    {
      agent: "scout",
      agentSource: "user",
      task: "Inspect runtime event projection",
      // The real extension initializes a running single result to zero.
      // Updates must not interpret this sentinel as completion.
      exitCode: 0,
      messages: firstMessages,
      stderr: "",
      usage:
        stage === 1
          ? {
              input: 80,
              output: 20,
              cacheRead: 5,
              cacheWrite: 0,
              cost: 0.001,
              contextTokens: 105,
              turns: 1,
            }
          : {
              input: 125,
              output: 35,
              cacheRead: 5,
              cacheWrite: 0,
              cost: 0.0015,
              contextTokens: 165,
              turns: 2,
            },
      model: "fake-provider/fake-model",
      ...(stage === "final" ? { stopReason: "stop" } : {}),
    },
    {
      // Repeated names deliberately prove identity is index-scoped.
      agent: "scout",
      agentSource: "user",
      task: "Review privacy boundaries",
      exitCode: stage === "final" ? 1 : -1,
      messages: secondMessages,
      stderr: stage === "final" ? "fixture review failed" : "",
      usage:
        stage === "final"
          ? {
              input: 30,
              output: 8,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.0004,
              contextTokens: 38,
              turns: 1,
            }
          : emptyUsage(),
      model: "fake-provider/fake-model",
      ...(stage === "final"
        ? {
            stopReason: "error",
            errorMessage:
              "Privacy review found a deterministic fixture failure.",
          }
        : {}),
    },
    {
      agent: "reviewer",
      agentSource: stage === "final" ? "user" : "unknown",
      task: "Confirm narrow layout behavior",
      exitCode: stage === "final" ? 0 : -1,
      messages: thirdMessages,
      stderr: "",
      usage:
        stage === "final"
          ? {
              input: 22,
              output: 7,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.0003,
              contextTokens: 29,
              turns: 1,
            }
          : emptyUsage(),
      ...(stage === "final"
        ? { model: "fake-provider/fake-model", stopReason: "stop" }
        : {}),
    },
  ];
}

function singleResult(
  stage: 1 | 2 | "final",
  options: { oversized?: boolean } = {},
): JsonObject {
  const oversized = options.oversized === true;
  const task = oversized
    ? `Safely inspect bounded input ${"task-segment ".repeat(100)}`
    : "Inspect one deterministic target";
  const messages = oversized
    ? Array.from({ length: 140 }, (_, index) =>
        assistantMessage([
          {
            type: "text",
            text: `oversized-public-entry-${index}-${"x".repeat(1_800)}`,
          },
        ]),
      )
    : [
        assistantMessage([
          {
            type: "toolCall",
            id: "single-read-call",
            name: "read",
            arguments: { path: "/private/single-target.ts" },
          },
          { type: "text", text: "Located the single-agent target." },
        ]),
        ...(stage === 1
          ? []
          : [
              assistantMessage([
                {
                  type: "text",
                  text: "Verified the single-agent result.",
                },
              ]),
            ]),
      ];
  return {
    agent: oversized ? "load-tester" : "worker",
    agentSource: "user",
    task,
    // A running single result uses zero before terminal completion.
    exitCode: 0,
    messages,
    stderr: "",
    usage: oversized
      ? {
          input: 9,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.0001,
          contextTokens: 12,
          turns: 140,
        }
      : stage === 1
        ? {
            input: 20,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.0002,
            contextTokens: 30,
            turns: 1,
          }
        : {
            input: 30,
            output: 15,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.0003,
            contextTokens: 45,
            turns: 2,
          },
    model: "fake-provider/fake-model",
    ...(stage === "final" ? { stopReason: "stop" } : {}),
  };
}

export function createSingleSuccessSubagentActivityFixture(
  toolCallId: string,
): SubagentActivityFixture {
  const args: JsonObject = {
    agent: "worker",
    task: "Inspect one deterministic target",
    agentScope: "user",
  };
  return {
    toolCallId,
    args,
    partialResults: [
      {
        content: [{ type: "text", text: "Single: first activity observed" }],
        details: details("single", [singleResult(1)]),
      },
      {
        content: [{ type: "text", text: "Single: second activity observed" }],
        details: details("single", [singleResult(2)]),
      },
    ],
    result: {
      content: [{ type: "text", text: "Single agent completed." }],
      details: details("single", [singleResult("final")]),
    },
    isError: false,
  };
}

export function createCancellationSubagentActivityFixture(
  toolCallId: string,
): SubagentActivityFixture {
  const args: JsonObject = {
    agent: "worker",
    task: "Remain unresolved until the user aborts",
    agentScope: "user",
  };
  const running = {
    agent: "worker",
    agentSource: "user",
    task: "Remain unresolved until the user aborts",
    exitCode: 0,
    messages: [
      assistantMessage([
        {
          type: "toolCall",
          id: "cancel-read-call",
          name: "read",
          arguments: { path: "/private/cancellation-target.ts" },
        },
        { type: "text", text: "Started cancellable child work." },
      ]),
    ],
    stderr: "",
    usage: {
      input: 12,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0001,
      contextTokens: 16,
      turns: 1,
    },
    model: "fake-provider/fake-model",
  } satisfies JsonObject;
  return {
    toolCallId,
    args,
    partialResults: [
      {
        content: [{ type: "text", text: "Single: cancellable activity" }],
        details: details("single", [running]),
      },
    ],
    // This result is intentionally never emitted: the actual RPC abort path
    // ends the parent without a tool_execution_end event.
    result: {
      content: [{ type: "text", text: "Cancelled by user." }],
      details: details("single", [
        { ...running, stopReason: "aborted", exitCode: 130 },
      ]),
    },
    isError: true,
  };
}

export function createMalformedSubagentActivityFixture(
  toolCallId: string,
): SubagentActivityFixture {
  const unsupported = {
    content: [{ type: "text", text: "Unsupported subagent details" }],
    details: { mode: "future-mode", results: "not-an-array" },
  } satisfies JsonObject;
  return {
    toolCallId,
    // Missing task makes the extension arguments unrecognizable, so Deck must
    // retain the generic tool card instead of manufacturing child activity.
    args: { agent: "malformed-only" },
    partialResults: [unsupported],
    result: unsupported,
    isError: false,
  };
}

export function createOversizedSubagentActivityFixture(
  toolCallId: string,
): SubagentActivityFixture {
  const result = singleResult("final", { oversized: true });
  return {
    toolCallId,
    args: {
      agent: "load-tester",
      task: `Safely inspect bounded input ${"task-segment ".repeat(100)}`,
      agentScope: "user",
    },
    partialResults: [
      {
        content: [{ type: "text", text: "Oversized activity observed" }],
        details: details("single", [result]),
      },
    ],
    result: {
      content: [{ type: "text", text: "Oversized fixture completed." }],
      details: details("single", [result]),
    },
    isError: false,
  };
}

export function createParallelSubagentActivityFixture(
  toolCallId: string,
): SubagentActivityFixture {
  const args: JsonObject = {
    tasks: [
      { agent: "scout", task: "Inspect runtime event projection" },
      { agent: "scout", task: "Review privacy boundaries" },
      { agent: "reviewer", task: "Confirm narrow layout behavior" },
    ],
    agentScope: "user",
  };
  return {
    toolCallId,
    args,
    partialResults: [
      {
        content: [{ type: "text", text: "Parallel: activity observed" }],
        details: details("parallel", parallelResults(1)),
      },
      {
        content: [{ type: "text", text: "Parallel: 0/3 done" }],
        details: details("parallel", parallelResults(2)),
      },
    ],
    result: {
      content: [
        {
          type: "text",
          text: "Parallel: 2/3 succeeded; privacy review failed.",
        },
      ],
      details: details("parallel", parallelResults("final")),
    },
    isError: false,
  };
}

function chainResult(
  agent: string,
  task: string,
  step: number,
  options: { failed?: boolean } = {},
): JsonObject {
  const failed = options.failed === true;
  return {
    agent,
    agentSource: "user",
    task,
    step,
    exitCode: failed ? 1 : 0,
    messages: [
      assistantMessage([
        {
          type: "toolCall",
          id: `chain-tool-${step}`,
          name: step === 1 ? "read" : "grep",
          arguments: { path: `/private/chain-step-${step}` },
        },
        {
          type: "text",
          text: failed
            ? "The contract review could not continue."
            : "Prepared the chain handoff.",
        },
      ]),
    ],
    stderr: failed ? "deterministic chain failure" : "",
    usage: {
      input: failed ? 18 : 25,
      output: failed ? 4 : 6,
      cacheRead: 0,
      cacheWrite: 0,
      cost: failed ? 0.0002 : 0.0003,
      contextTokens: failed ? 22 : 31,
      turns: 1,
    },
    model: "fake-provider/fake-model",
    stopReason: failed ? "error" : "stop",
    ...(failed
      ? { errorMessage: "Chain stopped on deterministic review failure." }
      : {}),
  };
}

export function createChainFailureSubagentActivityFixture(
  toolCallId: string,
): SubagentActivityFixture {
  const first = chainResult("worker", "Prepare the handoff", 1);
  const second = chainResult(
    "reviewer",
    "Review prepared handoff: {previous}",
    2,
    { failed: true },
  );
  return {
    toolCallId,
    args: {
      chain: [
        { agent: "worker", task: "Prepare the handoff" },
        { agent: "reviewer", task: "Review prepared handoff: {previous}" },
        { agent: "worker", task: "Publish approved handoff: {previous}" },
      ],
      agentScope: "user",
    },
    partialResults: [
      {
        content: [{ type: "text", text: "Prepared the chain handoff." }],
        details: details("chain", [first]),
      },
    ],
    result: {
      content: [
        {
          type: "text",
          text: "Chain stopped at step 2 (reviewer): deterministic review failure.",
        },
      ],
      details: details("chain", [first, second]),
    },
    isError: true,
  };
}
