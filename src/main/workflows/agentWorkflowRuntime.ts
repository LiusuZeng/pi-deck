import { randomUUID } from "node:crypto";
import {
  agentWorkflowDefinitionSchema,
  workflowRunEnvelopeSchema,
  canonicalNodeOccurrenceSchema,
  type AgentWorkflowDefinition,
  type AgentWorkflowNode,
  type AgentWorkflowRole,
  type WorkflowRunEnvelope,
  type CanonicalNodeOccurrence,
  type WorkflowNodeInputBinding,
} from "../../shared/agentWorkflowSchemas.js";

export { agentWorkflowDefinitionSchema } from "../../shared/agentWorkflowSchemas.js";
export type { AgentWorkflowDefinition } from "../../shared/agentWorkflowSchemas.js";
/** Compatibility alias for callers introduced during the agentWorkflow branch. */
export type WorkflowRoleDefinition = AgentWorkflowDefinition;
/** Canonical persisted run contract lives in shared schemas; these aliases keep the runtime API stable. */
export const workflowOccurrenceSchema = canonicalNodeOccurrenceSchema;
export const workflowRoleRunSchema = workflowRunEnvelopeSchema;
export type WorkflowOccurrence = CanonicalNodeOccurrence;
export type WorkflowRoleRun = WorkflowRunEnvelope;

