import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../../shared/agentWorkflowSchemas.js";
import { deriveAgentWorkflowGraph } from "./agentWorkflowGraph.js";

const definition: WorkflowDefinition = {
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

describe("deriveAgentWorkflowGraph", () => {
  it("derives loop, fan-out, human, decision, and terminal semantics", () => {
    const graph = deriveAgentWorkflowGraph(definition);
    const loop = graph.topLevelNodes.find((node) => node.id === "iterate")!;
    const fanout = graph.topLevelNodes.find((node) => node.id === "parallel")!;
    expect(loop.detail).toContain("maximum 3 iterations");
    expect(loop.managedNodes.map((node) => node.id)).toEqual([
      "implement",
      "ready",
    ]);
    expect(fanout.detail).toContain("2 Workers");
    expect(fanout.detail).toContain("maximum concurrency 1");
    expect(fanout.detail).toContain("when any");
    expect(
      graph.topLevelNodes.find((node) => node.id === "approve")?.detail,
    ).toBe("Human interaction: approval");
    expect(
      graph.routes
        .filter((route) => route.from === "decide")
        .map((route) => route.label),
    ).toEqual(["true (Ship)", "false (Stop)"]);
    expect(graph.terminalOutcomes).toEqual([
      "rejected",
      "completed",
      "stopped",
    ]);
  });

  it("keeps entry routing first and uses document order for disconnected ties", () => {
    expect(
      deriveAgentWorkflowGraph(definition).topLevelNodes.map((node) => node.id),
    ).toEqual(["prepare", "iterate", "parallel", "approve", "decide"]);
  });

  it("retains relationship IDs for duplicate unconditional same-endpoint routes", () => {
    const graph = deriveAgentWorkflowGraph({
      ...definition,
      relationships: [
        ...definition.relationships,
        {
          id: "prepare-iterate-again",
          from: "prepare",
          to: { nodeId: "iterate" },
        },
      ],
    });

    expect(
      graph.routes
        .filter((route) => route.from === "prepare" && route.to === "iterate")
        .map((route) => route.id),
    ).toEqual(["prepare-iterate", "prepare-iterate-again"]);
  });

  it("labels Human choice routes with their declared options", () => {
    const graph = deriveAgentWorkflowGraph({
      ...definition,
      nodes: definition.nodes.map((node) =>
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
      relationships: definition.relationships.map((relationship) => {
        if (relationship.id === "approve-decide")
          return {
            ...relationship,
            when: { equals: "Ship now" },
          };
        if (relationship.id === "approve-stop")
          return {
            ...relationship,
            when: { equals: "Request changes" },
          };
        return relationship;
      }),
    });

    expect(
      graph.routes
        .filter((route) => route.from === "approve")
        .map((route) => route.label),
    ).toEqual(["Ship now", "Request changes"]);
  });
});
