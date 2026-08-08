import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Occurrence based runtime for role workflows.  It deliberately lives beside
 * the v1 engine: v1 records use a template step as their execution identity,
 * while a v2 node may execute more than once (fan-out and bounded loops).
 */
const id = z.string().min(1).max(120);
export const workflowRoleNodeSchema = z.discriminatedUnion("role", [
  z.object({ id, name: z.string().min(1), role: z.literal("worker"), prompt: z.string(), modelOverride: z.object({ provider: z.string().optional(), modelId: z.string().optional() }).strict().optional(), thinkingOverride: z.string().optional() }).strict(),
  z.object({ id, name: z.string().min(1), role: z.literal("decider"), question: z.string().min(1), prompt: z.string().optional() }).strict(),
  z.object({ id, name: z.string().min(1), role: z.literal("human"), prompt: z.string().optional() }).strict(),
]);
export const workflowRoleEdgeSchema = z.object({
  id,
  fromNodeId: id,
  toNodeId: id,
  /** Decider decisions or human actions; omitted means worker success. */
  on: z.string().min(1).max(120).optional(),
  /** A loop must declare a finite guard; unguarded cycles are never run. */
  maxIterations: z.number().int().positive().max(100).optional(),
}).strict();
export const workflowRoleDefinitionSchema = z.object({
  version: z.literal(2),
  name: z.string().min(1),
  nodes: z.array(workflowRoleNodeSchema).min(1).max(200),
  edges: z.array(workflowRoleEdgeSchema).max(500),
  inputs: z.record(z.string(), z.string()).default({}),
}).strict().superRefine((value, context) => {
  const nodeIds = new Set<string>();
  for (const [index, node] of value.nodes.entries()) {
    if (nodeIds.has(node.id)) context.addIssue({ code: "custom", path: ["nodes", index, "id"], message: "Duplicate role node id." });
    nodeIds.add(node.id);
  }
  for (const [index, edge] of value.edges.entries()) {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) context.addIssue({ code: "custom", path: ["edges", index], message: "Role edge references an unknown node." });
    if (edge.fromNodeId === edge.toNodeId && edge.maxIterations === undefined) context.addIssue({ code: "custom", path: ["edges", index, "maxIterations"], message: "A self loop requires maxIterations." });
  }
});

export const workflowOccurrenceStatusSchema = z.enum(["ready", "queued", "running", "waitingHuman", "completed", "failed", "skipped"]);
export const workflowOccurrenceSchema = z.object({
  id: z.string().uuid(), nodeId: id, role: z.enum(["worker", "decider", "human"]), status: workflowOccurrenceStatusSchema,
  parentOccurrenceIds: z.array(z.string().uuid()), iteration: z.number().int().nonnegative(), attempt: z.number().int().positive(),
  runtimeId: z.string().optional(), renderedPrompt: z.string().optional(), finalAnswer: z.string().optional(), summary: z.string().optional(), transcript: z.string().optional(), decision: z.string().optional(), rationale: z.string().optional(), error: z.string().optional(),
  createdAtMs: z.number().finite(), startedAtMs: z.number().finite().optional(), completedAtMs: z.number().finite().optional(), updatedAtMs: z.number().finite(),
}).strict();
export const workflowRoleRunSchema = z.object({
  version: z.literal(2), id: z.string().uuid(), name: z.string().min(1), workspaceId: z.string().min(1), status: z.enum(["waiting", "running", "needsAttention", "completed", "failed", "stopped"]), definition: workflowRoleDefinitionSchema, inputs: z.record(z.string(), z.string()), occurrences: z.array(workflowOccurrenceSchema), createdAtMs: z.number().finite(), updatedAtMs: z.number().finite(), completedAtMs: z.number().finite().optional(),
}).strict();
export type WorkflowRoleDefinition = z.infer<typeof workflowRoleDefinitionSchema>;
export type WorkflowRoleNode = z.infer<typeof workflowRoleNodeSchema>;
export type WorkflowOccurrence = z.infer<typeof workflowOccurrenceSchema>;
export type WorkflowRoleRun = z.infer<typeof workflowRoleRunSchema>;

export function createWorkflowRoleRun(definition: WorkflowRoleDefinition, workspaceId: string, inputs: Record<string, string> = {}, now = Date.now()): WorkflowRoleRun {
  const parsed = workflowRoleDefinitionSchema.parse(definition);
  const inbound = new Set(parsed.edges.filter(edge => edge.maxIterations === undefined).map(edge => edge.toNodeId));
  const roots = parsed.nodes.filter(node => !inbound.has(node.id));
  // A graph consisting only of a guarded cycle has no safe spontaneous work.
  if (roots.length === 0) throw new Error("Role workflow needs at least one non-loop root node.");
  const run: WorkflowRoleRun = { version: 2, id: randomUUID(), name: parsed.name, workspaceId, status: "waiting", definition: parsed, inputs: { ...parsed.inputs, ...inputs }, occurrences: roots.map(node => newOccurrence(node, [], 0, now)), createdAtMs: now, updatedAtMs: now };
  return deriveStatus(run, now);
}

