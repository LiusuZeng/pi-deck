import { describe, expect, it } from "vitest";
import {
  workflowRunSchema,
  workflowTemplateDefinitionSchema,
} from "./workflowSchemas.js";

const inputPolicy = {
  includeWorkflowContext: true,
  includeParentFinalAnswer: false,
  includeParentSummary: false,
  includeParentTranscript: false,
};

const linearTemplate = {
  name: "Investigate then fix",
  inputs: [
    {
      id: "issue",
      label: "Issue",
      type: "text" as const,
      required: true,
    },
  ],
  steps: [
    {
      id: "investigate",
      name: "Investigate",
      kind: "agent" as const,
      promptParts: [
        { type: "workflowInput" as const, inputId: "issue" },
      ],
      inputPolicy,
      startPolicy: "auto" as const,
    },
    {
      id: "fix",
      name: "Fix",
      kind: "agent" as const,
      promptParts: [
        { type: "stepOutput" as const, stepId: "investigate", output: "finalAnswer" as const },
      ],
      inputPolicy: { ...inputPolicy, includeParentFinalAnswer: true },
      startPolicy: "auto" as const,
    },
  ],
  transitions: [
    {
      id: "investigate-to-fix",
      fromStepId: "investigate",
      kind: "always" as const,
      toStepId: "fix",
    },
  ],
};

describe("workflowTemplateDefinitionSchema", () => {
  it("accepts a reusable linear workflow with input and output references", () => {
    expect(workflowTemplateDefinitionSchema.parse(linearTemplate)).toEqual(
      linearTemplate,
    );
  });

  it("rejects a blank workflow with no agent steps", () => {
    const result = workflowTemplateDefinitionSchema.safeParse({
      ...linearTemplate,
      steps: [],
      transitions: [],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.join(".") === "steps")).toBe(true);
  });

  it("rejects dangling steps and input references", () => {
    const result = workflowTemplateDefinitionSchema.safeParse({
      ...linearTemplate,
      steps: [
        {
          ...linearTemplate.steps[0],
          promptParts: [{ type: "workflowInput", inputId: "missing" }],
        },
      ],
      transitions: [
        {
          id: "bad",
          fromStepId: "investigate",
          kind: "always",
          toStepId: "missing",
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "Unknown workflow input: missing",
        "Unknown workflow step target: missing",
      ]),
    );
  });

  it("rejects unsupported condition manual gates", () => {
    const result = workflowTemplateDefinitionSchema.safeParse({
      ...linearTemplate,
      transitions: [
        {
          id: "condition",
          fromStepId: "investigate",
          kind: "condition",
          question: "Need approval?",
          routes: { yes: { kind: "manualGate" } },
          previewBeforeStart: false,
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Condition manual gates are unsupported; use a manualGate transition to an approval step.",
    );
  });

  it("rejects duplicate transitions, fan-in, cycles, and graphs without a root", () => {
    const fanIn = workflowTemplateDefinitionSchema.safeParse({
      ...linearTemplate,
      steps: [
        ...linearTemplate.steps,
        { ...linearTemplate.steps[0], id: "other", name: "Other" },
      ],
      transitions: [
        { id: "one", fromStepId: "investigate", kind: "always", toStepId: "fix" },
        { id: "two", fromStepId: "other", kind: "always", toStepId: "fix" },
      ],
    });
    expect(fanIn.success).toBe(false);
    if (fanIn.success) return;
    expect(fanIn.error.issues.map((issue) => issue.message)).toContain(
      "Workflow step has unsupported fan-in: fix",
    );

    const cyclic = workflowTemplateDefinitionSchema.safeParse({
      ...linearTemplate,
      transitions: [
        { id: "one", fromStepId: "investigate", kind: "always", toStepId: "fix" },
        { id: "two", fromStepId: "fix", kind: "always", toStepId: "investigate" },
      ],
    });
    expect(cyclic.success).toBe(false);
    if (cyclic.success) return;
    expect(cyclic.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "Workflow must have at least one root step.",
        "Workflow transitions must form an acyclic graph.",
      ]),
    );

    const duplicate = workflowTemplateDefinitionSchema.safeParse({
      ...linearTemplate,
      transitions: [
        { id: "same", fromStepId: "investigate", kind: "always", toStepId: "fix" },
        { id: "same", fromStepId: "investigate", kind: "always", toStepId: "fix" },
      ],
    });
    expect(duplicate.success).toBe(false);
    if (duplicate.success) return;
    expect(duplicate.error.issues.map((issue) => issue.message)).toContain(
      "Duplicate workflow transition id: same",
    );
  });

  it("requires at least one condition route", () => {
    const result = workflowTemplateDefinitionSchema.safeParse({
      ...linearTemplate,
      transitions: [
        {
          id: "condition",
          fromStepId: "investigate",
          kind: "condition",
          question: "Did it find a fix?",
          routes: {},
          previewBeforeStart: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("workflowRunSchema", () => {
  it("accepts persisted run snapshots", () => {
    const now = Date.now();
    const template = workflowTemplateDefinitionSchema.parse(linearTemplate);
    expect(
      workflowRunSchema.parse({
        id: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1",
        templateId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
        name: template.name,
        workspaceId: "workspace-1",
        status: "waiting",
        templateSnapshot: {
          ...template,
          id: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
          createdAtMs: now,
          updatedAtMs: now,
        },
        inputs: { issue: "Fix test" },
        stepRuns: template.steps.map((step, index) => ({
          id: `00000000-0000-4000-8000-00000000000${index + 1}`, 
          templateStepId: step.id,
          name: step.name,
          status: index === 0 ? "ready" : "waiting",
          updatedAtMs: now,
        })),
        transitionRuns: [
          {
            id: "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1",
            templateTransitionId: "investigate-to-fix",
            status: "waiting",
            updatedAtMs: now,
          },
        ],
        createdAtMs: now,
        updatedAtMs: now,
      }),
    ).toBeTruthy();
  });
});
