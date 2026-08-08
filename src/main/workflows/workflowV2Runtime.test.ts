import { describe, expect, it } from "vitest";
import {
  answerWorkflowHumanOccurrence,
  completeWorkflowOccurrence,
  createWorkflowRoleRun,
  readyWorkflowOccurrences,
  startWorkflowOccurrence,
  type WorkflowRoleDefinition,
} from "./workflowV2Runtime.js";
import { renderWorkflowOccurrencePrompt } from "./workflowPromptRenderer.js";

const definition: WorkflowRoleDefinition = {
  version: 2,
  name: "roles",
  inputs: { issue: "one" },
  nodes: [
    { id: "worker", name: "Worker", role: "worker", prompt: "Fix {{input.issue}}" },
    { id: "left", name: "Left", role: "worker", prompt: "L: {{parent.finalAnswer}}" },
    { id: "right", name: "Right", role: "worker", prompt: "R: {{parent.finalAnswer}}" },
    { id: "human", name: "Human", role: "human", prompt: "Review" },
  ],
  edges: [
    { id: "left-edge", fromNodeId: "worker", toNodeId: "left" },
    { id: "right-edge", fromNodeId: "worker", toNodeId: "right" },
    { id: "human-edge", fromNodeId: "left", toNodeId: "human" },
  ],
};

describe("workflow v2 occurrence runtime", () => {
  it("creates independent deterministic fan-out occurrences and keeps human work local", () => {
    let run = createWorkflowRoleRun(definition, "workspace", {}, 1);
    const root = readyWorkflowOccurrences(run)[0]!;
    expect(renderWorkflowOccurrencePrompt(run, root)).toBe("Fix one");
    run = startWorkflowOccurrence(run, root.id, "runtime", "Fix one", 2);
    run = completeWorkflowOccurrence(run, root.id, { finalAnswer: "done" }, 3);
    const children = readyWorkflowOccurrences(run);
    expect(children.map((item) => item.nodeId)).toEqual(["left", "right"]);
    expect(renderWorkflowOccurrencePrompt(run, children[0]!)).toBe("L: done");
    run = startWorkflowOccurrence(run, children[0]!.id, "left-runtime", "", 4);
    run = completeWorkflowOccurrence(run, children[0]!.id, { finalAnswer: "left done" }, 5);
    const gate = run.occurrences.find((item) => item.nodeId === "human")!;
    expect(gate.status).toBe("waitingHuman");
    run = answerWorkflowHumanOccurrence(run, gate.id, "approve", 6);
    expect(run.occurrences.find((item) => item.id === gate.id)?.status).toBe("completed");
  });

  it("enforces a bounded loop instead of silently completing it", () => {
    const loop: WorkflowRoleDefinition = {
      version: 2, name: "loop", inputs: {},
      nodes: [{ id: "a", name: "A", role: "worker", prompt: "go" }],
      edges: [{ id: "loop", fromNodeId: "a", toNodeId: "a", maxIterations: 1 }],
    };
    let run = createWorkflowRoleRun(loop, "workspace", {}, 1);
    const first = readyWorkflowOccurrences(run)[0]!;
    run = startWorkflowOccurrence(run, first.id, "r1", "go", 2);
    run = completeWorkflowOccurrence(run, first.id, { finalAnswer: "one" }, 3);
    const second = readyWorkflowOccurrences(run)[0]!;
    expect(second.iteration).toBe(1);
    run = startWorkflowOccurrence(run, second.id, "r2", "go", 4);
    run = completeWorkflowOccurrence(run, second.id, { finalAnswer: "two" }, 5);
    expect(run.status).toBe("needsAttention");
    expect(run.occurrences.find((item) => item.id === second.id)?.error).toContain("Loop limit");
  });
});