export function createWorkflowRoleRun(
  definition: AgentWorkflowDefinition,
  workspaceId: string,
  inputs: Record<string, string> = {},
  now = Date.now(),
): WorkflowRoleRun {
  const parsed = agentWorkflowDefinitionSchema.parse(definition);
  for (const item of parsed.nodes) {
    if (item.role !== "human" && item.execution?.timeoutSeconds !== undefined)
      throw new Error(
        "timeoutSeconds is not supported for canonical workflow runs.",
      );
  }
  const inputIds = new Set(parsed.inputs.map((input) => input.id));
  for (const key of Object.keys(inputs))
    if (!inputIds.has(key)) throw new Error(`Unknown workflow input: ${key}`);
  const resolved = Object.fromEntries(
    parsed.inputs
      .map((input) => [input.id, inputs[input.id]])
      .filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  for (const input of parsed.inputs)
    if (input.required && !resolved[input.id]?.trim())
      throw new Error(`Workflow input is required: ${input.id}`);
  const entry = node(parsed, parsed.entryNodeId);
  const run = {
    id: randomUUID(),
    name: parsed.name,
    workspaceId,
    status: "waiting" as const,
    definition: structuredClone(parsed),
    inputs: resolved,
    revision: 1,
    occurrences: [newOccurrence(entry, [], undefined, 1, now)],
    createdAtMs: now,
    updatedAtMs: now,
  };
  return derive(run, now);
}
export function readyWorkflowOccurrences(
  run: WorkflowRoleRun,
): WorkflowOccurrence[] {
  return run.status === "stopped"
    ? []
    : run.occurrences
        .filter((item) => item.status === "ready")
        .map((item) => structuredClone(item));
}
export function startWorkflowOccurrence(
  run: WorkflowRoleRun,
  occurrenceId: string,
  runtimeId: string,
  sessionId?: string,
  now = Date.now(),
  sessionFile?: string,
): WorkflowRoleRun {
  const occurrence = occurrenceOf(run, occurrenceId);
  if (
    !["worker", "decider"].includes(occurrence.role) ||
    !["ready", "queued"].includes(occurrence.status)
  )
    throw new Error(
      "Only ready Worker or Decider occurrences may own Pi sessions.",
    );
  return derive(
    patch(run, occurrenceId, {
      status: "running",
      runtimeId,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionFile ? { sessionFile } : {}),
      startedAtMs: occurrence.startedAtMs ?? now,
      updatedAtMs: now,
    }),
    now,
  );
}
export function startWorkflowOrchestrator(
  run: WorkflowRoleRun,
  occurrenceId: string,
  now = Date.now(),
): WorkflowRoleRun {
  const occurrence = occurrenceOf(run, occurrenceId);
  if (occurrence.role !== "orchestrator" || occurrence.status !== "ready")
    throw new Error("Orchestrator occurrence is not ready.");
  const config = node(run.definition, occurrence.nodeId).config as Extract<
    AgentWorkflowNode,
    { role: "orchestrator" }
  >["config"];
  let next = patch(run, occurrenceId, {
    status: "running",
    startedAtMs: now,
    updatedAtMs: now,
  });
  let children = config.agents.map((id) =>
    newOccurrence(
      node(next.definition, id),
      [occurrence.id],
      occurrence.id,
      1,
      now,
      1,
      managedContext(next, occurrence),
    ),
  );
  if (config.mode === "fanout")
    children = children.map((child, index) =>
      index < config.maxConcurrency
        ? child
        : { ...child, status: "queued" as const },
    );
  next = add(next, children);
  return derive(
    patch(next, occurrenceId, {
      managedChildren: children.map((child) => child.id),
      updatedAtMs: now,
    }),
    now,
  );
}
export function completeWorkflowOccurrence(
  run: WorkflowRoleRun,
  occurrenceId: string,
  value: string | boolean,
  now = Date.now(),
): WorkflowRoleRun {
  const occurrence = occurrenceOf(run, occurrenceId);
  if (occurrence.status !== "running")
    throw new Error("Workflow occurrence is not running.");
  if (occurrence.role === "decider" && typeof value !== "boolean")
    throw new Error("Decider occurrences must return a boolean.");
  if (occurrence.role === "worker" && typeof value !== "string")
    throw new Error("Worker occurrences must return text.");
  let next = patch(clearRuntimeId(run, occurrenceId), occurrenceId, {
    status: "completed",
    output: typeof value === "string" ? bound(value) : value,
    completedAtMs: now,
    updatedAtMs: now,
  });
  next = occurrence.parentOrchestratorRunId
    ? advanceOrchestrator(
        next,
        occurrence.parentOrchestratorRunId,
        occurrenceId,
        now,
      )
    : route(next, occurrenceId, now);
  return derive(next, now);
}
export function answerWorkflowHumanOccurrence(
  run: WorkflowRoleRun,
  occurrenceId: string,
  value: string | boolean,
  now = Date.now(),
): WorkflowRoleRun {
  const occurrence = occurrenceOf(run, occurrenceId);
  const role = node(run.definition, occurrence.nodeId);
  if (
    occurrence.role !== "human" ||
    occurrence.status !== "waitingHuman" ||
    role.role !== "human"
  )
    throw new Error("Human occurrence is not awaiting input.");
  if (role.config.interaction === "input" && typeof value !== "string")
    throw new Error("Human input requires text.");
  if (role.config.interaction === "approval" && typeof value !== "boolean")
    throw new Error("Human approval requires a boolean.");
  if (
    role.config.interaction === "choice" &&
    (typeof value !== "string" || !role.config.options.includes(value))
  )
    throw new Error("Human choice must be a configured option.");
  let next = patch(run, occurrenceId, {
    status: "completed",
    output: typeof value === "string" ? bound(value) : value,
    completedAtMs: now,
    updatedAtMs: now,
  });
  return derive(route(next, occurrenceId, now), now);
}
export function failWorkflowOccurrence(
  run: WorkflowRoleRun,
  occurrenceId: string,
  error: string,
  now = Date.now(),
): WorkflowRoleRun {
  const occurrence = occurrenceOf(run, occurrenceId);
  if (["completed", "cancelled", "skipped"].includes(occurrence.status))
    return run;
  const next = patch(clearRuntimeId(run, occurrenceId), occurrenceId, {
    status: "failed",
    error: bound(error, 4_000),
    updatedAtMs: now,
  });
  return derive(
    occurrence.parentOrchestratorRunId
      ? advanceOrchestrator(
          next,
          occurrence.parentOrchestratorRunId,
          occurrenceId,
          now,
        )
      : next,
    now,
  );
}
export function queueWorkflowOccurrence(
  run: WorkflowRoleRun,
  occurrenceId: string,
  now = Date.now(),
): WorkflowRoleRun {
  const occurrence = occurrenceOf(run, occurrenceId);
  if (occurrence.status !== "ready")
    throw new Error("Only ready occurrences may be queued.");
  return derive(
    patch(run, occurrenceId, { status: "queued", updatedAtMs: now }),
    now,
  );
}
export function retryWorkflowOccurrence(
  run: WorkflowRoleRun,
  occurrenceId: string,
  now = Date.now(),
): WorkflowRoleRun {
  const prior = occurrenceOf(run, occurrenceId);
  if (!["failed", "cancelled"].includes(prior.status))
    throw new Error("Only failed or cancelled occurrences may retry.");
  const workflowNode = node(run.definition, prior.nodeId);
  const maxAttempts =
    workflowNode.role === "human"
      ? undefined
      : workflowNode.execution?.maxAttempts;
  if (maxAttempts !== undefined && prior.attempt >= maxAttempts)
    throw new Error(`Retry budget exhausted after ${maxAttempts} attempts.`);
  let next = add(
    {
      ...run,
      // A retry supersedes the failed attempt; historical output/error remains
      // preserved but no longer participates in terminal derivation.
      occurrences: run.occurrences.map((item) =>
        item.id === prior.id
          ? {
              ...withoutRuntimeId(item),
              status: "skipped" as const,
              updatedAtMs: now,
            }
          : item,
      ),
    },
    [
      newOccurrence(
        node(run.definition, prior.nodeId),
        prior.parentOccurrenceIds,
        prior.parentOrchestratorRunId,
        prior.iteration,
        now,
        prior.attempt + 1,
        [],
        prior.resolvedInputBindings,
      ),
    ],
  );
  if (prior.parentOrchestratorRunId) {
    next = patch(next, prior.parentOrchestratorRunId, {
      status: "running",
      error: undefined,
      completedAtMs: undefined,
      updatedAtMs: now,
    });
  }
  return derive(next, now);
}
export function stopWorkflowRoleRun(
  run: WorkflowRoleRun,
  now = Date.now(),
): WorkflowRoleRun {
  return {
    ...run,
    status: "stopped",
    occurrences: run.occurrences.map((item) =>
      ["ready", "queued", "running", "waitingHuman"].includes(item.status)
        ? {
            ...withoutRuntimeId(item),
            status: "cancelled" as const,
            updatedAtMs: now,
          }
        : item,
    ),
    updatedAtMs: now,
    completedAtMs: now,
  };
}

