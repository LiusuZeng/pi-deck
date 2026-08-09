import { z } from "zod";

/** Canonical document identities and every reference to them are UUIDs. */
const workflowIdSchema = z.string().uuid();
const nodeIdSchema = z.string().uuid();
const relationshipIdSchema = z.string().uuid();

export const agentWorkflowInputSchema = z
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

export const workflowNodeInputBindingSchema = z
  .object({
    sourceNodeId: nodeIdSchema,
    sourceValue: z.literal("finalOutput"),
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const nodeBaseSchema = z.object({
  id: nodeIdSchema,
  name: z.string().trim().min(1).max(160),
  managedBy: nodeIdSchema.optional(),
  /**
   * Optional explicit upstream handoffs. Omission preserves the v2 default:
   * immediate relationship-parent output is supplied by the runtime.
   */
  inputBindings: z.array(workflowNodeInputBindingSchema).max(50).optional(),
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

/** The only node roles supported by the agentWorkflow canonical document. */
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
    inputs: z.array(agentWorkflowInputSchema).max(50),
    entryNodeId: nodeIdSchema,
    nodes: z.array(workflowNodeSchema).min(1).max(100),
    relationships: z.array(relationshipSchema).max(200),
  })
  .strict()
  .superRefine(validateWorkflowGraph);

/** IPC requests retain workspace authorization outside the canonical document. */
const workspaceIdSchema = z.string().min(1).max(120);
export const workflowListRequestSchema = z
  .object({ workspaceId: workspaceIdSchema })
  .strict();
export const workflowCreateRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    workflow: workflowDefinitionSchema,
  })
  .strict();
export const workflowUpdateRequestSchema = workflowCreateRequestSchema;

/** Canonical occurrence-run IPC contracts. Workspace remains outside snapshots. */
export const canonicalWorkflowListRunsRequestSchema = z
  .object({ workspaceId: workspaceIdSchema.optional() })
  .strict()
  .optional();
export const canonicalWorkflowGetRunRequestSchema = z
  .object({ runId: z.string().uuid() })
  .strict();
export const canonicalWorkflowStartRunRequestSchema = z
  .object({
    workflowId: workflowIdSchema,
    workspaceId: workspaceIdSchema,
    inputs: z.record(z.string(), z.string().max(20_000)).default({}),
  })
  .strict();
export const canonicalWorkflowOccurrenceRequestSchema = z
  .object({
    runId: z.string().uuid(),
    occurrenceId: z.string().uuid(),
  })
  .strict();
export const canonicalWorkflowHumanAnswerRequestSchema =
  canonicalWorkflowOccurrenceRequestSchema
    .extend({ value: z.union([z.string().max(32_000), z.boolean()]) })
    .strict();

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
export type WorkflowNodeInputBinding = z.infer<
  typeof workflowNodeInputBindingSchema
>;
/** @deprecated Migration-only record retained to read pre-canonical occurrence data. */
export type WorkflowOccurrence = z.infer<typeof workflowOccurrenceSchema>;
export type NodeOccurrence = z.infer<typeof nodeOccurrenceSchema>;

/** The single persisted envelope for new role workflow executions. */
const boundedRunTextSchema = z.string().max(32_000);
export const resolvedWorkflowNodeInputBindingSchema =
  workflowNodeInputBindingSchema
    .extend({ value: boundedRunTextSchema })
    .strict();
export const canonicalNodeOccurrenceSchema = z
  .object({
    id: z.string().uuid(),
    nodeId: nodeIdSchema,
    role: z.enum(["worker", "decider", "orchestrator", "human"]),
    parentOrchestratorRunId: z.string().uuid().optional(),
    parentOccurrenceIds: z.array(z.string().uuid()).default([]),
    /** Explicit creation-time context. This avoids requiring an in-progress parent's output. */
    context: z.array(boundedRunTextSchema).max(100).default([]),
    /** Immutable values resolved from the node's explicit inputBindings. */
    resolvedInputBindings: z
      .array(resolvedWorkflowNodeInputBindingSchema)
      .max(50)
      .optional(),
    iteration: z.number().int().positive().default(1),
    attempt: z.number().int().positive(),
    status: z.enum([
      "ready",
      "queued",
      "running",
      "waitingHuman",
      "completed",
      "failed",
      "skipped",
      "cancelled",
    ]),
    output: z
      .union([
        boundedRunTextSchema,
        z.boolean(),
        z.array(boundedRunTextSchema).max(100),
      ])
      .optional(),
    sessionId: z.string().min(1).optional(),
    /** Saved Pi identity retained after the runtime is closed for transcript reopening. */
    sessionFile: z.string().min(1).optional(),
    /** Ephemeral live Pi runtime handle; never retained after closure or restart. */
    runtimeId: z.string().min(1).optional(),
    error: z.string().max(4_000).optional(),
    managedChildren: z.array(z.string().uuid()).default([]),
    aggregation: z.array(boundedRunTextSchema).max(100).default([]),
    createdAtMs: z.number().finite(),
    startedAtMs: z.number().finite().optional(),
    completedAtMs: z.number().finite().optional(),
    updatedAtMs: z.number().finite(),
  })
  .strict();
