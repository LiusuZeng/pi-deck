import { z } from "zod";

const workflowIdSchema = z.string().min(1).max(120);
const nodeIdSchema = z.string().min(1).max(120);
const relationshipIdSchema = z.string().min(1).max(120);

export const workflowInputV2Schema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().trim().min(1).max(120),
    type: z.enum(["text", "path"]),
    required: z.boolean(),
  })
  .strict();

const executionSchema = z
  .object({
    model: z.string().min(1).optional(),
    thinking: z.string().min(1).optional(),
    maxAttempts: z.number().int().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).optional(),
  })
  .strict();

const nodeBaseSchema = z.object({
  id: nodeIdSchema,
  name: z.string().trim().min(1).max(160),
  managedBy: nodeIdSchema.optional(),
});

export const workerNodeSchema = nodeBaseSchema
  .extend({
    role: z.literal("worker"),
    config: z
      .object({
        instructions: z.string().trim().min(1).max(20_000),
        input: z.string().max(20_000).optional(),
        expectedOutput: z.string().trim().min(1).max(4_000).optional(),
      })
      .strict(),
    execution: executionSchema.optional(),
  })
  .strict();

export const deciderNodeSchema = nodeBaseSchema
  .extend({
    role: z.literal("decider"),
    config: z
      .object({
        question: z.string().trim().min(1).max(4_000),
        input: z.string().max(20_000).optional(),
        trueLabel: z.string().trim().min(1).max(120).optional(),
        falseLabel: z.string().trim().min(1).max(120).optional(),
      })
      .strict(),
    execution: executionSchema.optional(),
  })
  .strict();

export const orchestratorNodeSchema = nodeBaseSchema
  .extend({
    role: z.literal("orchestrator"),
    config: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("loop"),
          agents: z.array(nodeIdSchema).min(1),
          input: z.string().max(20_000).optional(),
          decider: nodeIdSchema,
          maxIterations: z.number().int().finite().min(1),
        })
        .strict(),
      z
        .object({
          mode: z.literal("fanout"),
          agents: z.array(nodeIdSchema).min(1),
          input: z.string().max(20_000).optional(),
          maxConcurrency: z.number().int().finite().min(1),
          completion: z.enum(["all", "any"]).default("all"),
        })
        .strict(),
    ]),
    execution: executionSchema.optional(),
  })
  .strict();

export const humanNodeSchema = nodeBaseSchema
  .extend({
    role: z.literal("human"),
    config: z.discriminatedUnion("interaction", [
      z
        .object({
          interaction: z.literal("input"),
          prompt: z.string().trim().min(1).max(4_000),
          input: z.string().max(20_000).optional(),
        })
        .strict(),
      z
        .object({
          interaction: z.literal("approval"),
          prompt: z.string().trim().min(1).max(4_000),
          input: z.string().max(20_000).optional(),
        })
        .strict(),
      z
        .object({
          interaction: z.literal("choice"),
          prompt: z.string().trim().min(1).max(4_000),
          input: z.string().max(20_000).optional(),
          options: z.array(z.string().trim().min(1).max(120)).min(1),
        })
        .strict(),
    ]),
  })
  .strict();

/** The only node roles supported by the v2 canonical document. */
export const workflowNodeSchema = z.discriminatedUnion("role", [
  workerNodeSchema,
  deciderNodeSchema,
  orchestratorNodeSchema,
  humanNodeSchema,
]);

export const relationshipTargetSchema = z.union([
  z.object({ nodeId: nodeIdSchema }).strict(),
  z.object({ end: z.string().min(1).max(120) }).strict(),
]);

export const relationshipSchema = z
  .object({
    id: relationshipIdSchema,
    from: nodeIdSchema,
    when: z
      .object({ equals: z.union([z.boolean(), z.string().min(1)]) })
      .strict()
      .optional(),
    to: relationshipTargetSchema,
  })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    format: z.literal("pi-deck.agent-workflow"),
    schemaVersion: z.literal(2),
    id: workflowIdSchema,
    revision: z.number().int().min(1),
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4_000).optional(),
    inputs: z.array(workflowInputV2Schema).max(50),
    entryNodeId: nodeIdSchema,
    nodes: z.array(workflowNodeSchema).min(1).max(100),
    relationships: z.array(relationshipSchema).max(200),
  })
  .strict()
  .superRefine(validateWorkflowGraph);