function advanceOrchestrator(
  run: WorkflowRoleRun,
  orchestratorId: string,
  childId: string,
  now: number,
): WorkflowRoleRun {
  const orchestrator = occurrenceOf(run, orchestratorId);
  // Fan-out `any` deliberately lets already-started siblings finish because the
  // runtime owns no session-cancellation primitive. Their terminal events must
  // not advance an Orchestrator that was completed by an earlier sibling.
  if (orchestrator.status !== "running") return run;
  const config = node(run.definition, orchestrator.nodeId).config as Extract<
    AgentWorkflowNode,
    { role: "orchestrator" }
  >["config"];
  const child = occurrenceOf(run, childId);
  const current = run.occurrences.filter(
    (item) =>
      item.parentOrchestratorRunId === orchestratorId &&
      item.iteration === child.iteration,
  );
  if (
    child.status === "failed" &&
    !(config.mode === "fanout" && config.completion === "any")
  )
    return failWorkflowOccurrence(
      run,
      orchestratorId,
      `Managed ${child.role} failed: ${child.error ?? "unknown error"}`,
      now,
    );
  if (config.mode === "fanout") {
    const done = current.filter(
      (item) => item.role === "worker" && item.status === "completed",
    );
    const allDone = current
      .filter((item) => item.role === "worker")
      .every((item) =>
        ["completed", "failed", "cancelled"].includes(item.status),
      );
    if (config.completion === "any" && allDone && done.length === 0)
      return failWorkflowOccurrence(
        run,
        orchestratorId,
        `No managed Worker completed successfully: ${child.error ?? "all workers stopped"}`,
        now,
      );
    if (
      (config.completion === "any" && done.length) ||
      (config.completion === "all" && allDone)
    ) {
      let next = patch(run, orchestratorId, {
        status: "completed",
        output: done.map((item) => String(item.output ?? "")),
        aggregation: done.map((item) => String(item.output ?? "")),
        completedAtMs: now,
        updatedAtMs: now,
      });
      next = {
        ...next,
        occurrences: next.occurrences.map((item) =>
          item.parentOrchestratorRunId === orchestratorId &&
          ["ready", "queued"].includes(item.status)
            ? { ...item, status: "skipped" as const, updatedAtMs: now }
            : item,
        ),
      };
      return route(next, orchestratorId, now);
    }
    const active = current.filter(
      (item) =>
        item.role === "worker" && ["ready", "running"].includes(item.status),
    ).length;
    if (active < config.maxConcurrency) {
      const queued = current.find(
        (item) => item.role === "worker" && item.status === "queued",
      );
      if (queued)
        return patch(run, queued.id, { status: "ready", updatedAtMs: now });
    }
    return run;
  }
  const workers = current.filter((item) => item.role === "worker");
  if (
    child.role === "worker" &&
    workers.length === config.agents.length &&
    workers.every((item) => item.status === "completed")
  ) {
    const deciderRole = node(run.definition, config.decider);
    const resolvedInputBindings = resolveInputBindings(
      run,
      config.decider,
      bindingScope(orchestratorId, child.iteration),
    );
    const decider = newOccurrence(
      deciderRole,
      uniqueIds([
        ...workers.map((item) => item.id),
        ...bindingSourceOccurrenceIds(resolvedInputBindings),
      ]),
      orchestratorId,
      child.iteration,
      now,
      1,
      [],
      resolvedInputBindings,
    );
    return add(
      patch(run, orchestratorId, {
        managedChildren: [...orchestrator.managedChildren, decider.id],
        aggregation: workers.map((item) => String(item.output ?? "")),
        updatedAtMs: now,
      }),
      [decider],
    );
  }
  if (child.role === "decider") {
    if (child.output === true) {
      let next = patch(run, orchestratorId, {
        status: "completed",
        output: orchestrator.aggregation,
        completedAtMs: now,
        updatedAtMs: now,
      });
      return route(next, orchestratorId, now);
    }
    if (child.iteration >= config.maxIterations)
      return failWorkflowOccurrence(
        run,
        orchestratorId,
        `Loop limit (${config.maxIterations}) reached.`,
        now,
      );
    const workersNext = config.agents.map((id) =>
      newOccurrence(
        node(run.definition, id),
        [child.id],
        orchestratorId,
        child.iteration + 1,
        now,
        1,
        [
          ...orchestrator.aggregation,
          "Decider result: false",
          ...managedContext(run, orchestrator),
        ],
      ),
    );
    return add(
      patch(run, orchestratorId, {
        managedChildren: [
          ...orchestrator.managedChildren,
          ...workersNext.map((item) => item.id),
        ],
        updatedAtMs: now,
      }),
      workersNext,
    );
  }
  return run;
}
function route(
  run: WorkflowRoleRun,
  sourceId: string,
  now: number,
): WorkflowRoleRun {
  const source = occurrenceOf(run, sourceId);
  const outgoing = run.definition.relationships.filter(
    (item) =>
      item.from === source.nodeId &&
      (item.when === undefined || item.when.equals === source.output),
  );
  let next = run;
  for (const relationship of outgoing) {
    if ("nodeId" in relationship.to) {
      const targetId = relationship.to.nodeId;
      // Explicit bindings turn converging relationships into a join.  Do not
      // create a partially-bound child when an earlier branch wins the race:
      // wait until every declared source has completed, then persist the exact
      // values on the one child occurrence.
      const scope = bindingScope(
        source.parentOrchestratorRunId,
        source.iteration,
      );
      if (
        hasExplicitBindings(next, targetId) &&
        (!bindingsAreReady(next, targetId, scope) ||
          next.occurrences.some((item) => item.nodeId === targetId))
      )
        continue;
      const resolvedInputBindings = resolveInputBindings(next, targetId, scope);
      next = add(next, [
        newOccurrence(
          node(next.definition, targetId),
          uniqueIds([
            source.id,
            ...bindingSourceOccurrenceIds(resolvedInputBindings),
          ]),
          undefined,
          1,
          now,
          1,
          [],
          resolvedInputBindings,
        ),
      ]);
    } else {
      // Terminal labels are workflow business outcomes, not failure classifications.
      next = { ...next, terminalOutcome: relationship.to.end };
    }
  }
  return next;
}
function newOccurrence(
  role: AgentWorkflowNode,
  parents: string[],
  parentOrchestratorRunId: string | undefined,
  iteration: number,
  now: number,
  attempt = 1,
  context: string[] = [],
  resolvedInputBindings?: Array<
    WorkflowNodeInputBinding & {
      value: string;
      sourceOccurrenceId?: string | undefined;
    }
  >,
): WorkflowOccurrence {
  return {
    id: randomUUID(),
    nodeId: role.id,
    role: role.role as AgentWorkflowRole,
    ...(parentOrchestratorRunId ? { parentOrchestratorRunId } : {}),
    parentOccurrenceIds: parents,
    context: context.map((value) => bound(value)),
    ...(resolvedInputBindings !== undefined
      ? {
          resolvedInputBindings: resolvedInputBindings.map((binding) => ({
            ...binding,
            value: bound(binding.value),
          })),
        }
      : {}),
    iteration,
    attempt,
    status: role.role === "human" ? "waitingHuman" : "ready",
    managedChildren: [],
    aggregation: [],
    createdAtMs: now,
    updatedAtMs: now,
  };
}
function managedContext(
  run: WorkflowRoleRun,
  orchestrator: WorkflowOccurrence,
): string[] {
  const role = node(run.definition, orchestrator.nodeId);
  if (role.role !== "orchestrator") return [];
  const configured = role.config.input ? [role.config.input] : [];
  const parents = orchestrator.parentOccurrenceIds
    .map((id) => run.occurrences.find((item) => item.id === id)?.output)
    .flatMap((value) =>
      value === undefined ? [] : Array.isArray(value) ? value : [String(value)],
    );
  return [
    ...configured,
    ...(orchestrator.resolvedInputBindings?.map((binding) => binding.value) ??
      []),
    ...parents,
  ];
}

