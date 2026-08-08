import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../../shared/workflowV2Schemas.js";
import {
  workflowV2CardViewModel,
  workflowV2RoleSummary,
} from "./workflowV2ViewModels.js";

const workflow: WorkflowDefinition = {
  format: "pi-deck.agent-workflow",
  schemaVersion: 2,
  id: "delivery",
  revision: 1,
  name: "Delivery",
  description: "Deliver a reviewed change.",
  inputs: [],
  entryNodeId: "work",
  nodes: [
    {
      id: "work",
      name: "Work",
      role: "worker",
      config: { instructions: "Implement", expectedOutput: "A patch" },
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
      config: { interaction: "approval", prompt: "Approve the patch" },
    },
  ],
  relationships: [
    { id: "work-decide", from: "work", to: { nodeId: "decide" } },
    {
      id: "decide-coordinate",
      from: "decide",
      when: { equals: true },
      to: { nodeId: "coordinate" },
    },
    {
      id: "decide-approve",
      from: "decide",
      when: { equals: false },
      to: { nodeId: "approve" },
    },
    { id: "coordinate-end", from: "coordinate", to: { end: "completed" } },
    { id: "approve-end", from: "approve", to: { end: "rejected" } },
  ],
};

describe("workflow v2 view models", () => {
  it("summarizes each of the four roles", () => {
    const summaries = workflow.nodes.map(workflowV2RoleSummary);

    expect(summaries[0]).toBe("Produces: A patch");
    expect(summaries[1]).toBe("Decides: Ready?");
    expect(summaries[2]).toContain("Fan-out: 1 managed worker");
    expect(summaries[3]).toBe("Performs a configured task.");
    expect(summaries[4]).toBe("Human approval: Approve the patch");
  });

  it("derives role counts and workflow facts without legacy conversion", () => {
    expect(workflowV2CardViewModel(workflow)).toMatchObject({
      id: "delivery",
      nodeCount: 5,
      relationshipCount: 5,
      roleCounts: { worker: 2, decider: 1, orchestrator: 1, human: 1 },
    });
  });
});

export { workflow };
