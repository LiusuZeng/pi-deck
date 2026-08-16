import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../../shared/agentWorkflowSchemas.js";
import {
  agentWorkflowCardViewModel,
  agentWorkflowRoleSummary,
} from "./agentWorkflowViewModels.js";

const workflow: WorkflowDefinition = {
  format: "pi-deck.agent-workflow",
  schemaVersion: 2,
  id: "00000000-0000-4000-8000-000000000601",
  revision: 1,
  name: "Delivery",
  description: "Deliver a reviewed change.",
  inputs: [],
  entryNodeId: "00000000-0000-4000-8000-000000000602",
  nodes: [
    {
      id: "00000000-0000-4000-8000-000000000602",
      name: "Work",
      role: "worker",
      config: { instructions: "Implement", expectedOutput: "A patch" },
    },
    {
      id: "00000000-0000-4000-8000-000000000603",
      name: "Decide",
      role: "decider",
      config: { question: "Ready?" },
    },
    {
      id: "00000000-0000-4000-8000-000000000604",
      name: "Coordinate",
      role: "orchestrator",
      config: {
        mode: "fanout",
        agents: ["00000000-0000-4000-8000-000000000605"],
        maxConcurrency: 1,
        completion: "all",
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000605",
      name: "Verify",
      role: "worker",
      managedBy: "00000000-0000-4000-8000-000000000604",
      config: { instructions: "Verify" },
    },
    {
      id: "00000000-0000-4000-8000-000000000606",
      name: "Approve",
      role: "human",
      config: { interaction: "approval", prompt: "Approve the patch" },
    },
  ],
  relationships: [
    {
      id: "00000000-0000-4000-8000-000000000607",
      from: "00000000-0000-4000-8000-000000000602",
      to: { nodeId: "00000000-0000-4000-8000-000000000603" },
    },
    {
      id: "00000000-0000-4000-8000-000000000608",
      from: "00000000-0000-4000-8000-000000000603",
      when: { equals: true },
      to: { nodeId: "00000000-0000-4000-8000-000000000604" },
    },
    {
      id: "00000000-0000-4000-8000-000000000609",
      from: "00000000-0000-4000-8000-000000000603",
      when: { equals: false },
      to: { nodeId: "00000000-0000-4000-8000-000000000606" },
    },
    {
      id: "00000000-0000-4000-8000-000000000610",
      from: "00000000-0000-4000-8000-000000000604",
      to: { end: "completed" },
    },
    {
      id: "00000000-0000-4000-8000-000000000611",
      from: "00000000-0000-4000-8000-000000000606",
      to: { end: "rejected" },
    },
  ],
};

describe("workflow agentWorkflow view models", () => {
  it("summarizes each of the four roles", () => {
    const summaries = workflow.nodes.map(agentWorkflowRoleSummary);

    expect(summaries[0]).toBe("Produces: A patch");
    expect(summaries[1]).toBe("Decides: Ready?");
    expect(summaries[2]).toContain("Fan-out: 1 managed worker");
    expect(summaries[3]).toBe("Performs a configured task.");
    expect(summaries[4]).toBe("Human approval: Approve the patch");
  });

  it("derives role counts and workflow facts without legacy conversion", () => {
    expect(agentWorkflowCardViewModel(workflow)).toMatchObject({
      id: "00000000-0000-4000-8000-000000000601",
      nodeCount: 5,
      relationshipCount: 5,
      roleCounts: { worker: 2, decider: 1, orchestrator: 1, human: 1 },
    });
  });
});

export { workflow };
