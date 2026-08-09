/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "../../../../shared/agentWorkflowSchemas.js";
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

describe("AgentWorkflowHome", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  function render(
    overrides: Partial<Parameters<typeof AgentWorkflowHome>[0]> = {},
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const props = {
      workflows: [workflow],
      onCreate: vi.fn(),
      onEdit: vi.fn(),
      onStart: vi.fn(),
      ...overrides,
    };
    act(() => root?.render(createElement(AgentWorkflowHome, props)));
    return props;
  }

  it("renders an accessible empty state and creation action", () => {
    const props = render({ workflows: [] });
    expect(container?.textContent).toContain("Create an Agent Workflow");
    const create = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New workflow",
    )!;
    act(() => create.click());
    expect(props.onCreate).toHaveBeenCalledOnce();
  });

  it("renders a agentWorkflow-native populated card with all role counts", () => {
    render();
    expect(container?.textContent).toContain("Worker: 2");
    expect(container?.textContent).toContain("Decider: 1");
    expect(container?.textContent).toContain("Orchestrator: 1");
    expect(container?.textContent).toContain("Human: 1");
    expect(
      container?.querySelector("article")?.getAttribute("aria-label"),
    ).toBe("Delivery, Agent Workflow");
  });

  it("lists persisted canonical runs and opens the selected run", () => {
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
    const props = render({ runs: [run], onOpenRun: vi.fn() });
    expect(container?.textContent).toContain("Recent runs");
    const open = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Open run",
    )!;
    act(() => open.click());
    expect(props.onOpenRun).toHaveBeenCalledWith(run);
  });

  it("edits the selected agentWorkflow definition", () => {
    const props = render();
    const edit = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Edit",
    )!;
    act(() => edit.click());
    expect(props.onEdit).toHaveBeenCalledWith(workflow);
  });

  it("enables Start by default through the canonical execution seam", async () => {
    const props = render();
    const start = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Start run",
    )! as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    await act(async () => start.click());
    expect(props.onStart).toHaveBeenCalledWith(workflow, {});
  });

  it("starts when occurrence execution is enabled", async () => {
    const props = render({ startCapability: { enabled: true } });
    const start = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Start run",
    )! as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    await act(async () => start.click());
    expect(props.onStart).toHaveBeenCalledWith(workflow, {});
  });

  it("prevents concurrent starts for the same agentWorkflow definition", async () => {
    let resolveStart: (() => void) | undefined;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    render({ startCapability: { enabled: true }, onStart });
    const start = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Start run",
    )!;
    act(() => {
      start.click();
      start.click();
    });
    expect(onStart).toHaveBeenCalledOnce();
    await act(async () => resolveStart?.());
  });
});
