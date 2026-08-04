import { describe, expect, it } from "vitest";
import { createWorkflowRun } from "./workflowEngine.js";
import {
  WorkflowScheduler,
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

function setup(options: { capacity?: boolean } = {}) {
  const prompts: string[] = [];
  const persisted: WorkflowRun[] = [];
  const sessions = new Map<string, WorkflowSessionSnapshot>();
  let created = 0;
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
          { id: "a", role: "assistant", content: `answer ${runtimeId}` },
        ],
      });
    },
    getSnapshot: async (runtimeId) => sessions.get(runtimeId)!,
    closeSession: async () => undefined,
    persist: async (run) => {
      persisted.push(run);
      return run;
    },
    emit: () => undefined,
    now: () => 10,
  });
  return { scheduler, prompts, persisted, sessions };
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
});
