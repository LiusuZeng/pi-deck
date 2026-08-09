/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "../../../shared/agentWorkflowSchemas.js";
import { AgentWorkflowHome } from "./AgentWorkflowHome.js";

const workflow: WorkflowDefinition = {
  format: "pi-deck.agent-workflow",
  schemaVersion: 2,
  id: "delivery",
  revision: 1,
  name: "Delivery",
  inputs: [],
  entryNodeId: "work",
  nodes: [
    {
      id: "work",
      name: "Work",
      role: "worker",
      config: { instructions: "Implement" },
    },
    {
      id: "decide",
      name: "Decide",
      role: "decider",
      config: { question: "Ready?" },
    },
    {
      id: "coordinate",
      name: "Coordinate",
      role: "orchestrator",
      config: {
        mode: "fanout",
        agents: ["verify"],
        maxConcurrency: 1,
        completion: "all",
      },
    },
    {
      id: "verify",
      name: "Verify",
      role: "worker",
      managedBy: "coordinate",
      config: { instructions: "Verify" },
    },
    {
      id: "approve",
      name: "Approve",
      role: "human",
      config: { interaction: "approval", prompt: "Approve" },
    },
  ],
  relationships: [],
};

const run = {
  id: "00000000-0000-4000-8000-000000000001",
  name: workflow.name,
  workspaceId: "workspace",
  status: "waiting" as const,
  definition: workflow,
  inputs: {},
  occurrences: [],
  createdAtMs: 0,
  updatedAtMs: 0,
};

describe("AgentWorkflowHome", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  function render(
    overrides: Partial<Parameters<typeof AgentWorkflowHome>[0]> = {},
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const props = {
      workflows: [workflow],
      runs: [run],
      onCreate: vi.fn(),
      onEdit: vi.fn(),
      onStart: vi.fn(),
      onOpenRun: vi.fn(),
      onShowWorkflows: vi.fn(),
      onShowRuns: vi.fn(),
      onBack: vi.fn(),
      ...overrides,
    };
    act(() => root?.render(createElement(AgentWorkflowHome, props)));
    return props;
  }
  const button = (name: string) =>
    [...container!.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === name,
    )!;

  it("uses a single workflow overview as a compact summary with accessible actions", async () => {
    const props = render();
    const summary = container!.querySelector(".agent-workflow-summary");
    expect(summary?.getAttribute("aria-labelledby")).toBe(
      "agent-workflow-delivery-summary-title",
    );
    expect(summary?.textContent).toContain("Workflow structure");
    expect(summary?.textContent).toContain("Work");
    expect(summary?.textContent).toContain("Manages Verify");
    expect(summary?.textContent).toContain("2 Workers");
    expect(summary?.textContent).toContain("Waiting to start");
    expect(summary?.textContent).not.toContain("Performs a configured task.");

    await act(async () => button("Start run").click());
    act(() => button("Edit").click());
    act(() => button("Open run").click());
    act(() => button("View all runs").click());
    expect(props.onStart).toHaveBeenCalledWith(workflow, {});
    expect(props.onEdit).toHaveBeenCalledWith(workflow);
    expect(props.onOpenRun).toHaveBeenCalledWith(run);
    expect(props.onShowRuns).toHaveBeenCalledOnce();
  });

  it("opens required run inputs and reports start failures from the summary", async () => {
    const inputWorkflow = {
      ...workflow,
      inputs: [
        {
          id: "target",
          label: "Target",
          type: "text" as const,
          required: true,
        },
      ],
    };
    const props = render({ workflows: [inputWorkflow] });
    act(() => button("Start run").click());
    const dialog = container!.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Target");
    const dialogStart = [...dialog!.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === "Start run",
    )!;
    act(() => dialogStart.click());
    expect(dialog?.querySelector("input")?.getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(props.onStart).not.toHaveBeenCalled();
    act(() => root?.unmount());
    container?.remove();

    const failingStart = vi.fn().mockRejectedValue(new Error("Unavailable"));
    render({ onStart: failingStart });
    await act(async () => button("Start run").click());
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "Unavailable",
    );
  });

  it("keeps an intentional empty activity state for one workflow", () => {
    render({ runs: [] });
    expect(container?.textContent).toContain("No activity yet");
    expect(container?.textContent).toContain("Start a run when it is ready.");
  });

  it("keeps collection destinations for empty and multiple workflow density states", () => {
    const empty = render({ workflows: [], runs: [] });
    expect(
      container?.querySelectorAll(".agent-workflow-overview-card"),
    ).toHaveLength(2);
    expect(container?.textContent).toContain("0 saved");
    act(() => root?.unmount());
    container?.remove();

    const secondWorkflow = { ...workflow, id: "review", name: "Review" };
    const multiple = render({ workflows: [workflow, secondWorkflow] });
    expect(
      container?.querySelectorAll(".agent-workflow-overview-card"),
    ).toHaveLength(2);
    expect(container?.textContent).toContain("2 saved");
    expect(multiple.onShowWorkflows).not.toHaveBeenCalled();
    expect(empty.onShowRuns).not.toHaveBeenCalled();
  });

  it("keeps create, start, and edit in the focused Workflows view", async () => {
    const props = render({ view: "workflows" });
    expect(container?.querySelector("h2")?.textContent).toBe("Workflows");
    expect(container?.textContent).toContain("Worker: 2");
    expect(
      container?.querySelector("article")?.getAttribute("aria-labelledby"),
    ).toBe("agent-workflow-delivery-title");
    act(() => button("New workflow").click());
    act(() => button("Edit").click());
    await act(async () => button("Start run").click());
    expect(props.onCreate).toHaveBeenCalledOnce();
    expect(props.onEdit).toHaveBeenCalledWith(workflow);
    expect(props.onStart).toHaveBeenCalledWith(workflow, {});
  });

  it("keeps Open run in the focused Runs view and can return to the overview", () => {
    const props = render({ view: "runs" });
    expect(container?.querySelector("h2")?.textContent).toBe("Runs");
    expect(container?.textContent).not.toContain("Worker: 2");
    act(() => button("Open run").click());
    act(() => button("Back to overview").click());
    expect(props.onOpenRun).toHaveBeenCalledWith(run);
    expect(props.onBack).toHaveBeenCalledOnce();
  });

  it("uses focused empty states without duplicate creation actions", () => {
    render({ view: "workflows", workflows: [], runs: [] });
    expect(container?.textContent).toContain("No workflows yet");
    expect(
      [...container!.querySelectorAll("button")].filter(
        (item) => item.textContent?.trim() === "New workflow",
      ),
    ).toHaveLength(1);
  });
});
