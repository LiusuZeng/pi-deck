/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowRun } from "../../../main/workflows/workflowEngine.js";
import type {
  WorkflowRun,
  WorkflowTemplate,
} from "../../../shared/workflowSchemas.js";
import { WorkflowRunView } from "./WorkflowRunView.js";

const template: WorkflowTemplate = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Approval workflow",
  inputs: [],
  steps: [
    {
      id: "gate",
      name: "Review",
      kind: "agent",
      promptParts: [{ type: "text", text: "Review this." }],
      inputPolicy: {
        includeWorkflowContext: false,
        includeParentFinalAnswer: false,
        includeParentSummary: false,
        includeParentTranscript: false,
      },
      startPolicy: "manualApproval",
    },
  ],
  transitions: [],
  createdAtMs: 1,
  updatedAtMs: 1,
};

function runWithStep(status: "needsApproval" | "failed"): WorkflowRun {
  const run = createWorkflowRun({
    template,
    workspaceId: "workspace",
    inputs: {},
    now: 1,
  });
  return {
    ...run,
    status: "needsAttention",
    stepRuns: [
      {
        ...run.stepRuns[0]!,
        status,
        error: status === "failed" ? "Judge failed" : undefined,
      },
    ],
  };
}

describe("WorkflowRunView action controls", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  function render(
    run: WorkflowRun,
    props: Partial<Parameters<typeof WorkflowRunView>[0]> = {},
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(WorkflowRunView, {
          run,
          onBack: () => undefined,
          onStop: () => undefined,
          ...props,
        }),
      );
    });
  }

  it("exposes approve, skip, and stop actions for a manual approval step", async () => {
    const actions: string[] = [];
    render(runWithStep("needsApproval"), {
      onApproveGate: (_step, action) => actions.push(action),
    });
    expect(container?.textContent).toContain("Needs attention");
    const button = (label: string) =>
      [...(container?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.textContent?.trim() === label,
      ) as HTMLButtonElement;

    await act(async () => button("Approve next").click());
    await act(async () => button("Skip step").click());
    await act(async () => button("Stop").click());
    expect(actions).toEqual(["approve", "skip", "stop"]);
  });

  it("exposes retry for a failed agent step", async () => {
    const retried: string[] = [];
    const run = runWithStep("failed");
    render(run, {
      onRetryStep: (step) => retried.push(step.id),
    });
    const retry = [...(container?.querySelectorAll("button") ?? [])].find(
      (candidate) => candidate.textContent?.trim() === "Retry agent",
    ) as HTMLButtonElement;
    await act(async () => retry.click());
    expect(retried).toEqual([run.stepRuns[0]!.id]);
  });
});
