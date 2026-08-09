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

const semanticWorkflow: WorkflowDefinition = {
  ...workflow,
  id: "semantic",
  name: "Semantic delivery",
  entryNodeId: "prepare",
  nodes: [
    {
      id: "prepare",
      name: "Prepare",
      role: "worker",
      config: { instructions: "Prepare" },
    },
    {
      id: "iterate",
      name: "Iterate",
      role: "orchestrator",
      config: {
        mode: "loop",
        agents: ["implement"],
        decider: "ready",
        maxIterations: 3,
      },
    },
    {
      id: "implement",
      name: "Implement",
      role: "worker",
      managedBy: "iterate",
      config: { instructions: "Implement" },
    },
    {
      id: "ready",
      name: "Ready?",
      role: "decider",
      managedBy: "iterate",
      config: { question: "Ready?" },
    },
    {
      id: "ship",
      name: "Ship?",
      role: "decider",
      config: { question: "Ship?", trueLabel: "Ship", falseLabel: "Stop" },
    },
  ],
  relationships: [
    { id: "prepare-iterate", from: "prepare", to: { nodeId: "iterate" } },
    { id: "iterate-ship", from: "iterate", to: { nodeId: "ship" } },
    {
      id: "ship-complete",
      from: "ship",
      when: { equals: true },
      to: { end: "completed" },
    },
    {
      id: "ship-stop",
      from: "ship",
      when: { equals: false },
      to: { end: "stopped" },
    },
  ],
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
    expect(props.onShowWorkflows).not.toHaveBeenCalled();
    expect(props.onShowRuns).toHaveBeenCalledOnce();
    expect(container?.textContent).not.toContain("View workflows");
    expect(container?.querySelector(".workflow-run-layout")).toBeNull();
  });

  it("navigates to the focused definitions collection from the overview", () => {
    const props = render({ workflows: [workflow, semanticWorkflow], runs: [] });
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>(".agent-workflow-overview-card")
        ?.click(),
    );
    expect(props.onShowWorkflows).toHaveBeenCalledOnce();
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
    button("Start run").focus();
    act(() => button("Start run").click());
    const dialog = container!.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Target");
    expect(dialog?.getAttribute("aria-modal")).toBeNull();
    expect(document.activeElement).toBe(dialog?.querySelector("input"));
    const dialogStart = [...dialog!.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === "Start run",
    )!;
    act(() => dialogStart.click());
    expect(dialog?.querySelector("input")?.getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(props.onStart).not.toHaveBeenCalled();
    act(() =>
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(container?.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Start run"));
    act(() => root?.unmount());
    container?.remove();

    const failingStart = vi.fn().mockRejectedValue(new Error("Unavailable"));
    render({ onStart: failingStart });
    await act(async () => button("Start run").click());
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "Unavailable",
    );
  });

  it("shows semantic branch and loop routes without implying a linear execution path", () => {
    render({ workflows: [semanticWorkflow], runs: [] });
    const preview = container!.querySelector(".agent-workflow-flow-preview");
    expect(preview?.textContent).toContain("Loop · maximum 3 iterations");
    expect(preview?.textContent).toContain("Manages Implement, Ready?");
    expect(preview?.textContent).toContain(
      "Ship?: true (Ship) → End workflow: completed",
    );
    expect(preview?.textContent).toContain(
      "Ship?: false (Stop) → End workflow: stopped",
    );
    expect(
      preview?.querySelectorAll(".agent-workflow-role-preview > li"),
    ).toHaveLength(3);
  });

  it("makes recent runs visibly and accessibly identifiable", () => {
    const laterRun = {
      ...run,
      id: "00000000-0000-4000-8000-000000000002",
      updatedAtMs: 2_000,
    };
    const props = render({ runs: [run, laterRun] });
    const rows = container!.querySelectorAll(
      ".agent-workflow-activity-list li",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("ID 00000002");
    const labels = [
      ...container!.querySelectorAll<HTMLButtonElement>(
        ".agent-workflow-activity-list button",
      ),
    ].map((item) => item.getAttribute("aria-label"));
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.stringContaining(run.id),
        expect.stringContaining(laterRun.id),
      ]),
    );
    act(() => rows[0].querySelector<HTMLButtonElement>("button")?.click());
    expect(props.onOpenRun).toHaveBeenCalledWith(laterRun);
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
