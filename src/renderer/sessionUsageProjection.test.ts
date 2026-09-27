import { describe, expect, it } from "vitest";
import {
  clampThinkingLevel,
  eventHasUsageMetadata,
  extractMessageUsage,
  extractTextContent,
  extractThinkingContent,
  getContextWindowTokens,
  getMessageUsageFromEvent,
  mergeSessionUsageFromRuntimeStatus,
  mergeSessionUsageFromSnapshot,
  modelLabelForChatModel,
  modelLabelFromState,
  parseModelLabel,
  thinkingLevelsForModel,
  usageFromMessages,
} from "./sessionUsageProjection.js";

describe("usage projection", () => {
  it("reads aliases, preserves zeroes, and ignores invalid values", () => {
    expect(
      extractMessageUsage({
        usage: {
          prompt_tokens: 0,
          completionTokens: 4,
          cache_read_tokens: 2,
          cacheWrite: 3,
          total_cost_usd: 0,
          totalTokens: 999,
        },
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      totalCostUsd: 0,
    });
    expect(
      extractMessageUsage({ usage: { input: Number.NaN } }),
    ).toBeUndefined();
    expect(
      extractMessageUsage({ usage: { output: Infinity, cost: { usd: 2 } } }),
    ).toEqual({ totalCostUsd: 2 });
  });

  it("aggregates latest message usage, peak context, and optional cost", () => {
    const projection = usageFromMessages(
      [
        {
          id: "duplicate",
          role: "assistant",
          content: "first",
          usage: { input: 2, output: 100, cacheRead: 3, cost: 1 },
        },
        {
          id: "duplicate",
          role: "assistant",
          content: "latest",
          usage: { input: 5, output: 1, cacheWrite: 7, costUsd: 0 },
        },
        {
          id: "other",
          role: "assistant",
          content: "other",
          usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 8 },
        },
      ] as any,
      200,
    );

    expect(projection).toEqual({
      usageByMessageId: {
        duplicate: {
          inputTokens: 5,
          outputTokens: 1,
          cacheWriteTokens: 7,
          totalCostUsd: 0,
        },
        other: {
          inputTokens: 4,
          outputTokens: 2,
          cacheReadTokens: 8,
        },
      },
      usageStats: {
        inputTokens: 9,
        outputTokens: 3,
        cacheReadTokens: 8,
        cacheWriteTokens: 7,
        totalTokens: 27,
        contextUsedTokens: 12,
        contextWindowTokens: 200,
        totalCostUsd: 0,
      },
    });
    expect(usageFromMessages([] as any, 0)).toEqual({
      usageStats: { contextWindowTokens: 0 },
    });
  });

  it("uses direct event usage before message history", () => {
    const event = {
      usage: { input: 0 },
      messages: [{ usage: { input: 12 } }],
    } as any;
    expect(getMessageUsageFromEvent(event)).toEqual({ inputTokens: 0 });
    expect(eventHasUsageMetadata(event)).toBe(true);
    expect(
      getMessageUsageFromEvent({ messages: [{ usage: { output: 2 } }] } as any),
    ).toMatchObject({ outputTokens: 2 });
  });

  it("derives context and model labels without erasing provider-only state", () => {
    expect(getContextWindowTokens({ context_window: 0 } as any)).toBe(0);
    expect(
      getContextWindowTokens({ model: { contextWindowTokens: 128 } } as any),
    ).toBe(128);
    expect(modelLabelForChatModel({ id: "model", provider: "provider" })).toBe(
      "provider / model",
    );
    expect(
      modelLabelFromState({
        provider: "top",
        model: { id: "id", provider: "nested" },
      } as any),
    ).toBe("nested / id");
    expect(modelLabelFromState({ provider: "provider" } as any)).toBe(
      "provider",
    );
    expect(parseModelLabel(" provider / model ")).toEqual({
      provider: "provider",
      modelId: "model",
    });
    expect(parseModelLabel("provider-only")).toBeUndefined();
  });

  it("keeps missing message fields unavailable while summing known totals", () => {
    expect(
      usageFromMessages(
        [
          { id: "one", role: "assistant", usage: { input: 10 } },
          { id: "two", role: "assistant", usage: { output: 2, cost: 0 } },
        ] as any,
        272000,
      ).usageStats,
    ).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      contextUsedTokens: 10,
      contextWindowTokens: 272000,
    });
  });

  it("derives and clamps thinking levels", () => {
    expect(thinkingLevelsForModel(undefined, [])).toEqual(["off"]);
    expect(
      thinkingLevelsForModel({ id: "plain", reasoning: false }, ["high"]),
    ).toEqual(["off"]);
    expect(
      thinkingLevelsForModel(
        {
          id: "reasoning",
          reasoning: true,
          thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null },
        },
        [],
      ),
    ).toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(clampThinkingLevel("minimal", ["high"])).toBe("high");
    expect(clampThinkingLevel("max", ["medium"])).toBe("medium");
    expect(clampThinkingLevel("unknown", [])).toBe("off");
  });

  it("merges metadata without runtime mismatch or no-usage mutation", () => {
    const session = {
      id: "runtime-1",
      title: "Keep",
      timeline: ["keep"],
      modelLabel: "old / model",
      thinkingLevel: "low",
    };
    const fromSnapshot = mergeSessionUsageFromSnapshot(session, {
      id: "runtime-1",
      modelLabel: "new / model",
      usageStats: { inputTokens: 0 },
    });
    expect(fromSnapshot).toMatchObject({
      title: "Keep",
      timeline: ["keep"],
      modelLabel: "new / model",
      thinkingLevel: "low",
      usageStats: { inputTokens: 0 },
    });

    const mismatch = mergeSessionUsageFromRuntimeStatus(session, {
      runtimeId: "other",
      state: { isAgentActive: false },
    } as any);
    expect(mismatch).toBe(session);
    expect(
      mergeSessionUsageFromRuntimeStatus(session, {
        runtimeId: "runtime-1",
        state: { isAgentActive: false, model: "new" },
      } as any),
    ).toBe(session);
    expect(
      mergeSessionUsageFromRuntimeStatus(session, {
        runtimeId: "runtime-1",
        state: { isAgentActive: false },
        usage: {
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1,
        },
      } as any),
    ).toMatchObject({ modelLabel: "old / model", thinkingLevel: "low" });
    expect(
      mergeSessionUsageFromRuntimeStatus(session, {
        runtimeId: "runtime-1",
        state: {
          isAgentActive: false,
          provider: "new",
          model: "model",
          thinkingLevel: "high",
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          contextWindowTokens: 0,
          totalCostUsd: 0,
        },
      } as any),
    ).toMatchObject({
      modelLabel: "new / model",
      thinkingLevel: "high",
      usageStats: { totalTokens: 0, contextWindowTokens: 0, totalCostUsd: 0 },
    });
  });

  it("preserves known cumulative usage across active parallel, terminal, and navigation refreshes", () => {
    const known = {
      id: "runtime-1",
      usageStats: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        totalTokens: 125,
        totalCostUsd: 0.03,
      },
    };
    const duringPrivateWork = mergeSessionUsageFromRuntimeStatus(known, {
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { isAgentActive: true },
    } as any);
    expect(duringPrivateWork).toBe(known);

    const partialTerminal = mergeSessionUsageFromRuntimeStatus(known, {
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { isAgentActive: false },
      usage: {
        inputTokens: 0,
        outputTokens: 25,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        reportedFields: ["outputTokens"],
      },
    } as any);
    expect(partialTerminal.usageStats).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 5,
      totalTokens: 125,
      totalCostUsd: 0.03,
    });

    const navigationSnapshot = mergeSessionUsageFromSnapshot(partialTerminal, {
      id: "runtime-1",
      usageStats: { contextWindowTokens: 272000 },
    });
    expect(navigationSnapshot.usageStats).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 5,
      totalTokens: 125,
      contextWindowTokens: 272000,
      totalCostUsd: 0.03,
    });

    const secondTurn = mergeSessionUsageFromRuntimeStatus(navigationSnapshot, {
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { isAgentActive: false },
      usage: {
        inputTokens: 180,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        totalTokens: 230,
        totalCostUsd: 0.06,
      },
    } as any);
    expect(secondTurn.usageStats).toMatchObject({
      inputTokens: 180,
      outputTokens: 40,
      totalTokens: 230,
      totalCostUsd: 0.06,
    });
  });

  it("replaces current context occupancy while preserving cumulative and sparse usage", () => {
    const known = {
      id: "runtime-1",
      usageStats: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        contextUsedTokens: 900,
        contextWindowTokens: 2000,
        totalCostUsd: 0.03,
      },
    };

    const sparse = mergeSessionUsageFromRuntimeStatus(known, {
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { isAgentActive: false },
      usage: {
        inputTokens: 0,
        outputTokens: 25,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        reportedFields: ["outputTokens"],
      },
    });
    expect(sparse.usageStats).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 120,
      contextUsedTokens: 900,
      totalCostUsd: 0.03,
    });

    const afterCompaction = mergeSessionUsageFromRuntimeStatus(sparse, {
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { isAgentActive: false },
      usage: {
        inputTokens: 80,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 90,
        contextUsedTokens: 400,
        reportedFields: [
          "inputTokens",
          "outputTokens",
          "totalTokens",
          "contextUsedTokens",
        ],
      },
    });
    expect(afterCompaction.usageStats).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 120,
      contextUsedTokens: 400,
      contextWindowTokens: 2000,
      totalCostUsd: 0.03,
    });

    const contextUnavailable = mergeSessionUsageFromRuntimeStatus(
      afterCompaction,
      {
        runtimeId: "runtime-1",
        backendMode: "real",
        state: { isAgentActive: false },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          reportedFields: ["contextUsedTokens"],
        },
      },
    );
    expect(contextUnavailable.usageStats).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 120,
      contextWindowTokens: 2000,
      totalCostUsd: 0.03,
    });
  });

  it("aggregates valid multipart text and thinking content", () => {
    expect(extractTextContent("text")).toBe("text");
    expect(extractTextContent([{ text: "one" }, null, { text: "two" }])).toBe(
      "one\ntwo",
    );
    expect(extractTextContent([])).toBeUndefined();
    expect(
      extractThinkingContent([
        { thinking: "first" },
        { type: "thinking_delta", text: "second" },
        { type: "text", text: "ignored" },
      ]),
    ).toBe("first\nsecond");
  });
});
