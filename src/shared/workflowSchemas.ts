import { z } from "zod";

const workflowIdSchema = z.string().uuid();
const workflowStepIdSchema = z.string().min(1).max(120);
const workflowInputIdSchema = z.string().min(1).max(120);

export const workflowModelOverrideSchema = z
  .object({
    provider: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.provider !== undefined || value.modelId !== undefined,
    "A model override must include a provider or model id.",
  );

export const workflowInputDefinitionSchema = z
  .object({
    id: workflowInputIdSchema,
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    type: z.enum(["text", "path"]),
    required: z.boolean(),
    defaultValue: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.required && value.defaultValue !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["defaultValue"],
        message: "Required inputs cannot define a default value.",
      });
    }
  });

export const workflowPromptPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("workflowInput"),
      inputId: workflowInputIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("stepOutput"),
      stepId: workflowStepIdSchema,
      output: z.enum(["finalAnswer", "summary", "transcript"]),
    })
    .strict(),
]);

export const workflowContextSchema = z
  .object({
    objective: z.string().max(4_000).optional(),
    constraints: z.string().max(4_000).optional(),
    relevantPaths: z.array(z.string().min(1)).max(100),
    standards: z.string().max(4_000).optional(),
    doNotDo: z.string().max(4_000).optional(),
  })
  .strict();

export const workflowInputPolicySchema = z
  .object({
    includeWorkflowContext: z.boolean(),
    includeParentFinalAnswer: z.boolean(),
    includeParentSummary: z.boolean(),
    includeParentTranscript: z.boolean(),
  })
  .strict();

export const workflowStepDefinitionSchema = z
  .object({
    id: workflowStepIdSchema,
    name: z.string().trim().min(1).max(120),
    kind: z.literal("agent"),
    promptParts: z.array(workflowPromptPartSchema).min(1).max(200),
    modelOverride: workflowModelOverrideSchema.optional(),
    thinkingOverride: z.string().min(1).optional(),
    inputPolicy: workflowInputPolicySchema,
    startPolicy: z.enum(["auto", "manualApproval"]),
  })
  .strict();

export const workflowRouteTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("step"), stepId: workflowStepIdSchema }).strict(),
  z.object({ kind: z.literal("manualGate") }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
]);

export const workflowAlwaysTransitionSchema = z
  .object({
    id: z.string().min(1).max(120),
    fromStepId: workflowStepIdSchema,
    kind: z.literal("always"),
    toStepId: workflowStepIdSchema,
  })
  .strict();

export const workflowConditionTransitionSchema = z
  .object({
    id: z.string().min(1).max(120),
    fromStepId: workflowStepIdSchema,
    kind: z.literal("condition"),
    question: z.string().trim().min(1).max(2_000),
    routes: z
      .object({
        yes: workflowRouteTargetSchema.optional(),
        no: workflowRouteTargetSchema.optional(),
        unsure: workflowRouteTargetSchema.optional(),
      })
      .strict(),
    previewBeforeStart: z.boolean(),
  })
  .strict();

export const workflowManualGateTransitionSchema = z
  .object({
    id: z.string().min(1).max(120),
    fromStepId: workflowStepIdSchema,
    kind: z.literal("manualGate"),
    toStepId: workflowStepIdSchema,
    prompt: z.string().trim().max(500).optional(),
  })
  .strict();

export const workflowTransitionSchema = z.discriminatedUnion("kind", [
  workflowAlwaysTransitionSchema,
  workflowConditionTransitionSchema,
  workflowManualGateTransitionSchema,
]);

