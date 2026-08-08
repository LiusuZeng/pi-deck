import { z } from "zod";
import {
  workflowRunStatusSchema,
  workflowStepDefinitionSchema,
  workflowStepRunSchema,
  workflowTemplateDefinitionSchema,
  workflowTransitionRunSchema,
  workflowTransitionSchema,
  type WorkflowTemplateDefinition,
} from "./workflowSchemas.js";

/**
 * Version 2 names the reusable participants in a workflow roles and the
 * materialized participants in a run occurrences.  The field shapes remain
 * deliberately compatible with v1 so a persisted run never loses its Pi
 * session identity while being migrated.
 */
const roleWorkflowIdSchema = z.string().uuid();

export const workflowRoleSchema = workflowStepDefinitionSchema;
export const workflowRoleOccurrenceSchema = workflowStepRunSchema;
export const workflowTransitionOccurrenceSchema = workflowTransitionRunSchema;

export const roleWorkflowDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500).optional(),
    workspaceId: z.string().min(1).optional(),
    context: workflowTemplateDefinitionSchema.shape.context,
    defaultModel: workflowTemplateDefinitionSchema.shape.defaultModel,
    defaultThinkingLevel: z.string().min(1).optional(),
    inputs: workflowTemplateDefinitionSchema.shape.inputs,
    roles: z.array(workflowRoleSchema).min(1).max(100),
    transitions: z.array(workflowTransitionSchema).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    // Keep graph semantics in one place. This also makes role workflow
    // validation exactly as strict as the v1 graph while the public names
    // evolve.
    const {
      roles,
      id: _id,
      createdAtMs: _createdAtMs,
      updatedAtMs: _updatedAtMs,
      archivedAtMs: _archivedAtMs,
      ...definition
    } = value as typeof value & {
      id?: unknown;
      createdAtMs?: unknown;
      updatedAtMs?: unknown;
      archivedAtMs?: unknown;
    };
    const result = workflowTemplateDefinitionSchema.safeParse({
      ...definition,
      steps: roles,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({
          ...issue,
          path:
            issue.path[0] === "steps"
              ? ["roles", ...issue.path.slice(1)]
              : issue.path,
        });
      }
    }
  });

export const roleWorkflowSchema = roleWorkflowDefinitionSchema.extend({
  id: roleWorkflowIdSchema,
  createdAtMs: z.number().finite(),
  updatedAtMs: z.number().finite(),
  archivedAtMs: z.number().finite().optional(),
});

