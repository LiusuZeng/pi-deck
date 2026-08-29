import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
  WorkspaceUsageStore,
  contributionsFromSessionFile,
  contributionsFromSessionMessages,
  emptyUsageTotals,
  summarizeUsageContributions,
} from "./workspaceUsage.js";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";

describe("workspace usage accounting", () => {
  it("aggregates token categories, preserves reported totals, and tracks partial cost", () => {
    const totals = summarizeUsageContributions([
      {
        id: "one",
        workspaceId: workspaceA,
        source: "session",
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        totalTokens: 140,
        totalCostUsd: 0.12,
        recordedAtMs: 1,
      },
      {
        id: "two",
        workspaceId: workspaceA,
        source: "parallel",
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalTokens: 17,
        recordedAtMs: 2,
      },
    ]);

    assert.deepEqual(totals, {
      inputTokens: 110,
      outputTokens: 44,
      cacheReadTokens: 22,
      cacheWriteTokens: 6,
      totalTokens: 157,
      knownCostUsd: 0.12,
      contributorsWithCost: 1,
      contributorsWithoutCost: 1,
    });
  });

  it("extracts durable per-message usage without summing context-window occupancy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-usage-"));
    const project = path.join(root, "project");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-one", cwd: project }),
        JSON.stringify({
          type: "message",
          message: {
            id: "assistant-one",
            role: "assistant",
            content: "reply",
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 3,
              cacheWriteTokens: 2,
              totalTokens: 15,
              contextUsedTokens: 999,
              contextWindowTokens: 2000,
              totalCostUsd: 0.01,
            },
          },
        }),
      ].join("\n"),
    );

    const { contributions, diagnostics } = await contributionsFromSessionFile({
      workspaceId: workspaceA,
      sessionFile,
    });

    assert.deepEqual(diagnostics, []);
    assert.equal(contributions.length, 1);
    assert.equal(
      contributions[0]?.id,
      `session:${await fs.realpath(sessionFile)}:assistant-one`,
    );
    assert.equal(contributions[0]?.totalTokens, 15);
    assert.equal(JSON.stringify(contributions), JSON.stringify(contributions));
    assert.equal(
      JSON.stringify(contributions).includes("contextUsedTokens"),
      false,
    );
  });

  it("upserts contributions by stable id and reattributes session-owned usage on move", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-store-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    const store = new WorkspaceUsageStore(root);
    await store.loadIfNeeded();

    await store.upsertContributions(
      contributionsFromSessionMessages({
        workspaceId: workspaceA,
        sessionFile,
        sessionId: "stable-session",
        messages: [
          {
            id: "assistant-one",
            role: "assistant",
            usage: { input: 1, output: 2, total: 3, totalCostUsd: 0.02 },
          },
        ],
      }),
    );
    await store.upsertContributions(
      contributionsFromSessionMessages({
        workspaceId: workspaceA,
        sessionFile,
        sessionId: "stable-session",
        messages: [
          {
            id: "assistant-one",
            role: "assistant",
            usage: { input: 1, output: 2, total: 3, totalCostUsd: 0.02 },
          },
        ],
      }),
    );

    assert.deepEqual(
      await store.getWorkspaceUsage({
        workspaceId: workspaceA,
        sessionFiles: [],
      }),
      emptyUsageTotals(),
    );
    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceB,
          sessionFiles: [sessionFile],
        })
      ).totalTokens,
      3,
    );
  });

  it("keeps hidden worker usage even before the parent session file is known", async () => {
    const contributions = contributionsFromSessionMessages({
      workspaceId: workspaceA,
      sessionId: "parent:private:child",
      source: "parallel",
      messages: [
        {
          id: "assistant-one",
          role: "assistant",
          usage: { input: 7, output: 8, total: 15 },
        },
      ],
    });

    assert.equal(contributions[0]?.ownerSessionFile, undefined);
    assert.equal(
      summarizeUsageContributions(contributions).contributorsWithoutCost,
      1,
    );
  });

  it("freezes session-owned usage before hard deletion", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-delete-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    const store = new WorkspaceUsageStore(root);
    await store.upsertContributions(
      contributionsFromSessionMessages({
        workspaceId: workspaceA,
        sessionFile,
        sessionId: "stable-session",
        messages: [
          {
            id: "assistant-one",
            role: "assistant",
            usage: { input: 4, output: 6, total: 10 },
          },
        ],
      }),
    );

    await store.freezeSessionUsage({ workspaceId: workspaceA, sessionFile });

    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [],
        })
      ).totalTokens,
      10,
    );
  });
});
