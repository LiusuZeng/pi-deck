import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import type { ChatSessionSummary } from "../../shared/types.js";
import { buildFakeRpcServer } from "../../test/fakeRpcHarness.js";
import { PiWorker } from "../pi/piWorker.js";
import type { PiMessage } from "../pi/types.js";
import { WorkspaceStore } from "./workspaceStore.js";
import {
  WorkspaceUsageStore,
  contributionsFromSessionFile,
  contributionsFromSessionMessages,
  emptyUsageTotals,
  summarizeUsageContributions,
} from "./workspaceUsage.js";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";

function assistantMessage(
  id: string,
  inputTokens: number,
  totalCostUsd?: number,
): Record<string, unknown> {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: id }],
    usage: {
      input: inputTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens,
      ...(totalCostUsd !== undefined
        ? {
            cost: {
              input: totalCostUsd,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: totalCostUsd,
            },
          }
        : {}),
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function messageRecord(message: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message",
    id: `record-${String(message.id)}`,
    message,
  });
}

function sessionUsageRecord(options: {
  type: "usage" | "compaction" | "branch_summary";
  id: string;
  inputTokens: number;
  totalCostUsd: number;
  timestamp: number;
}): Record<string, unknown> {
  return {
    type: options.type,
    id: options.id,
    parentId: null,
    timestamp: new Date(options.timestamp).toISOString(),
    usage: assistantMessage(
      options.id,
      options.inputTokens,
      options.totalCostUsd,
    ).usage,
  };
}

async function writeSessionFixture(options: {
  sessionFile: string;
  parentSession?: string;
  messages: readonly Record<string, unknown>[];
  entries?: readonly Record<string, unknown>[];
  sessionTimestamp?: string;
}): Promise<void> {
  await fs.writeFile(
    options.sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: path.basename(options.sessionFile, ".jsonl"),
        timestamp: options.sessionTimestamp ?? new Date().toISOString(),
        cwd: path.dirname(options.sessionFile),
        ...(options.parentSession !== undefined
          ? { parentSession: options.parentSession }
          : {}),
      }),
      ...options.messages.map(messageRecord),
      ...(options.entries ?? []).map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n",
  );
}

function workspaceSessionSummary(sessionFile: string): ChatSessionSummary {
  return {
    id: path.basename(sessionFile, ".jsonl"),
    sessionFile,
    title: path.basename(sessionFile),
    updatedAtMs: 1,
    createdAtMs: 1,
    messageCount: 1,
  };
}

