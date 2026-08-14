import { describe, expect, it, vi } from "vitest";
import type { WorkflowRunEnvelope } from "../../shared/agentWorkflowSchemas.js";
import { deriveWorkflowGraphSnapshot } from "./workflowGraphSnapshot.js";
import { WorkflowGraphSubscriptions } from "./workflowGraphSubscriptions.js";

const run = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "workspace-a",
  revision: 3,
  definition: {
    format: "pi-deck.agent-workflow",
    schemaVersion: 2,
    id: "00000000-0000-4000-8000-000000000002",
    revision: 1,
    name: "Graph",
    inputs: [],
    entryNodeId: "00000000-0000-4000-8000-000000000003",
    nodes: [
      {
        id: "00000000-0000-4000-8000-000000000003",
        name: "Worker",
        role: "worker",
        config: { instructions: "work" },
      },
    ],
    relationships: [],
  },
  name: "Graph",
  status: "running",
  inputs: {},
  occurrences: [],
  createdAtMs: 1,
  updatedAtMs: 2,
} as WorkflowRunEnvelope;

function subscriber(id: number, destroyed = false) {
  return { id, isDestroyed: () => destroyed, send: vi.fn() };
}

describe("WorkflowGraphSubscriptions", () => {
  it("delivers only to each subscribed, authorized webContents", () => {
    const subscriptions = new WorkflowGraphSubscriptions();
    const first = subscriber(1);
    const second = subscriber(2);
    const wrongWorkspace = subscriber(3);
    const failing = subscriber(4);
    failing.send.mockImplementation(() => {
      throw new Error("window closed");
    });
    subscriptions.subscribe(1, run.id, run.workspaceId);
    subscriptions.subscribe(2, run.id, run.workspaceId);
    subscriptions.subscribe(3, run.id, "workspace-b");
    subscriptions.subscribe(4, run.id, run.workspaceId);
    subscriptions.publish(
      run,
      deriveWorkflowGraphSnapshot(run.definition, run),
      (id) => ({ 1: first, 2: second, 3: wrongWorkspace, 4: failing })[id],
    );
    expect(first.send).toHaveBeenCalledOnce();
    expect(second.send).toHaveBeenCalledOnce();
    expect(wrongWorkspace.send).not.toHaveBeenCalled();
  });

  it("stops delivery after unsubscribe and removes destroyed senders", () => {
    const subscriptions = new WorkflowGraphSubscriptions();
    const active = subscriber(1);
    const destroyed = subscriber(2, true);
    subscriptions.subscribe(1, run.id, run.workspaceId);
    subscriptions.subscribe(2, run.id, run.workspaceId);
    subscriptions.unsubscribe(1, run.id);
    subscriptions.publish(
      run,
      deriveWorkflowGraphSnapshot(run.definition, run),
      (id) => (id === 2 ? destroyed : active),
    );
    expect(active.send).not.toHaveBeenCalled();
    expect(destroyed.send).not.toHaveBeenCalled();
    expect(subscriptions.hasSender(2)).toBe(false);
  });
});