export const workflowOccurrenceSchema = z
  .object({
    id: roleWorkflowIdSchema,
    roleWorkflowId: roleWorkflowIdSchema.optional(),
    name: z.string().min(1),
    workspaceId: z.string().min(1),
    status: workflowRunStatusSchema,
    roleWorkflowSnapshot: roleWorkflowSchema,
    inputs: z.record(z.string(), z.string()),
    roleOccurrences: z.array(workflowRoleOccurrenceSchema),
    transitionOccurrences: z.array(workflowTransitionOccurrenceSchema),
    createdAtMs: z.number().finite(),
    updatedAtMs: z.number().finite(),
    completedAtMs: z.number().finite().optional(),
    parentFinalAnswer: z.string().optional(),
    parentSummary: z.string().optional(),
    parentTranscript: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.roleWorkflowId !== undefined &&
      value.roleWorkflowId !== value.roleWorkflowSnapshot.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["roleWorkflowId"],
        message:
          "Workflow occurrence roleWorkflowId must match its role workflow snapshot.",
      });
    }

    // Reuse the same materialization semantics used by v1, including exact
    // one-per-role/transition checks and input validation. Mapping is local
    // and lossless; no data is accepted merely because it has v2 names.
    const roleIds = new Set(
      value.roleWorkflowSnapshot.roles.map((role) => role.id),
    );
    const occurrenceIds = new Set<string>();
    const roleCounts = new Map<string, number>();
    value.roleOccurrences.forEach((occurrence, index) => {
      if (occurrenceIds.has(occurrence.id)) {
        context.addIssue({
          code: "custom",
          path: ["roleOccurrences", index, "id"],
          message: `Duplicate workflow role occurrence id: ${occurrence.id}`,
        });
      }
      occurrenceIds.add(occurrence.id);
      if (!roleIds.has(occurrence.templateStepId)) {
        context.addIssue({
          code: "custom",
          path: ["roleOccurrences", index, "templateStepId"],
          message: `Workflow role occurrence references an unknown role: ${occurrence.templateStepId}`,
        });
      }
      roleCounts.set(
        occurrence.templateStepId,
        (roleCounts.get(occurrence.templateStepId) ?? 0) + 1,
      );
    });
    for (const role of value.roleWorkflowSnapshot.roles) {
      if ((roleCounts.get(role.id) ?? 0) !== 1) {
        context.addIssue({
          code: "custom",
          path: ["roleOccurrences"],
          message: `Workflow occurrence must contain exactly one role occurrence for: ${role.id}`,
        });
      }
    }
    const inputIds = new Set(
      value.roleWorkflowSnapshot.inputs.map((input) => input.id),
    );
    for (const inputId of Object.keys(value.inputs)) {
      if (!inputIds.has(inputId)) {
        context.addIssue({
          code: "custom",
          path: ["inputs", inputId],
          message: `Workflow occurrence contains an unknown input: ${inputId}`,
        });
      }
    }
    const referencedInputIds = new Set(
      value.roleWorkflowSnapshot.roles.flatMap((role) =>
        role.promptParts.flatMap((part) =>
          part.type === "workflowInput" ? [part.inputId] : [],
        ),
      ),
    );
    for (const input of value.roleWorkflowSnapshot.inputs) {
      if (
        (input.required || referencedInputIds.has(input.id)) &&
        !(input.id in value.inputs)
      ) {
        context.addIssue({
          code: "custom",
          path: ["inputs", input.id],
          message: input.required
            ? `Workflow occurrence is missing required input: ${input.id}`
            : `Workflow occurrence is missing referenced input: ${input.id}`,
        });
      }
    }
    const transitionIds = new Set(
      value.roleWorkflowSnapshot.transitions.map((transition) => transition.id),
    );
    const transitionOccurrenceIds = new Set<string>();
    const transitionCounts = new Map<string, number>();
    value.transitionOccurrences.forEach((occurrence, index) => {
      if (transitionOccurrenceIds.has(occurrence.id)) {
        context.addIssue({
          code: "custom",
          path: ["transitionOccurrences", index, "id"],
          message: `Duplicate workflow transition occurrence id: ${occurrence.id}`,
        });
      }
      transitionOccurrenceIds.add(occurrence.id);
      if (!transitionIds.has(occurrence.templateTransitionId)) {
        context.addIssue({
          code: "custom",
          path: ["transitionOccurrences", index, "templateTransitionId"],
          message: `Workflow transition occurrence references an unknown transition: ${occurrence.templateTransitionId}`,
        });
      }
      transitionCounts.set(
        occurrence.templateTransitionId,
        (transitionCounts.get(occurrence.templateTransitionId) ?? 0) + 1,
      );
    });
    for (const transition of value.roleWorkflowSnapshot.transitions) {
      if ((transitionCounts.get(transition.id) ?? 0) !== 1) {
        context.addIssue({
          code: "custom",
          path: ["transitionOccurrences"],
          message: `Workflow occurrence must contain exactly one transition occurrence for: ${transition.id}`,
        });
      }
    }
  });

export type WorkflowRole = z.infer<typeof workflowRoleSchema>;
export type RoleWorkflowDefinition = z.infer<
  typeof roleWorkflowDefinitionSchema
>;
export type RoleWorkflow = z.infer<typeof roleWorkflowSchema>;
export type WorkflowOccurrence = z.infer<typeof workflowOccurrenceSchema>;
