import assert from "node:assert/strict";
import { it as test } from "vitest";
import {
  runtimeTotalTokensFromSessionStats,
  runtimeUsageFromSessionStats,
  runtimeUsageFromSources,
  runtimeUsageFromState,
} from "./runtimeUsage.js";

test("maps the current Pi get_session_stats aggregate with field provenance", () => {
  // Shape verified from installed Pi 0.87 source. Values are sanitized and are
  // not represented as a captured authenticated-provider payload.
  const usage = runtimeUsageFromSessionStats({
    tokens: {
      input: 120,
      output: 30,
      cacheRead: 5,
      cacheWrite: 2,
      total: 157,
    },
    cost: 0.0123,
    contextUsage: { tokens: 127, contextWindow: 200000, percent: 0.06 },
  });

  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    totalTokens: 157,
    contextUsedTokens: 127,
    contextWindowTokens: 200000,
    totalCostUsd: 0.0123,
    reportedFields: [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
      "contextUsedTokens",
      "contextWindowTokens",
      "totalCostUsd",
    ],
  });
});

test("treats missing and Pi's eager all-zero aggregate as unavailable", () => {
  assert.equal(runtimeUsageFromSessionStats(undefined), undefined);
  assert.deepEqual(
    runtimeUsageFromSessionStats({ contextUsage: { contextWindow: 200000 } }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      contextWindowTokens: 200000,
      reportedFields: ["contextWindowTokens"],
    },
  );
  // This exact no-provider shape was observed from an isolated, offline
  // get_session_stats call. Pi initializes these counters before model usage.
  assert.equal(
    runtimeUsageFromSessionStats({
      assistantMessages: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
    undefined,
  );
});

test("keeps partial aggregates sparse for renderer honesty", () => {
  assert.deepEqual(runtimeUsageFromSessionStats({ tokens: { input: 12 } }), {
    inputTokens: 12,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 12,
    reportedFields: ["inputTokens"],
  });
  assert.deepEqual(
    runtimeUsageFromSessionStats({
      tokens: { input: 12, output: 1, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    })?.reportedFields,
    ["inputTokens", "outputTokens"],
  );
});

test("uses only explicit Pi token counters for delegated telemetry", () => {
  assert.equal(
    runtimeTotalTokensFromSessionStats({
      contextUsage: { tokens: 500, contextWindow: 200000 },
    }),
    undefined,
  );
  assert.equal(
    runtimeTotalTokensFromSessionStats({ tokens: { input: 0, output: 0 } }),
    0,
  );
  assert.equal(
    runtimeTotalTokensFromSessionStats({ tokens: { input: 100, output: 10 } }),
    110,
  );
});

test("keeps legacy get_state usage fallback compatible and merges partial stats", () => {
  const state = {
    usage: {
      input: 3,
      output: 4,
      cacheRead: 1,
      total: 8,
      cost: { total: 0.004 },
    },
  };
  assert.deepEqual(runtimeUsageFromState(state), {
    inputTokens: 3,
    outputTokens: 4,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    totalTokens: 8,
    totalCostUsd: 0.004,
    reportedFields: [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "totalTokens",
      "totalCostUsd",
    ],
  });
  assert.deepEqual(runtimeUsageFromSources(state, { tokens: { input: 10 } }), {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    totalTokens: 8,
    totalCostUsd: 0.004,
    reportedFields: [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "totalTokens",
      "totalCostUsd",
    ],
  });
});