/** A static execution of a node. Repetition creates separate occurrences. */
export const nodeOccurrenceSchema = z.discriminatedUnion("role", [
  z
    .object({
      id: z.string().uuid(),
      nodeId: nodeIdSchema,
      role: z.literal("worker"),
      parentOrchestratorRunId: z.string().uuid().optional(),
      iteration: z.number().int().min(1).optional(),
      attempt: z.number().int().min(1),
      status: z.enum(["waiting", "running", "completed", "failed", "stopped"]),
      output: z.string().optional(),
      sessionId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      nodeId: nodeIdSchema,
      role: z.literal("decider"),
      parentOrchestratorRunId: z.string().uuid().optional(),
      iteration: z.number().int().min(1).optional(),
      attempt: z.number().int().min(1),
      status: z.enum(["waiting", "running", "completed", "failed", "stopped"]),
      output: z.boolean().optional(),
      sessionId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      nodeId: nodeIdSchema,
      role: z.literal("orchestrator"),
      parentOrchestratorRunId: z.string().uuid().optional(),
      iteration: z.number().int().min(1).optional(),
      attempt: z.number().int().min(1),
      status: z.enum(["waiting", "running", "completed", "failed", "stopped"]),
      output: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      nodeId: nodeIdSchema,
      role: z.literal("human"),
      parentOrchestratorRunId: z.string().uuid().optional(),
      iteration: z.number().int().min(1).optional(),
      attempt: z.number().int().min(1),
      status: z.enum(["waiting", "needsInput", "completed", "stopped"]),
      output: z.union([z.string(), z.boolean()]).optional(),
    })
    .strict(),
]);

export const workflowOccurrenceSchema = z
  .object({
    id: z.string().uuid(),
    workflowId: workflowIdSchema,
    workflowSnapshot: workflowDefinitionSchema,
    status: z.enum([
      "waiting",
      "running",
      "needsAttention",
      "completed",
      "failed",
      "stopped",
    ]),
    nodeOccurrences: z.array(nodeOccurrenceSchema),
    createdAtMs: z.number().finite(),
    updatedAtMs: z.number().finite(),
    completedAtMs: z.number().finite().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.workflowId !== value.workflowSnapshot.id)
      ctx.addIssue({
        code: "custom",
        path: ["workflowId"],
        message: "Workflow occurrence workflowId must match its snapshot.",
      });
    const nodes = new Map(
      value.workflowSnapshot.nodes.map((node) => [node.id, node]),
    );
    const ids = new Set<string>();
    value.nodeOccurrences.forEach((occurrence, index) => {
      if (ids.has(occurrence.id))
        ctx.addIssue({
          code: "custom",
          path: ["nodeOccurrences", index, "id"],
          message: "Duplicate node occurrence id.",
        });
      ids.add(occurrence.id);
      const node = nodes.get(occurrence.nodeId);
      if (!node)
        ctx.addIssue({
          code: "custom",
          path: ["nodeOccurrences", index, "nodeId"],
          message: "Unknown node occurrence node.",
        });
      else if (node.role !== occurrence.role)
        ctx.addIssue({
          code: "custom",
          path: ["nodeOccurrences", index, "role"],
          message: "Node occurrence role must match its workflow node.",
        });
    });
  });

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowRelationship = z.infer<typeof relationshipSchema>;
export type WorkflowOccurrence = z.infer<typeof workflowOccurrenceSchema>;
export type NodeOccurrence = z.infer<typeof nodeOccurrenceSchema>;

// Names retained for the runtime implementation while the public v2 contract
// uses the shorter WorkflowDefinition/WorkflowNode names above.
export const workflowV2DefinitionSchema = workflowDefinitionSchema;
export type WorkflowV2Definition = WorkflowDefinition;
export type WorkflowV2Node = WorkflowNode;
export type WorkflowV2Role = WorkflowNode["role"];

