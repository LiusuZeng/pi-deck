import {
  type WorkflowRun,
  type WorkflowTemplate,
  type WorkflowTransition,
} from "../../shared/workflowSchemas.js";
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from "../../shared/workflowV2Schemas.js";

/** Converts old prompt-first templates without retaining a second v1 shape. */
export function migrateV1Template(
  template: WorkflowTemplate,
): WorkflowDefinition {
  const nodes = template.steps.map((step) => ({
    id: step.id,
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
    id: string,
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
      const gateId = `${id}-approval`;
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
        id: `${id}-to-approval`,
        from,
        ...(when === undefined ? {} : { when: { equals: when } }),
        to: { nodeId: gateId },
      });
      relationships.push({
        id: `${id}-approved`,
        from: gateId,
        when: { equals: true },
        to: { nodeId: target.toStepId },
      });
      relationships.push({
        id: `${id}-rejected`,
        from: gateId,
        when: { equals: false },
        to: { end: "rejected" },
      });
    } else
      relationships.push({
        id,
        from,
        ...(when === undefined ? {} : { when: { equals: when } }),
        to:
          target.kind === "step"
            ? { nodeId: target.stepId }
            : { end: "stopped" },
      });
  };
  for (const transition of template.transitions) {
    if (transition.kind === "always")
      route(
        transition.fromStepId,
        { kind: "step", stepId: transition.toStepId },
        transition.id,
      );
    else if (transition.kind === "manualGate")
      route(
        transition.fromStepId,
        { kind: "manualGate", toStepId: transition.toStepId },
        transition.id,
        undefined,
        transition.prompt,
      );
    else {
      const deciderId = `${transition.id}-decider`;
      additions.push({
        id: deciderId,
        name: transition.question,
        role: "decider",
        config: { question: transition.question },
      });
      relationships.push({
        id: `${transition.id}-evaluate`,
        from: transition.fromStepId,
        to: { nodeId: deciderId },
      });
      if (transition.routes.yes)
        route(deciderId, transition.routes.yes, `${transition.id}-true`, true);
      else
        relationships.push({
          id: `${transition.id}-true`,
          from: deciderId,
          when: { equals: true },
          to: { end: "completed" },
        });
      if (transition.routes.no)
        route(deciderId, transition.routes.no, `${transition.id}-false`, false);
      else
        relationships.push({
          id: `${transition.id}-false`,
          from: deciderId,
          when: { equals: false },
          to: { end: "stopped" },
        });
      // v1's third value has no v2 equivalent. It is explicitly normalized
      // to the false route; v2 never fabricates a third decision value.
    }
  }
  const targets = new Set(
    relationships.flatMap((edge) =>
      "nodeId" in edge.to ? [edge.to.nodeId] : [],
    ),
  );
  const first =
    template.steps.find((step) => !targets.has(step.id))?.id ??
    template.steps[0]!.id;
  const approval = template.steps.find(
    (step) => step.id === first && step.startPolicy === "manualApproval",
  );
  if (approval) {
    const gateId = `${approval.id}-start-approval`;
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
      id: `${approval.id}-start-approved`,
      from: gateId,
      when: { equals: true },
      to: { nodeId: approval.id },
    });
    relationships.push({
      id: `${approval.id}-start-rejected`,
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
    entryNodeId: approval ? `${approval.id}-start-approval` : first,
    nodes: allNodes,
    relationships,
  });
}

/** Runs are intentionally not converted: v1's one-step-run model cannot represent v2 occurrences. */
export function preserveLegacyRun(run: WorkflowRun): WorkflowRun {
  return structuredClone(run);
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
