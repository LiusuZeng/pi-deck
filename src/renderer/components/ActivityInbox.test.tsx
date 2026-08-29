// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyOverlays } from "../sessionState.js";
import {
  buildActivityInbox,
  tagsForScope,
  type ActivityInboxModel,
  type ActivityItem,
  type ActivityScope,
  type ActivitySourceSession,
} from "../activityInbox.js";
import {
  ActivityInbox,
  type ActivityInboxFilter,
  type ActivityWorkspace,
} from "./ActivityInbox.js";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const workspaces: ActivityWorkspace[] = [
  { id: "workspace-atlas", name: "Project Atlas" },
  { id: "workspace-borealis", name: "Project Borealis" },
];

function sourceSession(
  id: string,
  patch: Partial<ActivitySourceSession> = {},
): ActivitySourceSession {
  return {
    id,
    workspaceId: workspaces[0]!.id,
    title: `Session ${id}`,
    workspaceName: workspaces[0]!.name,
    updatedAtMs: Date.now() - 60_000,
    baseState: "idle",
    overlays: { ...emptyOverlays },
    ...patch,
  };
}

function activity(
  status: ActivityItem["status"],
  suffix: string,
  workspace = workspaces[0]!,
): ActivityItem {
  return {
    id: `${status}-${suffix}`,
    sessionKey: `session-${suffix}`,
    workspaceId: workspace.id,
    status,
    tags: [`workspace:${workspace.id}`, `status:${status}`, "kind:session"],
    title: `${status} session ${suffix}`,
    workspaceName: workspace.name,
    detail: `Detail for ${status}`,
    updatedAtMs: Date.now() - 60_000,
    actionLabel:
      status === "needsAttention"
        ? "Respond"
        : status === "failed"
          ? "Review failure"
          : status === "queued"
            ? "View queued work"
            : status === "inProgress"
              ? "View progress"
              : "View result",
  };
}

function modelWithEveryKind(): ActivityInboxModel {
  const groups = {
    needsAttention: [activity("needsAttention", "attention")],
    failed: [activity("failed", "failure", workspaces[1])],
    queued: [activity("queued", "queued")],
    inProgress: [activity("inProgress", "progress")],
    completed: [activity("completed", "complete")],
  };
  return {
    items: Object.values(groups).flat(),
    groups,
    counts: Object.fromEntries(
      Object.entries(groups).map(([kind, items]) => [kind, items.length]),
    ) as ActivityInboxModel["counts"],
    actionableCount: 3,
    totalCount: 5,
    availableWorkspaceCounts: {
      "workspace-atlas": 4,
      "workspace-borealis": 1,
    },
  };
}

function rowTitles(view: ParentNode): string[] {
  return Array.from(
    view.querySelectorAll<HTMLElement>(".activity-inbox-row-title"),
  ).map((element) => element.textContent ?? "");
}

function rowForTitle(
  view: ParentNode,
  title: string,
): HTMLButtonElement | undefined {
  return Array.from(
    view.querySelectorAll<HTMLButtonElement>(".activity-inbox-row"),
  ).find((row) =>
    row
      .querySelector(".activity-inbox-row-title")
      ?.textContent?.includes(title),
  );
}