export const workflowTemplateDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500).optional(),
    workspaceId: z.string().min(1).optional(),
    context: workflowContextSchema.optional(),
    defaultModel: workflowModelOverrideSchema.optional(),
    defaultThinkingLevel: z.string().min(1).optional(),
    inputs: z.array(workflowInputDefinitionSchema).max(50),
    steps: z.array(workflowStepDefinitionSchema).min(1).max(100),
    transitions: z.array(workflowTransitionSchema).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const inputIds = new Set<string>();
    for (const [index, input] of value.inputs.entries()) {
      if (inputIds.has(input.id)) {
        context.addIssue({
          code: "custom",
          path: ["inputs", index, "id"],
          message: `Duplicate workflow input id: ${input.id}`,
        });
      }
      inputIds.add(input.id);
    }

    const stepIds = new Set<string>();
    for (const [index, step] of value.steps.entries()) {
      if (stepIds.has(step.id)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `Duplicate workflow step id: ${step.id}`,
        });
      }
      stepIds.add(step.id);
      for (const [partIndex, part] of step.promptParts.entries()) {
        if (part.type === "workflowInput" && !inputIds.has(part.inputId)) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "promptParts", partIndex, "inputId"],
            message: `Unknown workflow input: ${part.inputId}`,
          });
        }
        if (part.type === "stepOutput" && !stepIds.has(part.stepId)) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "promptParts", partIndex, "stepId"],
            message: `Unknown or later workflow step: ${part.stepId}`,
          });
        }
      }
    }

    const checkTarget = (target: WorkflowRouteTarget, path: (string | number)[]) => {
      if (target.kind === "step" && !stepIds.has(target.stepId)) {
        context.addIssue({
          code: "custom",
          path,
          message: `Unknown workflow step target: ${target.stepId}`,
        });
      }
    };

    for (const [index, transition] of value.transitions.entries()) {
      if (!stepIds.has(transition.fromStepId)) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "fromStepId"],
          message: `Unknown workflow step: ${transition.fromStepId}`,
        });
      }
      if (transition.kind === "always" || transition.kind === "manualGate") {
        if (!stepIds.has(transition.toStepId)) {
          context.addIssue({
            code: "custom",
            path: ["transitions", index, "toStepId"],
            message: `Unknown workflow step target: ${transition.toStepId}`,
          });
        }
      } else {
        const routeEntries = [
          ["yes", transition.routes.yes],
          ["no", transition.routes.no],
          ["unsure", transition.routes.unsure],
        ] as const;
        if (routeEntries.every(([, target]) => target === undefined)) {
          context.addIssue({
            code: "custom",
            path: ["transitions", index, "routes"],
            message: "A condition must define at least one route.",
          });
        }
        for (const [label, target] of routeEntries) {
          if (target !== undefined) {
            checkTarget(target, ["transitions", index, "routes", label]);
          }
        }
      }
    }
  });

export const workflowTemplateSchema = workflowTemplateDefinitionSchema.extend({
  id: workflowIdSchema,
  createdAtMs: z.number().finite(),
  updatedAtMs: z.number().finite(),
  archivedAtMs: z.number().finite().optional(),
});

const workflowStepStatusSchema = z.enum([
  "waiting",
  "ready",
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "skipped",
  "blocked",
  "needsApproval",
]);

export const workflowRunStatusSchema = z.enum([
  "waiting",
  "running",
  "needsAttention",
  "completed",
  "failed",
  "stopped",
]);

export const workflowStepRunSchema = z
  .object({
    id: workflowIdSchema,
    templateStepId: workflowStepIdSchema,
    name: z.string().min(1),
    status: workflowStepStatusSchema,
    runtimeId: z.string().min(1).optional(),
    sessionFile: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    renderedPrompt: z.string().optional(),
    finalAnswer: z.string().optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    startedAtMs: z.number().finite().optional(),
    completedAtMs: z.number().finite().optional(),
    updatedAtMs: z.number().finite(),
  })
  .strict();

export const workflowTransitionRunSchema = z
  .object({
    id: workflowIdSchema,
    templateTransitionId: z.string().min(1),
    status: z.enum(["waiting", "evaluating", "resolved", "failed", "skipped"]),
    decision: z.enum(["yes", "no", "unsure"]).optional(),
    rationale: z.string().optional(),
    selectedTarget: workflowRouteTargetSchema.optional(),
    error: z.string().optional(),
    updatedAtMs: z.number().finite(),
  })
  .strict();

