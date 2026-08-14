import { describe, expect, it } from "vitest";
import {
  answerWorkflowHumanOccurrence,
  completeWorkflowOccurrence,
  createWorkflowRoleRun,
  failWorkflowOccurrence,
  readyWorkflowOccurrences,
  retryWorkflowOccurrence,
  startWorkflowOccurrence,
  startWorkflowOrchestrator,
  stopWorkflowRoleRun,
  type WorkflowRoleDefinition,
} from "./agentWorkflowRuntime.js";
import { renderWorkflowOccurrencePrompt } from "./workflowPromptRenderer.js";

const ids = {
  workflow: "00000000-0000-4000-8000-000000000001",
  fan: "00000000-0000-4000-8000-000000000002",
  a: "00000000-0000-4000-8000-000000000003",
  b: "00000000-0000-4000-8000-000000000004",
  c: "00000000-0000-4000-8000-000000000005",
  after: "00000000-0000-4000-8000-000000000006",
  plan: "00000000-0000-4000-8000-000000000007",
  review: "00000000-0000-4000-8000-000000000008",
  deliver: "00000000-0000-4000-8000-000000000009",
  worker: "00000000-0000-4000-8000-000000000010",
  loop: "00000000-0000-4000-8000-000000000011",
  work: "00000000-0000-4000-8000-000000000012",
  ready: "00000000-0000-4000-8000-000000000013",
  pick: "00000000-0000-4000-8000-000000000014",
  end: "00000000-0000-4000-8000-000000000015",
  fanAfter: "00000000-0000-4000-8000-000000000016",
  planReview: "00000000-0000-4000-8000-000000000017",
  reviewDeliver: "00000000-0000-4000-8000-000000000018",
} as const;

const base = {
  format: "pi-deck.agent-workflow" as const,
  schemaVersion: 2 as const,
  id: ids.workflow,
  revision: 1,
  name: "Workflow",
  inputs: [],
  relationships: [],
};

function fanoutDefinition(completion: "all" | "any"): WorkflowRoleDefinition {
  return {
    ...base,
    entryNodeId: ids.fan,
    nodes: [
      {
        id: ids.fan,
        name: "Fan",
        role: "orchestrator",
        config: {
          mode: "fanout",
          agents: [ids.a, ids.b],
          maxConcurrency: 2,
          completion,
        },
      },
      ...[
        { id: ids.a, name: "a" },
        { id: ids.b, name: "b" },
      ].map(({ id, name }) => ({
        id,
        name: name.toUpperCase(),
        role: "worker" as const,
        managedBy: ids.fan,
        config: { instructions: name },
      })),
      {
        id: ids.after,
        name: "After",
        role: "worker",
        config: { instructions: "after" },
      },
    ],
    relationships: [
      { id: ids.fanAfter, from: ids.fan, to: { nodeId: ids.after } },
    ],
  };
}

