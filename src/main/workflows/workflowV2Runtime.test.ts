import { describe, expect, it } from "vitest";
import {
  answerWorkflowHumanOccurrence,
  completeWorkflowOccurrence,
  createWorkflowRoleRun,
  failWorkflowOccurrence,
  readyWorkflowOccurrences,
  startWorkflowOccurrence,
  startWorkflowOrchestrator,
  type WorkflowRoleDefinition,
} from "./workflowV2Runtime.js";

const base = {
  format: "pi-deck.agent-workflow" as const,
  schemaVersion: 2 as const,
  id: "workflow",
  revision: 1,
  name: "Workflow",
  inputs: [],
  relationships: [],
};

function fanoutDefinition(completion: "all" | "any"): WorkflowRoleDefinition {
  return {
    ...base,
    entryNodeId: "fan",
    nodes: [
      {
        id: "fan",
        name: "Fan",
        role: "orchestrator",
        config: {
          mode: "fanout",
          agents: ["a", "b"],
          maxConcurrency: 2,
          completion,
        },
      },
      ...["a", "b"].map((id) => ({
        id,
        name: id.toUpperCase(),
        role: "worker" as const,
        managedBy: "fan",
        config: { instructions: id },
      })),
      {
        id: "after",
        name: "After",
        role: "worker",
        config: { instructions: "after" },
      },
    ],
    relationships: [{ id: "fan-after", from: "fan", to: { nodeId: "after" } }],
  };
}

describe("v2 occurrence runtime", () => {
  it("uses boolean deciders and records each bounded loop occurrence", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: "loop",
      nodes: [
        {
          id: "loop",
          name: "Loop",
          role: "orchestrator",
          config: {
            mode: "loop",
            agents: ["work"],
            decider: "ready",
            maxIterations: 2,
          },
        },
        {
          id: "work",
          name: "Work",
          role: "worker",
          managedBy: "loop",
          config: { instructions: "work" },
        },
        {
          id: "ready",
          name: "Ready",
          role: "decider",
          managedBy: "loop",
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
      run.occurrences.filter((item) => item.nodeId === "work"),
    ).toHaveLength(2);
  });

  it("pauses Human input, approval, and choice without a Pi session", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: "pick",
      nodes: [
        {
          id: "pick",
          name: "Pick",
          role: "human",
          config: { interaction: "choice", prompt: "Pick", options: ["a"] },
        },
      ],
      relationships: [
        { id: "end", from: "pick", when: { equals: "a" }, to: { end: "done" } },
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
      entryNodeId: "fan",
      nodes: [
        {
          id: "fan",
          name: "Fan",
          role: "orchestrator",
          config: {
            mode: "fanout",
            agents: ["a", "b", "c"],
            maxConcurrency: 2,
            completion: "all",
          },
        },
        ...["a", "b", "c"].map((id) => ({
          id,
          name: id.toUpperCase(),
          role: "worker" as const,
          managedBy: "fan",
          config: { instructions: id },
        })),
        {
          id: "after",
          name: "After",
          role: "worker",
          config: { instructions: "after" },
        },
      ],
      relationships: [
        { id: "fan-after", from: "fan", to: { nodeId: "after" } },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    let ready = readyWorkflowOccurrences(run);
    expect(ready.map((item) => item.nodeId).sort()).toEqual(["a", "b"]);
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
    expect(ready.map((item) => item.nodeId)).toEqual(["c"]);
    run = startWorkflowOccurrence(run, ready[0]!.id, "c", undefined, 6);
    const b = run.occurrences.find(
      (item) => item.nodeId === "b" && item.status === "running",
    )!;
    run = completeWorkflowOccurrence(run, b.id, "B", 7);
    run = completeWorkflowOccurrence(run, ready[0]!.id, "C", 8);
    expect(run.status).toBe("waiting");
    expect(
      run.occurrences.filter((item) => item.nodeId === "after"),
    ).toHaveLength(1);
    expect(readyWorkflowOccurrences(run).map((item) => item.nodeId)).toEqual([
      "after",
    ]);
  });

  it("finishes fan-out any once and ignores a late running sibling completion", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: "fan",
      nodes: [
        {
          id: "fan",
          name: "Fan",
          role: "orchestrator",
          config: {
            mode: "fanout",
            agents: ["a", "b", "c"],
            maxConcurrency: 2,
            completion: "any",
          },
        },
        ...["a", "b", "c"].map((id) => ({
          id,
          name: id.toUpperCase(),
          role: "worker" as const,
          managedBy: "fan",
          config: { instructions: id },
        })),
        {
          id: "after",
          name: "After",
          role: "worker",
          config: { instructions: "after" },
        },
      ],
      relationships: [
        { id: "fan-after", from: "fan", to: { nodeId: "after" } },
      ],
    };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    const [a, b] = readyWorkflowOccurrences(run);
    run = startWorkflowOccurrence(run, a!.id, "a", undefined, 3);
    run = startWorkflowOccurrence(run, b!.id, "b", undefined, 4);
    run = completeWorkflowOccurrence(run, a!.id, "A", 5);
    const fan = run.occurrences.find((item) => item.nodeId === "fan")!;
    expect(fan.status).toBe("completed");
    expect(fan.output).toEqual(["A"]);
    expect(run.occurrences.find((item) => item.nodeId === "c")?.status).toBe(
      "skipped",
    );
    expect(
      run.occurrences.filter((item) => item.nodeId === "after"),
    ).toHaveLength(1);
    run = completeWorkflowOccurrence(run, b!.id, "B", 6);
    expect(run.occurrences.find((item) => item.id === fan.id)?.output).toEqual([
      "A",
    ]);
    expect(
      run.occurrences.filter((item) => item.nodeId === "after"),
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

    const fan = run.occurrences.find((item) => item.nodeId === "fan")!;
    expect(fan.output).toEqual(["A"]);
    expect(
      run.occurrences.filter((item) => item.nodeId === "after"),
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
      run.occurrences.filter((item) => item.nodeId === "after"),
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
    expect(run.occurrences.find((item) => item.nodeId === "fan")?.status).toBe(
      "running",
    );
    expect(run.status).toBe("running");

    run = completeWorkflowOccurrence(run, b!.id, "B", 6);
    expect(run.occurrences.find((item) => item.nodeId === "fan")).toMatchObject(
      { status: "completed", output: ["B"] },
    );
    expect(
      run.occurrences.filter((item) => item.nodeId === "after"),
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
    expect(run.occurrences.find((item) => item.nodeId === "fan")?.status).toBe(
      "failed",
    );
    expect(
      run.occurrences.filter((item) => item.nodeId === "after"),
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
    expect(run.occurrences.find((item) => item.nodeId === "fan")?.status).toBe(
      "failed",
    );
    expect(
      run.occurrences.filter((item) => item.nodeId === "after"),
    ).toHaveLength(0);
  });

  it("fans out workers with distinct child occurrences", () => {
    const definition: WorkflowRoleDefinition = {
      ...base,
      entryNodeId: "fan",
      nodes: [
        {
          id: "fan",
          name: "Fan",
          role: "orchestrator",
          config: {
            mode: "fanout",
            agents: ["a", "b"],
            maxConcurrency: 1,
            completion: "all",
          },
        },
        {
          id: "a",
          name: "A",
          role: "worker",
          managedBy: "fan",
          config: { instructions: "a" },
        },
        {
          id: "b",
          name: "B",
          role: "worker",
          managedBy: "fan",
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
