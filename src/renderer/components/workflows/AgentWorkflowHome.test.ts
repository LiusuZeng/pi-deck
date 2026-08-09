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

  it("is an overview with separate workflow and run destinations", () => {
    const props = render();
    expect(container?.querySelector("h2")?.textContent).toBe("Agent Workflows");
    expect(container?.textContent).toContain("1 saved");
    expect(container?.textContent).toContain("1 in this workspace");
    const overviewCards = container!.querySelectorAll(
      ".agent-workflow-overview-card",
    );
    act(() => (overviewCards[0] as HTMLButtonElement).click());
    act(() => (overviewCards[1] as HTMLButtonElement).click());
    expect(props.onShowWorkflows).toHaveBeenCalledOnce();
    expect(props.onShowRuns).toHaveBeenCalledOnce();
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
