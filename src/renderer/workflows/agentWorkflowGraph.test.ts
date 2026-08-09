import { describe, expect, it } from "vitest";
import type {
  CanonicalNodeOccurrence,
  WorkflowDefinition,
} from "../../shared/agentWorkflowSchemas.js";
import {
  deriveAgentWorkflowGraph,
  layoutAgentWorkflowGraph,
} from "./agentWorkflowGraph.js";

const definition: WorkflowDefinition = {
  format: "pi-deck.agent-workflow",
  schemaVersion: 2,
  id: "00000000-0000-4000-8000-000000000501",
  revision: 1,
  name: "Semantic graph",
  inputs: [],
  entryNodeId: "00000000-0000-4000-8000-000000000502",
  nodes: [
    {
      id: "00000000-0000-4000-8000-000000000502",
      name: "Prepare",
      role: "worker",
      config: { instructions: "Prepare." },
    },
    {
      id: "00000000-0000-4000-8000-000000000503",
      name: "Iterate",
      role: "orchestrator",
      config: {
        mode: "loop",
        agents: ["00000000-0000-4000-8000-000000000504"],
        decider: "00000000-0000-4000-8000-000000000505",
        maxIterations: 3,
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000504",
      name: "Implement",
      role: "worker",
      managedBy: "00000000-0000-4000-8000-000000000503",
      config: { instructions: "Implement." },
    },
    {
      id: "00000000-0000-4000-8000-000000000505",
      name: "Ready?",
      role: "decider",
      managedBy: "00000000-0000-4000-8000-000000000503",
      config: { question: "Ready?" },
    },
    {
      id: "00000000-0000-4000-8000-000000000506",
      name: "Parallel review",
      role: "orchestrator",
      config: {
        mode: "fanout",
        agents: [
          "00000000-0000-4000-8000-000000000507",
          "00000000-0000-4000-8000-000000000508",
        ],
        maxConcurrency: 1,
        completion: "any",
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000507",
      name: "Review",
      role: "worker",
      managedBy: "00000000-0000-4000-8000-000000000506",
      config: { instructions: "Review." },
    },
    {
      id: "00000000-0000-4000-8000-000000000508",
      name: "Test",
      role: "worker",
      managedBy: "00000000-0000-4000-8000-000000000506",
      config: { instructions: "Test." },
    },
    {
      id: "00000000-0000-4000-8000-000000000509",
      name: "Approve",
      role: "human",
      config: { interaction: "approval", prompt: "Approve?" },
    },
    {
      id: "00000000-0000-4000-8000-000000000510",
      name: "Ship?",
      role: "decider",
      config: { question: "Ship?", trueLabel: "Ship", falseLabel: "Stop" },
    },
  ],
  relationships: [
    {
      id: "00000000-0000-4000-8000-000000000511",
      from: "00000000-0000-4000-8000-000000000502",
      to: { nodeId: "00000000-0000-4000-8000-000000000503" },
    },
    {
      id: "00000000-0000-4000-8000-000000000512",
      from: "00000000-0000-4000-8000-000000000503",
      to: { nodeId: "00000000-0000-4000-8000-000000000506" },
    },
    {
      id: "00000000-0000-4000-8000-000000000513",
      from: "00000000-0000-4000-8000-000000000506",
      to: { nodeId: "00000000-0000-4000-8000-000000000509" },
    },
    {
      id: "00000000-0000-4000-8000-000000000514",
      from: "00000000-0000-4000-8000-000000000509",
      when: { equals: true },
      to: { nodeId: "00000000-0000-4000-8000-000000000510" },
    },
    {
      id: "00000000-0000-4000-8000-000000000515",
      from: "00000000-0000-4000-8000-000000000509",
      when: { equals: false },
      to: { end: "rejected" },
    },
    {
      id: "00000000-0000-4000-8000-000000000516",
      from: "00000000-0000-4000-8000-000000000510",
      when: { equals: true },
      to: { end: "completed" },
    },
    {
      id: "00000000-0000-4000-8000-000000000517",
      from: "00000000-0000-4000-8000-000000000510",
      when: { equals: false },
      to: { end: "stopped" },
    },
  ],
};

describe("deriveAgentWorkflowGraph", () => {
  it("derives loop, fan-out, human, decision, and terminal semantics", () => {
    const graph = deriveAgentWorkflowGraph(definition);
    const loop = graph.topLevelNodes.find(
      (node) => node.id === "00000000-0000-4000-8000-000000000503",
    )!;
    const fanout = graph.topLevelNodes.find(
      (node) => node.id === "00000000-0000-4000-8000-000000000506",
    )!;
    expect(loop.detail).toContain("maximum 3 iterations");
    expect(loop.managedNodes.map((node) => node.id)).toEqual([
      "00000000-0000-4000-8000-000000000504",
      "00000000-0000-4000-8000-000000000505",
    ]);
    expect(fanout.detail).toContain("2 Workers");
    expect(fanout.detail).toContain("maximum concurrency 1");
    expect(fanout.detail).toContain("when any");
    expect(
      graph.topLevelNodes.find(
        (node) => node.id === "00000000-0000-4000-8000-000000000509",
      )?.detail,
    ).toBe("Human interaction: approval");
    expect(
      graph.routes
        .filter(
          (route) => route.from === "00000000-0000-4000-8000-000000000510",
        )
        .map((route) => route.label),
    ).toEqual(["true (Ship)", "false (Stop)"]);
    expect(graph.terminalOutcomes).toEqual([
      "rejected",
      "completed",
      "stopped",
    ]);
  });

  it("lays out fan-out children and loop feedback as routed graph edges", () => {
    const graph = layoutAgentWorkflowGraph(definition);
    expect(graph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "00000000-0000-4000-8000-000000000503",
        "00000000-0000-4000-8000-000000000504",
        "00000000-0000-4000-8000-000000000505",
        "00000000-0000-4000-8000-000000000506",
        "00000000-0000-4000-8000-000000000507",
        "00000000-0000-4000-8000-000000000508",
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "00000000-0000-4000-8000-000000000506",
          to: "00000000-0000-4000-8000-000000000507",
          ownership: true,
        }),
        expect.objectContaining({
          from: "00000000-0000-4000-8000-000000000506",
          to: "00000000-0000-4000-8000-000000000508",
          ownership: true,
        }),
        expect.objectContaining({
          from: "00000000-0000-4000-8000-000000000505",
          to: "00000000-0000-4000-8000-000000000503",
          feedback: true,
        }),
      ]),
    );
    expect(graph.edges.every((edge) => edge.points.length >= 2)).toBe(true);
  });

  it("keeps entry routing first and uses document order for disconnected ties", () => {
    expect(
      deriveAgentWorkflowGraph(definition).topLevelNodes.map((node) => node.id),
    ).toEqual([
      "00000000-0000-4000-8000-000000000502",
      "00000000-0000-4000-8000-000000000503",
      "00000000-0000-4000-8000-000000000506",
      "00000000-0000-4000-8000-000000000509",
      "00000000-0000-4000-8000-000000000510",
    ]);
  });

  it("retains relationship IDs for duplicate unconditional same-endpoint routes", () => {
    const graph = deriveAgentWorkflowGraph({
      ...definition,
      relationships: [
        ...definition.relationships,
        {
          id: "00000000-0000-4000-8000-000000000518",
          from: "00000000-0000-4000-8000-000000000502",
          to: { nodeId: "00000000-0000-4000-8000-000000000503" },
        },
      ],
    });

    expect(
      graph.routes
        .filter(
          (route) =>
            route.from === "00000000-0000-4000-8000-000000000502" &&
            route.to === "00000000-0000-4000-8000-000000000503",
        )
        .map((route) => route.id),
    ).toEqual([
      "00000000-0000-4000-8000-000000000511",
      "00000000-0000-4000-8000-000000000518",
    ]);
  });

  it("projects live occurrence status onto every stable definition node", () => {
    const occurrence = {
      id: "00000000-0000-4000-8000-000000000001",
      nodeId: "00000000-0000-4000-8000-000000000502",
      role: "worker",
      parentOccurrenceIds: [],
      context: [],
      iteration: 1,
      attempt: 2,
      status: "running",
      managedChildren: [],
      aggregation: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    } as CanonicalNodeOccurrence;
    const graph = deriveAgentWorkflowGraph(definition, [occurrence]);
    expect(
      graph.topLevelNodes.find(
        (node) => node.id === "00000000-0000-4000-8000-000000000502",
      ),
    ).toMatchObject({
      status: "in_progress",
      retries: 1,
      counts: { in_progress: 1 },
    });
    expect(
      graph.topLevelNodes.find(
        (node) => node.id === "00000000-0000-4000-8000-000000000503",
      ),
    ).toMatchObject({
      status: "not_started",
      occurrenceCount: 0,
    });
    expect(
      graph.routes.find(
        (route) => route.id === "00000000-0000-4000-8000-000000000511",
      )?.status,
    ).toBe("active");
  });

  it("labels Human choice routes with their declared options", () => {
    const graph = deriveAgentWorkflowGraph({
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id === "00000000-0000-4000-8000-000000000509"
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
        if (relationship.id === "00000000-0000-4000-8000-000000000514")
          return {
            ...relationship,
            when: { equals: "Ship now" },
          };
        if (relationship.id === "00000000-0000-4000-8000-000000000515")
          return {
            ...relationship,
            when: { equals: "Request changes" },
          };
        return relationship;
      }),
    });

    expect(
      graph.routes
        .filter(
          (route) => route.from === "00000000-0000-4000-8000-000000000509",
        )
        .map((route) => route.label),
    ).toEqual(["Ship now", "Request changes"]);
  });
});
