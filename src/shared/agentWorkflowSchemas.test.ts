import { describe, expect, it } from "vitest";
import {
  canonicalNodeOccurrenceSchema,
  workflowDefinitionSchema,
  workflowRunEnvelopeSchema,
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
  it("validates persisted binding occurrence lineage while accepting legacy snapshots", () => {
    const definition = base();
    const approval = definition.nodes.find((node) => node.id === ids.approval);
    if (!approval) throw new Error("fixture");
    approval.inputBindings = [
      { sourceNodeId: ids.plan, sourceValue: "finalOutput" },
    ];
    const sourceId = "00000000-0000-4000-8000-000000000018";
    const targetId = "00000000-0000-4000-8000-000000000019";
    const run = {
      id: "00000000-0000-4000-8000-000000000020",
      name: definition.name,
      workspaceId: "workspace",
      status: "running" as const,
      definition,
      inputs: {},
      occurrences: [
        {
          id: sourceId,
          nodeId: ids.plan,
          role: "worker" as const,
          parentOccurrenceIds: [],
          context: [],
          iteration: 1,
          attempt: 1,
          status: "completed" as const,
          output: "plan",
          managedChildren: [],
          aggregation: [],
          createdAtMs: 1,
          completedAtMs: 2,
          updatedAtMs: 2,
        },
        {
          id: targetId,
          nodeId: ids.approval,
          role: "human" as const,
          parentOccurrenceIds: [sourceId],
          context: [],
          resolvedInputBindings: [
            {
              sourceNodeId: ids.plan,
              sourceValue: "finalOutput" as const,
              value: "plan",
              sourceOccurrenceId: sourceId,
            },
          ],
          iteration: 1,
          attempt: 1,
          status: "waitingHuman" as const,
          managedChildren: [],
          aggregation: [],
          createdAtMs: 3,
          updatedAtMs: 3,
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 3,
    };
    expect(workflowRunEnvelopeSchema.safeParse(run).success).toBe(true);
    const forged = structuredClone(run);
    forged.occurrences[1]!.resolvedInputBindings![0]!.sourceOccurrenceId =
      "00000000-0000-4000-8000-000000000017";
    expect(workflowRunEnvelopeSchema.safeParse(forged).success).toBe(false);
    delete forged.occurrences[1]!.resolvedInputBindings![0]!.sourceOccurrenceId;
    expect(workflowRunEnvelopeSchema.safeParse(forged).success).toBe(true);
  });

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

  it("rejects downstream and invalid managed-node input bindings", () => {
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
        expect.stringContaining("Managed input bindings require"),
      ]),
    );
  });

  it("accepts a loop decider binding from its own managed worker", () => {
    const definition = base();
    const ready = definition.nodes.find((node) => node.id === ids.ready);
    if (!ready) throw new Error("fixture");
    ready.inputBindings = [
      { sourceNodeId: ids.implement, sourceValue: "finalOutput" },
    ];
    expect(workflowDefinitionSchema.safeParse(definition).success).toBe(true);
  });

  it("rejects non-worker explicit binding sources", () => {
    const definition = base();
    const plan = definition.nodes.find((node) => node.id === ids.plan);
    if (!plan) throw new Error("fixture");
    plan.inputBindings = [
      { sourceNodeId: ids.approval, sourceValue: "finalOutput" },
    ];
    const result = workflowDefinitionSchema.safeParse(definition);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("fixture");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Only Worker finalOutput is supported as an explicit input binding source.",
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