export const workflowRunEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(160),
    workspaceId: workspaceIdSchema,
    status: z.enum([
      "waiting",
      "running",
      "needsAttention",
      "completed",
      "failed",
      "stopped",
    ]),
    definition: workflowDefinitionSchema,
    inputs: z.record(z.string(), z.string().max(20_000)),
    occurrences: z.array(canonicalNodeOccurrenceSchema).max(10_000),
    terminalOutcome: z.string().min(1).max(120).optional(),
    createdAtMs: z.number().finite(),
    updatedAtMs: z.number().finite(),
    completedAtMs: z.number().finite().optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.workspaceId.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["workspaceId"],
        message: "Workspace is required.",
      });
    const nodes = new Map(run.definition.nodes.map((node) => [node.id, node]));
    for (const [index, occurrence] of run.occurrences.entries()) {
      const node = nodes.get(occurrence.nodeId);
      if (!node || node.role !== occurrence.role)
        ctx.addIssue({
          code: "custom",
          path: ["occurrences", index, "nodeId"],
          message: "Occurrence must match a node in its immutable snapshot.",
        });
    }
  });
export type CanonicalNodeOccurrence = z.infer<
  typeof canonicalNodeOccurrenceSchema
>;
export type WorkflowRunEnvelope = z.infer<typeof workflowRunEnvelopeSchema>;
export const canonicalWorkflowEventSchema = z
  .object({
    type: z.literal("workflow_occurrence_run_updated"),
    run: workflowRunEnvelopeSchema,
  })
  .strict();
export type CanonicalWorkflowEvent = z.infer<
  typeof canonicalWorkflowEventSchema
>;

// Names retained for the runtime implementation while the public agentWorkflow contract
// uses the shorter WorkflowDefinition/WorkflowNode names above.
export const agentWorkflowDefinitionSchema = workflowDefinitionSchema;
export type AgentWorkflowDefinition = WorkflowDefinition;
export type AgentWorkflowNode = WorkflowNode;
export type AgentWorkflowRole = WorkflowNode["role"];

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

  for (const [index, node] of value.nodes.entries()) {
    const seenBindings = new Set<string>();
    for (const [bindingIndex, binding] of (
      node.inputBindings ?? []
    ).entries()) {
      const bindingPath = ["nodes", index, "inputBindings", bindingIndex];
      const source = nodes.get(binding.sourceNodeId);
      const key = `${binding.sourceNodeId}\u0000${binding.sourceValue}`;
      if (seenBindings.has(key))
        ctx.addIssue({
          code: "custom",
          path: bindingPath,
          message: `Duplicate input binding: ${binding.sourceNodeId}`,
        });
      seenBindings.add(key);
      if (!source)
        ctx.addIssue({
          code: "custom",
          path: [...bindingPath, "sourceNodeId"],
          message: `Input binding source node does not exist: ${binding.sourceNodeId}`,
        });
      else if (source.id === node.id)
        ctx.addIssue({
          code: "custom",
          path: [...bindingPath, "sourceNodeId"],
          message: "A node cannot use its own output as an input binding.",
        });
      else if (source.managedBy || node.managedBy)
        ctx.addIssue({
          code: "custom",
          path: [...bindingPath, "sourceNodeId"],
          message:
            "Explicit input bindings may only connect top-level nodes; managed nodes use their orchestrator lineage.",
        });
    }
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
  const reaches = (from: string, target: string): boolean => {
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (id === target) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return (edges.get(id) ?? []).some(visit);
    };
    return visit(from);
  };
  value.nodes.forEach((node, index) => {
    for (const [bindingIndex, binding] of (
      node.inputBindings ?? []
    ).entries()) {
      const source = nodes.get(binding.sourceNodeId);
      if (
        source &&
        !source.managedBy &&
        !node.managedBy &&
        !reaches(source.id, node.id)
      )
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "inputBindings", bindingIndex, "sourceNodeId"],
          message: `Input binding source must be upstream of ${node.id}: ${source.id}`,
        });
    }
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
