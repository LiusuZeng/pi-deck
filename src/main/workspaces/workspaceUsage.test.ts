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

  it("does not rewrite persisted usage when only recordedAtMs changes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-timestamp-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    const store = new WorkspaceUsageStore(root);

    await store.upsertContributions(
      contributionsFromSessionMessages({
        workspaceId: workspaceA,
        sessionFile,
        sessionId: "stable-session",
        recordedAtMs: 1,
        messages: [
          {
            id: "assistant-one",
            role: "assistant",
            usage: { input: 4, output: 6, total: 10, totalCostUsd: 0.02 },
          },
        ],
      }),
    );
    const before = await fs.readFile(store.storeFile, "utf8");

    await store.upsertContributions(
      contributionsFromSessionMessages({
        workspaceId: workspaceA,
        sessionFile,
        sessionId: "stable-session",
        recordedAtMs: 2,
        messages: [
          {
            id: "assistant-one",
            role: "assistant",
            usage: { input: 4, output: 6, total: 10, totalCostUsd: 0.02 },
          },
        ],
      }),
    );

    assert.equal(await fs.readFile(store.storeFile, "utf8"), before);
  });

  it("coalesces concurrent refreshes for the same session file", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-coalesce-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          id: "assistant-one",
          role: "assistant",
          usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
        },
      }),
    );
    const store = new WorkspaceUsageStore(root);

    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        store.refreshSessionFileUsage({
          workspaceId: workspaceA,
          sessionFile,
        }),
      ),
    );

    assert.equal(
      results.every((result) => result === results[0]),
      true,
    );
    assert.equal(results[0]?.refreshed, true);
    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [sessionFile],
        })
      ).totalTokens,
      12,
    );
    assert.deepEqual(
      await store.refreshSessionFileUsage({
        workspaceId: workspaceA,
        sessionFile,
      }),
      { diagnostics: [], refreshed: false },
    );
  });

  it("refreshes a session JSONL once per file signature", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-refresh-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          id: "assistant-one",
          role: "assistant",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      }),
    );
    const store = new WorkspaceUsageStore(root);

    const first = await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile,
    });
    assert.equal(first.refreshed, true);
    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [sessionFile],
        })
      ).totalTokens,
      3,
    );

    const unchanged = await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile,
    });
    assert.deepEqual(unchanged, { diagnostics: [], refreshed: false });

    await fs.appendFile(
      sessionFile,
      `\n${JSON.stringify({
        type: "message",
        message: {
          id: "assistant-two",
          role: "assistant",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        },
      })}`,
    );
    const changed = await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile,
    });
    assert.equal(changed.refreshed, true);
    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [sessionFile],
        })
      ).totalTokens,
      8,
    );
    assert.deepEqual(
      await store.refreshSessionFileUsage({
        workspaceId: workspaceA,
        sessionFile,
      }),
      { diagnostics: [], refreshed: false },
    );
  });
  it("stores one compact snapshot for a long normal session", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-compact-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    const store = new WorkspaceUsageStore(root);
    const messages = Array.from({ length: 500 }, (_, index) => ({
      id: `assistant-${index}`,
      role: "assistant",
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        totalCostUsd: 0.001,
      },
    }));

    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile,
      sessionKey: sessionFile,
      source: "session",
      messages,
    });

    const persisted = JSON.parse(await fs.readFile(store.storeFile, "utf8")) as {
      version: number;
      snapshots: Array<{
        totalTokens: number;
        contributorsWithCost: number;
      }>;
    };
    assert.equal(persisted.version, 2);
    assert.equal(persisted.snapshots.length, 1);
    assert.equal(persisted.snapshots[0]?.totalTokens, 1500);
    assert.equal(persisted.snapshots[0]?.contributorsWithCost, 500);
  });

  it("replaces cumulative runtime usage without growing snapshot state", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-runtime-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    const store = new WorkspaceUsageStore(root);

    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile,
      sessionKey: sessionFile,
      source: "session",
      messages: [
        {
          id: "assistant-one",
          role: "assistant",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            totalCostUsd: 0.02,
          },
        },
        {
          id: "assistant-two",
          role: "assistant",
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            totalTokens: 30,
            totalCostUsd: 0.03,
          },
        },
      ],
    });
    await store.recordRuntimeUsage({
      workspaceId: workspaceA,
      sessionFile,
      usage: {
        inputTokens: 40,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 60,
        totalCostUsd: 0.08,
      },
    });

    const persisted = JSON.parse(await fs.readFile(store.storeFile, "utf8")) as {
      snapshots: Array<{
        totalTokens: number;
        totalCostUsd?: number;
        contributorsWithCost: number;
      }>;
    };
    assert.equal(persisted.snapshots.length, 1);
    assert.equal(persisted.snapshots[0]?.totalTokens, 60);
    assert.equal(persisted.snapshots[0]?.totalCostUsd, 0.08);
    assert.equal(persisted.snapshots[0]?.contributorsWithCost, 2);
  });

  it("migrates the v1 per-message store into compact v2 snapshots", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-migrate-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    await fs.writeFile(
      path.join(root, "workspace-usage.json"),
      JSON.stringify({
        version: 1,
        contributions: [
          {
            id: `session:${sessionFile}:assistant-one`,
            workspaceId: workspaceA,
            ownerSessionFile: sessionFile,
            source: "session",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            totalCostUsd: 0.02,
            recordedAtMs: 1,
          },
          {
            id: `session:${sessionFile}:assistant-two`,
            workspaceId: workspaceA,
            ownerSessionFile: sessionFile,
            source: "session",
            inputTokens: 20,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 30,
            recordedAtMs: 2,
          },
        ],
      }),
    );

    const store = new WorkspaceUsageStore(root);
    await store.loadIfNeeded();
    const persisted = JSON.parse(await fs.readFile(store.storeFile, "utf8")) as {
      version: number;
      snapshots: Array<{
        totalTokens: number;
        contributorsWithCost: number;
        contributorsWithoutCost: number;
      }>;
    };
    assert.equal(persisted.version, 2);
    assert.equal(persisted.snapshots.length, 1);
    assert.equal(persisted.snapshots[0]?.totalTokens, 45);
    assert.equal(persisted.snapshots[0]?.contributorsWithCost, 1);
    assert.equal(persisted.snapshots[0]?.contributorsWithoutCost, 1);
  });

  it("persists recovery signatures across store reloads", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-signature-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          id: "assistant-one",
          role: "assistant",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        },
      }),
    );

    const firstStore = new WorkspaceUsageStore(root);
    assert.equal(
      (
        await firstStore.refreshSessionFileUsage({
          workspaceId: workspaceA,
          sessionFile,
        })
      ).refreshed,
      true,
    );

    const reloaded = new WorkspaceUsageStore(root);
    assert.deepEqual(
      await reloaded.refreshSessionFileUsage({
        workspaceId: workspaceA,
        sessionFile,
      }),
      { diagnostics: [], refreshed: false },
    );
  });

  it("serves cached workspace usage without reading the session file", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-cheap-read-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          id: "assistant-one",
          role: "assistant",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        },
      }),
    );
    const store = new WorkspaceUsageStore(root);
    await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile,
    });
    await fs.unlink(sessionFile);

    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [sessionFile],
        })
      ).totalTokens,
      10,
    );
  });

});
