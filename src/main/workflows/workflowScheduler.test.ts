import { describe, expect, it } from "vitest";
import {
  createWorkflowRun,
  markWorkflowStepQueued,
  stopWorkflowRun,
} from "./workflowEngine.js";
import {
  renderWorkflowTranscript,
  WorkflowScheduler,
  WORKFLOW_TRANSCRIPT_MAX_CHARS,
  type WorkflowSessionSnapshot,
} from "./workflowScheduler.js";
import type {
  WorkflowRun,
  WorkflowTemplate,
} from "../../shared/workflowSchemas.js";

const template: WorkflowTemplate = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Linear",
  inputs: [],
  steps: [
    {
      id: "first",
      name: "First",
      kind: "agent",
      promptParts: [{ type: "text", text: "first prompt" }],
      inputPolicy: {
        includeWorkflowContext: false,
        includeParentFinalAnswer: false,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
      startPolicy: "auto",
    },
    {
      id: "second",
      name: "Second",
      kind: "agent",
      promptParts: [
        { type: "stepOutput", stepId: "first", output: "finalAnswer" },
      ],
      inputPolicy: {
        includeWorkflowContext: false,
        includeParentFinalAnswer: false,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
      startPolicy: "auto",
    },
  ],
  transitions: [
    {
      id: "always-1",
      fromStepId: "first",
      kind: "always",
      toStepId: "second",
    },
  ],
  createdAtMs: 1,
  updatedAtMs: 1,
};

const conditionTemplate: WorkflowTemplate = {
  ...template,
  id: "00000000-0000-4000-8000-000000000002",
  steps: [
    { ...template.steps[0]!, id: "source", name: "Source" },
    {
      ...template.steps[1]!,
      id: "yes",
      name: "Yes",
      promptParts: [{ type: "text", text: "yes" }],
    },
    {
      ...template.steps[1]!,
      id: "no",
      name: "No",
      promptParts: [{ type: "text", text: "no" }],
    },
  ],
  transitions: [
    {
      id: "condition-1",
      fromStepId: "source",
      kind: "condition",
      question: "Did it succeed?",
      routes: {
        yes: { kind: "step", stepId: "yes" },
        no: { kind: "step", stepId: "no" },
      },
      previewBeforeStart: false,
    },
  ],
};

function snapshot(
  runtimeId: string,
  prompt: string,
  answer?: string,
): WorkflowSessionSnapshot {
  return {
    runtimeId,
    state: {
      runtimeId,
      sessionId: `session-${runtimeId}`,
      sessionFile: `/tmp/${runtimeId}.jsonl`,
    },
    messages:
      answer === undefined
        ? []
        : [
            {
              id: `assistant-${runtimeId}`,
              role: "assistant",
              content: answer,
              createdAt: 2,
            },
          ],
  };
}

function setup(
  options: {
    capacity?: boolean;
    conditionAnswer?: string;
    delaySnapshot?: boolean;
  } = {},
) {
  const prompts: string[] = [];
  const persisted: WorkflowRun[] = [];
  const closed: string[] = [];
  const sessions = new Map<string, WorkflowSessionSnapshot>();
  let created = 0;
  let releaseSnapshot = () => undefined;
  const snapshotGate = options.delaySnapshot
    ? new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      })
    : Promise.resolve();
  const scheduler = new WorkflowScheduler({
    createSession: async () => {
      if (options.capacity && created > 0) {
        const error = new Error(
          "Maximum running session capacity (1) reached.",
        );
        error.name = "WorkerCapacityError";
        throw error;
      }
      const runtimeId = `runtime-${++created}`;
      const value = snapshot(runtimeId, "");
      sessions.set(runtimeId, value);
      return value;
    },
    prompt: async (runtimeId, text) => {
      prompts.push(text);
      const value = sessions.get(runtimeId)!;
      sessions.set(runtimeId, {
        ...value,
        messages: [
          {
            id: "a",
            role: "assistant",
            content: text.startsWith("You are a workflow condition judge.")
              ? (options.conditionAnswer ?? `answer ${runtimeId}`)
              : `answer ${runtimeId}`,
          },
        ],
      });
    },
    getSnapshot: async (runtimeId) => {
      await snapshotGate;
      return sessions.get(runtimeId)!;
    },
    closeSession: async (runtimeId) => {
      closed.push(runtimeId);
    },
    persist: async (run) => {
      persisted.push(run);
      return run;
    },
    emit: () => undefined,
    now: () => 10,
  });
  return { scheduler, prompts, persisted, closed, sessions, releaseSnapshot };
}