export function readyWorkflowOccurrences(run: WorkflowRoleRun): WorkflowOccurrence[] {
  return run.status === "stopped" ? [] : run.occurrences.filter(item => item.status === "ready").map(item => ({ ...item, parentOccurrenceIds: [...item.parentOccurrenceIds] }));
}
export function startWorkflowOccurrence(run: WorkflowRoleRun, occurrenceId: string, runtimeId: string, renderedPrompt: string | undefined, now = Date.now()): WorkflowRoleRun {
  const occurrence = requireOccurrence(run, occurrenceId);
  if (occurrence.status !== "ready" && occurrence.status !== "queued") throw new Error("Workflow occurrence is not ready.");
  if (occurrence.role === "human") throw new Error("Human occurrences do not own a Pi runtime.");
  return deriveStatus(updateOccurrence(run, occurrenceId, { status: "running", runtimeId, ...(renderedPrompt === undefined ? {} : { renderedPrompt }), startedAtMs: occurrence.startedAtMs ?? now, updatedAtMs: now }), now);
}
export function queueWorkflowOccurrence(run: WorkflowRoleRun, occurrenceId: string, now = Date.now()): WorkflowRoleRun {
  requireOccurrence(run, occurrenceId);
  return deriveStatus(updateOccurrence(run, occurrenceId, { status: "queued", updatedAtMs: now }), now);
}
export function completeWorkflowOccurrence(run: WorkflowRoleRun, occurrenceId: string, output: { finalAnswer?: string; summary?: string; transcript?: string; decision?: string; rationale?: string }, now = Date.now()): WorkflowRoleRun {
  const occurrence = requireOccurrence(run, occurrenceId);
  if (occurrence.status !== "running") throw new Error("Workflow occurrence is not running.");
  const node = requireNode(run, occurrence.nodeId);
  if (node.role === "decider" && !["yes", "no", "unsure"].includes(output.decision ?? "")) throw new Error("Decider occurrences must return yes, no, or unsure.");
  let next = updateOccurrence(run, occurrenceId, { status: "completed", ...output, completedAtMs: now, updatedAtMs: now });
  next = emitOutgoing(next, requireOccurrence(next, occurrenceId), node.role === "decider" ? output.decision! : "success", now);
  return deriveStatus(next, now);
}
export function answerWorkflowHumanOccurrence(run: WorkflowRoleRun, occurrenceId: string, action: "approve" | "skip" | "stop", now = Date.now()): WorkflowRoleRun {
  const occurrence = requireOccurrence(run, occurrenceId);
  if (occurrence.role !== "human" || occurrence.status !== "waitingHuman") throw new Error("Workflow occurrence is not awaiting human input.");
  if (action === "stop") return { ...run, status: "stopped", updatedAtMs: now, completedAtMs: now };
  let next = updateOccurrence(run, occurrenceId, { status: action === "approve" ? "completed" : "skipped", decision: action, completedAtMs: now, updatedAtMs: now });
  if (action === "approve") next = emitOutgoing(next, requireOccurrence(next, occurrenceId), action, now);
  return deriveStatus(next, now);
}
export function failWorkflowOccurrence(run: WorkflowRoleRun, occurrenceId: string, error: string, now = Date.now()): WorkflowRoleRun {
  requireOccurrence(run, occurrenceId);
  return deriveStatus(updateOccurrence(run, occurrenceId, { status: "failed", error, updatedAtMs: now }), now);
}

function emitOutgoing(run: WorkflowRoleRun, source: WorkflowOccurrence, outcome: string, now: number): WorkflowRoleRun {
  let next = run;
  for (const edge of run.definition.edges) {
    if (edge.fromNodeId !== source.nodeId || (edge.on ?? "success") !== outcome) continue;
    const iteration = source.iteration + (edge.maxIterations === undefined ? 0 : 1);
    if (edge.maxIterations !== undefined && iteration > edge.maxIterations) {
      next = updateOccurrence(next, source.id, { error: `Loop limit (${edge.maxIterations}) reached on edge ${edge.id}.`, updatedAtMs: now });
      continue;
    }
    const target = requireNode(next, edge.toNodeId);
    const child = newOccurrence(target, [source.id], iteration, now);
    next = { ...next, occurrences: [...next.occurrences, child] };
  }
  return next;
}
function newOccurrence(node: WorkflowRoleNode, parents: string[], iteration: number, now: number): WorkflowOccurrence {
  return { id: randomUUID(), nodeId: node.id, role: node.role, status: node.role === "human" ? "waitingHuman" : "ready", parentOccurrenceIds: parents, iteration, attempt: 1, createdAtMs: now, updatedAtMs: now };
}
function requireOccurrence(run: WorkflowRoleRun, id: string): WorkflowOccurrence { const result = run.occurrences.find(item => item.id === id); if (!result) throw new Error(`Unknown workflow occurrence: ${id}`); return result; }
function requireNode(run: WorkflowRoleRun, id: string): WorkflowRoleNode { const result = run.definition.nodes.find(item => item.id === id); if (!result) throw new Error(`Unknown role node: ${id}`); return result; }
function updateOccurrence(run: WorkflowRoleRun, id: string, patch: Partial<WorkflowOccurrence>): WorkflowRoleRun { return { ...run, occurrences: run.occurrences.map(item => item.id === id ? { ...item, ...patch } : item) } as WorkflowRoleRun; }
function deriveStatus(run: WorkflowRoleRun, now: number): WorkflowRoleRun {
  if (run.status === "stopped") return run;
  if (run.occurrences.some(item => item.status === "failed" || item.error !== undefined)) return workflowRoleRunSchema.parse({ ...run, status: "needsAttention", updatedAtMs: now });
  if (run.occurrences.some(item => item.status === "waitingHuman")) return workflowRoleRunSchema.parse({ ...run, status: "needsAttention", updatedAtMs: now });
  if (run.occurrences.some(item => ["ready", "queued", "running"].includes(item.status))) return workflowRoleRunSchema.parse({ ...run, status: run.occurrences.some(item => item.status === "running") ? "running" : "waiting", updatedAtMs: now });
  return workflowRoleRunSchema.parse({ ...run, status: "completed", completedAtMs: run.completedAtMs ?? now, updatedAtMs: now });
}