/** Resolve configured handoffs while the source occurrence output is still
 * available. The resulting immutable values are persisted on the child so a
 * retry/restart never depends on process memory or a later graph revision. */
function hasExplicitBindings(run: WorkflowRoleRun, nodeId: string): boolean {
  return node(run.definition, nodeId).inputBindings !== undefined;
}

type BindingScope = Pick<
  WorkflowOccurrence,
  "parentOrchestratorRunId" | "iteration"
>;
type ResolvedInputBinding = WorkflowNodeInputBinding & {
  value: string;
  sourceOccurrenceId?: string | undefined;
};

function bindingScope(
  parentOrchestratorRunId: string | undefined,
  iteration: number,
): BindingScope {
  return {
    ...(parentOrchestratorRunId ? { parentOrchestratorRunId } : {}),
    iteration,
  };
}

function bindingCandidates(
  run: WorkflowRoleRun,
  binding: WorkflowNodeInputBinding,
  scope: BindingScope,
): WorkflowOccurrence[] {
  return run.occurrences
    .filter(
      (occurrence) =>
        occurrence.nodeId === binding.sourceNodeId &&
        occurrence.status === "completed" &&
        occurrence.output !== undefined &&
        occurrence.parentOrchestratorRunId === scope.parentOrchestratorRunId &&
        occurrence.iteration === scope.iteration,
    )
    .sort(
      // Never depend on persisted array order: recovery/import can reorder it.
      (left, right) =>
        right.attempt - left.attempt ||
        (right.completedAtMs ?? 0) - (left.completedAtMs ?? 0) ||
        right.createdAtMs - left.createdAtMs ||
        right.id.localeCompare(left.id),
    );
}

