import { ipcChannels } from "../../shared/ipcSchemas.js";
import type {
  WorkflowGraphSnapshot,
  WorkflowRunEnvelope,
} from "../../shared/agentWorkflowSchemas.js";

export interface GraphSubscriber {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** Run subscriptions are owned by the subscribing webContents, never a window. */
export class WorkflowGraphSubscriptions {
  private readonly subscriptions = new Map<number, Map<string, string>>();

  hasSender(senderId: number): boolean {
    return this.subscriptions.has(senderId);
  }

  subscribe(senderId: number, runId: string, workspaceId: string): void {
    const runs = this.subscriptions.get(senderId) ?? new Map<string, string>();
    runs.set(runId, workspaceId);
    this.subscriptions.set(senderId, runs);
  }

  unsubscribe(senderId: number, runId: string): void {
    const runs = this.subscriptions.get(senderId);
    runs?.delete(runId);
    if (runs?.size === 0) this.subscriptions.delete(senderId);
  }

  removeSender(senderId: number): void {
    this.subscriptions.delete(senderId);
  }

  publish(
    run: WorkflowRunEnvelope,
    snapshot: WorkflowGraphSnapshot,
    resolve: (senderId: number) => GraphSubscriber | undefined,
  ): void {
    for (const [senderId, runs] of this.subscriptions) {
      if (runs.get(run.id) !== run.workspaceId) continue;
      const subscriber = resolve(senderId);
      if (!subscriber || subscriber.isDestroyed()) {
        this.subscriptions.delete(senderId);
        continue;
      }
      // A renderer may disappear between isDestroyed() and send(). Do not let
      // one stale subscriber prevent updates for the remaining subscribers.
      try {
        subscriber.send(ipcChannels.workflowGraphEvent, {
          type: "workflow_graph_updated",
          runId: run.id,
          revision: run.revision,
          snapshot,
        });
      } catch {
        this.subscriptions.delete(senderId);
      }
    }
  }
}
