// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityInboxModel,
  ActivityItem,
  ActivityScope,
} from "../activityInbox.js";
import { ActivityInbox, type ActivityWorkspace } from "./ActivityInbox.js";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const workspaces: ActivityWorkspace[] = [
  { id: "workspace-atlas", name: "Project Atlas" },
  { id: "workspace-borealis", name: "Project Borealis" },
];

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
          : status === "pending"
            ? "View pending"
            : status === "inProgress"
              ? "View progress"
              : "View result",
  };
}

function modelWithEveryKind(): ActivityInboxModel {
  const groups = {
    needsAttention: [activity("needsAttention", "attention")],
    failed: [activity("failed", "failure", workspaces[1])],
    pending: [activity("pending", "pending")],
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

function renderInbox(
  model: ActivityInboxModel,
  scope: ActivityScope = { type: "all" },
  onOpenActivityItem = vi.fn(),
  onScopeChange = vi.fn(),
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ActivityInbox
        model={model}
        onClose={vi.fn()}
        onOpenActivityItem={onOpenActivityItem}
        onScopeChange={onScopeChange}
        scope={scope}
        workspaces={workspaces}
      />,
    );
  });
  return { onOpenActivityItem, onScopeChange, view: container };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("ActivityInbox", () => {
  it("shows global rows, workspace context, selector counts, and status chips", () => {
    const { view } = renderInbox(modelWithEveryKind());

    expect(view.querySelector("h1")?.textContent).toBe("Work inbox");
    expect(view.textContent).toContain("All workspaces");
    expect(view.textContent).toContain("Project Atlas");
    expect(view.textContent).toContain("Project Borealis");
    expect(view.querySelector("select")?.textContent).toContain(
      "Project Borealis (1)",
    );
    expect(view.querySelector('[aria-pressed="true"]')?.textContent).toContain(
      "All",
    );
    expect(view.textContent).toContain("Respond");
    expect(view.textContent).toContain("Review failure");
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

    expect(view.querySelector("h1")?.textContent).toBe(
      "Work inbox · Project Atlas",
    );
    expect(view.textContent).not.toContain("failed session failure");
    expect(view.textContent).not.toContain("Project Borealis");
    expect(view.textContent).toContain("Failed0");

    act(() => {
      selector!.value = "workspace-borealis";
      selector?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onScopeChange).toHaveBeenCalledWith({
      type: "workspace",
      workspaceId: "workspace-borealis",
    });
  });

  it("filters by status and provides scoped empty state copy", () => {
    const { view } = renderInbox(modelWithEveryKind(), {
      type: "workspace",
      workspaceId: "workspace-atlas",
    });
    const failedFilter = Array.from(view.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Failed"),
    );

    act(() => failedFilter?.click());

    expect(failedFilter?.getAttribute("aria-pressed")).toBe("true");
    expect(view.querySelector('[role="status"]')?.textContent).toContain(
      "No failed work in Project Atlas.",
    );
  });

  it("activates a full row by click or keyboard with its canonical item", () => {
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
    act(() =>
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      ),
    );
    expect(onOpenActivityItem).toHaveBeenCalledWith(model.items[0]);
  });
});