function bindingsAreReady(
  run: WorkflowRoleRun,
  nodeId: string,
  scope: BindingScope,
): boolean {
  return (node(run.definition, nodeId).inputBindings ?? []).every(
    (binding) => bindingCandidates(run, binding, scope).length > 0,
  );
}

function resolveInputBindings(
  run: WorkflowRoleRun,
  nodeId: string,
  scope: BindingScope,
): ResolvedInputBinding[] | undefined {
  const target = node(run.definition, nodeId);
  if (target.inputBindings === undefined) return undefined;
  return target.inputBindings.map((binding) => {
    const source = bindingCandidates(run, binding, scope)[0];
    if (source === undefined || source.output === undefined)
      throw new Error(
        `Workflow input binding is unavailable: ${binding.sourceNodeId} has not completed in this execution lineage.`,
      );
    const value = Array.isArray(source.output)
      ? source.output.join("\n")
      : String(source.output);
    if (!value.trim())
      throw new Error(
        `Workflow input binding is unavailable: ${binding.sourceNodeId} produced no final output.`,
      );
    return { ...binding, value: bound(value), sourceOccurrenceId: source.id };
  });
}

function bindingSourceOccurrenceIds(
  bindings: ResolvedInputBinding[] | undefined,
): string[] {
  return (
    bindings?.flatMap((binding) =>
      binding.sourceOccurrenceId ? [binding.sourceOccurrenceId] : [],
    ) ?? []
  );
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}
function node(
  definition: AgentWorkflowDefinition,
  id: string,
): AgentWorkflowNode {
  const result = definition.nodes.find((item) => item.id === id);
  if (!result) throw new Error(`Unknown workflow node: ${id}`);
  return result;
}
function occurrenceOf(run: WorkflowRoleRun, id: string): WorkflowOccurrence {
  const result = run.occurrences.find((item) => item.id === id);
  if (!result) throw new Error(`Unknown workflow occurrence: ${id}`);
  return result;
}
function clearRuntimeId(run: WorkflowRoleRun, id: string): WorkflowRoleRun {
  return {
    ...run,
    occurrences: run.occurrences.map((item) =>
      item.id === id ? withoutRuntimeId(item) : item,
    ),
  };
}
function withoutRuntimeId(
  occurrence: WorkflowOccurrence,
): Omit<WorkflowOccurrence, "runtimeId"> {
  const { runtimeId: _runtimeId, ...withoutRuntime } = occurrence;
  return withoutRuntime;
}
function patch(
  run: WorkflowRoleRun,
  id: string,
  changes: Partial<WorkflowOccurrence>,
): WorkflowRoleRun {
  return {
    ...run,
    occurrences: run.occurrences.map((item) =>
      item.id === id ? { ...item, ...changes } : item,
    ),
  };
}
function add(
  run: WorkflowRoleRun,
  occurrences: WorkflowOccurrence[],
): WorkflowRoleRun {
  return { ...run, occurrences: [...run.occurrences, ...occurrences] };
}
function bound(value: string, limit = 32_000): string {
  return value.length > limit ? value.slice(0, limit) : value;
}
function isNonFatalFanoutAnyFailure(
  run: WorkflowRoleRun,
  occurrence: WorkflowOccurrence,
): boolean {
  if (!occurrence.parentOrchestratorRunId) return false;
  const orchestrator = run.occurrences.find(
    (item) => item.id === occurrence.parentOrchestratorRunId,
  );
  if (
    orchestrator?.status !== "running" &&
    orchestrator?.status !== "completed"
  )
    return false;
  const role = node(run.definition, orchestrator.nodeId);
  return (
    role.role === "orchestrator" &&
    role.config.mode === "fanout" &&
    role.config.completion === "any"
  );
}
function derive(run: WorkflowRoleRun, now: number): WorkflowRoleRun {
  if (run.status === "stopped") return run;
  if (run.terminalOutcome === "stopped")
    return workflowRoleRunSchema.parse({
      ...run,
      status: "stopped",
      updatedAtMs: now,
      completedAtMs: run.completedAtMs ?? now,
    });
  const status = run.occurrences.some(
    (item) =>
      item.status === "failed" && !isNonFatalFanoutAnyFailure(run, item),
  )
    ? "needsAttention"
    : run.occurrences.some((item) => item.status === "waitingHuman")
      ? "needsAttention"
      : run.occurrences.some((item) =>
            ["ready", "queued", "running"].includes(item.status),
          )
        ? run.occurrences.some((item) => item.status === "running")
          ? "running"
          : "waiting"
        : "completed";
  return workflowRoleRunSchema.parse({
    ...run,
    status,
    updatedAtMs: now,
    ...(status === "completed"
      ? { completedAtMs: run.completedAtMs ?? now }
      : {}),
  });
}
