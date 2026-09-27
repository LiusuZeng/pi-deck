import { describe, expect, it } from "vitest";
import { classifyActivity } from "./activityInbox.js";
import {
  reduceRuntimeEvent,
  type SessionViewModel,
} from "./sessionRuntimeReducer.js";
import { emptyOverlays, type BaseSessionState } from "./sessionState.js";
import {
  captureSessionReconciliationIdentity,
  isSessionReconciliationIdentityCurrent,
  reconcileSessionWithRuntimeStatus,
  shouldReconcileSession,
  type ReconciliationSessionStatus,
  type SessionForRuntimeReconciliation,
  type SessionForRuntimeReconciliationEligibility,
  type SessionRuntimeReconciliationDependencies,
} from "./sessionRuntimeReconciliation.js";

interface TestSession extends SessionForRuntimeReconciliation {
  diagnostics: string[];
}

function session(patch: Partial<TestSession> = {}): TestSession {
  return {
    id: "runtime-1",
    status: "idle",
    baseState: "idle",
    overlays: { ...emptyOverlays },
    subtitle: "Idle · Pi RPC backend",
    updatedAt: "Earlier",
    updatedAtMs: 1,
    diagnostics: [],
    ...patch,
    overlays: { ...emptyOverlays, ...patch.overlays },
  };
}

function runtimeStatus(isAgentActive: boolean, runtimeId = "runtime-1") {
  return { runtimeId, state: { isAgentActive } };
}

function dependencies(
  now = 500,
): SessionRuntimeReconciliationDependencies<TestSession> {
  return {
    backendLabel: () => "Pi RPC backend",
    appendInfoDiagnostic: (current, content) => ({
      ...current,
      diagnostics: [...current.diagnostics, content],
    }),
    now: () => now,
  };
}

function eligibilitySession(
  patch: Partial<SessionForRuntimeReconciliationEligibility> = {},
): SessionForRuntimeReconciliationEligibility {
  return {
    runtimeBacked: true,
    status: "idle",
    overlays: {
      streaming: false,
      toolRunning: false,
      compacting: false,
      retrying: false,
    },
    ...patch,
    overlays: {
      streaming: false,
      toolRunning: false,
      compacting: false,
      retrying: false,
      ...patch.overlays,
    },
  };
}

