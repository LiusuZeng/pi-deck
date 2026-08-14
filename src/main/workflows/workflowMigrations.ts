import {
  type WorkflowRun,
  type WorkflowTemplate,
  type WorkflowTransition,
} from "../../shared/workflowSchemas.js";
import { randomUUID } from "node:crypto";
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowOccurrence,
  type WorkflowRunEnvelope,
} from "../../shared/agentWorkflowSchemas.js";

/** Converts old prompt-first templates without retaining a second v1 shape. */
export function migrateV1Template(
  template: WorkflowTemplate,
): WorkflowDefinition {
  // v1 step and transition IDs were user-facing slugs. They are never valid
  // canonical identities, so allocate opaque IDs before constructing the v2 document.
  const nodeIds = new Map(
    template.steps.map((step) => [step.id, randomUUID()]),
  );
  const nodeId = (id: string): string => {
    const result = nodeIds.get(id);
    if (!result) throw new Error(`Unknown legacy workflow step: ${id}`);
    return result;
  };
  const nodes = template.steps.map((step) => ({
    id: nodeId(step.id),
    name: step.name,
    role: "worker" as const,
    config: { instructions: renderLegacyPrompt(step.promptParts) },
    ...(step.modelOverride || step.thinkingOverride
      ? {
          execution: {
            ...(step.modelOverride?.modelId
              ? { model: step.modelOverride.modelId }
              : {}),
            ...(step.thinkingOverride
              ? { thinking: step.thinkingOverride }
              : {}),
          },
        }
      : {}),
  }));
  const relationships: WorkflowDefinition["relationships"] = [];
  const additions: WorkflowDefinition["nodes"] = [];
  const route = (
    from: string,
    originalTarget:
      | { kind: "step"; stepId: string }
      | { kind: "manualGate"; toStepId: string }
      | { kind: "stop" },
    when?: boolean,
    prompt?: string,
  ): void => {
    // A legacy start approval is a gate immediately before that step, whether
    // the step is the entry point or is reached from another transition.
    const target =
      originalTarget.kind === "step" &&
      template.steps.find((step) => step.id === originalTarget.stepId)
        ?.startPolicy === "manualApproval"
        ? { kind: "manualGate" as const, toStepId: originalTarget.stepId }
        : originalTarget;
    if (target.kind === "manualGate") {
      const gateId = randomUUID();
      additions.push({
        id: gateId,
        name: "Approval",
        role: "human",
        config: {
          interaction: "approval",
          prompt: prompt ?? "Approve continuation of this workflow.",
        },
      });
      relationships.push({
        id: randomUUID(),
        from: nodeId(from),
        ...(when === undefined ? {} : { when: { equals: when } }),
        to: { nodeId: gateId },
      });
      relationships.push({
        id: randomUUID(),
        from: gateId,
        when: { equals: true },
        to: { nodeId: nodeId(target.toStepId) },
      });
      relationships.push({
        id: randomUUID(),
        from: gateId,
        when: { equals: false },
        to: { end: "rejected" },
      });
    } else
      relationships.push({
        id: randomUUID(),
        from: nodeId(from),
        ...(when === undefined ? {} : { when: { equals: when } }),
        to:
          target.kind === "step"
            ? { nodeId: nodeId(target.stepId) }
            : { end: "stopped" },
      });
  };
  for (const transition of template.transitions) {
    if (transition.kind === "always")
      route(transition.fromStepId, {
        kind: "step",
        stepId: transition.toStepId,
      });
    else if (transition.kind === "manualGate")
      route(
        transition.fromStepId,
        { kind: "manualGate", toStepId: transition.toStepId },
        undefined,
        transition.prompt,
      );
    else {
      const deciderId = randomUUID();
      nodeIds.set(deciderId, deciderId);
      additions.push({
        id: deciderId,
        name: transition.question,
        role: "decider",
        config: { question: transition.question },
      });
      relationships.push({
        id: randomUUID(),
        from: nodeId(transition.fromStepId),
        to: { nodeId: deciderId },
      });
      if (transition.routes.yes) route(deciderId, transition.routes.yes, true);
      else
        relationships.push({
          id: randomUUID(),
          from: deciderId,
          when: { equals: true },
          to: { end: "completed" },
        });
      if (transition.routes.no) route(deciderId, transition.routes.no, false);
      else
        relationships.push({
          id: randomUUID(),
          from: deciderId,
          when: { equals: false },
          to: { end: "stopped" },
        });
      // v1's third value has no agentWorkflow equivalent. It is explicitly normalized
      // to the false route; agentWorkflow never fabricates a third decision value.
    }
  }
  const targets = new Set(
    relationships.flatMap((edge) =>
      "nodeId" in edge.to ? [edge.to.nodeId] : [],
    ),
  );
  const first =
    template.steps.find((step) => !targets.has(nodeId(step.id)))?.id ??
    template.steps[0]!.id;
  const approval = template.steps.find(
    (step) => step.id === first && step.startPolicy === "manualApproval",
  );
  if (approval) {
    const gateId = randomUUID();
    additions.push({
      id: gateId,
      name: `Approve ${approval.name}`,
      role: "human",
      config: {
        interaction: "approval",
        prompt: `Approve starting ${approval.name}.`,
      },
    });
    relationships.push({
      id: randomUUID(),
      from: gateId,
      when: { equals: true },
      to: { nodeId: nodeId(approval.id) },
    });
    relationships.push({
      id: randomUUID(),
      from: gateId,
      when: { equals: false },
      to: { end: "rejected" },
    });
  }
  const allNodes = [...nodes, ...additions];
  return workflowDefinitionSchema.parse({
    format: "pi-deck.agent-workflow",
    schemaVersion: 2,
    id: template.id,
    revision: 1,
    name: template.name,
    description: template.description ?? "",
    inputs: template.inputs.map(({ id, label, type, required }) => ({
      id,
      label,
      type,
      required,
    })),
    entryNodeId: approval ? additions[additions.length - 1]!.id : nodeId(first),
    nodes: allNodes,
    relationships,
  });
}