export const workflowRunSchema = z
  .object({
    id: workflowIdSchema,
    templateId: workflowIdSchema.optional(),
    name: z.string().min(1),
    workspaceId: z.string().min(1),
    status: workflowRunStatusSchema,
    templateSnapshot: workflowTemplateSchema,
    inputs: z.record(z.string(), z.string()),
    stepRuns: z.array(workflowStepRunSchema),
    transitionRuns: z.array(workflowTransitionRunSchema),
    createdAtMs: z.number().finite(),
    updatedAtMs: z.number().finite(),
    completedAtMs: z.number().finite().optional(),
  })
  .strict();

export const workflowTemplateListResultSchema = z
  .object({ templates: z.array(workflowTemplateSchema) })
  .strict();

export const workflowRunListResultSchema = z
  .object({ runs: z.array(workflowRunSchema) })
  .strict();

export const workflowGetTemplateRequestSchema = z
  .object({ templateId: workflowIdSchema })
  .strict();

export const workflowCreateTemplateRequestSchema = workflowTemplateDefinitionSchema;

export const workflowUpdateTemplateRequestSchema = workflowTemplateDefinitionSchema
  .extend({ templateId: workflowIdSchema })
  .strict();

export const workflowArchiveTemplateRequestSchema = z
  .object({ templateId: workflowIdSchema })
  .strict();

export const workflowDuplicateTemplateRequestSchema =
  workflowArchiveTemplateRequestSchema;

export const workflowListRunsRequestSchema = z
  .object({ workspaceId: z.string().min(1).optional() })
  .strict()
  .optional();

export const workflowGetRunRequestSchema = z
  .object({ runId: workflowIdSchema })
  .strict();

export const workflowStartRunRequestSchema = z
  .object({
    templateId: workflowIdSchema,
    workspaceId: z.string().min(1).optional(),
    inputs: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const workflowStopRunRequestSchema = workflowGetRunRequestSchema;

export const workflowRetryStepRequestSchema = z
  .object({ runId: workflowIdSchema, stepRunId: workflowIdSchema })
  .strict();

export const workflowApproveGateRequestSchema = z
  .object({
    runId: workflowIdSchema,
    stepRunId: workflowIdSchema,
    action: z.enum(["approve", "skip", "stop"]),
  })
  .strict();

export const workflowEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("workflow_run_updated"), runId: workflowIdSchema, status: workflowRunStatusSchema })
    .strict(),
  z
    .object({ type: z.literal("workflow_step_updated"), runId: workflowIdSchema, stepRunId: workflowIdSchema, status: workflowStepStatusSchema })
    .strict(),
  z
    .object({ type: z.literal("workflow_transition_updated"), runId: workflowIdSchema, transitionRunId: workflowIdSchema, status: z.enum(["waiting", "evaluating", "resolved", "failed", "skipped"]) })
    .strict(),
  z
    .object({ type: z.literal("workflow_attention_required"), runId: workflowIdSchema, reason: z.string().min(1) })
    .strict(),
]);

export type WorkflowModelOverride = z.infer<typeof workflowModelOverrideSchema>;
export type WorkflowInputDefinition = z.infer<typeof workflowInputDefinitionSchema>;
export type WorkflowContext = z.infer<typeof workflowContextSchema>;
export type WorkflowPromptPart = z.infer<typeof workflowPromptPartSchema>;
export type WorkflowInputPolicy = z.infer<typeof workflowInputPolicySchema>;
export type WorkflowStepDefinition = z.infer<typeof workflowStepDefinitionSchema>;
export type WorkflowRouteTarget = z.infer<typeof workflowRouteTargetSchema>;
export type WorkflowTransition = z.infer<typeof workflowTransitionSchema>;
export type WorkflowTemplateDefinition = z.infer<typeof workflowTemplateDefinitionSchema>;
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export type WorkflowStepRun = z.infer<typeof workflowStepRunSchema>;
export type WorkflowTransitionRun = z.infer<typeof workflowTransitionRunSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
