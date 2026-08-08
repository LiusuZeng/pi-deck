import { describe, expect, it } from "vitest";
import { answerWorkflowHumanOccurrence, completeWorkflowOccurrence, createWorkflowRoleRun, readyWorkflowOccurrences, startWorkflowOccurrence, startWorkflowOrchestrator, type WorkflowRoleDefinition } from "./workflowV2Runtime.js";

const base = { format: "pi-deck.agent-workflow" as const, schemaVersion: 2 as const, id: "workflow", revision: 1, name: "Workflow", inputs: [], relationships: [] };

describe("v2 occurrence runtime", () => {
  it("uses boolean deciders and records each bounded loop occurrence", () => {
    const definition: WorkflowRoleDefinition = { ...base, entryNodeId: "loop", nodes: [
      { id: "loop", name: "Loop", role: "orchestrator", config: { mode: "loop", agents: ["work"], decider: "ready", maxIterations: 2 } },
      { id: "work", name: "Work", role: "worker", managedBy: "loop", config: { instructions: "work" } },
      { id: "ready", name: "Ready", role: "decider", managedBy: "loop", config: { question: "done?" } },
    ] };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    const orchestration = readyWorkflowOccurrences(run)[0]!;
    run = startWorkflowOrchestrator(run, orchestration.id, 2);
    let work = readyWorkflowOccurrences(run)[0]!;
    run = startWorkflowOccurrence(run, work.id, "r1", "s1", 3);
    run = completeWorkflowOccurrence(run, work.id, "first", 4);
    let decider = readyWorkflowOccurrences(run)[0]!;
    run = startWorkflowOccurrence(run, decider.id, "r2", "s2", 5);
    expect(() => completeWorkflowOccurrence(run, decider.id, "unsure", 6)).toThrow("boolean");
    run = completeWorkflowOccurrence(run, decider.id, false, 6);
    work = readyWorkflowOccurrences(run)[0]!;
    expect(work.iteration).toBe(2);
    run = startWorkflowOccurrence(run, work.id, "r3", "s3", 7);
    run = completeWorkflowOccurrence(run, work.id, "second", 8);
    decider = readyWorkflowOccurrences(run)[0]!;
    run = startWorkflowOccurrence(run, decider.id, "r4", "s4", 9);
    run = completeWorkflowOccurrence(run, decider.id, true, 10);
    expect(run.status).toBe("completed");
    expect(run.occurrences.filter(item => item.nodeId === "work")).toHaveLength(2);
  });

  it("pauses Human input, approval, and choice without a Pi session", () => {
    const definition: WorkflowRoleDefinition = { ...base, entryNodeId: "pick", nodes: [{ id: "pick", name: "Pick", role: "human", config: { interaction: "choice", prompt: "Pick", options: [{ id: "a", label: "A" }] } }], relationships: [{ id: "end", from: "pick", when: { equals: "a" }, to: { end: "done" } }] };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    const human = run.occurrences[0]!;
    expect(human.status).toBe("waitingHuman");
    expect(human.sessionId).toBeUndefined();
    run = answerWorkflowHumanOccurrence(run, human.id, "a", 2);
    expect(run.occurrences[0]?.output).toBe("a");
    expect(run.status).toBe("completed");
  });

  it("fans out workers with distinct child occurrences", () => {
    const definition: WorkflowRoleDefinition = { ...base, entryNodeId: "fan", nodes: [
      { id: "fan", name: "Fan", role: "orchestrator", config: { mode: "fanout", agents: ["a", "b"], maxConcurrency: 1, completion: "all" } },
      { id: "a", name: "A", role: "worker", managedBy: "fan", config: { instructions: "a" } }, { id: "b", name: "B", role: "worker", managedBy: "fan", config: { instructions: "b" } },
    ] };
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1); run = startWorkflowOrchestrator(run, run.occurrences[0]!.id, 2);
    const a = readyWorkflowOccurrences(run)[0]!;
    expect(run.occurrences.filter(item => item.status === "ready")).toHaveLength(1);
    run = startWorkflowOccurrence(run, a.id, "a", undefined, 3); run = completeWorkflowOccurrence(run, a.id, "A", 4);
    const b = readyWorkflowOccurrences(run)[0]!;
    expect(a.id).not.toBe(b.id);
    run = startWorkflowOccurrence(run, b.id, "b", undefined, 5); run = completeWorkflowOccurrence(run, b.id, "B", 6);
    expect(run.status).toBe("completed");
  });
});