describe("WorkflowScheduler", () => {
  it("executes one linear step, captures output, and starts the always-after step", async () => {
    const fixture = setup();
    const run = createWorkflowRun({
      template,
      workspaceId: "workspace",
      inputs: {},
      now: 1,
    });
    await fixture.scheduler.schedule(run);
    await fixture.scheduler.handleRuntimeEvent({
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "completed",
    });

    expect(fixture.prompts).toEqual(["first prompt", "answer runtime-1"]);
    expect(fixture.persisted.at(-1)?.stepRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateStepId: "first",
          status: "completed",
          finalAnswer: "answer runtime-1",
        }),
        expect.objectContaining({
          templateStepId: "second",
          status: "running",
          runtimeId: "runtime-2",
        }),
      ]),
    );
  });

  it("persists a bounded transcript from the completed Pi snapshot", async () => {
    const fixture = setup();
    const run = createWorkflowRun({
      template,
      workspaceId: "workspace",
      inputs: {},
      now: 1,
    });
    await fixture.scheduler.schedule(run);
    fixture.sessions.set("runtime-1", {
      ...fixture.sessions.get("runtime-1")!,
      messages: [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "answer runtime-1" },
      ],
    });

    await fixture.scheduler.handleRuntimeEvent({
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "completed",
    });

    expect(fixture.persisted.at(-1)?.stepRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateStepId: "first",
          transcript: "user: first prompt\nassistant: answer runtime-1",
        }),
      ]),
    );
  });

  it("bounds transcript handoffs and omits snapshots without text", () => {
    const transcript = renderWorkflowTranscript(
      Array.from({ length: 250 }, (_, index) => ({
        role: "assistant",
        content: `${index}:${"x".repeat(300)}`,
      })),
    );
    expect(transcript).toBeDefined();
    expect(transcript!.length).toBeLessThanOrEqual(
      WORKFLOW_TRANSCRIPT_MAX_CHARS,
    );
    expect(transcript).toContain("249:");
    expect(
      renderWorkflowTranscript([
        { role: "assistant", content: [{ type: "toolCall" }] },
      ]),
    ).toBeUndefined();
  });

  it("blocks unavailable referenced outputs before prompting Pi", async () => {
    const fixture = setup();
    const blockedTemplate: WorkflowTemplate = {
      ...template,
      steps: [
        {
          ...template.steps[0]!,
          inputPolicy: {
            ...template.steps[0]!.inputPolicy,
            includeParentFinalAnswer: true,
          },
        },
        template.steps[1]!,
      ],
    };
    const run = createWorkflowRun({
      template: blockedTemplate,
      workspaceId: "workspace",
      inputs: {},
      now: 1,
    });
    await fixture.scheduler.schedule(run);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.persisted.at(-1)?.status).toBe("needsAttention");
    expect(fixture.persisted.at(-1)?.stepRuns[0]?.status).toBe("failed");
  });

  it("rejects an optional input referenced by a prompt before scheduling", () => {
    const fixture = setup();
    const optionalInputTemplate: WorkflowTemplate = {
      ...template,
      inputs: [
        { id: "context", label: "Context", type: "text", required: false },
      ],
      steps: [
        {
          ...template.steps[0]!,
          promptParts: [{ type: "workflowInput", inputId: "context" }],
        },
        template.steps[1]!,
      ],
    };

    expect(() =>
      createWorkflowRun({
        template: optionalInputTemplate,
        workspaceId: "workspace",
        inputs: {},
        now: 1,
      }),
    ).toThrow(/required.*context/i);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.persisted).toEqual([]);
  });

  it("ignores a stale completion after the run is stopped", async () => {
    const fixture = setup();
    const run = createWorkflowRun({
      template,
      workspaceId: "workspace",
      inputs: {},
      now: 1,
    });
    await fixture.scheduler.schedule(run);
    const stopped = {
      ...run,
      status: "stopped" as const,
      updatedAtMs: 20,
    };

    await Promise.all([
      fixture.scheduler.update(stopped),
      fixture.scheduler.handleRuntimeEvent({
        type: "agent_end",
        runtimeId: "runtime-1",
        status: "completed",
      }),
    ]);

    expect(fixture.prompts).toEqual(["first prompt"]);
    expect(fixture.persisted.at(-1)?.stepRuns[0]?.status).toBe("running");
    expect(fixture.persisted.at(-1)?.stepRuns[0]?.finalAnswer).toBeUndefined();
    expect(fixture.closed).toEqual(["runtime-1"]);
  });

  it.todo(
    "does not send a prompt when rendering exposes an unavailable upstream output",
  );

  it("reschedules a queued step when a workspace is restored", async () => {
    const fixture = setup();
    const run = createWorkflowRun({
      template,
      workspaceId: "workspace",
      inputs: {},
      now: 1,
    });
    const queued = markWorkflowStepQueued(run, run.stepRuns[0]!.id, 2);

    await fixture.scheduler.schedule(queued);

    expect(fixture.prompts).toEqual(["first prompt"]);
    expect(fixture.persisted.at(-1)?.stepRuns[0]).toMatchObject({
      templateStepId: "first",
      status: "running",
    });
  });

  it("persists a queued step when worker capacity is unavailable", async () => {
    const fixture = setup({ capacity: true });
    const run = createWorkflowRun({
      template,
      workspaceId: "workspace",
      inputs: {},
      now: 1,
    });
    await fixture.scheduler.schedule(run);
    await fixture.scheduler.handleRuntimeEvent({
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "completed",
    });
    const queued = fixture.persisted.find((item) =>
      item.stepRuns.some((step) => step.status === "queued"),
    );
    expect(
      queued?.stepRuns.find((step) => step.templateStepId === "second")?.status,
    ).toBe("queued");
  });

  it("does not let a delayed completion overwrite a concurrent stop", async () => {
    const fixture = setup({ delaySnapshot: true });
    const run = createWorkflowRun({
      template,
      workspaceId: "workspace",
      inputs: {},
      now: 1,
    });
    await fixture.scheduler.schedule(run);
    const completion = fixture.scheduler.handleRuntimeEvent({
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "completed",
    });
    await Promise.resolve();
    const stopped = stopWorkflowRun(run, 20);
    await fixture.scheduler.update(stopped);
    fixture.releaseSnapshot();
    await completion;
    expect(fixture.persisted.some((item) => item.status === "completed")).toBe(
      false,
    );
    expect(fixture.persisted.some((item) => item.status === "stopped")).toBe(
      false,
    );
  });

  it("judges a condition with strict JSON and starts only the selected branch", async () => {
    const fixture = setup({
      conditionAnswer:
        '{"decision":"yes","rationale":"The result confirms success."}',
    });
    const run = createWorkflowRun({
      template: conditionTemplate,
      workspaceId: "workspace",
      inputs: {},
      now: 1,
    });
    await fixture.scheduler.schedule(run);
    await fixture.scheduler.handleRuntimeEvent({
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "completed",
    });
    await fixture.scheduler.handleRuntimeEvent({
      type: "agent_end",
      runtimeId: "runtime-2",
      status: "completed",
    });
    const latest = fixture.persisted.at(-1)!;
    expect(latest.transitionRuns[0]).toMatchObject({
      decision: "yes",
      rationale: "The result confirms success.",
    });
    expect(
      latest.stepRuns.find((step) => step.templateStepId === "yes")?.status,
    ).toBe("running");
    expect(
      latest.stepRuns.find((step) => step.templateStepId === "no")?.status,
    ).toBe("skipped");
  });

  it("turns malformed condition output into attention without selecting a branch", async () => {
    const fixture = setup({ conditionAnswer: "yes, definitely" });
    const run = createWorkflowRun({
      template: conditionTemplate,
      workspaceId: "workspace",
      inputs: {},
      now: 1,
    });
    await fixture.scheduler.schedule(run);
    await fixture.scheduler.handleRuntimeEvent({
      type: "agent_end",
      runtimeId: "runtime-1",
      status: "completed",
    });
    await fixture.scheduler.handleRuntimeEvent({
      type: "agent_end",
      runtimeId: "runtime-2",
      status: "completed",
    });
    const latest = fixture.persisted.at(-1)!;
    expect(latest.status).toBe("needsAttention");
    expect(latest.transitionRuns[0]?.status).toBe("failed");
    expect(
      latest.stepRuns.find((step) => step.templateStepId === "yes")?.status,
    ).toBe("waiting");
  });
});
