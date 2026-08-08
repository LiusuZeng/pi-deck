import { describe, expect, it } from "vitest";
import { workflowDefinitionSchema } from "./workflowV2Schemas.js";

const base = () => ({
  format: "pi-deck.agent-workflow" as const,
  schemaVersion: 2 as const,
  id: "feature-delivery",
  revision: 1,
  name: "Feature delivery",
  description: "A role based workflow.",
  inputs: [],
  entryNodeId: "plan",
  nodes: [
    {
      id: "plan",
      name: "Plan",
      role: "worker" as const,
      config: { instructions: "Plan it" },
    },
    {
      id: "delivery",
      name: "Delivery",
      role: "orchestrator" as const,
      config: {
        mode: "loop" as const,
        agents: ["implement"],
        decider: "ready",
        maxIterations: 3,
      },
    },
    {
      id: "implement",
      name: "Implement",
      role: "worker" as const,
      managedBy: "delivery",
      config: { instructions: "Implement it" },
      execution: { thinking: "high" },
    },
    {
      id: "ready",
      name: "Ready?",
      role: "decider" as const,
      managedBy: "delivery",
      config: { question: "Is it ready?" },
    },
    {
      id: "approval",
      name: "Approve",
      role: "human" as const,
      config: { interaction: "approval" as const, prompt: "Approve?" },
    },
  ],
  relationships: [
    { id: "plan-delivery", from: "plan", to: { nodeId: "delivery" } },
    { id: "delivery-approval", from: "delivery", to: { nodeId: "approval" } },
    {
      id: "approved",
      from: "approval",
      when: { equals: true },
      to: { end: "completed" },
    },
    {
      id: "rejected",
      from: "approval",
      when: { equals: false },
      to: { end: "rejected" },
    },
  ],
});

describe("v2 workflow contracts", () => {
  it("accepts exactly the four native roles and canonical fields", () => {
    const parsed = workflowDefinitionSchema.parse(base());
    expect(parsed.nodes.map((node) => node.role)).toEqual([
      "worker",
      "orchestrator",
      "worker",
      "decider",
      "human",
    ]);
    expect(
      workflowDefinitionSchema.safeParse({ ...base(), roles: [] }).success,
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({ ...base(), extra: true }).success,
    ).toBe(false);
  });

  it("rejects invalid role-specific config and Human execution", () => {
    const missingInstructions = base();
    missingInstructions.nodes[0] = {
      ...missingInstructions.nodes[0],
      config: {},
    } as never;
    expect(
      workflowDefinitionSchema.safeParse(missingInstructions).success,
    ).toBe(false);
    const wrongLoop = base();
    wrongLoop.nodes[1] = {
      ...wrongLoop.nodes[1],
      config: { mode: "loop", agents: ["implement"], maxIterations: 0 },
    } as never;
    expect(workflowDefinitionSchema.safeParse(wrongLoop).success).toBe(false);
    const humanExecution = base();
    humanExecution.nodes[4] = {
      ...humanExecution.nodes[4],
      execution: { timeoutSeconds: 1 },
    } as never;
    expect(workflowDefinitionSchema.safeParse(humanExecution).success).toBe(
      false,
    );
  });

  it("enforces ownership, reachability, acyclicity and complete boolean routes", () => {
    const wrongOwner = base();
    wrongOwner.nodes[2] = {
      ...wrongOwner.nodes[2],
      managedBy: "plan",
    } as never;
    expect(workflowDefinitionSchema.safeParse(wrongOwner).success).toBe(false);
    const unreachable = base();
    unreachable.nodes.push({
      id: "extra",
      name: "Extra",
      role: "worker",
      config: { instructions: "x" },
    } as never);
    expect(workflowDefinitionSchema.safeParse(unreachable).success).toBe(false);
    const cycle = base();
    cycle.relationships[1] = {
      id: "delivery-plan",
      from: "delivery",
      to: { nodeId: "plan" },
    };
    expect(workflowDefinitionSchema.safeParse(cycle).success).toBe(false);
    const missingFalse = base();
    missingFalse.relationships.pop();
    expect(workflowDefinitionSchema.safeParse(missingFalse).success).toBe(
      false,
    );
  });

  it("validates choice routes against declared unique options", () => {
    const workflow = base();
    workflow.nodes[4] = {
      id: "choice",
      name: "Choose",
      role: "human",
      config: {
        interaction: "choice",
        prompt: "Choose",
        options: ["go", "stop"],
      },
    } as never;
    workflow.relationships.splice(
      1,
      3,
      { id: "delivery-choice", from: "delivery", to: { nodeId: "choice" } },
      {
        id: "go",
        from: "choice",
        when: { equals: "go" },
        to: { end: "completed" },
      },
      {
        id: "stop",
        from: "choice",
        when: { equals: "stop" },
        to: { end: "stopped" },
      },
    );
    expect(workflowDefinitionSchema.safeParse(workflow).success).toBe(true);
    (
      workflow.nodes[4] as { config: { options: string[] } }
    ).config.options.push("go");
    expect(workflowDefinitionSchema.safeParse(workflow).success).toBe(false);
  });
});
