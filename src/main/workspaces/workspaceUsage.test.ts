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

async function writeSessionFixture(options: {
  sessionFile: string;
  parentSession?: string;
  messages: readonly Record<string, unknown>[];
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
    ].join("\n") + "\n",
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
