import { z } from "zod";

export const workflowRoles = [
  "worker",
  "decider",
  "orchestrator",
  "human",
] as const;
export type WorkflowRole = (typeof workflowRoles)[number];
export const workflowRoleTemplates: ReadonlyArray<{
  id: WorkflowRole;
  label: string;
}> = [
  { id: "worker", label: "Worker" },
  { id: "decider", label: "Decider" },
  { id: "orchestrator", label: "Orchestrator" },
  { id: "human", label: "Human" },
];
const id = z.string().min(1).max(120);
const execution = z
  .object({
    model: z.string().optional(),
    thinking: z.string().optional(),
    maxAttempts: z.number().int().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).optional(),
  })
  .strict();
const worker = z
  .object({
    id,
    name: z.string().trim().min(1),
    role: z.literal("worker"),
    config: z
      .object({
        instructions: z.string().trim().min(1),
        input: z.string().optional(),
        expectedOutput: z.string().optional(),
      })
      .strict(),
    execution: execution.optional(),
    managedBy: id.optional(),
  })
  .strict();
const decider = z
  .object({
    id,
    name: z.string().trim().min(1),
    role: z.literal("decider"),
    config: z
      .object({
        question: z.string().trim().min(1),
        input: z.string().optional(),
        trueLabel: z.string().optional(),
        falseLabel: z.string().optional(),
      })
      .strict(),
    execution: execution.optional(),
    managedBy: id.optional(),
  })
  .strict();
const orchestrator = z
  .object({
    id,
    name: z.string().trim().min(1),
    role: z.literal("orchestrator"),
    config: z
      .object({
        mode: z.enum(["loop", "fanout"]),
        agents: z.array(id).min(1),
        input: z.string().optional(),
        decider: id.optional(),
        maxIterations: z.number().int().min(1).optional(),
        maxConcurrency: z.number().int().min(1).optional(),
        completion: z.enum(["all", "any"]).optional(),
      })
      .strict(),
    execution: execution.optional(),
  })
  .strict();
const human = z
  .object({
    id,
    name: z.string().trim().min(1),
    role: z.literal("human"),
    config: z
      .object({
        interaction: z.enum(["input", "approval", "choice"]),
        prompt: z.string().trim().min(1),
        input: z.string().optional(),
        options: z.array(z.string().trim().min(1)).optional(),
      })
      .strict(),
    managedBy: id.optional(),
  })
  .strict();
const node = z.discriminatedUnion("role", [
  worker,
  decider,
  orchestrator,
  human,
]);
const relationship = z
  .object({
    id,
    from: id,
    when: z
      .object({ equals: z.union([z.boolean(), z.string()]) })
      .strict()
      .optional(),
    to: z.object({ nodeId: id.optional(), end: id.optional() }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.to.nodeId === undefined) === (value.to.end === undefined))
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message:
          "Relationship target must name exactly one node or terminal outcome.",
      });
  });
