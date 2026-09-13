import { describe, expect, it } from "vitest";
import { emptyOverlays, type BaseSessionState } from "./sessionState.js";
import {
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

  it("clears retry and ordinary error state while recording a missed completion diagnostic", () => {
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
      status: "idle",
      baseState: "idle",
      lastError: undefined,
      providerErrorObserved: false,
      awaitingAgentEnd: false,
      workingStartedAtMs: undefined,
      subtitle: "Idle · Pi RPC backend reconciled",
      lastRuntimeEventLabel: "Pi reconciliation confirmed completion",
      diagnostics: [
        "Reconciled from Pi runtime status because the live completion event was not observed.",
      ],
    });
    expect(reconciled.overlays).toMatchObject({
      streaming: false,
      toolRunning: false,
      retrying: false,
      compacting: true,
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
