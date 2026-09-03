import assert from "node:assert/strict";
import { it as test } from "vitest";
import {
  runtimeUsageFromSessionStats,
  runtimeUsageFromState,
} from "./runtimeUsage.js";

test("maps current Pi get_session_stats usage payload", () => {
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
  });
});

test("treats missing session stats as unavailable instead of zero usage", () => {
  assert.equal(runtimeUsageFromSessionStats(undefined), undefined);
  assert.equal(
    runtimeUsageFromSessionStats({ contextUsage: { contextWindow: 200000 } }),
    undefined,
  );
});

test("preserves explicit zero token stats from Pi", () => {
  assert.deepEqual(
    runtimeUsageFromSessionStats({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      contextUsage: { tokens: 0, contextWindow: 128000 },
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      contextUsedTokens: 0,
      contextWindowTokens: 128000,
      totalCostUsd: 0,
    },
  );
});

test("keeps legacy get_state usage fallback compatible", () => {
  assert.deepEqual(
    runtimeUsageFromState({
      usage: {
        input: 3,
        output: 4,
        cacheRead: 1,
        total: 8,
        cost: { total: 0.004 },
      },
    }),
    {
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      totalTokens: 8,
      totalCostUsd: 0.004,
    },
  );
});
