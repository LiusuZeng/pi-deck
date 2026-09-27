import { describe, expect, it, vi } from "vitest";
import { emptyOverlays } from "./sessionState.js";
import type { SessionViewModel } from "./sessionRuntimeReducer.js";
import {
  AttachedSessionRecoveryTimeoutError,
  loadAttachedSessionRecovery,
  mergeRecoveredAttachedSession,
  projectAttachedSessionRecovery,
} from "./attachedSessionRecovery.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function session(
  id: string,
  patch: Partial<SessionViewModel> = {},
): SessionViewModel {
  return {
    id,
    workspaceId: "workspace-a",
    title: "Recovered session",
    project: "Project",
    projectPath: "/project",
    subtitle: "Idle",
    status: "idle",
    updatedAt: "Now",
    updatedAtMs: 1,
    timeline: [],
    baseState: "idle",
    overlays: { ...emptyOverlays },
    runtimeBacked: true,
    backendMode: "real",
    ...patch,
  };
}

describe("loadAttachedSessionRecovery", () => {
  it("loads snapshot history and normalized runtime status without resuming", async () => {
    const getSnapshot = vi.fn().mockResolvedValue({
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { isStreaming: false },
      messages: [],
    });
    const getRuntimeStatus = vi.fn().mockResolvedValue({
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { isAgentActive: true },
    });

    await expect(
      loadAttachedSessionRecovery({
        api: { getSnapshot, getRuntimeStatus } as any,
        runtimeId: "runtime-1",
      }),
    ).resolves.toMatchObject({
      snapshot: { runtimeId: "runtime-1" },
      status: { state: { isAgentActive: true } },
    });
    expect(getSnapshot).toHaveBeenCalledWith({ runtimeId: "runtime-1" });
    expect(getRuntimeStatus).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
    });
  });

  it("bounds a quiet attached-runtime read instead of leaving loading forever", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = deferred<any>();
      const status = deferred<any>();
      const recovery = loadAttachedSessionRecovery({
        api: {
          getSnapshot: () => snapshot.promise,
          getRuntimeStatus: () => status.promise,
        },
        runtimeId: "runtime-quiet",
        timeoutMs: 25,
      });
      const rejection = expect(recovery).rejects.toBeInstanceOf(
        AttachedSessionRecoveryTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects cross-runtime replies", async () => {
    await expect(
      loadAttachedSessionRecovery({
        api: {
          getSnapshot: async () =>
            ({ runtimeId: "other", backendMode: "real" }) as any,
          getRuntimeStatus: async () =>
            ({ runtimeId: "runtime-1", state: {} }) as any,
        },
        runtimeId: "runtime-1",
      }),
    ).rejects.toThrow("identity changed");
  });
});

describe("mergeRecoveredAttachedSession", () => {
  it("uses normalized runtime status instead of a conflicting raw streaming field", () => {
    const current = session("runtime-1");
    const recovered = projectAttachedSessionRecovery({
      snapshot: {
        runtimeId: "runtime-1",
        backendMode: "real",
        state: { isStreaming: false },
        messages: [],
      } as any,
      status: {
        runtimeId: "runtime-1",
        backendMode: "real",
        state: { isAgentActive: true },
      } as any,
      current,
      runtimeEventObserved: false,
      sessionFromSnapshot: () => session("runtime-1"),
      reconcileRuntimeStatus: (candidate, status) => ({
        ...candidate,
        status: status.state.isAgentActive ? "working" : "idle",
        baseState: status.state.isAgentActive ? "working" : "idle",
        overlays: {
          ...candidate.overlays,
          streaming: status.state.isAgentActive,
        },
      }),
    });

    expect(recovered).toMatchObject({
      status: "working",
      baseState: "working",
      overlays: { streaming: true },
    });
  });

  it("replaces previews with history while retaining workspace title authority", () => {
    const recovered = session("runtime-1", {
      workspaceId: "snapshot-workspace",
      title: "Generated title",
      timeline: [
        {
          id: "user-1",
          kind: "user",
          content: "durable prompt",
          createdAt: "10:00",
        },
      ],
    });
    const current = session("runtime-1", {
      workspaceId: "workspace-owner",
      title: "Renamed title",
      titleOverride: "Renamed title",
      timeline: [
        {
          id: "preview-1",
          kind: "diagnostic",
          tone: "info",
          content: "Saved session preview: durable prompt",
          createdAt: "Earlier",
        },
      ],
    });

    expect(
      mergeRecoveredAttachedSession(recovered, current, false),
    ).toMatchObject({
      workspaceId: "workspace-owner",
      title: "Renamed title",
      titleOverride: "Renamed title",
      timeline: [{ id: "user-1", content: "durable prompt" }],
    });
  });

  it("does not erase a newer event or pending extension interaction", () => {
    const recovered = session("runtime-1", {
      timeline: [
        {
          id: "assistant-1",
          kind: "assistant",
          content: "older snapshot",
          createdAt: "10:00",
        },
      ],
    });
    const current = session("runtime-1", {
      status: "waiting",
      baseState: "waitingForInput",
      overlays: { ...emptyOverlays, needsUserInput: true },
      lifecycle: { phase: "active", turnId: "turn-current" },
      pendingExtensionUiRequests: [
        {
          id: "approval-1",
          method: "confirm",
          title: "Approve action",
        } as any,
      ],
      timeline: [
        {
          id: "assistant-1",
          kind: "assistant",
          content: "newer streamed value",
          createdAt: "10:01",
          streaming: true,
        },
      ],
    });

    const merged = mergeRecoveredAttachedSession(recovered, current, true);
    expect(merged).toMatchObject({
      status: "waiting",
      baseState: "waitingForInput",
      overlays: { needsUserInput: true },
      lifecycle: { phase: "active", turnId: "turn-current" },
      pendingExtensionUiRequests: [{ id: "approval-1" }],
      timeline: [
        {
          id: "assistant-1",
          content: "newer streamed value",
          streaming: true,
        },
      ],
    });
  });
});