async function visibleSessionFiles(
  store: WorkspaceStore,
  workspaceId: string,
): Promise<string[]> {
  return (await store.getCachedSessionSummaries(workspaceId)).map(
    (summary) => summary.sessionFile,
  );
}

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

    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
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

    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
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

  it("keeps three high-frequency live sessions bounded to three snapshots", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-live-stress-"),
    );
    const sessionFiles = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const sessionFile = path.join(root, `session-${index}.jsonl`);
        await fs.writeFile(sessionFile, "");
        return sessionFile;
      }),
    );
    const store = new WorkspaceUsageStore(root);

    for (let turn = 1; turn <= 250; turn += 1) {
      await Promise.all(
        sessionFiles.map((sessionFile, sessionIndex) =>
          store.recordRuntimeUsage({
            workspaceId: workspaceA,
            sessionFile,
            usage: {
              inputTokens: turn * (sessionIndex + 1),
              outputTokens: turn,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: turn * (sessionIndex + 2),
              totalCostUsd: turn * 0.001,
            },
            recordedAtMs: turn,
          }),
        ),
      );
    }

    const persistedBeforeUnchanged = await fs.readFile(store.storeFile, "utf8");
    const parsed = JSON.parse(persistedBeforeUnchanged) as {
      version: number;
      snapshots: Array<{ totalTokens: number }>;
    };
    assert.equal(parsed.version, 2);
    assert.equal(parsed.snapshots.length, 3);
    assert.deepEqual(
      parsed.snapshots
        .map((snapshot) => snapshot.totalTokens)
        .sort((a, b) => a - b),
      [500, 750, 1000],
    );
    assert.ok(
      Buffer.byteLength(persistedBeforeUnchanged, "utf8") < 10_000,
      "live usage persistence should stay bounded by sessions, not update count",
    );

    await Promise.all(
      sessionFiles.map((sessionFile, sessionIndex) =>
        store.recordRuntimeUsage({
          workspaceId: workspaceA,
          sessionFile,
          usage: {
            inputTokens: 250 * (sessionIndex + 1),
            outputTokens: 250,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 250 * (sessionIndex + 2),
            totalCostUsd: 0.25,
          },
          recordedAtMs: 10_000,
        }),
      ),
    );
    assert.equal(
      await fs.readFile(store.storeFile, "utf8"),
      persistedBeforeUnchanged,
      "timestamp-only live refreshes must not rewrite compact accounting",
    );
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
    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
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

  it("freezes deletion without retaining duplicate owned snapshots", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-freeze-compact-"),
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
          id: "assistant-parent",
          role: "assistant",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        },
      ],
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile,
      sessionKey: "private-child",
      source: "parallel",
      messages: [
        {
          id: "assistant-child",
          role: "assistant",
          usage: {
            inputTokens: 4,
            outputTokens: 6,
            totalTokens: 10,
            totalCostUsd: 0.02,
          },
        },
      ],
    });

    await store.freezeSessionUsage({ workspaceId: workspaceA, sessionFile });

    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
      snapshots: Array<{ id: string; ownerSessionFile?: string }>;
    };
    assert.equal(persisted.snapshots.length, 2);
    assert.equal(
      persisted.snapshots.every(
        (snapshot) =>
          snapshot.id.startsWith("deleted:") &&
          snapshot.ownerSessionFile === undefined,
      ),
      true,
    );
    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [],
        })
      ).totalTokens,
      15,
    );
  });

  it("keeps deleted usage when a restored path records new usage and moves", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-restore-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    const firstStore = new WorkspaceUsageStore(root);
    const record = async (store: WorkspaceUsageStore, totalTokens: number) =>
      store.recordSessionMessagesUsage({
        workspaceId: workspaceA,
        sessionFile,
        sessionKey: "private-child",
        source: "parallel",
        messages: [
          {
            id: "assistant-child",
            role: "assistant",
            usage: { inputTokens: totalTokens, totalTokens },
          },
        ],
      });

    await record(firstStore, 10);
    await firstStore.freezeSessionUsage({
      workspaceId: workspaceA,
      sessionFile,
    });

    // Reload between deletion and restore. The new store must retain the
    // tombstone generation instead of reusing deleted:1 on the next delete.
    const restoredStore = new WorkspaceUsageStore(root);
    // A restored session reuses its former filesystem path, but its new
    // snapshot must stay live rather than overwrite the frozen history.
    await fs.writeFile(sessionFile, "restored");
    await record(restoredStore, 20);

    assert.equal(
      (
        await restoredStore.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [],
        })
      ).totalTokens,
      10,
    );
    assert.equal(
      (
        await restoredStore.getWorkspaceUsage({
          workspaceId: workspaceB,
          sessionFiles: [sessionFile],
        })
      ).totalTokens,
      20,
    );

    // A later deletion gets a distinct tombstone, preserving the first
    // workspace's historical usage instead of replacing it by snapshot id.
    await restoredStore.freezeSessionUsage({
      workspaceId: workspaceB,
      sessionFile,
    });
    assert.equal(
      (
        await restoredStore.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [],
        })
      ).totalTokens,
      10,
    );
    assert.equal(
      (
        await restoredStore.getWorkspaceUsage({
          workspaceId: workspaceB,
          sessionFiles: [],
        })
      ).totalTokens,
      20,
    );
  });

  it("preserves legacy v2 tombstones after restore and deletion", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-legacy-tombstone-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    const resolvedSessionFile = path.resolve(sessionFile);
    await fs.writeFile(sessionFile, "");
    // Stores written before deletion generations deliberately have no
    // sessionFreezeGenerations field and use the unnumbered tombstone id.
    await fs.writeFile(
      path.join(root, "workspace-usage.json"),
      JSON.stringify({
        version: 2,
        snapshots: [
          {
            id: `deleted:session:${resolvedSessionFile}`,
            workspaceId: workspaceA,
            source: "session",
            inputTokens: 10,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 10,
            contributorsWithCost: 0,
            contributorsWithoutCost: 1,
            recordedAtMs: 1,
          },
        ],
      }),
    );

    const store = new WorkspaceUsageStore(root);
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceB,
      sessionFile,
      sessionKey: sessionFile,
      source: "session",
      messages: [
        {
          id: "assistant-restored",
          role: "assistant",
          usage: { inputTokens: 20, totalTokens: 20 },
        },
      ],
    });
    await store.freezeSessionUsage({ workspaceId: workspaceB, sessionFile });

    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [],
        })
      ).totalTokens,
      10,
    );
    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceB,
          sessionFiles: [],
        })
      ).totalTokens,
      20,
    );
    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
      snapshots: Array<{ id: string }>;
      sessionFreezeGenerations: Record<string, number>;
    };
    assert.deepEqual(
      persisted.snapshots.map((snapshot) => snapshot.id).sort(),
      [
        `deleted:2:session:${resolvedSessionFile}`,
        `deleted:session:${resolvedSessionFile}`,
      ],
    );
    assert.equal(persisted.sessionFreezeGenerations[resolvedSessionFile], 2);
  });

  it("does not overwrite an unassociated legacy private tombstone", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-legacy-private-tombstone-"),
    );
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    await fs.writeFile(
      path.join(root, "workspace-usage.json"),
      JSON.stringify({
        version: 2,
        snapshots: [
          {
            id: "deleted:parallel:planner",
            workspaceId: workspaceA,
            source: "parallel",
            inputTokens: 10,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 10,
            contributorsWithCost: 0,
            contributorsWithoutCost: 1,
            recordedAtMs: 1,
          },
        ],
      }),
    );

    const store = new WorkspaceUsageStore(root);
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceB,
      sessionFile,
      sessionKey: "planner",
      source: "parallel",
      messages: [
        {
          id: "assistant-restored",
          role: "assistant",
          usage: { inputTokens: 20, totalTokens: 20 },
        },
      ],
    });
    await store.freezeSessionUsage({ workspaceId: workspaceB, sessionFile });

    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [],
        })
      ).totalTokens,
      10,
    );
    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceB,
          sessionFiles: [],
        })
      ).totalTokens,
      20,
    );
  });

  it("accounts fake-native fork history once through moves, archiving, runtime, and recovery", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(
        path.join(os.tmpdir(), "pi-deck-usage-native-fork-lifecycle-"),
      ),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    parentAnswer.timestamp = "2024-01-01T00:00:00.000Z";
    await writeSessionFixture({
      sessionFile: sourceFile,
      sessionTimestamp: "2024-01-01T00:00:00.000Z",
      messages: [parentAnswer],
    });

    const worker = new PiWorker({
      command: process.execPath,
      args: [
        buildFakeRpcServer(),
        "--fork",
        sourceFile,
        "--fork-target",
        childFile,
      ],
      cwd: process.cwd(),
      env: process.env,
      requestTimeoutMs: 5_000,
      killGraceMs: 100,
    });
    let childMessages: PiMessage[];
    try {
      const state = await worker.getState();
      assert.equal(state.sessionFile, childFile);
      childMessages = await worker.getMessages();
    } finally {
      await worker.closeSession();
    }

    const workspaces = new WorkspaceStore(root);
    const sourceWorkspace = await workspaces.create({ name: "Source" });
    const childWorkspace = await workspaces.create({ name: "Child" });
    await workspaces.upsertSessionRef(
      sourceWorkspace.id,
      workspaceSessionSummary(sourceFile),
    );
    await workspaces.upsertSessionRef(
      sourceWorkspace.id,
      workspaceSessionSummary(childFile),
    );

    const usage = new WorkspaceUsageStore(root);
    await usage.refreshSessionFileUsage({
      workspaceId: sourceWorkspace.id,
      sessionFile: sourceFile,
    });
    await usage.recordSessionMessagesUsage({
      workspaceId: sourceWorkspace.id,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: childMessages,
    });
    await usage.recordRuntimeUsage({
      workspaceId: sourceWorkspace.id,
      sessionFile: childFile,
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 10,
        totalCostUsd: 0.01,
      },
    });
    assert.equal(
      (
        await usage.getWorkspaceUsage({
          workspaceId: sourceWorkspace.id,
          sessionFiles: await visibleSessionFiles(
            workspaces,
            sourceWorkspace.id,
          ),
        })
      ).totalTokens,
      10,
    );

    await workspaces.moveSession(childFile, childWorkspace.id);
    assert.equal(
      (
        await usage.getWorkspaceUsage({
          workspaceId: childWorkspace.id,
          sessionFiles: await visibleSessionFiles(
            workspaces,
            childWorkspace.id,
          ),
        })
      ).totalTokens,
      0,
    );
    await usage.recordRuntimeUsage({
      workspaceId: childWorkspace.id,
      sessionFile: childFile,
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 10,
        totalCostUsd: 0.01,
      },
    });
    assert.equal(
      (
        await usage.getWorkspaceUsage({
          workspaceId: sourceWorkspace.id,
          sessionFiles: await visibleSessionFiles(
            workspaces,
            sourceWorkspace.id,
          ),
        })
      ).totalTokens,
      10,
    );

    await workspaces.moveSession(sourceFile, childWorkspace.id);
    assert.equal(
      (
        await usage.getWorkspaceUsage({
          workspaceId: sourceWorkspace.id,
          sessionFiles: await visibleSessionFiles(
            workspaces,
            sourceWorkspace.id,
          ),
        })
      ).totalTokens,
      0,
    );
    assert.equal(
      (
        await usage.getWorkspaceUsage({
          workspaceId: childWorkspace.id,
          sessionFiles: await visibleSessionFiles(
            workspaces,
            childWorkspace.id,
          ),
        })
      ).totalTokens,
      10,
    );

    await workspaces.archiveSession(childWorkspace.id, childFile);
    assert.equal(
      (
        await usage.getWorkspaceUsage({
          workspaceId: childWorkspace.id,
          sessionFiles: await visibleSessionFiles(
            workspaces,
            childWorkspace.id,
          ),
        })
      ).totalTokens,
      10,
    );
    await workspaces.archiveSession(childWorkspace.id, sourceFile);
    assert.equal(
      (
        await usage.getWorkspaceUsage({
          workspaceId: childWorkspace.id,
          sessionFiles: await visibleSessionFiles(
            workspaces,
            childWorkspace.id,
          ),
        })
      ).totalTokens,
      0,
    );
    await workspaces.restoreSession(childWorkspace.id, sourceFile);

    const recovered = new WorkspaceUsageStore(
      await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-usage-fork-recover-")),
    );
    await recovered.refreshSessionFileUsage({
      workspaceId: childWorkspace.id,
      sessionFile: sourceFile,
    });
    await recovered.refreshSessionFileUsage({
      workspaceId: childWorkspace.id,
      sessionFile: childFile,
    });
    assert.equal(
      (
        await recovered.getWorkspaceUsage({
          workspaceId: childWorkspace.id,
          sessionFiles: await visibleSessionFiles(
            workspaces,
            childWorkspace.id,
          ),
        })
      ).totalTokens,
      10,
    );
  });

  it("counts native fork inherited history only once across live, runtime, recovery, and reload", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    const childAnswer = assistantMessage("assistant-child", 5, 0.005);
    const sourceAfterFork = assistantMessage(
      "assistant-source-after",
      7,
      0.007,
    );

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      messages: [parentAnswer],
    });

    const store = new WorkspaceUsageStore(root);
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
      sessionKey: sourceFile,
      source: "session",
      messages: [parentAnswer],
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: [parentAnswer],
    });
    assert.deepEqual(
      await store.getWorkspaceUsage({
        workspaceId: workspaceA,
        sessionFiles: [sourceFile, childFile],
      }),
      {
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 10,
        knownCostUsd: 0.01,
        contributorsWithCost: 1,
        contributorsWithoutCost: 0,
      },
    );

    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      messages: [parentAnswer, childAnswer],
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: [parentAnswer, childAnswer],
    });
    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer, sourceAfterFork],
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
      sessionKey: sourceFile,
      source: "session",
      messages: [parentAnswer, sourceAfterFork],
    });
    await store.recordRuntimeUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      usage: {
        inputTokens: 15,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        totalCostUsd: 0.015,
      },
    });

    const assertExpectedForkUsage = (usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      knownCostUsd: number;
      contributorsWithCost: number;
      contributorsWithoutCost: number;
    }): void => {
      assert.equal(usage.inputTokens, 22);
      assert.equal(usage.outputTokens, 0);
      assert.equal(usage.cacheReadTokens, 0);
      assert.equal(usage.cacheWriteTokens, 0);
      assert.equal(usage.totalTokens, 22);
      assert.ok(Math.abs(usage.knownCostUsd - 0.022) < 1e-12);
      assert.equal(usage.contributorsWithCost, 3);
      assert.equal(usage.contributorsWithoutCost, 0);
    };
    assertExpectedForkUsage(
      await store.getWorkspaceUsage({
        workspaceId: workspaceA,
        sessionFiles: [sourceFile, childFile],
      }),
    );
    assertExpectedForkUsage(
      await new WorkspaceUsageStore(root).getWorkspaceUsage({
        workspaceId: workspaceA,
        sessionFiles: [sourceFile, childFile],
      }),
    );

    const recovered = new WorkspaceUsageStore(
      await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-usage-fork-recover-")),
    );
    assert.equal(
      (
        await recovered.refreshSessionFileUsage({
          workspaceId: workspaceA,
          sessionFile: sourceFile,
        })
      ).refreshed,
      true,
    );
    assert.equal(
      (
        await recovered.refreshSessionFileUsage({
          workspaceId: workspaceA,
          sessionFile: childFile,
        })
      ).refreshed,
      true,
    );
    assertExpectedForkUsage(
      await recovered.getWorkspaceUsage({
        workspaceId: workspaceA,
        sessionFiles: [sourceFile, childFile],
      }),
    );
  });

  it("keeps child work when a compacted fork projection omits inherited messages", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-compacted-live-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const forkStartedAtMs = Date.now();
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    parentAnswer.timestamp = forkStartedAtMs - 1_000;
    const childAnswer = assistantMessage("assistant-child", 5, 0.005);
    childAnswer.timestamp = forkStartedAtMs + 1_000;
    const compactionMarker = {
      type: "compaction",
      id: "compaction-after-parent",
      timestamp: new Date(forkStartedAtMs - 500).toISOString(),
      firstKeptEntryId: "assistant-child",
    };

    // The raw source/child JSONL retain the copied parent turn, but Pi's
    // compaction-aware get_messages projection need not include it.
    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer],
      entries: [compactionMarker],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      sessionTimestamp: new Date(forkStartedAtMs).toISOString(),
      messages: [parentAnswer, childAnswer],
      entries: [compactionMarker],
    });

    const store = new WorkspaceUsageStore(root);
    await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      // Simulate get_messages after compaction: inherited history is absent.
      messages: [childAnswer],
    });

    const assertExpected = async (): Promise<void> => {
      const usage = await store.getWorkspaceUsage({
        workspaceId: workspaceA,
        sessionFiles: [sourceFile, childFile],
      });
      assert.equal(usage.totalTokens, 15);
      assert.ok(Math.abs(usage.knownCostUsd - 0.015) < 1e-12);
      assert.equal(usage.contributorsWithCost, 2);
    };
    await assertExpected();

    await store.recordRuntimeUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      usage: {
        inputTokens: 15,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        totalCostUsd: 0.015,
      },
    });
    await assertExpected();

    await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
    });
    await assertExpected();

    const recovered = new WorkspaceUsageStore(
      await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-usage-fork-recover-")),
    );
    await recovered.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
    });
    await recovered.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
    });
    assert.equal(
      (
        await recovered.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [sourceFile, childFile],
        })
      ).totalTokens,
      15,
    );
  });

  it("excludes copied native non-message usage from live, recovery, and runtime fork totals", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-native-entries-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const forkStartedAtMs = Date.now();
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    parentAnswer.timestamp = forkStartedAtMs - 4_000;
    const inheritedEntries = [
      sessionUsageRecord({
        type: "usage",
        id: "usage-parent",
        inputTokens: 2,
        totalCostUsd: 0.002,
        timestamp: forkStartedAtMs - 3_000,
      }),
      sessionUsageRecord({
        type: "compaction",
        id: "compaction-parent",
        inputTokens: 3,
        totalCostUsd: 0.003,
        timestamp: forkStartedAtMs - 2_000,
      }),
      sessionUsageRecord({
        type: "branch_summary",
        id: "branch-summary-parent",
        inputTokens: 4,
        totalCostUsd: 0.004,
        timestamp: forkStartedAtMs - 1_000,
      }),
    ];

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer],
      entries: inheritedEntries,
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      sessionTimestamp: new Date(forkStartedAtMs).toISOString(),
      messages: [parentAnswer],
      entries: inheritedEntries,
    });

    const store = new WorkspaceUsageStore(root);
    await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: [parentAnswer],
    });
    await store.recordRuntimeUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      usage: {
        inputTokens: 19,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 19,
        totalCostUsd: 0.019,
      },
    });

    const usage = await store.getWorkspaceUsage({
      workspaceId: workspaceA,
      sessionFiles: [sourceFile, childFile],
    });
    assert.equal(usage.totalTokens, 19);
    assert.ok(Math.abs(usage.knownCostUsd - 0.019) < 1e-12);
    assert.equal(usage.contributorsWithCost, 4);
    assert.equal(usage.contributorsWithoutCost, 0);

    const recovered = new WorkspaceUsageStore(
      await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-usage-fork-recover-")),
    );
    await recovered.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
    });
    await recovered.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
    });
    assert.equal(
      (
        await recovered.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [sourceFile, childFile],
        })
      ).totalTokens,
      19,
    );

    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
      snapshots: Array<{
        ownerSessionFile?: string;
        inheritedTotalTokens?: number;
        inheritedUsageEntryCount?: number;
        inheritedMessageUsageEntryCount?: number;
      }>;
    };
    const childSnapshot = persisted.snapshots.find(
      (snapshot) => snapshot.ownerSessionFile === path.resolve(childFile),
    );
    assert.equal(childSnapshot?.inheritedTotalTokens, 19);
    assert.equal(childSnapshot?.inheritedUsageEntryCount, 4);
    assert.equal(childSnapshot?.inheritedMessageUsageEntryCount, 1);
  });

  it("derives runtime contributors when a fork previously stored only inherited history", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-runtime-known-cost-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const forkStartedAtMs = Date.now();
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    parentAnswer.timestamp = forkStartedAtMs - 1_000;
    const childAnswer = assistantMessage(
      "assistant-child-known-cost",
      5,
      0.005,
    );
    childAnswer.timestamp = forkStartedAtMs + 1_000;

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      sessionTimestamp: new Date(forkStartedAtMs).toISOString(),
      messages: [parentAnswer, childAnswer],
    });

    const store = new WorkspaceUsageStore(root);
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
      sessionKey: sourceFile,
      source: "session",
      messages: [parentAnswer],
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: [parentAnswer],
    });
    await store.recordRuntimeUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      usage: {
        inputTokens: 15,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        totalCostUsd: 0.015,
      },
    });

    const usage = await store.getWorkspaceUsage({
      workspaceId: workspaceA,
      sessionFiles: [sourceFile, childFile],
    });
    assert.equal(usage.totalTokens, 15);
    assert.ok(Math.abs(usage.knownCostUsd - 0.015) < 1e-12);
    assert.equal(usage.contributorsWithCost, 2);
    assert.equal(usage.contributorsWithoutCost, 0);

    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
      snapshots: Array<{
        ownerSessionFile?: string;
        totalTokens: number;
        totalCostUsd?: number;
        contributorsWithCost: number;
        contributorsWithoutCost: number;
      }>;
    };
    const childSnapshot = persisted.snapshots.find(
      (snapshot) => snapshot.ownerSessionFile === path.resolve(childFile),
    );
    assert.equal(childSnapshot?.totalTokens, 5);
    assert.ok(Math.abs((childSnapshot?.totalCostUsd ?? 0) - 0.005) < 1e-12);
    assert.equal(childSnapshot?.contributorsWithCost, 1);
    assert.equal(childSnapshot?.contributorsWithoutCost, 0);
  });

  it("preserves known zero cost for a child runtime turn after a fork", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-runtime-zero-cost-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const forkStartedAtMs = Date.now();
    const parentAnswer = assistantMessage("assistant-parent", 10, 0);
    parentAnswer.timestamp = forkStartedAtMs - 1_000;
    const childAnswer = assistantMessage("assistant-child-zero-cost", 5, 0);
    childAnswer.timestamp = forkStartedAtMs + 1_000;

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      sessionTimestamp: new Date(forkStartedAtMs).toISOString(),
      messages: [parentAnswer, childAnswer],
    });

    const store = new WorkspaceUsageStore(root);
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
      sessionKey: sourceFile,
      source: "session",
      messages: [parentAnswer],
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: [parentAnswer],
    });
    await store.recordRuntimeUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      usage: {
        inputTokens: 15,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        totalCostUsd: 0,
      },
    });

    const usage = await store.getWorkspaceUsage({
      workspaceId: workspaceA,
      sessionFiles: [sourceFile, childFile],
    });
    assert.equal(usage.totalTokens, 15);
    assert.equal(usage.knownCostUsd, 0);
    assert.equal(usage.contributorsWithCost, 2);
    assert.equal(usage.contributorsWithoutCost, 0);

    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
      snapshots: Array<{
        ownerSessionFile?: string;
        totalTokens: number;
        totalCostUsd?: number;
        contributorsWithCost: number;
        contributorsWithoutCost: number;
      }>;
    };
    const childSnapshot = persisted.snapshots.find(
      (snapshot) => snapshot.ownerSessionFile === path.resolve(childFile),
    );
    assert.equal(childSnapshot?.totalTokens, 5);
    assert.equal(childSnapshot?.totalCostUsd, 0);
    assert.equal(childSnapshot?.contributorsWithCost, 1);
    assert.equal(childSnapshot?.contributorsWithoutCost, 0);
  });

  it("preserves unknown child cost when runtime fork totals include only inherited known cost", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-runtime-unknown-cost-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const forkStartedAtMs = Date.now();
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    parentAnswer.timestamp = forkStartedAtMs - 1_000;
    const childAnswer = assistantMessage("assistant-child-unknown-cost", 5);
    childAnswer.timestamp = forkStartedAtMs + 1_000;

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      sessionTimestamp: new Date(forkStartedAtMs).toISOString(),
      messages: [parentAnswer, childAnswer],
    });

    const store = new WorkspaceUsageStore(root);
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
      sessionKey: sourceFile,
      source: "session",
      messages: [parentAnswer],
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: [parentAnswer],
    });
    await store.recordRuntimeUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      usage: {
        inputTokens: 15,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        totalCostUsd: 0.01,
        reportedFields: ["inputTokens", "totalTokens", "totalCostUsd"],
      },
    });

    const usage = await store.getWorkspaceUsage({
      workspaceId: workspaceA,
      sessionFiles: [sourceFile, childFile],
    });
    assert.equal(usage.totalTokens, 15);
    assert.equal(usage.knownCostUsd, 0.01);
    assert.equal(usage.contributorsWithCost, 1);
    assert.equal(usage.contributorsWithoutCost, 1);

    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
      snapshots: Array<{
        ownerSessionFile?: string;
        totalTokens: number;
        totalCostUsd?: number;
        contributorsWithCost: number;
        contributorsWithoutCost: number;
      }>;
    };
    const childSnapshot = persisted.snapshots.find(
      (snapshot) => snapshot.ownerSessionFile === path.resolve(childFile),
    );
    assert.equal(childSnapshot?.totalTokens, 5);
    assert.equal(childSnapshot?.totalCostUsd, undefined);
    assert.equal(childSnapshot?.contributorsWithCost, 0);
    assert.equal(childSnapshot?.contributorsWithoutCost, 1);
  });

  it("does not subtract identical post-fork source and child turns during baseline recovery", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-identical-post-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const forkStartedAtMs = Date.now();
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    parentAnswer.timestamp = forkStartedAtMs - 1_000;
    const identicalPostForkAnswer = assistantMessage(
      "assistant-identical-post-fork",
      7,
      0.007,
    );
    identicalPostForkAnswer.timestamp = forkStartedAtMs + 1_000;

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer, identicalPostForkAnswer],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      sessionTimestamp: new Date(forkStartedAtMs).toISOString(),
      messages: [parentAnswer, identicalPostForkAnswer],
    });

    const store = new WorkspaceUsageStore(root);
    await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
    });
    await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
    });

    const usage = await store.getWorkspaceUsage({
      workspaceId: workspaceA,
      sessionFiles: [sourceFile, childFile],
    });
    assert.equal(usage.totalTokens, 24);
    assert.ok(Math.abs(usage.knownCostUsd - 0.024) < 1e-12);
    assert.equal(usage.contributorsWithCost, 3);
  });

  it("does not treat colliding post-fork message ids as inherited usage", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-id-collision-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    const sourceAfterFork = assistantMessage("msg_assistant_2", 7, 0.007);
    const childAfterFork = assistantMessage("msg_assistant_2", 5, 0.005);
    childAfterFork.content = [{ type: "text", text: "child-only answer" }];

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer, sourceAfterFork],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      messages: [parentAnswer, childAfterFork],
    });

    const store = new WorkspaceUsageStore(root);
    await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
    });
    await store.refreshSessionFileUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
    });

    const usage = await store.getWorkspaceUsage({
      workspaceId: workspaceA,
      sessionFiles: [sourceFile, childFile],
    });
    assert.equal(usage.totalTokens, 22);
    assert.ok(Math.abs(usage.knownCostUsd - 0.022) < 1e-12);
    assert.equal(usage.contributorsWithCost, 3);
  });

  it("subtracts live fork history when get_messages omits ids from copied records", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-live-idless-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const userPrompt = {
      role: "user",
      content: [{ type: "text", text: "seed prompt" }],
    };
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    delete parentAnswer.id;

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [userPrompt, parentAnswer],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      messages: [userPrompt, parentAnswer],
    });

    const store = new WorkspaceUsageStore(root);
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
      sessionKey: sourceFile,
      source: "session",
      messages: [userPrompt, parentAnswer],
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: [userPrompt, parentAnswer],
    });

    const usage = await store.getWorkspaceUsage({
      workspaceId: workspaceA,
      sessionFiles: [sourceFile, childFile],
    });
    assert.equal(usage.totalTokens, 10);
    assert.equal(usage.knownCostUsd, 0.01);
    assert.equal(usage.contributorsWithCost, 1);

    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
      snapshots: Array<{
        ownerSessionFile?: string;
        forkParentSession?: string;
        inheritedTotalTokens?: number;
        inheritedUsageEntryCount?: number;
      }>;
    };
    const childSnapshot = persisted.snapshots.find(
      (snapshot) => snapshot.ownerSessionFile === path.resolve(childFile),
    );
    assert.equal(childSnapshot?.forkParentSession, path.resolve(sourceFile));
    assert.equal(childSnapshot?.inheritedTotalTokens, 10);
    assert.equal(childSnapshot?.inheritedUsageEntryCount, 1);
  });

  it("handles sibling and nested forks without repeated ancestor accounting", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-tree-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childAFile = path.join(root, "child-a.jsonl");
    const childBFile = path.join(root, "child-b.jsonl");
    const grandchildFile = path.join(root, "grandchild.jsonl");
    const sourceAnswer = assistantMessage("assistant-source", 10, 0.01);
    const childAAnswer = assistantMessage("assistant-child-a", 5, 0.005);
    const grandchildAnswer = assistantMessage("assistant-grandchild", 2);

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [sourceAnswer],
    });
    await writeSessionFixture({
      sessionFile: childAFile,
      parentSession: sourceFile,
      messages: [sourceAnswer, childAAnswer],
    });
    await writeSessionFixture({
      sessionFile: childBFile,
      parentSession: sourceFile,
      messages: [sourceAnswer],
    });
    await writeSessionFixture({
      sessionFile: grandchildFile,
      parentSession: childAFile,
      messages: [sourceAnswer, childAAnswer, grandchildAnswer],
    });

    const store = new WorkspaceUsageStore(root);
    for (const sessionFile of [
      sourceFile,
      childAFile,
      childBFile,
      grandchildFile,
    ]) {
      assert.equal(
        (
          await store.refreshSessionFileUsage({
            workspaceId: workspaceA,
            sessionFile,
          })
        ).refreshed,
        true,
      );
    }

    assert.deepEqual(
      await store.getWorkspaceUsage({
        workspaceId: workspaceA,
        sessionFiles: [sourceFile, childAFile, childBFile, grandchildFile],
      }),
      {
        inputTokens: 17,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 17,
        knownCostUsd: 0.015,
        contributorsWithCost: 2,
        contributorsWithoutCost: 1,
      },
    );

    await store.freezeSessionUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
    });
    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [childAFile, childBFile, grandchildFile],
        })
      ).totalTokens,
      17,
    );
  });

  it("repairs an unchanged persisted fork snapshot with incomplete fork baseline metadata", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-repair-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      messages: [parentAnswer],
    });
    const childStat = await fs.stat(childFile);
    await fs.writeFile(
      path.join(root, "workspace-usage.json"),
      JSON.stringify({
        version: 2,
        snapshots: [
          {
            id: `session:${path.resolve(sourceFile)}`,
            workspaceId: workspaceA,
            ownerSessionFile: path.resolve(sourceFile),
            source: "session",
            inputTokens: 10,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 10,
            totalCostUsd: 0.01,
            contributorsWithCost: 1,
            contributorsWithoutCost: 0,
            recordedAtMs: 1,
          },
          {
            id: `session:${path.resolve(childFile)}`,
            workspaceId: workspaceA,
            ownerSessionFile: path.resolve(childFile),
            source: "session",
            inputTokens: 10,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 10,
            totalCostUsd: 0.01,
            contributorsWithCost: 1,
            contributorsWithoutCost: 0,
            recordedAtMs: 1,
            sessionFileSize: childStat.size,
            sessionFileMtimeMs: childStat.mtimeMs,
            forkParentSession: path.resolve(sourceFile),
            inheritedInputTokens: 0,
            inheritedOutputTokens: 0,
            inheritedCacheReadTokens: 0,
            inheritedCacheWriteTokens: 0,
            inheritedTotalTokens: 0,
            inheritedContributorsWithCost: 0,
            inheritedContributorsWithoutCost: 0,
          },
        ],
      }),
    );

    const store = new WorkspaceUsageStore(root);
    assert.equal(
      (
        await store.refreshSessionFileUsage({
          workspaceId: workspaceA,
          sessionFile: childFile,
        })
      ).refreshed,
      true,
    );
    assert.equal(
      (
        await store.getWorkspaceUsage({
          workspaceId: workspaceA,
          sessionFiles: [sourceFile, childFile],
        })
      ).totalTokens,
      10,
    );
  });

  it("repairs a pre-fix fork snapshot after the source is frozen and deleted", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-repair-deleted-parent-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const forkStartedAtMs = Date.now();
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    parentAnswer.timestamp = forkStartedAtMs - 1_000;
    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      sessionTimestamp: new Date(forkStartedAtMs).toISOString(),
      messages: [parentAnswer],
    });
    const childStat = await fs.stat(childFile);
    await fs.writeFile(
      path.join(root, "workspace-usage.json"),
      JSON.stringify({
        version: 2,
        snapshots: [
          {
            id: `session:${path.resolve(sourceFile)}`,
            workspaceId: workspaceA,
            ownerSessionFile: path.resolve(sourceFile),
            source: "session",
            inputTokens: 10,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 10,
            totalCostUsd: 0.01,
            contributorsWithCost: 1,
            contributorsWithoutCost: 0,
            recordedAtMs: 1,
          },
          {
            id: `session:${path.resolve(childFile)}`,
            workspaceId: workspaceA,
            ownerSessionFile: path.resolve(childFile),
            source: "session",
            inputTokens: 10,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 10,
            totalCostUsd: 0.01,
            contributorsWithCost: 1,
            contributorsWithoutCost: 0,
            recordedAtMs: 1,
            sessionFileSize: childStat.size,
            sessionFileMtimeMs: childStat.mtimeMs,
            forkParentSession: path.resolve(sourceFile),
            inheritedInputTokens: 0,
            inheritedOutputTokens: 0,
            inheritedCacheReadTokens: 0,
            inheritedCacheWriteTokens: 0,
            inheritedTotalTokens: 0,
            inheritedContributorsWithCost: 0,
            inheritedContributorsWithoutCost: 0,
          },
        ],
      }),
    );

    const store = new WorkspaceUsageStore(root);
    await store.freezeSessionUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
    });
    await fs.unlink(sourceFile);
    assert.equal(
      (
        await store.refreshSessionFileUsage({
          workspaceId: workspaceA,
          sessionFile: childFile,
        })
      ).refreshed,
      true,
    );

    const usage = await store.getWorkspaceUsage({
      workspaceId: workspaceA,
      sessionFiles: [childFile],
    });
    assert.equal(usage.totalTokens, 10);
    assert.equal(usage.knownCostUsd, 0.01);
    assert.equal(usage.contributorsWithCost, 1);

    const persisted = JSON.parse(
      await fs.readFile(store.storeFile, "utf8"),
    ) as {
      snapshots: Array<{
        id: string;
        ownerSessionFile?: string;
        totalTokens: number;
        inheritedTotalTokens?: number;
        inheritedUsageEntryCount?: number;
      }>;
    };
    const childSnapshot = persisted.snapshots.find(
      (snapshot) => snapshot.ownerSessionFile === path.resolve(childFile),
    );
    assert.equal(childSnapshot?.totalTokens, 0);
    assert.equal(childSnapshot?.inheritedTotalTokens, 10);
    assert.equal(childSnapshot?.inheritedUsageEntryCount, 1);
    assert.equal(
      persisted.snapshots.some(
        (snapshot) =>
          snapshot.id === `deleted:session:${path.resolve(sourceFile)}` &&
          snapshot.totalTokens === 10,
      ),
      true,
    );
  });

  it("keeps child work at the fork timestamp after its parent is deleted", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-usage-fork-deleted-parent-live-"),
    );
    const sourceFile = path.join(root, "source.jsonl");
    const childFile = path.join(root, "child.jsonl");
    const forkStartedAtMs = Date.now();
    const parentAnswer = assistantMessage("assistant-parent", 10, 0.01);
    parentAnswer.timestamp = forkStartedAtMs - 1_000;
    const childAnswer = assistantMessage("assistant-child", 5, 0.005);
    childAnswer.timestamp = forkStartedAtMs;

    await writeSessionFixture({
      sessionFile: sourceFile,
      messages: [parentAnswer],
    });
    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      sessionTimestamp: new Date(forkStartedAtMs).toISOString(),
      messages: [parentAnswer],
    });

    const store = new WorkspaceUsageStore(root);
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: sourceFile,
      sessionKey: sourceFile,
      source: "session",
      messages: [parentAnswer],
    });
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: [parentAnswer],
    });

    await writeSessionFixture({
      sessionFile: childFile,
      parentSession: sourceFile,
      sessionTimestamp: new Date(forkStartedAtMs).toISOString(),
      messages: [parentAnswer, childAnswer],
    });
    await fs.unlink(sourceFile);
    await store.recordSessionMessagesUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      sessionKey: childFile,
      source: "session",
      messages: [parentAnswer, childAnswer],
    });
    await store.recordRuntimeUsage({
      workspaceId: workspaceA,
      sessionFile: childFile,
      usage: {
        inputTokens: 15,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        totalCostUsd: 0.015,
      },
    });

    const expected = {
      inputTokens: 15,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      knownCostUsd: 0.015,
      contributorsWithCost: 2,
      contributorsWithoutCost: 0,
    };
    assert.deepEqual(
      await store.getWorkspaceUsage({
        workspaceId: workspaceA,
        sessionFiles: [sourceFile, childFile],
      }),
      expected,
    );
    assert.deepEqual(
      await new WorkspaceUsageStore(root).getWorkspaceUsage({
        workspaceId: workspaceA,
        sessionFiles: [sourceFile, childFile],
      }),
      expected,
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