describe("agentWorkflow occurrence runtime", () => {
  it("captures only configured upstream outputs in a durable ordered binding snapshot", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.plan,
      nodes: [
        {
          id: ids.plan,
          name: "Plan",
          role: "worker",
          config: { instructions: "plan" },
        },
        {
          id: ids.review,
          name: "Review",
          role: "worker",
          config: { instructions: "review" },
        },
        {
          id: ids.deliver,
          name: "Deliver",
          role: "worker",
          inputBindings: [
            {
              sourceNodeId: ids.plan,
              sourceValue: "finalOutput",
              label: "Selected plan",
            },
            {
              sourceNodeId: ids.review,
              sourceValue: "finalOutput",
              label: "Selected review",
            },
          ],
          config: { instructions: "deliver" },
        },
      ],
      relationships: [
        { id: ids.planReview, from: ids.plan, to: { nodeId: ids.review } },
        // The direct edge races the review path; explicit bindings make this a
        // join rather than creating a partially-bound Deliver occurrence.
        { id: ids.fanAfter, from: ids.plan, to: { nodeId: ids.deliver } },
        {
          id: ids.reviewDeliver,
          from: ids.review,
          to: { nodeId: ids.deliver },
        },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace");
    const plan = run.occurrences[0]!;
    run = startWorkflowOccurrence(run, plan.id, "plan-runtime");
    run = completeWorkflowOccurrence(run, plan.id, "chosen plan");
    const review = run.occurrences.find((item) => item.nodeId === ids.review)!;
    expect(run.occurrences.some((item) => item.nodeId === ids.deliver)).toBe(
      false,
    );
    run = startWorkflowOccurrence(run, review.id, "review-runtime");
    run = completeWorkflowOccurrence(run, review.id, "incidental review");
    const deliver = run.occurrences.find(
      (item) => item.nodeId === ids.deliver,
    )!;
    expect(deliver.resolvedInputBindings).toEqual([
      {
        sourceNodeId: ids.plan,
        sourceValue: "finalOutput",
        label: "Selected plan",
        value: "chosen plan",
      },
      {
        sourceNodeId: ids.review,
        sourceValue: "finalOutput",
        label: "Selected review",
        value: "incidental review",
      },
    ]);
    const prompt = renderWorkflowOccurrencePrompt(run, deliver);
    expect(prompt).toContain("Selected plan:\nchosen plan");
    expect(prompt).toContain("Selected review:\nincidental review");

    run = startWorkflowOccurrence(run, deliver.id, "deliver-runtime");
    run = failWorkflowOccurrence(run, deliver.id, "temporary failure");
    run = retryWorkflowOccurrence(run, deliver.id);
    const retry = run.occurrences.at(-1)!;
    expect(retry.attempt).toBe(2);
    expect(retry.resolvedInputBindings).toEqual(deliver.resolvedInputBindings);
    expect(renderWorkflowOccurrencePrompt(run, retry)).toContain(
      "Selected plan:\nchosen plan",
    );
  });
  it("renders the configured first managed context without an Orchestrator output", () => {
    const definition = fanoutDefinition("all");
    const orchestrator = definition.nodes.find((node) => node.id === ids.fan);
    if (!orchestrator || orchestrator.role !== "orchestrator")
      throw new Error("fixture");
    orchestrator.config.input = "shared orchestration input";
    let run = createWorkflowRoleRun(definition, "workspace", {});
    run = startWorkflowOrchestrator(run, run.occurrences[0].id);
    const child = run.occurrences.find((item) => item.nodeId === ids.a);
    if (!child) throw new Error("fixture");
    expect(renderWorkflowOccurrencePrompt(run, child)).toContain(
      "shared orchestration input",
    );
  });

  it("passes an immutable bound source to fan-out and loop managed children", () => {
    const exercise = (mode: "fanout" | "loop") => {
      const orchestratorId = mode === "fanout" ? ids.fan : ids.loop;
      const definition: WorkflowRoleDefinition = {
        ...base,
        entryNodeId: ids.plan,
        nodes: [
          {
            id: ids.plan,
            name: "Plan",
            role: "worker",
            config: { instructions: "plan" },
          },
          {
            id: orchestratorId,
            name: mode,
            role: "orchestrator",
            inputBindings: [
              { sourceNodeId: ids.plan, sourceValue: "finalOutput" },
            ],
            config:
              mode === "fanout"
                ? {
                    mode: "fanout",
                    agents: [ids.work],
                    maxConcurrency: 1,
                    completion: "all",
                  }
                : {
                    mode: "loop",
                    agents: [ids.work],
                    decider: ids.ready,
                    maxIterations: 2,
                  },
          },
          {
            id: ids.work,
            name: "Work",
            role: "worker",
            managedBy: orchestratorId,
            config: { instructions: "work" },
          },
          ...(mode === "loop"
            ? [
                {
                  id: ids.ready,
                  name: "Ready",
                  role: "decider" as const,
                  managedBy: orchestratorId,
                  config: { question: "ready?" },
                },
              ]
            : []),
        ],
        relationships: [
          {
            id: ids.planReview,
            from: ids.plan,
            to: { nodeId: orchestratorId },
          },
        ],
      };
      let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
      const plan = run.occurrences[0]!;
      run = startWorkflowOccurrence(run, plan.id, "plan", undefined, 2);
      run = completeWorkflowOccurrence(run, plan.id, `${mode} source`, 3);
      const orchestrator = readyWorkflowOccurrences(run)[0]!;
      expect(orchestrator.resolvedInputBindings?.[0]?.value).toBe(
        `${mode} source`,
      );
      run = startWorkflowOrchestrator(run, orchestrator.id, 4);
      const child = readyWorkflowOccurrences(run)[0]!;
      expect(renderWorkflowOccurrencePrompt(run, child)).toContain(
        `${mode} source`,
      );
    };
    exercise("fanout");
    exercise("loop");
  });

  it("retains the saved Pi session file on a running occurrence", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.worker,
      nodes: [
        {
          id: ids.worker,
          name: "Worker",
          role: "worker",
          config: { instructions: "do" },
        },
      ],
      relationships: [
        { id: ids.end, from: ids.worker, to: { end: "completed" } },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace");
    run = startWorkflowOccurrence(
      run,
      run.occurrences[0].id,
      "runtime",
      "session",
      2,
      "/tmp/workflow-session.jsonl",
    );
    expect(run.occurrences[0]).toMatchObject({
      runtimeId: "runtime",
      sessionId: "session",
      sessionFile: "/tmp/workflow-session.jsonl",
    });
  });

  it("keeps sessionFile but removes the live runtime when an occurrence closes", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.worker,
      nodes: [
        {
          id: ids.worker,
          name: "Worker",
          role: "worker",
          config: { instructions: "do" },
        },
      ],
      relationships: [
        { id: ids.end, from: ids.worker, to: { end: "completed" } },
      ],
    };
    const start = () => {
      let run = createWorkflowRoleRun(definition, "workspace");
      return startWorkflowOccurrence(
        run,
        run.occurrences[0].id,
        "runtime",
        "session",
        2,
        "/tmp/workflow-session.jsonl",
      );
    };

    const completedStart = start();
    const completed = completeWorkflowOccurrence(
      completedStart,
      completedStart.occurrences[0].id,
      "done",
    );
    expect(completed.occurrences[0]).toMatchObject({
      sessionFile: "/tmp/workflow-session.jsonl",
    });
    expect(completed.occurrences[0]).not.toHaveProperty("runtimeId");

    const failedStart = start();
    const failed = failWorkflowOccurrence(
      failedStart,
      failedStart.occurrences[0].id,
      "failed",
    );
    expect(failed.occurrences[0]).toMatchObject({
      sessionFile: "/tmp/workflow-session.jsonl",
    });
    expect(failed.occurrences[0]).not.toHaveProperty("runtimeId");

    const stopped = stopWorkflowRoleRun(start());
    expect(stopped.occurrences[0]).toMatchObject({
      status: "cancelled",
      sessionFile: "/tmp/workflow-session.jsonl",
    });
    expect(stopped.occurrences[0]).not.toHaveProperty("runtimeId");
  });

  it("supersedes a failed attempt so a retry can complete the run", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.worker,
      nodes: [
        {
          id: ids.worker,
          name: "Worker",
          role: "worker",
          config: { instructions: "do" },
        },
      ],
      relationships: [
        { id: ids.end, from: ids.worker, to: { end: "completed" } },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace");
    run = startWorkflowOccurrence(run, run.occurrences[0].id, "runtime");
    run = failWorkflowOccurrence(run, run.occurrences[0].id, "failed");
    run = retryWorkflowOccurrence(run, run.occurrences[0].id);
    const retry = run.occurrences.at(-1)!;
    run = startWorkflowOccurrence(run, retry.id, "retry-runtime");
    run = completeWorkflowOccurrence(run, retry.id, "done");
    expect(run.status).toBe("completed");
    expect(run.occurrences[0].status).toBe("skipped");
  });

  it("enforces persisted maxAttempts while retaining the failed attempt for projection", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.worker,
      nodes: [
        {
          id: ids.worker,
          name: "Worker",
          role: "worker",
          config: { instructions: "do" },
          execution: { maxAttempts: 2 },
        },
      ],
      relationships: [],
    };
    let run = createWorkflowRoleRun(definition, "workspace");
    run = startWorkflowOccurrence(run, run.occurrences[0]!.id, "runtime");
    run = failWorkflowOccurrence(run, run.occurrences[0]!.id, "failed");
    run = retryWorkflowOccurrence(run, run.occurrences[0]!.id);
    const retry = run.occurrences.at(-1)!;
    run = startWorkflowOccurrence(run, retry.id, "retry-runtime");
    run = failWorkflowOccurrence(run, retry.id, "failed again");
    expect(() => retryWorkflowOccurrence(run, retry.id)).toThrow(
      "Retry budget exhausted after 2 attempts.",
    );
  });

  it("records named terminal outcomes without treating rejection as a failure", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.worker,
      nodes: [
        {
          id: ids.worker,
          name: "Worker",
          role: "worker",
          config: { instructions: "do" },
        },
      ],
      relationships: [
        { id: ids.end, from: ids.worker, to: { end: "rejected" } },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace");
    const occurrence = run.occurrences[0];
    run = startWorkflowOccurrence(run, occurrence.id, "runtime", "session");
    run = completeWorkflowOccurrence(run, occurrence.id, "done");
    expect(run).toMatchObject({
      status: "completed",
      terminalOutcome: "rejected",
    });
  });

  it("maps only the stopped terminal outcome to stopped", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.worker,
      nodes: [
        {
          id: ids.worker,
          name: "Worker",
          role: "worker",
          config: { instructions: "do" },
        },
      ],
      relationships: [
        { id: ids.end, from: ids.worker, to: { end: "stopped" } },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace");
    run = startWorkflowOccurrence(
      run,
      run.occurrences[0].id,
      "runtime",
      "session",
    );
    run = completeWorkflowOccurrence(run, run.occurrences[0].id, "done");
    expect(run).toMatchObject({
      status: "stopped",
      terminalOutcome: "stopped",
    });
  });
  it("uses boolean deciders and records each bounded loop occurrence", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.loop,
      nodes: [
        {
          id: ids.loop,
          name: "Loop",
          role: "orchestrator",
          config: {
            mode: "loop",
            agents: [ids.work],
            decider: ids.ready,
            maxIterations: 2,
          },
        },
        {
          id: ids.work,
          name: "Work",
          role: "worker",
          managedBy: ids.loop,
          config: { instructions: "work" },
        },
        {
          id: ids.ready,
          name: "Ready",
          role: "decider",
          managedBy: ids.loop,
          config: { question: "done?" },
        },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    const orchestration = readyWorkflowOccurrences(run)[0]!;
    run = startWorkflowOrchestrator(run, orchestration.id, 2);
    let work = readyWorkflowOccurrences(run)[0]!;
    run = startWorkflowOccurrence(run, work.id, "r1", "s1", 3);
    run = completeWorkflowOccurrence(run, work.id, "first", 4);
    let decider = readyWorkflowOccurrences(run)[0]!;
    run = startWorkflowOccurrence(run, decider.id, "r2", "s2", 5);
    expect(() =>
      completeWorkflowOccurrence(run, decider.id, "unsure", 6),
    ).toThrow("boolean");
    run = completeWorkflowOccurrence(run, decider.id, false, 6);
    work = readyWorkflowOccurrences(run)[0]!;
    expect(work.iteration).toBe(2);
    run = startWorkflowOccurrence(run, work.id, "r3", "s3", 7);
    run = completeWorkflowOccurrence(run, work.id, "second", 8);
    decider = readyWorkflowOccurrences(run)[0]!;
    run = startWorkflowOccurrence(run, decider.id, "r4", "s4", 9);
    run = completeWorkflowOccurrence(run, decider.id, true, 10);
    expect(run.status).toBe("completed");
    expect(
      run.occurrences.filter((item) => item.nodeId === ids.work),
    ).toHaveLength(2);
  });

  it("pauses Human input, approval, and choice without a Pi session", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.pick,
      nodes: [
        {
          id: ids.pick,
          name: "Pick",
          role: "human",
          config: { interaction: "choice", prompt: "Pick", options: ["a"] },
        },
      ],
      relationships: [
        {
          id: ids.end,
          from: ids.pick,
          when: { equals: "a" },
          to: { end: "done" },
        },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    const human = run.occurrences[0]!;
    expect(human.status).toBe("waitingHuman");
    expect(human.sessionId).toBeUndefined();
    run = answerWorkflowHumanOccurrence(run, human.id, "a", 2);
    expect(run.occurrences[0]?.output).toBe("a");
    expect(run.status).toBe("completed");
  });

  it("completes all fan-out children within bounded concurrency and routes once", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.fan,
      nodes: [
        {
          id: ids.fan,
          name: "Fan",
          role: "orchestrator",
          config: {
            mode: "fanout",
            agents: [ids.a, ids.b, ids.c],
            maxConcurrency: 2,
            completion: "all",
          },
        },
        ...[
          { id: ids.a, name: "a" },
          { id: ids.b, name: "b" },
          { id: ids.c, name: "c" },
        ].map(({ id, name }) => ({
          id,
          name: name.toUpperCase(),
          role: "worker" as const,
          managedBy: ids.fan,
          config: { instructions: name },
        })),
        {
          id: ids.after,
          name: "After",
          role: "worker",
          config: { instructions: "after" },
        },
      ],
      relationships: [
        { id: ids.fanAfter, from: ids.fan, to: { nodeId: ids.after } },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    let ready = readyWorkflowOccurrences(run);
    expect(ready.map((item) => item.nodeId).sort()).toEqual([ids.a, ids.b]);
    for (const [index, child] of ready.entries())
      run = startWorkflowOccurrence(
        run,
        child.id,
        child.nodeId,
        undefined,
        3 + index,
      );
    run = completeWorkflowOccurrence(run, ready[0]!.id, "A", 5);
    ready = readyWorkflowOccurrences(run);
    expect(ready.map((item) => item.nodeId)).toEqual([ids.c]);
    run = startWorkflowOccurrence(run, ready[0]!.id, "c", undefined, 6);
    const b = run.occurrences.find(
      (item) => item.nodeId === ids.b && item.status === "running",
    )!;
    run = completeWorkflowOccurrence(run, b.id, "B", 7);
    run = completeWorkflowOccurrence(run, ready[0]!.id, "C", 8);
    expect(run.status).toBe("waiting");
    expect(
      run.occurrences.filter((item) => item.nodeId === ids.after),
    ).toHaveLength(1);
    expect(readyWorkflowOccurrences(run).map((item) => item.nodeId)).toEqual([
      ids.after,
    ]);
  });

  it("finishes fan-out any once and ignores a late running sibling completion", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.fan,
      nodes: [
        {
          id: ids.fan,
          name: "Fan",
          role: "orchestrator",
          config: {
            mode: "fanout",
            agents: [ids.a, ids.b, ids.c],
            maxConcurrency: 2,
            completion: "any",
          },
        },
        ...[
          { id: ids.a, name: "a" },
          { id: ids.b, name: "b" },
          { id: ids.c, name: "c" },
        ].map(({ id, name }) => ({
          id,
          name: name.toUpperCase(),
          role: "worker" as const,
          managedBy: ids.fan,
          config: { instructions: name },
        })),
        {
          id: ids.after,
          name: "After",
          role: "worker",
          config: { instructions: "after" },
        },
      ],
      relationships: [
        { id: ids.fanAfter, from: ids.fan, to: { nodeId: ids.after } },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    const [a, b] = readyWorkflowOccurrences(run);
    run = startWorkflowOccurrence(run, a!.id, "a", undefined, 3);
    run = startWorkflowOccurrence(run, b!.id, "b", undefined, 4);
    run = completeWorkflowOccurrence(run, a!.id, "A", 5);
    const fan = run.occurrences.find((item) => item.nodeId === ids.fan)!;
    expect(fan.status).toBe("completed");
    expect(fan.output).toEqual(["A"]);
    expect(run.occurrences.find((item) => item.nodeId === ids.c)?.status).toBe(
      "skipped",
    );
    expect(
      run.occurrences.filter((item) => item.nodeId === ids.after),
    ).toHaveLength(1);
    run = completeWorkflowOccurrence(run, b!.id, "B", 6);
    expect(run.occurrences.find((item) => item.id === fan.id)?.output).toEqual([
      "A",
    ]);
    expect(
      run.occurrences.filter((item) => item.nodeId === ids.after),
    ).toHaveLength(1);
    expect(run.occurrences.find((item) => item.id === b!.id)?.status).toBe(
      "completed",
    );
    expect(run.status).toBe("waiting");
    expect(() => completeWorkflowOccurrence(run, b!.id, "again", 7)).toThrow(
      "not running",
    );
  });

  it("keeps a late any fan-out sibling failure as history without downgrading the run", () => {
    let run = createWorkflowRoleRun(
      fanoutDefinition("any"),
      "workspace",
      {},
      1,
    );
    run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    const [a, b] = readyWorkflowOccurrences(run);
    run = startWorkflowOccurrence(run, a!.id, "a", undefined, 3);
    run = startWorkflowOccurrence(run, b!.id, "b", undefined, 4);
    run = completeWorkflowOccurrence(run, a!.id, "A", 5);

    const fan = run.occurrences.find((item) => item.nodeId === ids.fan)!;
    expect(fan.output).toEqual(["A"]);
    expect(
      run.occurrences.filter((item) => item.nodeId === ids.after),
    ).toHaveLength(1);

    run = failWorkflowOccurrence(run, b!.id, "late failure", 6);
    expect(run.status).toBe("waiting");
    expect(run.occurrences.find((item) => item.id === b!.id)).toMatchObject({
      status: "failed",
      error: "late failure",
    });
    expect(run.occurrences.find((item) => item.id === fan.id)?.output).toEqual([
      "A",
    ]);
    expect(
      run.occurrences.filter((item) => item.nodeId === ids.after),
    ).toHaveLength(1);

    run = failWorkflowOccurrence(run, b!.id, "duplicate late failure", 7);
    expect(run.status).toBe("waiting");
    expect(run.occurrences.find((item) => item.id === b!.id)?.error).toBe(
      "duplicate late failure",
    );
  });

  it("allows a running sibling to satisfy fan-out any after an earlier failure", () => {
    let run = createWorkflowRoleRun(
      fanoutDefinition("any"),
      "workspace",
      {},
      1,
    );
    run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    const [a, b] = readyWorkflowOccurrences(run);
    run = startWorkflowOccurrence(run, a!.id, "a", undefined, 3);
    run = startWorkflowOccurrence(run, b!.id, "b", undefined, 4);

    run = failWorkflowOccurrence(run, a!.id, "first failed", 5);
    expect(
      run.occurrences.find((item) => item.nodeId === ids.fan)?.status,
    ).toBe("running");
    expect(run.status).toBe("running");

    run = completeWorkflowOccurrence(run, b!.id, "B", 6);
    expect(
      run.occurrences.find((item) => item.nodeId === ids.fan),
    ).toMatchObject({ status: "completed", output: ["B"] });
    expect(
      run.occurrences.filter((item) => item.nodeId === ids.after),
    ).toHaveLength(1);
    expect(run.status).toBe("waiting");
  });

  it("fails fan-out any when every managed worker fails", () => {
    let run = createWorkflowRoleRun(
      fanoutDefinition("any"),
      "workspace",
      {},
      1,
    );
    run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    const [a, b] = readyWorkflowOccurrences(run);
    run = startWorkflowOccurrence(run, a!.id, "a", undefined, 3);
    run = startWorkflowOccurrence(run, b!.id, "b", undefined, 4);
    run = failWorkflowOccurrence(run, a!.id, "a failed", 5);
    run = failWorkflowOccurrence(run, b!.id, "b failed", 6);

    expect(run.status).toBe("needsAttention");
    expect(
      run.occurrences.find((item) => item.nodeId === ids.fan)?.status,
    ).toBe("failed");
    expect(
      run.occurrences.filter((item) => item.nodeId === ids.after),
    ).toHaveLength(0);
  });

  it("keeps all fan-out failures needing attention", () => {
    let run = createWorkflowRoleRun(
      fanoutDefinition("all"),
      "workspace",
      {},
      1,
    );
    run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    const [a] = readyWorkflowOccurrences(run);
    run = startWorkflowOccurrence(run, a!.id, "a", undefined, 3);
    run = failWorkflowOccurrence(run, a!.id, "failure", 4);

    expect(run.status).toBe("needsAttention");
    expect(
      run.occurrences.find((item) => item.nodeId === ids.fan)?.status,
    ).toBe("failed");
    expect(
      run.occurrences.filter((item) => item.nodeId === ids.after),
    ).toHaveLength(0);
  });

  it("fans out workers with distinct child occurrences", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: ids.fan,
      nodes: [
        {
          id: ids.fan,
          name: "Fan",
          role: "orchestrator",
          config: {
            mode: "fanout",
            agents: [ids.a, ids.b],
            maxConcurrency: 1,
            completion: "all",
          },
        },
        {
          id: ids.a,
          name: "A",
          role: "worker",
          managedBy: ids.fan,
          config: { instructions: "a" },
        },
        {
          id: ids.b,
          name: "B",
          role: "worker",
          managedBy: ids.fan,
          config: { instructions: "b" },
        },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    const a = readyWorkflowOccurrences(run)[0]!;
    expect(
      run.occurrences.filter((item) => item.status === "ready"),
    ).toHaveLength(1);
    run = startWorkflowOccurrence(run, a.id, "a", undefined, 3);
    run = completeWorkflowOccurrence(run, a.id, "A", 4);
    const b = readyWorkflowOccurrences(run)[0]!;
    expect(a.id).not.toBe(b.id);
    run = startWorkflowOccurrence(run, b.id, "b", undefined, 5);
    run = completeWorkflowOccurrence(run, b.id, "B", 6);
    expect(run.status).toBe("completed");
  });
});
