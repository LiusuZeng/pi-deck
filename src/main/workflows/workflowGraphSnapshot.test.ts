import { describe, expect, it } from "vitest";
import type { WorkflowRunEnvelope } from "../../shared/agentWorkflowSchemas.js";
import { deriveWorkflowGraphSnapshot } from "./workflowGraphSnapshot.js";

const run: WorkflowRunEnvelope = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Graph",
  workspaceId: "workspace",
  status: "running",
  revision: 7,
  inputs: {},
  createdAtMs: 1,
  updatedAtMs: 100,
  definition: {
    format: "pi-deck.agent-workflow",
    schemaVersion: 2,
    id: "workflow",
    revision: 1,
    name: "Graph",
    inputs: [],
    entryNodeId: "one",
    nodes: [
      {
        id: "one",
        name: "One",
        role: "worker",
        config: { instructions: "one" },
      },
      {
        id: "two",
        name: "Two",
        role: "worker",
        config: { instructions: "two" },
      },
    ],
    relationships: [{ id: "one-two", from: "one", to: { nodeId: "two" } }],
  },
  occurrences: [
    {
      id: "00000000-0000-4000-8000-000000000011",
      nodeId: "one",
      role: "worker",
      parentOccurrenceIds: [],
      context: [],
      iteration: 1,
      attempt: 1,
      status: "completed",
      output: "x".repeat(600),
      sessionFile: "/safe.session",
      managedChildren: [],
      aggregation: [],
      createdAtMs: 1,
      startedAtMs: 10,
      completedAtMs: 20,
      updatedAtMs: 20,
    },
    {
      id: "00000000-0000-4000-8000-000000000012",
      nodeId: "two",
      role: "worker",
      parentOccurrenceIds: ["00000000-0000-4000-8000-000000000011"],
      context: [],
      iteration: 1,
      attempt: 1,
      status: "running",
      runtimeId: "must-not-leak",
      managedChildren: [],
      aggregation: [],
      createdAtMs: 21,
      startedAtMs: 21,
      updatedAtMs: 21,
    },
  ],
};

describe("deriveWorkflowGraphSnapshot", () => {
  it("is deterministic, bounded, and derives lineage-backed active edges without runtime IDs", () => {
    const snapshot = deriveWorkflowGraphSnapshot(run.definition, run);
    expect(snapshot.revision).toBe(7);
    expect(snapshot.nodes.map((node) => node.aggregateStatus)).toEqual([
      "completed",
      "in_progress",
    ]);
    expect(snapshot.edges).toEqual([
      { relationshipId: "one-two", status: "active" },
    ]);
    expect(snapshot.nodes[0]!.occurrences![0]!.outputSummary).toHaveLength(500);
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
    expect(deriveWorkflowGraphSnapshot(run.definition, run)).toEqual(snapshot);
  });

  it("projects persisted retry budgets and terminal reasons without inventing retry state", () => {
    const exhausted = structuredClone(run);
    exhausted.definition.nodes[0] = {
      ...exhausted.definition.nodes[0]!,
      execution: { maxAttempts: 2 },
    };
    exhausted.occurrences[0] = {
      ...exhausted.occurrences[0]!,
      attempt: 2,
      status: "failed",
      error: "last failure",
    };
    exhausted.terminalOutcome = "failed";
    const snapshot = deriveWorkflowGraphSnapshot(
      exhausted.definition,
      exhausted,
    );
    expect(snapshot.terminalReason).toBe("failed");
    expect(snapshot.nodes[0]!.occurrences![0]!.retry).toEqual({
      maxAttempts: 2,
      retriesRemaining: 0,
      terminalReason: "retry_budget_exhausted",
    });
    expect(snapshot.nodes[0]!.aggregateStatus).toBe("failed");
  });

  it("projects loop and fan-out progress and human attention from occurrences", () => {
    const definition = structuredClone(run.definition);
    definition.entryNodeId = "00000000-0000-4000-8000-000000000021";
    definition.nodes = [
      {
        id: "00000000-0000-4000-8000-000000000021",
        name: "Loop",
        role: "orchestrator",
        config: {
          mode: "loop",
          agents: ["00000000-0000-4000-8000-000000000022"],
          decider: "00000000-0000-4000-8000-000000000023",
          maxIterations: 3,
        },
      },
      {
        id: "00000000-0000-4000-8000-000000000022",
        name: "Work",
        role: "worker",
        config: { instructions: "work" },
      },
      {
        id: "00000000-0000-4000-8000-000000000023",
        name: "Decide",
        role: "decider",
        config: { question: "ready?" },
      },
      {
        id: "00000000-0000-4000-8000-000000000024",
        name: "Fan",
        role: "orchestrator",
        config: {
          mode: "fanout",
          agents: ["00000000-0000-4000-8000-000000000022"],
          maxConcurrency: 1,
          completion: "any",
        },
      },
      {
        id: "00000000-0000-4000-8000-000000000025",
        name: "Human",
        role: "human",
        config: { interaction: "approval", prompt: "approve" },
      },
    ];
    definition.relationships = [
      {
        id: "human-next",
        from: "00000000-0000-4000-8000-000000000025",
        to: { nodeId: "00000000-0000-4000-8000-000000000022" },
      },
    ];
    const projected = {
      ...run,
      definition,
      updatedAtMs: 100,
      occurrences: [
        {
          ...run.occurrences[0]!,
          id: "00000000-0000-4000-8000-000000000031",
          nodeId: "00000000-0000-4000-8000-000000000021",
          role: "orchestrator" as const,
          status: "running" as const,
          iteration: 1,
        },
        {
          ...run.occurrences[0]!,
          id: "00000000-0000-4000-8000-000000000032",
          nodeId: "00000000-0000-4000-8000-000000000022",
          parentOrchestratorRunId: "00000000-0000-4000-8000-000000000031",
          iteration: 2,
          status: "running" as const,
        },
        {
          ...run.occurrences[0]!,
          id: "00000000-0000-4000-8000-000000000033",
          nodeId: "00000000-0000-4000-8000-000000000024",
          role: "orchestrator" as const,
          status: "running" as const,
        },
        {
          ...run.occurrences[0]!,
          id: "00000000-0000-4000-8000-000000000034",
          nodeId: "00000000-0000-4000-8000-000000000022",
          parentOrchestratorRunId: "00000000-0000-4000-8000-000000000033",
          status: "completed" as const,
        },
        {
          ...run.occurrences[0]!,
          id: "00000000-0000-4000-8000-000000000035",
          nodeId: "00000000-0000-4000-8000-000000000025",
          role: "human" as const,
          status: "waitingHuman" as const,
          updatedAtMs: 40,
        },
      ],
    } as WorkflowRunEnvelope;
    const snapshot = deriveWorkflowGraphSnapshot(definition, projected);
    expect(snapshot.nodes[0]!.progress).toEqual({
      loop: { currentIteration: 2, maxIterations: 3, remainingIterations: 1 },
    });
    expect(snapshot.nodes[3]!.progress!.fanout).toMatchObject({
      completion: "any",
      completed: 1,
      policySatisfied: true,
    });
    expect(snapshot.nodes[4]!.attention).toEqual({
      interaction: "approval",
      waitingSinceMs: 40,
      waitingMs: 60,
      downstreamBlocked: true,
    });
  });
});