/** Runs are intentionally not converted: v1's one-step-run model cannot represent agentWorkflow occurrences. */
export function preserveLegacyRun(run: WorkflowRun): WorkflowRun {
  return structuredClone(run);
}

/**
 * Replaces the human-readable node identities used by persisted v2 canonical
 * documents. Every snapshot gets its own map: run snapshots are immutable and
 * may not match the workflow currently being edited.
 */
/**
 * The v2 persistence boundary predates UUID node/relationship identities.
 * Its non-identity fields are validated by the canonical parse after remapping.
 */
export type LegacyV2MigrationFile = {
  workflows: WorkflowDefinition[];
  occurrences: WorkflowOccurrence[];
  runs: WorkflowRunEnvelope[];
  workflowScopes: Record<string, string>;
};

export function migrateV2NodeIds(
  file: LegacyV2MigrationFile,
): Pick<
  LegacyV2MigrationFile,
  "workflows" | "occurrences" | "runs" | "workflowScopes"
> {
  // v2's UI generated `workflow-${uuid}` IDs. Keep all definitions and
  // immutable snapshots for one old workflow associated with the same new ID.
  // Crucially, retain the old-node-id mapping too: a run snapshot is immutable,
  // but it must still identify the same configured node after a reload/rename.
  const workflowIds = new Map<string, string>();
  const nodeIdsByWorkflow = new Map<string, Map<string, string>>();
  const workflowId = (id: string): string => {
    let result = workflowIds.get(id);
    if (!result) {
      result = randomUUID();
      workflowIds.set(id, result);
    }
    return result;
  };
  const migrate = (definition: WorkflowDefinition) =>
    migrateDefinition(
      definition,
      workflowId(definition.id),
      nodeIdsByWorkflow.get(definition.id) ?? new Map(),
    );
  return {
    workflows: file.workflows.map((definition) => {
      const migrated = migrate(definition);
      nodeIdsByWorkflow.set(definition.id, migrated.nodeIds);
      return migrated.definition;
    }),
    occurrences: file.occurrences.map((occurrence) => {
      const migrated = migrate(occurrence.workflowSnapshot);
      nodeIdsByWorkflow.set(occurrence.workflowSnapshot.id, migrated.nodeIds);
      return {
        ...occurrence,
        workflowId: workflowId(occurrence.workflowId),
        workflowSnapshot: migrated.definition,
        nodeOccurrences: occurrence.nodeOccurrences.map((nodeOccurrence) => ({
          ...nodeOccurrence,
          nodeId: migrated.nodeIds.get(nodeOccurrence.nodeId)!,
        })),
      };
    }),
    runs: file.runs.map((run) => {
      const migrated = migrate(run.definition);
      nodeIdsByWorkflow.set(run.definition.id, migrated.nodeIds);
      return {
        ...run,
        definition: migrated.definition,
        occurrences: run.occurrences.map((occurrence) => ({
          ...occurrence,
          nodeId: migrated.nodeIds.get(occurrence.nodeId)!,
          ...(occurrence.resolvedInputBindings
            ? {
                resolvedInputBindings: occurrence.resolvedInputBindings.map(
                  (binding) => ({
                    ...binding,
                    sourceNodeId: migrated.nodeIds.get(binding.sourceNodeId)!,
                  }),
                ),
              }
            : {}),
        })),
      };
    }),
    workflowScopes: Object.fromEntries(
      Object.entries(file.workflowScopes).map(([id, scope]) => [
        workflowId(id),
        scope,
      ]),
    ),
  };
}

