/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LegacyWorkflowRunCompatibility } from "./LegacyWorkflowRunCompatibility.js";

const run = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Migrated saved run",
  workspaceId: "workspace",
  status: "needsAttention",
  stepRuns: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Failed worker",
      templateStepId: "work",
      status: "failed",
      sessionFile: "/tmp/worker.jsonl",
      updatedAtMs: 1,
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      name: "Approval",
      templateStepId: "approval",
      status: "needsApproval",
      updatedAtMs: 1,
    },
  ],
  transitionRuns: [
    {
      id: "00000000-0000-4000-8000-000000000004",
      templateTransitionId: "condition",
      status: "failed",
      updatedAtMs: 1,
    },
  ],
} as any;

describe("LegacyWorkflowRunCompatibility", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  it("keeps saved-run session, retry, gate, and condition recovery actions reachable", async () => {
    const props = {
      run,
      onBack: vi.fn(),
      onStop: vi.fn(),
      onRetryStep: vi.fn(),
      onRetryCondition: vi.fn(),
      onOverrideCondition: vi.fn(),
      onApproveGate: vi.fn(),
      onOpenSession: vi.fn(),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(createElement(LegacyWorkflowRunCompatibility, props)),
    );
    const button = (label: string) =>
      [...container!.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      )!;
    await act(async () => button("Open Pi session").click());
    await act(async () => button("Retry agent").click());
    await act(async () => button("Approve").click());
    expect(props.onOpenSession).toHaveBeenCalledWith(run.stepRuns[0]);
    expect(props.onRetryStep).toHaveBeenCalledWith(run.stepRuns[0]);
    expect(props.onApproveGate).toHaveBeenCalledWith(
      run.stepRuns[1],
      "approve",
    );
    const textarea = container.querySelector("textarea")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Known safe route");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Override YES").click());
    expect(props.onOverrideCondition).toHaveBeenCalledWith(
      run.transitionRuns[0],
      "yes",
      "Known safe route",
    );
  });
});