function renderInbox(
  model: ActivityInboxModel,
  scope: ActivityScope = { type: "all" },
  onOpenActivityItem = vi.fn(),
  onScopeChange = vi.fn(),
  workspaceOptions: readonly ActivityWorkspace[] = workspaces,
  onNewSession = vi.fn(),
  selectedFilter: ActivityInboxFilter = "all",
  onSelectedFilterChange = vi.fn(),
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ActivityInbox
        model={model}
        onOpenActivityItem={onOpenActivityItem}
        onScopeChange={onScopeChange}
        onSelectedFilterChange={onSelectedFilterChange}
        selectedFilter={selectedFilter}
        onNewSession={onNewSession}
        scope={scope}
        workspaces={workspaceOptions}
      />,
    );
  });
  return {
    onOpenActivityItem,
    onScopeChange,
    onSelectedFilterChange,
    view: container,
  };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("ActivityInbox", () => {
  it("removes the legacy close action while preserving heading focus", () => {
    const { view } = renderInbox(modelWithEveryKind());

    expect(view.querySelector('button[aria-label^="Close "]')).toBeNull();
    expect(view.querySelector(".activity-inbox-close")).toBeNull();
    expect(view.querySelector("h1")?.getAttribute("tabindex")).toBe("-1");
  });

  it("shows expandable workspace usage with partial cost wording", () => {
    const { view } = renderInbox(modelWithEveryKind(), {
      type: "workspace",
      workspaceId: workspaces[0]!.id,
    });

    act(() => {
      root?.render(
        <ActivityInbox
          model={modelWithEveryKind()}
          onOpenActivityItem={vi.fn()}
          onScopeChange={vi.fn()}
          onSelectedFilterChange={vi.fn()}
          selectedFilter="all"
          onNewSession={vi.fn()}
          scope={{ type: "workspace", workspaceId: workspaces[0]!.id }}
          usage={{
            inputTokens: 1_400,
            outputTokens: 300,
            cacheReadTokens: 600,
            cacheWriteTokens: 10,
            totalTokens: 2_310,
            knownCostUsd: 0.18,
            contributorsWithCost: 1,
            contributorsWithoutCost: 2,
          }}
          workspaces={workspaces}
        />,
      );
    });

    expect(view.querySelector(".activity-inbox-usage")?.textContent).toContain(
      "2.31K tokens",
    );
    expect(view.querySelector(".activity-inbox-usage")?.textContent).toContain(
      "2 executions without cost data",
    );
  });

  it("keeps default-only Work free of workspace presentation mechanics", () => {
    const { view } = renderInbox(
      modelWithEveryKind(),
      { type: "all" },
      vi.fn(),
      vi.fn(),
      [],
    );

    expect(view.querySelector("select")).toBeNull();
    expect(view.querySelector(".activity-inbox-row-context")).toBeNull();
    expect(
      view.querySelector(".activity-inbox-row")?.getAttribute("aria-label"),
    ).not.toContain("Project Atlas");
    expect(view.textContent).not.toContain("Project Atlas");
  });

  it("shows global rows, workspace context, selector counts, and status chips", () => {
    const { view } = renderInbox(modelWithEveryKind());

    expect(view.querySelector("h1")?.textContent).toBe("All Work");
    expect(view.querySelector("h1")?.getAttribute("tabindex")).toBe("-1");
    expect(view.textContent).toContain("All Work");
    expect(view.textContent).toContain("Project Atlas");
    expect(view.textContent).toContain("Project Borealis");
    expect(view.querySelector("select")?.getAttribute("aria-label")).toBe(
      "Current Work scope",
    );
    expect(view.querySelector("select")?.textContent).toContain(
      "Project Borealis (1)",
    );
    expect(view.querySelector('option[value="all"]')?.textContent).toBe(
      "All Work (5)",
    );
    const selectedAllFilter = view.querySelector('[aria-pressed="true"]');
    expect(selectedAllFilter?.textContent).toContain("All");
    expect(
      selectedAllFilter?.querySelector(".activity-inbox-filter-count")
        ?.textContent,
    ).toBe("5");
    expect(view.textContent).toContain("Respond");
    expect(view.textContent).toContain("Review failure");
    expect(view.textContent).toContain("Queued");
    expect(view.textContent).toContain("View queued work");
    expect(view.textContent).not.toContain("Pending");
    expect(view.textContent).not.toContain("Idle");
  });

  it("uses total Work, not actionable Work, for All Work-labeled counts", () => {
    const model = modelWithEveryKind();
    expect(model.actionableCount).toBe(3);
    expect(model.totalCount).toBe(5);

    const { view } = renderInbox(model);

    expect(view.querySelector('option[value="all"]')?.textContent).toBe(
      "All Work (5)",
    );
    expect(
      view
        .querySelector('[aria-pressed="true"]')
        ?.querySelector(".activity-inbox-filter-count")?.textContent,
    ).toBe("5");
  });

  it("keeps All Work availability counts global when App passes a scoped model", () => {
    const sources = [
      sourceSession("atlas-working", { baseState: "working" }),
      sourceSession("borealis-failed", {
        workspaceId: workspaces[1]!.id,
        workspaceName: workspaces[1]!.name,
        baseState: "error",
      }),
    ];
    const scopedModel = buildActivityInbox(
      sources,
      tagsForScope({ type: "workspace", workspaceId: workspaces[0]!.id }),
    );
    const { view } = renderInbox(scopedModel, {
      type: "workspace",
      workspaceId: workspaces[0]!.id,
    });

    expect(view.querySelector('option[value="all"]')?.textContent).toBe(
      "All Work (2)",
    );
    const allFilter = view.querySelector(".activity-inbox-filter");
    expect(allFilter?.textContent).toContain("All");
    expect(
      allFilter?.querySelector(".activity-inbox-filter-count")?.textContent,
    ).toBe("1");
    expect(
      view.querySelector(".activity-inbox-content")?.textContent,
    ).toContain("atlas-working");
    expect(
      view.querySelector(".activity-inbox-content")?.textContent,
    ).not.toContain("borealis-failed");
  });

  it("keeps same-status row order stable when recency updates in All Work", () => {
    const initialUpdatedAtMs = 1_700_000_000_000;
    const refreshedUpdatedAtMs = initialUpdatedAtMs + 120_000;
    const initial = buildActivityInbox([
      sourceSession("alpha", {
        title: "Alpha active session",
        baseState: "working",
        updatedAtMs: initialUpdatedAtMs,
      }),
      sourceSession("beta", {
        title: "Beta active session",
        baseState: "working",
        updatedAtMs: initialUpdatedAtMs + 60_000,
      }),
    ]);
    const refreshed = buildActivityInbox([
      sourceSession("alpha", {
        title: "Alpha active session",
        baseState: "working",
        updatedAtMs: refreshedUpdatedAtMs,
      }),
      sourceSession("beta", {
        title: "Beta active session",
        baseState: "working",
        updatedAtMs: initialUpdatedAtMs,
      }),
    ]);
    const { view } = renderInbox(
      initial,
      { type: "all" },
      vi.fn(),
      vi.fn(),
      workspaces,
      vi.fn(),
      "inProgress",
    );

    expect(rowTitles(view)).toEqual([
      "Alpha active session",
      "Beta active session",
    ]);

    act(() => {
      root?.render(
        <ActivityInbox
          model={refreshed}
          onOpenActivityItem={vi.fn()}
          onScopeChange={vi.fn()}
          onSelectedFilterChange={vi.fn()}
          selectedFilter="inProgress"
          scope={{ type: "all" }}
          workspaces={workspaces}
        />,
      );
    });

    expect(rowTitles(view)).toEqual([
      "Alpha active session",
      "Beta active session",
    ]);
    expect(rowForTitle(view, "Alpha")?.querySelector("time")?.dateTime).toBe(
      new Date(refreshedUpdatedAtMs).toISOString(),
    );
  });

  it("keeps same-status row order stable in workspace-scoped Work", () => {
    const initial = buildActivityInbox([
      sourceSession("atlas-alpha", {
        title: "Atlas alpha",
        baseState: "working",
        updatedAtMs: 100,
      }),
      sourceSession("atlas-beta", {
        title: "Atlas beta",
        baseState: "working",
        updatedAtMs: 300,
      }),
      sourceSession("borealis", {
        title: "Borealis active",
        workspaceId: workspaces[1]!.id,
        workspaceName: workspaces[1]!.name,
        baseState: "working",
        updatedAtMs: 200,
      }),
    ]);
    const refreshed = buildActivityInbox([
      sourceSession("atlas-alpha", {
        title: "Atlas alpha",
        baseState: "working",
        updatedAtMs: 400,
      }),
      sourceSession("atlas-beta", {
        title: "Atlas beta",
        baseState: "working",
        updatedAtMs: 100,
      }),
      sourceSession("borealis", {
        title: "Borealis active",
        workspaceId: workspaces[1]!.id,
        workspaceName: workspaces[1]!.name,
        baseState: "working",
        updatedAtMs: 500,
      }),
    ]);
    const scope: ActivityScope = {
      type: "workspace",
      workspaceId: workspaces[0]!.id,
    };
    const { view } = renderInbox(
      initial,
      scope,
      vi.fn(),
      vi.fn(),
      workspaces,
      vi.fn(),
      "inProgress",
    );

    expect(rowTitles(view)).toEqual(["Atlas alpha", "Atlas beta"]);

    act(() => {
      root?.render(
        <ActivityInbox
          model={refreshed}
          onOpenActivityItem={vi.fn()}
          onScopeChange={vi.fn()}
          onSelectedFilterChange={vi.fn()}
          selectedFilter="inProgress"
          scope={scope}
          workspaces={workspaces}
        />,
      );
    });

    expect(rowTitles(view)).toEqual(["Atlas alpha", "Atlas beta"]);
    expect(view.textContent).not.toContain("Borealis active");
  });

  it("moves a row immediately when it transitions to another status", () => {
    const initial = buildActivityInbox([
      sourceSession("alpha", {
        title: "Alpha active session",
        baseState: "working",
      }),
      sourceSession("beta", {
        title: "Beta active session",
        baseState: "working",
      }),
    ]);
    const transitioned = buildActivityInbox([
      sourceSession("alpha", {
        title: "Alpha active session",
        baseState: "waitingForInput",
      }),
      sourceSession("beta", {
        title: "Beta active session",
        baseState: "working",
      }),
    ]);
    const { view } = renderInbox(initial);

    expect(
      rowForTitle(view, "Alpha")
        ?.closest(".activity-inbox-section")
        ?.querySelector("h2")?.textContent,
    ).toContain("In progress");

    act(() => {
      root?.render(
        <ActivityInbox
          model={transitioned}
          onOpenActivityItem={vi.fn()}
          onScopeChange={vi.fn()}
          onSelectedFilterChange={vi.fn()}
          selectedFilter="all"
          scope={{ type: "all" }}
          workspaces={workspaces}
        />,
      );
    });

    expect(
      rowForTitle(view, "Alpha")
        ?.closest(".activity-inbox-section")
        ?.querySelector("h2")?.textContent,
    ).toContain("Needs attention");
    expect(
      rowForTitle(view, "Beta")
        ?.closest(".activity-inbox-section")
        ?.querySelector("h2")?.textContent,
    ).toContain("In progress");
  });

  it("changes workspace scope through the selector and uses scoped status counts", () => {
    const onScopeChange = vi.fn();
    const { view } = renderInbox(
      modelWithEveryKind(),
      { type: "workspace", workspaceId: "workspace-atlas" },
      vi.fn(),
      onScopeChange,
    );
    const selector = view.querySelector<HTMLSelectElement>("select");

    expect(view.querySelector("h1")?.textContent).toBe("Project Atlas Work");
    expect(selector?.value).toBe("workspace-atlas");
    expect(
      view.querySelector("#activity-inbox-scope-status")?.textContent,
    ).toBe("Current scope: Project Atlas Work.");
    expect(
      view.querySelector(".activity-inbox-content")?.textContent,
    ).not.toContain("failed session failure");
    expect(view.textContent).toContain("Project Borealis");
    expect(view.textContent).toContain("Failed0");
    expect(
      view.querySelector(".activity-inbox-filters")?.getAttribute("role"),
    ).toBe("group");

    act(() => {
      selector!.value = "workspace-borealis";
      selector?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onScopeChange).toHaveBeenCalledWith({
      type: "workspace",
      workspaceId: "workspace-borealis",
    });
  });

  it("names an empty workspace scope without falling back to global copy", () => {
    const { view } = renderInbox(
      modelWithEveryKind(),
      { type: "workspace", workspaceId: "workspace-cygnus" },
      vi.fn(),
      vi.fn(),
      [...workspaces, { id: "workspace-cygnus", name: "Project Cygnus" }],
    );

    expect(view.querySelector("h1")?.textContent).toBe("Project Cygnus Work");
    expect(view.querySelector('[role="status"]')?.textContent).toContain(
      "No work in Project Cygnus Work.",
    );
    expect(view.querySelector('option[value="all"]')?.textContent).toBe(
      "All Work (5)",
    );
  });

  it("uses App-controlled status filters and provides scoped empty state copy", () => {
    const onSelectedFilterChange = vi.fn();
    const { view } = renderInbox(
      modelWithEveryKind(),
      { type: "workspace", workspaceId: "workspace-atlas" },
      vi.fn(),
      vi.fn(),
      workspaces,
      vi.fn(),
      "failed",
      onSelectedFilterChange,
    );
    const failedFilter = Array.from(view.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Failed"),
    );

    expect(failedFilter?.getAttribute("aria-pressed")).toBe("true");
    expect(view.querySelector('[role="status"]')?.textContent).toContain(
      "No failed work in Project Atlas Work.",
    );
    act(() => failedFilter?.click());
    expect(onSelectedFilterChange).toHaveBeenCalledWith("failed");
  });

  it("renders a retained App-owned filter after an inbox remount", () => {
    const renderWithRetainedFilter = () =>
      root?.render(
        <ActivityInbox
          model={modelWithEveryKind()}
          onOpenActivityItem={vi.fn()}
          onScopeChange={vi.fn()}
          onSelectedFilterChange={vi.fn()}
          scope={{ type: "all" }}
          selectedFilter="needsAttention"
          workspaces={workspaces}
        />,
      );

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(renderWithRetainedFilter);
    act(() => root?.unmount());
    root = createRoot(container);
    act(renderWithRetainedFilter);

    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(".activity-inbox-filter"),
      )
        .find((button) => button.textContent?.includes("Needs attention"))
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("offers New session from an empty Work surface", () => {
    const onNewSession = vi.fn();
    const { view } = renderInbox(
      buildActivityInbox([]),
      { type: "workspace", workspaceId: "workspace-atlas" },
      vi.fn(),
      vi.fn(),
      workspaces,
      onNewSession,
    );
    const cta = view.querySelector<HTMLButtonElement>(
      ".activity-inbox-empty-action",
    );

    expect(cta?.textContent).toBe("New session");
    act(() => cta?.click());
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it("names rows with visible detail and relative update time", () => {
    const { view } = renderInbox(modelWithEveryKind());
    const row = Array.from(
      view.querySelectorAll<HTMLButtonElement>(".activity-inbox-row"),
    ).find((button) =>
      button.getAttribute("aria-label")?.includes("Needs attention"),
    );

    expect(row?.getAttribute("aria-label")).toContain(
      "Detail for needsAttention",
    );
    expect(row?.getAttribute("aria-label")).toContain("Updated");
    expect(row?.dataset.activityItemId).toBe("needsAttention-attention");
  });

  it("shows the Completed row timestamp from completedAtMs", () => {
    const now = 1_700_000_600_000;
    const completedAtMs = now - 300_000;
    const updatedAtMs = now - 60_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const model = buildActivityInbox([
      sourceSession("done", {
        title: "Done session",
        completedAtMs,
        updatedAtMs,
      }),
    ]);

    const { view } = renderInbox(
      model,
      { type: "all" },
      vi.fn(),
      vi.fn(),
      workspaces,
      vi.fn(),
      "completed",
    );
    const row = rowForTitle(view, "Done session");
    const time = row?.querySelector("time");

    expect(row?.getAttribute("aria-label")).toContain("Completed 5m ago");
    expect(time?.textContent).toBe("5m ago");
    expect(time?.dateTime).toBe(new Date(completedAtMs).toISOString());
    expect(time?.dateTime).not.toBe(new Date(updatedAtMs).toISOString());
    nowSpy.mockRestore();
  });

  it("activates a full row once by click, Enter, or Space with its canonical item", () => {
    const onOpenActivityItem = vi.fn();
    const model = modelWithEveryKind();
    const { view } = renderInbox(model, { type: "all" }, onOpenActivityItem);
    const row = Array.from(
      view.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) =>
      button.getAttribute("aria-label")?.includes("Project Atlas"),
    );

    expect(row?.getAttribute("aria-label")).toContain("Needs attention");
    expect(row?.getAttribute("aria-label")).toContain("Respond");
    act(() => row?.click());
    expect(onOpenActivityItem).toHaveBeenCalledTimes(1);
    expect(onOpenActivityItem).toHaveBeenLastCalledWith(model.items[0]);
    act(() =>
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      ),
    );
    expect(onOpenActivityItem).toHaveBeenCalledTimes(2);
    const space = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
    });
    act(() => row?.dispatchEvent(space));
    expect(space.defaultPrevented).toBe(true);
    expect(onOpenActivityItem).toHaveBeenCalledTimes(3);
    expect(onOpenActivityItem).toHaveBeenLastCalledWith(model.items[0]);
  });
});
