import { describe, expect, it } from "vitest";
import {
  canonicalNodeOccurrenceSchema,
  workflowDefinitionSchema,
} from "./agentWorkflowSchemas.js";

const base = () => ({
  format: "pi-deck.agent-workflow" as const,
  schemaVersion: 2 as const,
  id: "feature-delivery",
  revision: 1,
  name: "Feature delivery",
  description: "A canonical agent workflow.",
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

describe("canonical node occurrence schema", () => {
  it("persists a saved Pi session file for reopening after the runtime exits", () => {
    expect(
      canonicalNodeOccurrenceSchema.parse({
        id: "00000000-0000-4000-8000-000000000001",
        nodeId: "worker",
        role: "worker",
        attempt: 1,
        status: "completed",
        sessionFile: "/tmp/workflow-session.jsonl",
        managedChildren: [],
        aggregation: [],
        createdAtMs: 1,
        updatedAtMs: 1,
      }).sessionFile,
    ).toBe("/tmp/workflow-session.jsonl");
  });
});

describe("agentWorkflow workflow contracts", () => {
  it("accepts ordered explicit bindings from an upstream top-level node", () => {
    const definition = base();
    const approval = definition.nodes.find((node) => node.id === "approval");
    if (!approval) throw new Error("fixture");
    approval.inputBindings = [
      {
        sourceNodeId: "plan",
        sourceValue: "finalOutput",
        label: "Delivery plan",
      },
    ];
    expect(
      workflowDefinitionSchema
        .parse(definition)
        .nodes.find((node) => node.id === "approval")?.inputBindings,
    ).toHaveLength(1);
  });

  it("rejects downstream and managed-node input bindings", () => {
    const definition = base();
    const plan = definition.nodes.find((node) => node.id === "plan");
    const implement = definition.nodes.find((node) => node.id === "implement");
    if (!plan || !implement) throw new Error("fixture");
    plan.inputBindings = [
      { sourceNodeId: "approval", sourceValue: "finalOutput" },
    ];
    implement.inputBindings = [
      { sourceNodeId: "plan", sourceValue: "finalOutput" },
    ];
    const errors = workflowDefinitionSchema.safeParse(definition);
    expect(errors.success).toBe(false);
    if (errors.success) throw new Error("fixture");
    expect(errors.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("upstream"),
        expect.stringContaining("top-level nodes"),
      ]),
    );
  });

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
