import { describe, expect, it } from "vitest";
import {
  canonicalNodeOccurrenceSchema,
  workflowDefinitionSchema,
} from "./agentWorkflowSchemas.js";

const ids = {
  workflow: "00000000-0000-4000-8000-000000000001",
  plan: "00000000-0000-4000-8000-000000000002",
  delivery: "00000000-0000-4000-8000-000000000003",
  implement: "00000000-0000-4000-8000-000000000004",
  ready: "00000000-0000-4000-8000-000000000005",
  approval: "00000000-0000-4000-8000-000000000006",
  planDelivery: "00000000-0000-4000-8000-000000000007",
  deliveryApproval: "00000000-0000-4000-8000-000000000008",
  approved: "00000000-0000-4000-8000-000000000009",
  rejected: "00000000-0000-4000-8000-000000000010",
  worker: "00000000-0000-4000-8000-000000000011",
  extra: "00000000-0000-4000-8000-000000000012",
  deliveryPlan: "00000000-0000-4000-8000-000000000013",
  choice: "00000000-0000-4000-8000-000000000014",
  deliveryChoice: "00000000-0000-4000-8000-000000000015",
  go: "00000000-0000-4000-8000-000000000016",
  stop: "00000000-0000-4000-8000-000000000017",
};

const base = () => ({
  format: "pi-deck.agent-workflow" as const,
  schemaVersion: 2 as const,
  id: ids.workflow,
  revision: 1,
  name: "Feature delivery",
  description: "A canonical agent workflow.",
  inputs: [],
  entryNodeId: ids.plan,
  nodes: [
    {
      id: ids.plan,
      name: "Plan",
      role: "worker" as const,
      config: { instructions: "Plan it" },
    },
    {
      id: ids.delivery,
      name: "Delivery",
      role: "orchestrator" as const,
      config: {
        mode: "loop" as const,
        agents: [ids.implement],
        decider: ids.ready,
        maxIterations: 3,
      },
    },
    {
      id: ids.implement,
      name: "Implement",
      role: "worker" as const,
      managedBy: ids.delivery,
      config: { instructions: "Implement it" },
      execution: { thinking: "high" },
    },
    {
      id: ids.ready,
      name: "Ready?",
      role: "decider" as const,
      managedBy: ids.delivery,
      config: { question: "Is it ready?" },
    },
    {
      id: ids.approval,
      name: "Approve",
      role: "human" as const,
      config: { interaction: "approval" as const, prompt: "Approve?" },
    },
  ],
  relationships: [
    { id: ids.planDelivery, from: ids.plan, to: { nodeId: ids.delivery } },
    {
      id: ids.deliveryApproval,
      from: ids.delivery,
      to: { nodeId: ids.approval },
    },
    {
      id: ids.approved,
      from: ids.approval,
      when: { equals: true },
      to: { end: "completed" },
    },
    {
      id: ids.rejected,
      from: ids.approval,
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
        nodeId: ids.worker,
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
  it("rejects non-UUID document identities and node references", () => {
    const cases = [
      { ...base(), id: "workflow-slug" },
      { ...base(), entryNodeId: "plan" },
      {
        ...base(),
        nodes: [{ ...base().nodes[0], id: "plan" }, ...base().nodes.slice(1)],
      },
      {
        ...base(),
        nodes: [
          { ...base().nodes[0], managedBy: "owner" },
          ...base().nodes.slice(1),
        ],
      },
      {
        ...base(),
        nodes: [
          base().nodes[0],
          {
            ...base().nodes[1],
            config: { ...base().nodes[1]!.config, agents: ["worker"] },
          },
          ...base().nodes.slice(2),
        ],
      },
      {
        ...base(),
        nodes: [
          base().nodes[0],
          {
            ...base().nodes[1],
            config: { ...base().nodes[1]!.config, decider: "decider" },
          },
          ...base().nodes.slice(2),
        ],
      },
      {
        ...base(),
        relationships: [
          { ...base().relationships[0], id: "edge" },
          ...base().relationships.slice(1),
        ],
      },
      {
        ...base(),
        relationships: [
          { ...base().relationships[0], from: "plan" },
          ...base().relationships.slice(1),
        ],
      },
      {
        ...base(),
        relationships: [
          { ...base().relationships[0], to: { nodeId: "delivery" } },
          ...base().relationships.slice(1),
        ],
      },
      {
        ...base(),
        nodes: [
          {
            ...base().nodes[0],
            inputBindings: [
              { sourceNodeId: "plan", sourceValue: "finalOutput" },
            ],
          },
          ...base().nodes.slice(1),
        ],
      },
    ];
    for (const definition of cases)
      expect(workflowDefinitionSchema.safeParse(definition).success).toBe(
        false,
      );
  });

  it("accepts ordered explicit bindings from an upstream top-level node", () => {
    const definition = base();
    const approval = definition.nodes.find((node) => node.id === ids.approval);
    if (!approval) throw new Error("fixture");
    approval.inputBindings = [
      {
        sourceNodeId: ids.plan,
        sourceValue: "finalOutput",
        label: "Delivery plan",
      },
    ];
    expect(
      workflowDefinitionSchema
        .parse(definition)
        .nodes.find((node) => node.id === ids.approval)?.inputBindings,
    ).toHaveLength(1);
  });

  it("rejects downstream and managed-node input bindings", () => {
    const definition = base();
    const plan = definition.nodes.find((node) => node.id === ids.plan);
    const implement = definition.nodes.find(
      (node) => node.id === ids.implement,
    );
    if (!plan || !implement) throw new Error("fixture");
    plan.inputBindings = [
      { sourceNodeId: ids.approval, sourceValue: "finalOutput" },
    ];
    implement.inputBindings = [
      { sourceNodeId: ids.plan, sourceValue: "finalOutput" },
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
      config: { mode: "loop", agents: [ids.implement], maxIterations: 0 },
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
      managedBy: ids.plan,
    } as never;
    expect(workflowDefinitionSchema.safeParse(wrongOwner).success).toBe(false);
    const unreachable = base();
    unreachable.nodes.push({
      id: ids.extra,
      name: "Extra",
      role: "worker",
      config: { instructions: "x" },
    } as never);
    expect(workflowDefinitionSchema.safeParse(unreachable).success).toBe(false);
    const cycle = base();
    cycle.relationships[1] = {
      id: ids.deliveryPlan,
      from: ids.delivery,
      to: { nodeId: ids.plan },
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
      id: ids.choice,
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
      {
        id: ids.deliveryChoice,
        from: ids.delivery,
        to: { nodeId: ids.choice },
      },
      {
        id: ids.go,
        from: ids.choice,
        when: { equals: "go" },
        to: { end: "completed" },
      },
      {
        id: ids.stop,
        from: ids.choice,
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
