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
});