function migrateDefinition(
  definition: WorkflowDefinition,
  migratedWorkflowId: string,
  nodeIds: Map<string, string>,
): {
  definition: WorkflowDefinition;
  nodeIds: Map<string, string>;
} {
  // A duplicate legacy ID makes every relationship ambiguous. Refuse the
  // atomic migration rather than silently assigning a historical occurrence
  // to an arbitrary node; the store keeps the raw file and backup path.
  if (
    new Set(definition.nodes.map((node) => node.id)).size !==
    definition.nodes.length
  )
    throw new Error(`Ambiguous v2 workflow node IDs: ${definition.id}`);
  for (const legacyId of definition.nodes.map((node) => node.id))
    if (!nodeIds.has(legacyId)) nodeIds.set(legacyId, randomUUID());
  const nodeId = (id: string): string => {
    const result = nodeIds.get(id);
    if (!result) throw new Error(`Unknown v2 workflow node: ${id}`);
    return result;
  };
  return {
    nodeIds,
    definition: workflowDefinitionSchema.parse({
      ...definition,
      id: migratedWorkflowId,
      entryNodeId: nodeId(definition.entryNodeId),
      nodes: definition.nodes.map((node) => ({
        ...node,
        id: nodeId(node.id),
        ...(node.managedBy ? { managedBy: nodeId(node.managedBy) } : {}),
        ...(node.inputBindings
          ? {
              inputBindings: node.inputBindings.map((binding) => ({
                ...binding,
                sourceNodeId: nodeId(binding.sourceNodeId),
              })),
            }
          : {}),
        ...(node.role === "orchestrator"
          ? {
              config: {
                ...node.config,
                agents: node.config.agents.map(nodeId),
                ...(node.config.mode === "loop"
                  ? { decider: nodeId(node.config.decider) }
                  : {}),
              },
            }
          : {}),
      })),
      relationships: definition.relationships.map((relationship) => ({
        ...relationship,
        id: randomUUID(),
        from: nodeId(relationship.from),
        ...("nodeId" in relationship.to
          ? { to: { nodeId: nodeId(relationship.to.nodeId) } }
          : {}),
      })),
    }),
  };
}

function renderLegacyPrompt(
  parts: WorkflowTemplate["steps"][number]["promptParts"],
): string {
  return parts
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "workflowInput"
          ? `{{input:${part.inputId}}}`
          : `{{output:${part.stepId}:${part.output}}}`,
    )
    .join("\n");
}