describe("shouldReconcileSession", () => {
  it("requires a runtime-backed session", () => {
    expect(
      shouldReconcileSession(
        eligibilitySession({
          runtimeBacked: false,
          status: "working",
          overlays: {
            streaming: false,
            toolRunning: false,
            compacting: false,
            retrying: true,
          },
        }),
      ),
    ).toBe(false);
  });

  it.each<ReconciliationSessionStatus>([
    "starting",
    "sending",
    "working",
    "aborting",
    "reconnecting",
  ])("reconciles a %s lifecycle", (status) => {
    expect(shouldReconcileSession(eligibilitySession({ status }))).toBe(true);
  });

  it("reconciles pending extension input", () => {
    expect(
      shouldReconcileSession(
        eligibilitySession({
          status: "waiting",
          overlays: {
            streaming: false,
            toolRunning: false,
            compacting: false,
            retrying: false,
          },
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["streaming", { streaming: true }, false],
    ["running tool", { toolRunning: true }, false],
    ["compacting", { compacting: true }, false],
    ["retrying", { retrying: true }, true],
  ] as const)(
    "is %s for an idle session with its overlay",
    (_overlay, overlays, expected) => {
      expect(
        shouldReconcileSession(
          eligibilitySession({
            overlays: {
              streaming: false,
              toolRunning: false,
              compacting: false,
              retrying: false,
              ...overlays,
            },
          }),
        ),
      ).toBe(expected);
    },
  );

  it.each<ReconciliationSessionStatus>(["idle", "error"])(
    "does not reconcile a settled %s session",
    (status) => {
      expect(shouldReconcileSession(eligibilitySession({ status }))).toBe(
        false,
      );
    },
  );
});

describe("reconcileSessionWithRuntimeStatus", () => {
  it("does not let deferred poll A settle a newer turn B on the same runtime", async () => {
    let resolvePoll!: (status: ReturnType<typeof runtimeStatus>) => void;
    const poll = new Promise<ReturnType<typeof runtimeStatus>>((resolve) => {
      resolvePoll = resolve;
    });
    let current = session({
      status: "working",
      baseState: "working",
      lifecycle: { phase: "active", turnId: "turn-a" },
    });
    const identity = captureSessionReconciliationIdentity(current);
    const applyPoll = poll.then((status) => {
      if (
        isSessionReconciliationIdentityCurrent(current, identity) &&
        shouldReconcileSession({ ...current, runtimeBacked: true })
      ) {
        current = reconcileSessionWithRuntimeStatus(
          current,
          status,
          dependencies(),
        );
      }
    });

    current = {
      ...current,
      status: "idle",
      baseState: "idle",
      lifecycle: {
        phase: "terminal",
        outcome: "completed",
        settledAtMs: 100,
        turnId: "turn-a",
      },
    };
    current = {
      ...current,
      status: "working",
      baseState: "working",
      lifecycle: { phase: "active", turnId: "turn-b" },
    };
    resolvePoll(runtimeStatus(false));
    await applyPoll;

    expect(current).toMatchObject({
      status: "working",
      baseState: "working",
      lifecycle: { phase: "active", turnId: "turn-b" },
    });
    expect(current.diagnostics).toEqual([]);
  });

  it.each<[ReconciliationSessionStatus, BaseSessionState]>([
    ["idle", "idle"],
    ["starting", "attaching"],
    ["sending", "attaching"],
    ["reconnecting", "working"],
    ["error", "error"],
  ])("confirms active %s lifecycle work", (status, baseState) => {
    const reconciled = reconcileSessionWithRuntimeStatus(
      session({ status, baseState }),
      runtimeStatus(true),
      dependencies(),
    );

    expect(reconciled).toMatchObject({
      status: "working",
      baseState: "working",
      subtitle: "Working · Pi RPC backend confirmed by Pi",
      lastRuntimeEventLabel: "Pi reconciliation confirmed active work",
    });
    expect(reconciled.overlays.streaming).toBe(true);
  });

  it("preserves pending extension input regardless of runtime activity", () => {
    const waiting = session({
      status: "waiting",
      baseState: "waitingForInput",
      overlays: { ...emptyOverlays, needsUserInput: true },
    });

    expect(
      reconcileSessionWithRuntimeStatus(
        waiting,
        runtimeStatus(true),
        dependencies(),
      ),
    ).toBe(waiting);
    expect(
      reconcileSessionWithRuntimeStatus(
        waiting,
        runtimeStatus(false),
        dependencies(),
      ),
    ).toBe(waiting);
  });

  it("preserves authoritative provider error evidence while recording reconciliation", () => {
    const reconciled = reconcileSessionWithRuntimeStatus(
      session({
        status: "working",
        baseState: "working",
        lastError: "Temporary provider failure",
        providerErrorObserved: true,
        awaitingAgentEnd: true,
        workingStartedAtMs: 42,
        overlays: {
          ...emptyOverlays,
          streaming: true,
          toolRunning: true,
          compacting: true,
          retrying: true,
        },
      }),
      runtimeStatus(false),
      dependencies(),
    );

    expect(reconciled).toMatchObject({
      status: "error",
      baseState: "error",
      lastError: "Temporary provider failure",
      providerErrorObserved: true,
      lifecycle: { phase: "terminal", outcome: "failed" },
      awaitingAgentEnd: false,
      workingStartedAtMs: undefined,
      subtitle: "Error · backend stream failed",
      lastRuntimeEventLabel: "Pi reconciliation preserved terminal failure",
      diagnostics: [
        "Reconciled from Pi runtime status because the live completion event was not observed.",
      ],
    });
    expect(reconciled.overlays).toMatchObject({
      streaming: false,
      toolRunning: false,
      retrying: false,
      compacting: false,
    });
  });

  it("repairs a missed agent_end from the real reducer into Completed Work", () => {
    const view: SessionViewModel = {
      id: "runtime-1",
      workspaceId: "workspace-a",
      title: "Repaired session",
      project: "Project",
      projectPath: "/project",
      subtitle: "Idle",
      status: "idle",
      updatedAt: "Earlier",
      updatedAtMs: 1,
      timeline: [],
      baseState: "idle",
      overlays: { ...emptyOverlays },
      runtimeBacked: true,
      backendMode: "real",
    };
    const started = reduceRuntimeEvent(view, {
      type: "agent_start",
      runtimeId: "runtime-1",
    } as any);
    const messageDone = reduceRuntimeEvent(started, {
      type: "message_update",
      runtimeId: "runtime-1",
      messageId: "assistant-1",
      role: "assistant",
      content: "Done",
      done: true,
    } as any);

    expect(messageDone).toMatchObject({
      status: "working",
      awaitingAgentEnd: true,
      lifecycle: { phase: "active" },
    });
    const reconciled = reconcileSessionWithRuntimeStatus(
      { ...messageDone, diagnostics: [] },
      runtimeStatus(false),
      dependencies(500),
    );
    expect(reconciled).toMatchObject({
      status: "idle",
      baseState: "idle",
      completedAtMs: 500,
      lifecycle: {
        phase: "terminal",
        outcome: "completed",
        settledAtMs: 500,
      },
    });
    expect(
      classifyActivity({ ...reconciled, workspaceName: "Workspace A" }),
    ).toBe("completed");
  });

  it("does not let an in-flight status result overwrite a newer reducer error", () => {
    const view: SessionViewModel = {
      id: "runtime-1",
      workspaceId: "workspace-a",
      title: "Errored session",
      project: "Project",
      projectPath: "/project",
      subtitle: "Working",
      status: "working",
      updatedAt: "Earlier",
      updatedAtMs: 1,
      timeline: [],
      baseState: "working",
      overlays: { ...emptyOverlays, streaming: true },
      runtimeBacked: true,
      backendMode: "real",
      lifecycle: { phase: "active" },
    };
    const failed = reduceRuntimeEvent(view, {
      type: "message_update",
      runtimeId: "runtime-1",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider failed",
      },
      assistantMessageEvent: { type: "error", reason: "error" },
    } as any);

    expect(shouldReconcileSession(failed)).toBe(false);
    const guarded = shouldReconcileSession(failed)
      ? reconcileSessionWithRuntimeStatus(
          { ...failed, diagnostics: [] },
          runtimeStatus(false),
          dependencies(),
        )
      : failed;
    expect(guarded).toBe(failed);
    expect(guarded).toMatchObject({
      status: "error",
      lifecycle: { phase: "terminal", outcome: "failed" },
      lastError: "provider failed",
    });
  });

  it("keeps #99 auth-required recovery and its original diagnostic pending", () => {
    const reconciled = reconcileSessionWithRuntimeStatus(
      session({
        status: "working",
        baseState: "working",
        failureKind: "auth-required",
        providerErrorObserved: true,
        lastError: "Provided authentication token is expired.",
      }),
      runtimeStatus(false),
      dependencies(),
    );

    expect(reconciled).toMatchObject({
      status: "error",
      baseState: "error",
      failureKind: "auth-required",
      providerErrorObserved: true,
      lastError: "Provided authentication token is expired.",
      subtitle: "Error · OpenAI authentication verification pending",
    });

    expect(
      reconcileSessionWithRuntimeStatus(
        session({
          status: "working",
          baseState: "working",
          failureKind: "auth-required",
          providerErrorObserved: false,
          lastError: "Provided authentication token is expired.",
        }),
        runtimeStatus(false),
        dependencies(),
      ).providerErrorObserved,
    ).toBe(false);
  });

  it("uses the injected clock before App appends the completion diagnostic", () => {
    let diagnosticInput: TestSession | undefined;
    const reconciled = reconcileSessionWithRuntimeStatus(
      session({ status: "working", baseState: "working" }),
      runtimeStatus(false),
      {
        ...dependencies(12_345),
        appendInfoDiagnostic: (current, content) => {
          diagnosticInput = current;
          return { ...current, diagnostics: [...current.diagnostics, content] };
        },
      },
    );

    expect(diagnosticInput).toMatchObject({
      updatedAt: "Now",
      updatedAtMs: 12_345,
    });
    expect(reconciled.updatedAtMs).toBe(12_345);
  });

  it("returns the original object for another runtime and active working or aborting sessions", () => {
    const current = session({ status: "working", baseState: "working" });
    const aborting = session({ status: "aborting", baseState: "working" });
    let diagnostics = 0;
    const noOpDependencies = {
      ...dependencies(),
      appendInfoDiagnostic: (current: TestSession, content: string) => {
        diagnostics += 1;
        return { ...current, diagnostics: [...current.diagnostics, content] };
      },
    };

    expect(
      reconcileSessionWithRuntimeStatus(
        current,
        runtimeStatus(false, "other-runtime"),
        noOpDependencies,
      ),
    ).toBe(current);
    expect(
      reconcileSessionWithRuntimeStatus(
        current,
        runtimeStatus(true),
        noOpDependencies,
      ),
    ).toBe(current);
    expect(
      reconcileSessionWithRuntimeStatus(
        aborting,
        runtimeStatus(true),
        noOpDependencies,
      ),
    ).toBe(aborting);
    expect(diagnostics).toBe(0);
  });
});
