/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanonicalNodeOccurrence,
  WorkflowDefinition,
} from "../../../../shared/agentWorkflowSchemas.js";
import { AgentWorkflowGraph } from "./AgentWorkflowGraph.js";

const semanticGraphDefinition: WorkflowDefinition = {
  format: "pi-deck.agent-workflow",
  schemaVersion: 2,
  id: "semantic-graph",
  revision: 1,
  name: "Semantic graph",
  inputs: [],
  entryNodeId: "prepare",
  nodes: [
    {
      id: "prepare",
      name: "Prepare",
      role: "worker",
      config: { instructions: "Prepare." },
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
      config: { instructions: "Implement." },
    },
    {
      id: "ready",
      name: "Ready?",
      role: "decider",
      managedBy: "iterate",
      config: { question: "Ready?" },
    },
    {
      id: "parallel",
      name: "Parallel review",
      role: "orchestrator",
      config: {
        mode: "fanout",
        agents: ["review", "test"],
        maxConcurrency: 1,
        completion: "any",
      },
    },
    {
      id: "review",
      name: "Review",
      role: "worker",
      managedBy: "parallel",
      config: { instructions: "Review." },
    },
    {
      id: "test",
      name: "Test",
      role: "worker",
      managedBy: "parallel",
      config: { instructions: "Test." },
    },
    {
      id: "approve",
      name: "Approve",
      role: "human",
      config: { interaction: "approval", prompt: "Approve?" },
    },
    {
      id: "decide",
      name: "Ship?",
      role: "decider",
      config: { question: "Ship?", trueLabel: "Ship", falseLabel: "Stop" },
    },
  ],
  relationships: [
    { id: "prepare-iterate", from: "prepare", to: { nodeId: "iterate" } },
    { id: "iterate-parallel", from: "iterate", to: { nodeId: "parallel" } },
    { id: "parallel-approve", from: "parallel", to: { nodeId: "approve" } },
    {
      id: "approve-decide",
      from: "approve",
      when: { equals: true },
      to: { nodeId: "decide" },
    },
    {
      id: "approve-stop",
      from: "approve",
      when: { equals: false },
      to: { end: "rejected" },
    },
    {
      id: "decide-ship",
      from: "decide",
      when: { equals: true },
      to: { end: "completed" },
    },
    {
      id: "decide-stop",
      from: "decide",
      when: { equals: false },
      to: { end: "stopped" },
    },
  ],
};

describe("AgentWorkflowGraph", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const onSelectNode = vi.fn();

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    onSelectNode.mockReset();
  });

  const render = (
    definition = semanticGraphDefinition,
    occurrences?: CanonicalNodeOccurrence[],
  ) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        createElement(AgentWorkflowGraph, {
          definition,
          occurrences,
          selectedNodeId: "prepare",
          onSelectNode,
        }),
      ),
    );
  };

  it("renders semantic loop, fan-out, human, decision routes, and terminals", () => {
    render();
    expect(container!.textContent).toContain("maximum 3 iterations");
    expect(container!.textContent).toContain("completion Decider ready");
    expect(container!.textContent).toContain("2 Workers");
    expect(container!.textContent).toContain("maximum concurrency 1");
    expect(container!.textContent).toContain("completes when any");
    expect(container!.textContent).toContain("Human interaction: approval");
    expect(container!.textContent).toContain("true (Ship)");
    expect(container!.textContent).toContain("false (Stop)");
    expect(
      container!.querySelector('[aria-label="Terminal outcomes"]')?.textContent,
    ).toContain("completed");
    expect(
      container!.querySelector('[aria-label="Managed roles for Iterate"]')
        ?.textContent,
    ).toContain("Implement");
  });

  it("distinguishes in-progress execution from completed execution", () => {
    render(semanticGraphDefinition, [
      {
        id: "00000000-0000-4000-8000-000000000001",
        nodeId: "prepare",
        role: "worker",
        parentOccurrenceIds: [],
        context: [],
        iteration: 1,
        attempt: 1,
        status: "running",
        managedChildren: [],
        aggregation: [],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        nodeId: "iterate",
        role: "orchestrator",
        parentOccurrenceIds: [],
        context: [],
        iteration: 1,
        attempt: 1,
        status: "completed",
        managedChildren: [],
        aggregation: [],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    ]);

    const inProgress = container!.querySelector(
      ".agent-workflow-graph-node.is-in_progress",
    )!;
    const completed = container!.querySelector(
      ".agent-workflow-graph-node.is-completed",
    )!;
    expect(inProgress.getAttribute("aria-label")).toContain("In progress");
    expect(inProgress.textContent).toContain("Status: In progress");
    expect(completed.getAttribute("aria-label")).toContain("Completed");
    expect(completed.textContent).toContain("Status: Completed");
  });

  it("renders duplicate same-endpoint routes independently", () => {
    render({
      ...semanticGraphDefinition,
      relationships: [
        ...semanticGraphDefinition.relationships,
        {
          id: "prepare-iterate-again",
          from: "prepare",
          to: { nodeId: "iterate" },
        },
      ],
    });

    expect(
      container!.querySelectorAll('[aria-label="Routes from Prepare"] li'),
    ).toHaveLength(2);
  });

  it("renders Human choice option labels on their routes", () => {
    render({
      ...semanticGraphDefinition,
      nodes: semanticGraphDefinition.nodes.map((node) =>
        node.id === "approve"
          ? {
              ...node,
              config: {
                interaction: "choice" as const,
                prompt: "Choose a disposition",
                options: ["Ship now", "Request changes"],
              },
            }
          : node,
      ),
      relationships: semanticGraphDefinition.relationships.map(
        (relationship) => {
          if (relationship.id === "approve-decide")
            return { ...relationship, when: { equals: "Ship now" } };
          if (relationship.id === "approve-stop")
            return { ...relationship, when: { equals: "Request changes" } };
          return relationship;
        },
      ),
    });

    const routes = container!.querySelector(
      '[aria-label="Routes from Approve"]',
    );
    expect(routes?.textContent).toContain("Ship now");
    expect(routes?.textContent).toContain("Request changes");
  });

  it("uses native keyboard-selectable buttons to select top-level and managed nodes", () => {
    render();
    const managed = [
      ...container!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Implement")!;
    expect(managed).not.toBeNull();
    act(() => {
      managed.focus();
      managed.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      managed.click();
    });
    expect(document.activeElement).toBe(managed);
    expect(onSelectNode).toHaveBeenCalledWith("implement");
    expect(
      container!
        .querySelector<HTMLButtonElement>("button")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
