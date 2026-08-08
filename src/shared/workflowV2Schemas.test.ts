import { describe, expect, it } from "vitest";
import {
  roleWorkflowDefinitionSchema,
  workflowOccurrenceSchema,
} from "./workflowV2Schemas.js";

const now = 1;
const workflow = {
  id: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
  name: "Investigate",
  inputs: [],
  roles: [
    {
      id: "investigate",
      name: "Investigate",
      kind: "agent" as const,
      promptParts: [{ type: "text" as const, text: "Investigate" }],
      inputPolicy: {
        includeWorkflowContext: false,
        includeParentFinalAnswer: false,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
      startPolicy: "auto" as const,
    },
  ],
  transitions: [],
  createdAtMs: now,
  updatedAtMs: now,
};

describe("v2 role workflow contracts", () => {
  it("uses the same strict graph semantics for role workflows", () => {
    const {
      id: _id,
      createdAtMs: _createdAtMs,
      updatedAtMs: _updatedAtMs,
      ...definition
    } = workflow;
    expect(
      roleWorkflowDefinitionSchema.safeParse({ ...definition, roles: [] })
        .success,
    ).toBe(false);
    expect(
      roleWorkflowDefinitionSchema.safeParse({ ...definition, extra: true })
        .success,
    ).toBe(false);
    expect(roleWorkflowDefinitionSchema.parse(definition).roles[0]?.id).toBe(
      "investigate",
    );
  });

  it("requires a frozen matching workflow snapshot and exactly one occurrence per role", () => {
    const occurrence = {
      id: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1",
      roleWorkflowId: workflow.id,
      name: workflow.name,
      workspaceId: "workspace",
      status: "waiting" as const,
      roleWorkflowSnapshot: workflow,
      inputs: [],
      createdAtMs: now,
      updatedAtMs: now,
      roleOccurrences: [
        {
          id: "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1",
          templateStepId: "investigate",
          name: "Investigate",
          status: "waiting" as const,
          updatedAtMs: now,
        },
      ],
      transitionOccurrences: [],
    };
    // Zod records are objects, not arrays.
    expect(
      workflowOccurrenceSchema.parse({ ...occurrence, inputs: {} }),
    ).toMatchObject({ roleWorkflowId: workflow.id });
    expect(
      workflowOccurrenceSchema.safeParse({
        ...occurrence,
        inputs: {},
        roleWorkflowId: "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
      }).success,
    ).toBe(false);
    expect(
      workflowOccurrenceSchema.safeParse({
        ...occurrence,
        inputs: {},
        roleOccurrences: [],
      }).success,
    ).toBe(false);
    expect(
      workflowOccurrenceSchema.safeParse({
        ...occurrence,
        inputs: {},
        roleOccurrences: [
          ...occurrence.roleOccurrences,
          occurrence.roleOccurrences[0],
        ],
      }).success,
    ).toBe(false);
    expect(
      workflowOccurrenceSchema.safeParse({
        ...occurrence,
        inputs: { unknown: "value" },
      }).success,
    ).toBe(false);
  });
});