export const workflowV2DefinitionSchema = z
  .object({
    format: z.literal("pi-deck.agent-workflow"),
    schemaVersion: z.literal(2),
    id,
    revision: z.number().int().min(1),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    inputs: z.array(
      z
        .object({
          id,
          label: z.string().min(1),
          type: z.enum(["text", "path"]),
          required: z.boolean(),
        })
        .strict(),
    ),
    entryNodeId: id,
    nodes: z.array(node).min(1),
    relationships: z.array(relationship),
  })
  .strict()
  .superRefine((value, ctx) => {
    const nodes = new Map(value.nodes.map((n) => [n.id, n]));
    const managed = new Set(
      value.nodes
        .filter((n) => "managedBy" in n && n.managedBy)
        .map((n) => n.id),
    );
    if (!nodes.has(value.entryNodeId) || managed.has(value.entryNodeId))
      ctx.addIssue({
        code: "custom",
        path: ["entryNodeId"],
        message: "Entry node must be a known unmanaged node.",
      });
    const edges = new Map<string, string[]>();
    for (const [i, edge] of value.relationships.entries()) {
      if (!nodes.has(edge.from) || managed.has(edge.from))
        ctx.addIssue({
          code: "custom",
          path: ["relationships", i, "from"],
          message: "Relationships may originate only from unmanaged nodes.",
        });
      if (
        edge.to.nodeId &&
        (!nodes.has(edge.to.nodeId) || managed.has(edge.to.nodeId))
      )
        ctx.addIssue({
          code: "custom",
          path: ["relationships", i, "to"],
          message: "Relationships may target only unmanaged nodes.",
        });
      if (edge.to.nodeId)
        edges.set(edge.from, [...(edges.get(edge.from) ?? []), edge.to.nodeId]);
    }
    for (const [i, item] of value.nodes.entries())
      if (item.role === "orchestrator") {
        const owned = value.nodes
          .filter((n) => "managedBy" in n && n.managedBy === item.id)
          .map((n) => n.id);
        if (item.config.agents.some((a) => !owned.includes(a)))
          ctx.addIssue({
            code: "custom",
            path: ["nodes", i, "config", "agents"],
            message:
              "Orchestrator agents must be managed by this orchestrator.",
          });
        if (
          item.config.mode === "loop" &&
          (!item.config.decider ||
            !owned.includes(item.config.decider) ||
            !item.config.maxIterations)
        )
          ctx.addIssue({
            code: "custom",
            path: ["nodes", i, "config"],
            message: "Loop requires a managed Decider and maxIterations.",
          });
        if (item.config.mode === "fanout" && !item.config.maxConcurrency)
          ctx.addIssue({
            code: "custom",
            path: ["nodes", i, "config"],
            message: "Fan-out requires maxConcurrency.",
          });
      }
    const seen = new Set<string>();
    const visiting = new Set<string>();
    const walk = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      visiting.add(key);
      const cycle = (edges.get(key) ?? []).some(walk);
      visiting.delete(key);
      return cycle;
    };
    if ([...edges.keys()].some(walk))
      ctx.addIssue({
        code: "custom",
        path: ["relationships"],
        message: "Relationships cannot contain cycles.",
      });
  });
export type WorkflowV2Definition = z.infer<typeof workflowV2DefinitionSchema>;
export type WorkflowV2Node = z.infer<typeof node>;
export function defaultV2Definition(): WorkflowV2Definition {
  return {
    format: "pi-deck.agent-workflow",
    schemaVersion: 2,
    id: "new-workflow",
    revision: 1,
    name: "New agent workflow",
    inputs: [],
    entryNodeId: "worker-1",
    nodes: [
      {
        id: "worker-1",
        name: "Do the work",
        role: "worker",
        config: { instructions: "Describe the work to perform." },
      },
    ],
    relationships: [],
  };
}
export function roleTemplate(role: WorkflowRole) {
  return workflowRoleTemplates.find((item) => item.id === role)!;
}
export function definitionJson(definition: WorkflowV2Definition): string {
  return JSON.stringify(definition, null, 2);
}
export function validateJsonDraft(value: string): {
  definition?: WorkflowV2Definition;
  error?: string;
} {
  try {
    const result = workflowV2DefinitionSchema.safeParse(JSON.parse(value));
    if (result.success) return { definition: result.data };
    const issue = result.error.issues[0];
    return {
      error: `${issue?.path.length ? `/${issue.path.join("/")}: ` : ""}${issue?.message ?? "Invalid workflow definition."}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    const at = /position (\d+)/.exec(message);
    return {
      error: `Invalid JSON${at ? ` near character ${at[1]}` : ""}: ${message}`,
    };
  }
}
export function graphEdges(definition: WorkflowV2Definition) {
  return definition.relationships.map((edge) => ({
    from: edge.from,
    to: edge.to.nodeId,
    label: edge.when ? String(edge.when.equals) : "then",
  }));
}
