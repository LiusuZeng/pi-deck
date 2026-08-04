import { describe, expect, it } from "vitest";
import { emptyOverlays, type SessionOverlays } from "./sessionState.js";
import {
  activityTags,
  buildActivityInbox,
  classifyActivity,
  filterActivityItems,
  statusTag,
  tagsForScope,
  type ActivitySourceSession,
} from "./activityInbox.js";

function source(
  id: string,
  patch: Partial<ActivitySourceSession> = {},
): ActivitySourceSession {
  return {
    id,
    workspaceId: "workspace-a",
    title: `Session ${id}`,
    workspaceName: "Workspace A",
    updatedAtMs: 100,
    baseState: "idle",
    overlays: { ...emptyOverlays },
    ...patch,
  };
}

function overlays(patch: Partial<SessionOverlays>): SessionOverlays {
  return { ...emptyOverlays, ...patch };
}

describe("buildActivityInbox", () => {
  it("classifies every state into one tagged status with its action label", () => {
    const inbox = buildActivityInbox([
      source("attention", { baseState: "waitingForInput" }),
      source("failed", {
        baseState: "error",
        lastError: "Provider unavailable",
      }),
      source("pending", { overlays: overlays({ piQueuedFollowUpCount: 1 }) }),
      source("working", { baseState: "working" }),
      source("completed", { completedAtMs: 99 }),
      source("idle"),
    ]);

    expect(inbox.items.map((item) => [item.sessionKey, item.status])).toEqual([
      ["attention", "needsAttention"],
      ["failed", "failed"],
      ["pending", "pending"],
      ["working", "inProgress"],
      ["completed", "completed"],
      ["idle", "idle"],
    ]);
    expect(inbox.items.map((item) => item.actionLabel)).toEqual([
      "Respond",
      "Review failure",
      "View pending",
      "View progress",
      "View result",
      "Open session",
    ]);
    expect(inbox.items[0]?.tags).toEqual([
      "workspace:workspace-a",
      "status:needsAttention",
      "kind:session",
    ]);
    expect(inbox.items.find((item) => item.status === "failed")?.detail).toBe(
      "Provider unavailable",
    );
  });

  it("keeps precedence exclusive: attention, failure, pending, progress, completion", () => {
    expect(
      classifyActivity(
        source("all", {
          baseState: "error",
          overlays: overlays({
            needsUserInput: true,
            localQueuedStartCount: 1,
          }),
          completedAtMs: 1,
        }),
      ),
    ).toBe("needsAttention");
    expect(
      classifyActivity(
        source("failure", {
          baseState: "error",
          overlays: overlays({ piQueuedFollowUpCount: 1 }),
          completedAtMs: 1,
        }),
      ),
    ).toBe("failed");
    expect(
      classifyActivity(
        source("queued-working", {
          baseState: "working",
          overlays: overlays({ piQueuedSteeringCount: 1, toolRunning: true }),
          completedAtMs: 1,
        }),
      ),
    ).toBe("pending");
    expect(
      classifyActivity(
        source("working-done", { baseState: "working", completedAtMs: 1 }),
      ),
    ).toBe("inProgress");
  });

  it("classifies idle sessions after completion precedence and skips drafts", () => {
    expect(classifyActivity(source("idle"))).toBe("idle");
    expect(
      classifyActivity(source("idle-completed", { completedAtMs: 1 })),
    ).toBe("completed");
    expect(classifyActivity(source("draft", { draftSession: true }))).toBe(
      undefined,
    );
    expect(
      buildActivityInbox([source("draft", { draftSession: true })]),
    ).toMatchObject({
      totalCount: 0,
      counts: { idle: 0 },
    });
    expect(buildActivityInbox([source("idle")]).items[0]).toMatchObject({
      detail: "No active work",
      actionLabel: "Open session",
      tags: ["workspace:workspace-a", "status:idle", "kind:session"],
    });
  });

  it("requires an explicit finite completion timestamp", () => {
    expect(
      classifyActivity(
        source("undefined", { baseState: "working", completedAtMs: undefined }),
      ),
    ).toBe("inProgress");
    expect(
      classifyActivity(
        source("invalid", { baseState: "unloaded", completedAtMs: Number.NaN }),
      ),
    ).toBeUndefined();
    expect(classifyActivity(source("completed", { completedAtMs: 0 }))).toBe(
      "completed",
    );
  });

  it("uses sessionFile for stable identity across a workspace rename", () => {
    const initial = buildActivityInbox([
      source("runtime-1", {
        sessionFile: "/sessions/a.jsonl",
        sessionId: "session-a",
        runtimeId: "runtime-1",
        workspaceName: "Before rename",
        completedAtMs: 1,
      }),
    ]).items[0];
    const renamed = buildActivityInbox([
      source("runtime-2", {
        sessionFile: "/sessions/a.jsonl",
        sessionId: "session-a",
        runtimeId: "runtime-2",
        workspaceName: "After rename",
        completedAtMs: 1,
      }),
    ]).items[0];

    expect(initial?.id).toBe("activity:workspace-a:/sessions/a.jsonl");
    expect(renamed?.id).toBe(initial?.id);
    expect(renamed?.workspaceName).toBe("After rename");
    expect(renamed?.runtimeId).toBe("runtime-2");
  });

  it("filters all-workspace, workspace, and status tags by intersection", () => {
    const items = buildActivityInbox([
      source("waiting", { overlays: overlays({ needsUserInput: true }) }),
      source("error", {
        baseState: "error",
        workspaceId: "workspace-b",
        workspaceName: "Workspace B",
      }),
      source("pending", {
        overlays: overlays({ piQueuedFollowUpCount: 1 }),
        workspaceId: "workspace-b",
        workspaceName: "Workspace B",
      }),
    ]).items;

    expect(
      filterActivityItems(items, tagsForScope({ type: "all" })),
    ).toHaveLength(3);
    expect(
      filterActivityItems(
        items,
        tagsForScope({ type: "workspace", workspaceId: "workspace-b" }),
      ).map((item) => item.sessionKey),
    ).toEqual(["error", "pending"]);
    expect(
      filterActivityItems(items, {
        includeAll: ["workspace:workspace-b", statusTag("pending")],
      }).map((item) => item.sessionKey),
    ).toEqual(["pending"]);
  });

  it("excludes archived sessions by default and provides scoped actionable counts", () => {
    const inbox = buildActivityInbox([
      source("active", { overlays: overlays({ needsUserInput: true }) }),
      source("archived", { baseState: "error", archivedAtMs: 1 }),
      source("other", {
        baseState: "error",
        workspaceId: "workspace-b",
        workspaceName: "Workspace B",
      }),
      source("working", {
        baseState: "working",
        workspaceId: "workspace-b",
        workspaceName: "Workspace B",
      }),
    ]);
    const workspaceB = buildActivityInbox(
      [
        source("active", { overlays: overlays({ needsUserInput: true }) }),
        source("archived", { baseState: "error", archivedAtMs: 1 }),
        source("other", {
          baseState: "error",
          workspaceId: "workspace-b",
          workspaceName: "Workspace B",
        }),
        source("working", {
          baseState: "working",
          workspaceId: "workspace-b",
          workspaceName: "Workspace B",
        }),
      ],
      tagsForScope({ type: "workspace", workspaceId: "workspace-b" }),
    );

    expect(inbox.items.map((item) => item.sessionKey)).toEqual([
      "active",
      "other",
      "working",
    ]);
    expect(inbox.actionableCount).toBe(2);
    expect(inbox.availableWorkspaceCounts).toEqual({
      "workspace-a": 1,
      "workspace-b": 2,
    });
    expect(workspaceB.actionableCount).toBe(1);
    expect(workspaceB.counts).toMatchObject({ failed: 1, inProgress: 1 });
    expect(
      activityTags(source("archived", { archivedAtMs: 1 }), "completed"),
    ).toContain("visibility:archived");
  });
});
