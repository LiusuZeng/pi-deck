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
  it("classifies operational states into one tagged status with its action label", () => {
    const inbox = buildActivityInbox([
      source("attention", { baseState: "waitingForInput" }),
      source("failed", {
        baseState: "error",
        lastError: "Provider unavailable",
      }),
      source("queued", { overlays: overlays({ piQueuedFollowUpCount: 1 }) }),
      source("working", { baseState: "working" }),
      source("completed", { completedAtMs: 99 }),
      source("idle"),
    ]);

    expect(inbox.items.map((item) => [item.sessionKey, item.status])).toEqual([
      ["attention", "needsAttention"],
      ["failed", "failed"],
      ["queued", "queued"],
      ["working", "inProgress"],
      ["completed", "completed"],
    ]);
    expect(inbox.items.map((item) => item.actionLabel)).toEqual([
      "Respond",
      "Review failure",
      "View queued work",
      "View progress",
      "View result",
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

  it("preserves source order within active statuses instead of sorting by recency", () => {
    const inbox = buildActivityInbox([
      source("older-working", { baseState: "working", updatedAtMs: 100 }),
      source("newer-working", { baseState: "working", updatedAtMs: 200 }),
      source("older-failed", { baseState: "error", updatedAtMs: 100 }),
      source("newer-failed", { baseState: "error", updatedAtMs: 200 }),
    ]);

    expect(inbox.groups.inProgress.map((item) => item.sessionKey)).toEqual([
      "older-working",
      "newer-working",
    ]);
    expect(inbox.groups.failed.map((item) => item.sessionKey)).toEqual([
      "older-failed",
      "newer-failed",
    ]);
    expect(inbox.items.map((item) => item.sessionKey)).toEqual([
      "older-failed",
      "newer-failed",
      "older-working",
      "newer-working",
    ]);
  });

  it("orders Completed as a FIFO queue by completedAtMs, not updatedAtMs", () => {
    const inbox = buildActivityInbox([
      source("updated-newest", { completedAtMs: 300, updatedAtMs: 900 }),
      source("completed-oldest", { completedAtMs: 100, updatedAtMs: 500 }),
      source("completed-middle", { completedAtMs: 200, updatedAtMs: 100 }),
    ]);

    expect(inbox.groups.completed.map((item) => item.sessionKey)).toEqual([
      "completed-oldest",
      "completed-middle",
      "updated-newest",
    ]);
    expect(inbox.groups.completed.map((item) => item.completedAtMs)).toEqual([
      100, 200, 300,
    ]);
  });

  it("does not reorder Completed when only generic updatedAtMs changes", () => {
    const initial = buildActivityInbox([
      source("first", { completedAtMs: 100, updatedAtMs: 100 }),
      source("second", { completedAtMs: 200, updatedAtMs: 200 }),
    ]);
    const refreshed = buildActivityInbox([
      source("first", { completedAtMs: 100, updatedAtMs: 900 }),
      source("second", { completedAtMs: 200, updatedAtMs: 50 }),
    ]);

    expect(initial.groups.completed.map((item) => item.sessionKey)).toEqual([
      "first",
      "second",
    ]);
    expect(refreshed.groups.completed.map((item) => item.sessionKey)).toEqual([
      "first",
      "second",
    ]);
  });

  it("inserts newly Completed work by completion time with deterministic ties", () => {
    const inbox = buildActivityInbox([
      source("later", { completedAtMs: 300, updatedAtMs: 300 }),
      source("tie-b", { completedAtMs: 200, updatedAtMs: 200 }),
      source("tie-a", { completedAtMs: 200, updatedAtMs: 900 }),
      source("new-middle", { completedAtMs: 250, updatedAtMs: 250 }),
      source("earlier", { completedAtMs: 100, updatedAtMs: 100 }),
    ]);

    expect(inbox.groups.completed.map((item) => item.sessionKey)).toEqual([
      "earlier",
      "tie-a",
      "tie-b",
      "new-middle",
      "later",
    ]);
  });

  it("uses the same Completed queue ordering in All Work and workspace scopes", () => {
    const fixture = [
      source("atlas-late", { completedAtMs: 300, workspaceId: "atlas" }),
      source("atlas-early", { completedAtMs: 100, workspaceId: "atlas" }),
      source("borealis", { completedAtMs: 200, workspaceId: "borealis" }),
    ];

    expect(
      buildActivityInbox(fixture).groups.completed.map(
        (item) => item.sessionKey,
      ),
    ).toEqual(["atlas-early", "borealis", "atlas-late"]);
    expect(
      buildActivityInbox(
        fixture,
        tagsForScope({ type: "workspace", workspaceId: "atlas" }),
      ).groups.completed.map((item) => item.sessionKey),
    ).toEqual(["atlas-early", "atlas-late"]);
  });

  it("keeps precedence exclusive: attention, failure, queued, progress, completion", () => {
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
    ).toBe("queued");
    expect(
      classifyActivity(
        source("working-done", { baseState: "working", completedAtMs: 1 }),
      ),
    ).toBe("inProgress");
  });

  it("moves Completed work out of the queue when a follow-up is queued", () => {
    const inbox = buildActivityInbox([
      source("follow-up", {
        completedAtMs: 100,
        overlays: overlays({ piQueuedFollowUpCount: 1 }),
      }),
      source("completed", { completedAtMs: 200 }),
    ]);

    expect(inbox.groups.completed.map((item) => item.sessionKey)).toEqual([
      "completed",
    ]);
    expect(inbox.groups.queued.map((item) => item.sessionKey)).toEqual([
      "follow-up",
    ]);
    expect(inbox.groups.queued[0]?.completedAtMs).toBeUndefined();
  });

  it("uses a fresh completion timestamp when follow-up work completes again", () => {
    const beforeFollowUp = buildActivityInbox([
      source("existing", { completedAtMs: 200 }),
      source("follow-up", { completedAtMs: 100 }),
    ]);
    const afterFollowUp = buildActivityInbox([
      source("existing", { completedAtMs: 200 }),
      source("follow-up", { completedAtMs: 300 }),
    ]);

    expect(
      beforeFollowUp.groups.completed.map((item) => item.sessionKey),
    ).toEqual(["follow-up", "existing"]);
    expect(
      afterFollowUp.groups.completed.map((item) => item.sessionKey),
    ).toEqual(["existing", "follow-up"]);
  });

  it("omits idle sessions without dropping completed work or queued work", () => {
    expect(classifyActivity(source("idle"))).toBeUndefined();
    expect(
      classifyActivity(source("idle-completed", { completedAtMs: 1 })),
    ).toBe("completed");
    expect(
      classifyActivity(
        source("idle-queued", {
          overlays: overlays({ piQueuedFollowUpCount: 1 }),
        }),
      ),
    ).toBe("queued");
    expect(classifyActivity(source("draft", { draftSession: true }))).toBe(
      undefined,
    );
    expect(
      buildActivityInbox([
        source("idle"),
        source("draft", { draftSession: true }),
      ]),
    ).toMatchObject({
      items: [],
      totalCount: 0,
      counts: {
        needsAttention: 0,
        failed: 0,
        queued: 0,
        inProgress: 0,
        completed: 0,
      },
      availableWorkspaceCounts: {},
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
      source("queued", {
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
    ).toEqual(["error", "queued"]);
    expect(
      filterActivityItems(items, {
        includeAll: ["workspace:workspace-b", statusTag("queued")],
      }).map((item) => item.sessionKey),
    ).toEqual(["queued"]);
  });

  it("keeps simultaneous workspace and status fixtures consistent across scopes", () => {
    const fixture = [
      source("default-needs", {
        workspaceId: "workspace-default",
        workspaceName: "Default workspace",
        baseState: "waitingForInput",
      }),
      source("default-idle", {
        workspaceId: "workspace-default",
        workspaceName: "Default workspace",
        sessionFile: "/sessions/default-idle.jsonl",
        sessionId: "default-idle-session",
      }),
      source("atlas-working", {
        workspaceId: "workspace-atlas",
        workspaceName: "Project Atlas",
        baseState: "working",
      }),
      source("atlas-queued", {
        workspaceId: "workspace-atlas",
        workspaceName: "Project Atlas",
        overlays: overlays({ piQueuedFollowUpCount: 1 }),
      }),
      source("borealis-failed", {
        workspaceId: "workspace-borealis",
        workspaceName: "Project Borealis",
        baseState: "error",
      }),
      source("borealis-completed", {
        workspaceId: "workspace-borealis",
        workspaceName: "Project Borealis",
        completedAtMs: 99,
      }),
      source("archived-borealis", {
        workspaceId: "workspace-borealis",
        workspaceName: "Project Borealis",
        baseState: "error",
        archivedAtMs: 98,
      }),
      source("draft-atlas", {
        workspaceId: "workspace-atlas",
        workspaceName: "Project Atlas",
        draftSession: true,
      }),
    ];
    const global = buildActivityInbox(fixture);

    expect(
      global.items.map(({ sessionKey, status }) => [sessionKey, status]),
    ).toEqual([
      ["default-needs", "needsAttention"],
      ["borealis-failed", "failed"],
      ["atlas-queued", "queued"],
      ["atlas-working", "inProgress"],
      ["borealis-completed", "completed"],
    ]);
    expect(global.counts).toEqual({
      needsAttention: 1,
      failed: 1,
      queued: 1,
      inProgress: 1,
      completed: 1,
    });
    expect(global.actionableCount).toBe(3);
    expect(global.totalCount).toBe(5);
    expect(global.availableWorkspaceCounts).toEqual({
      "workspace-default": 1,
      "workspace-atlas": 2,
      "workspace-borealis": 2,
    });

    const atlas = buildActivityInbox(
      fixture,
      tagsForScope({ type: "workspace", workspaceId: "workspace-atlas" }),
    );
    const borealis = buildActivityInbox(
      fixture,
      tagsForScope({ type: "workspace", workspaceId: "workspace-borealis" }),
    );

    expect(
      atlas.items.map(({ sessionKey, status }) => [sessionKey, status]),
    ).toEqual([
      ["atlas-queued", "queued"],
      ["atlas-working", "inProgress"],
    ]);
    expect(atlas.actionableCount).toBe(1);
    const defaultWorkspace = buildActivityInbox(
      fixture,
      tagsForScope({ type: "workspace", workspaceId: "workspace-default" }),
    );
    expect(
      defaultWorkspace.items.map(({ sessionKey, status }) => [
        sessionKey,
        status,
      ]),
    ).toEqual([["default-needs", "needsAttention"]]);
    expect(defaultWorkspace.actionableCount).toBe(1);
    expect(
      borealis.items.map(({ sessionKey, status }) => [sessionKey, status]),
    ).toEqual([
      ["borealis-failed", "failed"],
      ["borealis-completed", "completed"],
    ]);
    expect(borealis.actionableCount).toBe(1);
    expect(
      filterActivityItems(borealis.items, {
        includeAll: ["workspace:workspace-borealis", statusTag("failed")],
      }).map((item) => item.sessionKey),
    ).toEqual(["borealis-failed"]);
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
