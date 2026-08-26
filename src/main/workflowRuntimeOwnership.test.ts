import { describe, expect, it } from "vitest";
import { WorkflowRuntimeOwnershipRegistry } from "./workflowRuntimeOwnership.js";

const metadata = {
  scheduler: "legacy" as const,
  runId: "run-a",
  itemId: "step-a",
  itemKind: "step" as const,
  workspaceId: "workspace-a",
  sessionFile: "/tmp/session-a.jsonl",
};

describe("WorkflowRuntimeOwnershipRegistry", () => {
  it("tracks and releases a workflow runtime claim idempotently", () => {
    const registry = new WorkflowRuntimeOwnershipRegistry();
    const claim = registry.claim("runtime-a", metadata);

    expect(registry.isOwned("runtime-a")).toBe(true);
    expect(registry.isSessionFileOwned("/tmp/session-a.jsonl")).toBe(true);
    expect(registry.isWorkspaceOwned("workspace-a")).toBe(true);

    claim.markPhase("terminal");
    claim.updateSessionFile("/tmp/session-a-renamed.jsonl");
    expect(registry.get("runtime-a")?.phase).toBe("terminal");
    expect(registry.isSessionFileOwned("/tmp/session-a-renamed.jsonl")).toBe(
      true,
    );
    expect(claim.metadata.sessionFile).toBe("/tmp/session-a-renamed.jsonl");

    claim.release();
    claim.release();

    expect(registry.isOwned("runtime-a")).toBe(false);
    expect(registry.isSessionFileOwned("/tmp/session-a.jsonl")).toBe(false);
  });

  it("prevents duplicate workflow owners for one runtime", () => {
    const registry = new WorkflowRuntimeOwnershipRegistry();
    registry.claim("runtime-a", metadata);

    expect(() => registry.claim("runtime-a", metadata)).toThrow(
      /already owned/,
    );
  });

  it("does not let a stale claim release a newer owner", () => {
    const registry = new WorkflowRuntimeOwnershipRegistry();
    const first = registry.claim("runtime-a", metadata);
    first.release();
    registry.claim("runtime-a", {
      ...metadata,
      runId: "run-b",
      itemId: "step-b",
    });

    first.release();

    expect(registry.get("runtime-a")?.runId).toBe("run-b");
  });
});