function validateWorkflowGraph(
  value: z.infer<typeof workflowDefinitionSchema>,
  ctx: z.RefinementCtx,
): void {
  const inputIds = new Set<string>();
  value.inputs.forEach((input, index) => {
    if (inputIds.has(input.id))
      ctx.addIssue({
        code: "custom",
        path: ["inputs", index, "id"],
        message: `Duplicate workflow input id: ${input.id}`,
      });
    inputIds.add(input.id);
  });
  const nodes = new Map<string, WorkflowNode>();
  value.nodes.forEach((node, index) => {
    if (nodes.has(node.id))
      ctx.addIssue({
        code: "custom",
        path: ["nodes", index, "id"],
        message: `Duplicate node id: ${node.id}`,
      });
    if (
      node.role === "human" &&
      node.config.interaction === "choice" &&
      new Set(node.config.options).size !== node.config.options.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["nodes", index, "config", "options"],
        message: "Human choice option IDs must be unique.",
      });
    nodes.set(node.id, node);
  });
  const entry = nodes.get(value.entryNodeId);
  if (!entry)
    ctx.addIssue({
      code: "custom",
      path: ["entryNodeId"],
      message: "Entry node must exist.",
    });
  else if (entry.managedBy)
    ctx.addIssue({
      code: "custom",
      path: ["entryNodeId"],
      message: "Entry node cannot be managed.",
    });

  const owners = new Map<string, string>();
  for (const [index, node] of value.nodes.entries()) {
    if (node.managedBy) {
      const owner = nodes.get(node.managedBy);
      if (!owner || owner.role !== "orchestrator")
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "managedBy"],
          message: "Managed node owner must be an Orchestrator.",
        });
      else owners.set(node.id, owner.id);
    }
    if (node.role !== "orchestrator") continue;
    const agentIds = node.config.agents;
    if (new Set(agentIds).size !== agentIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["nodes", index, "config", "agents"],
        message: "Orchestrator agents must be unique.",
      });
    for (const agentId of agentIds) {
      const agent = nodes.get(agentId);
      if (!agent || agent.role !== "worker")
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "config", "agents"],
          message: `Managed agent must be a Worker: ${agentId}`,
        });
      else if (agent.managedBy !== node.id)
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "config", "agents"],
          message: `Managed agent ownership disagrees: ${agentId}`,
        });
    }
    if (node.config.mode === "loop") {
      const decider = nodes.get(node.config.decider);
      if (
        !decider ||
        decider.role !== "decider" ||
        decider.managedBy !== node.id
      )
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "config", "decider"],
          message:
            "Loop decider must be a Decider managed by this Orchestrator.",
        });
    }
  }
  for (const [nodeId, ownerId] of owners) {
    const owner = nodes.get(ownerId);
    if (
      owner?.role === "orchestrator" &&
      !owner.config.agents.includes(nodeId) &&
      !(owner.config.mode === "loop" && owner.config.decider === nodeId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["nodes"],
        message: `Managed node is not referenced by its owner: ${nodeId}`,
      });
  }

  const relationshipIds = new Set<string>();
  const edges = new Map<string, string[]>();
  const routes = new Map<string, Set<boolean | string>>();
  value.relationships.forEach((relationship, index) => {
    if (relationshipIds.has(relationship.id))
      ctx.addIssue({
        code: "custom",
        path: ["relationships", index, "id"],
        message: `Duplicate relationship id: ${relationship.id}`,
      });
    relationshipIds.add(relationship.id);
    const from = nodes.get(relationship.from);
    if (!from || from.managedBy)
      ctx.addIssue({
        code: "custom",
        path: ["relationships", index, "from"],
        message: "Relationship source must be an unmanaged node.",
      });
    if ("nodeId" in relationship.to) {
      const to = nodes.get(relationship.to.nodeId);
      if (!to || to.managedBy)
        ctx.addIssue({
          code: "custom",
          path: ["relationships", index, "to", "nodeId"],
          message: "Relationship target must be an unmanaged node.",
        });
      else
        edges.set(relationship.from, [
          ...(edges.get(relationship.from) ?? []),
          relationship.to.nodeId,
        ]);
    }
    if (relationship.when) {
      if (!from || !canCondition(from, relationship.when.equals))
        ctx.addIssue({
          code: "custom",
          path: ["relationships", index, "when"],
          message:
            "Conditional relationships require a matching Decider or Human choice/approval output.",
        });
      else {
        const values = routes.get(from.id) ?? new Set();
        if (values.has(relationship.when.equals))
          ctx.addIssue({
            code: "custom",
            path: ["relationships", index, "when"],
            message: "A conditional output may have only one route.",
          });
        values.add(relationship.when.equals);
        routes.set(from.id, values);
      }
    } else if (from && requiresConditionalRoutes(from))
      ctx.addIssue({
        code: "custom",
        path: ["relationships", index, "when"],
        message:
          "Boolean and choice outputs require conditional relationships.",
      });
  });
  for (const node of value.nodes)
    if (!node.managedBy && requiresConditionalRoutes(node)) {
      const expected =
        node.role === "human" && node.config.interaction === "choice"
          ? node.config.options
          : [true, false];
      const actual = routes.get(node.id) ?? new Set();
      for (const route of expected)
        if (!actual.has(route))
          ctx.addIssue({
            code: "custom",
            path: ["relationships"],
            message: `Missing conditional route for ${node.id}: ${route}`,
          });
    }
  if (entry && !entry.managedBy) {
    const reached = new Set<string>();
    const visit = (id: string): void => {
      if (reached.has(id)) return;
      reached.add(id);
      (edges.get(id) ?? []).forEach(visit);
    };
    visit(entry.id);
    value.nodes
      .filter((node) => !node.managedBy && !reached.has(node.id))
      .forEach((node) =>
        ctx.addIssue({
          code: "custom",
          path: ["nodes"],
          message: `Top-level node is unreachable: ${node.id}`,
        }),
      );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const result = (edges.get(id) ?? []).some(cycle);
    visiting.delete(id);
    visited.add(id);
    return result;
  };
  if (
    value.nodes.filter((node) => !node.managedBy).some((node) => cycle(node.id))
  )
    ctx.addIssue({
      code: "custom",
      path: ["relationships"],
      message: "Top-level relationships must not form cycles.",
    });
}
function requiresConditionalRoutes(node: WorkflowNode): boolean {
  return (
    node.role === "decider" ||
    (node.role === "human" &&
      (node.config.interaction === "approval" ||
        node.config.interaction === "choice"))
  );
}
function canCondition(node: WorkflowNode, value: boolean | string): boolean {
  return (
    (node.role === "decider" && typeof value === "boolean") ||
    (node.role === "human" &&
      node.config.interaction === "approval" &&
      typeof value === "boolean") ||
    (node.role === "human" &&
      node.config.interaction === "choice" &&
      typeof value === "string" &&
      node.config.options.includes(value))
  );
}
