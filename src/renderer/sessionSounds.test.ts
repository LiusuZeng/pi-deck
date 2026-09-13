import { describe, expect, it, vi } from "vitest";
import type { ActivitySourceSession } from "./activityInbox.js";
import {
  createInitialReducedSessionState,
  emptyOverlays,
  reduceSessionRuntimeEvent,
} from "./sessionState.js";
import {
  collectSessionSoundRequests,
  createDefaultSessionSoundPlayer,
  sessionSoundCueForTransition,
  sessionSoundProjectionFromActivitySource,
  type SessionSoundMemoryByKey,
  type SessionSoundProjection,
} from "./sessionSounds.js";

function source(
  patch: Partial<ActivitySourceSession> & { id?: string } = {},
): ActivitySourceSession {
  return {
    id: patch.id ?? "runtime-1",
    workspaceId: patch.workspaceId ?? "workspace-1",
    runtimeId: patch.runtimeId ?? patch.id ?? "runtime-1",
    title: patch.title ?? "Session",
    workspaceName: patch.workspaceName ?? "Workspace",
    updatedAtMs: patch.updatedAtMs ?? 1,
    baseState: patch.baseState ?? "idle",
    overlays: { ...emptyOverlays, ...patch.overlays },
    ...patch,
  };
}

function projection(
  patch: Partial<SessionSoundProjection>,
): SessionSoundProjection {
  return {
    key: patch.key ?? "runtime:runtime-1",
    status: patch.status ?? "none",
    ...(patch.completedTurnKey !== undefined
      ? { completedTurnKey: patch.completedTurnKey }
      : {}),
  };
}

function collect(
  previous: SessionSoundMemoryByKey,
  sources: ActivitySourceSession[],
  settings = { needsAttention: true, completed: true },
) {
  return collectSessionSoundRequests({ previous, sources, settings });
}

describe("session sound playback", () => {
  it("does not schedule a cue when audio cannot resume", async () => {
    const resume = vi.fn().mockRejectedValue(new Error("not allowed"));
    const createOscillator = vi.fn();
    vi.stubGlobal("window", {
      AudioContext: class {
        readonly currentTime = 0;
        readonly destination = {} as AudioNode;
        readonly resume = resume;
        createGain(): GainNode {
          throw new Error("should not create gain");
        }
        createOscillator(): OscillatorNode {
          createOscillator();
          throw new Error("should not create oscillator");
        }
      },
    });

    try {
      createDefaultSessionSoundPlayer().play("completed");
      await new Promise((resolve) => setTimeout(resolve));
      expect(resume).toHaveBeenCalledOnce();
      expect(createOscillator).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("unlocks audio on gesture before scheduling a later cue", async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    const createOscillator = vi.fn(
      () =>
        ({
          type: "sine",
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        }) as unknown as OscillatorNode,
    );
    const createGain = vi.fn(
      () =>
        ({
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        }) as unknown as GainNode,
    );
    vi.stubGlobal("window", {
      AudioContext: class {
        readonly currentTime = 0;
        readonly destination = {} as AudioNode;
        readonly resume = resume;
        readonly createGain = createGain;
        readonly createOscillator = createOscillator;
      },
    });

    try {
      const player = createDefaultSessionSoundPlayer();
      player.unlock();
      await new Promise((resolve) => setTimeout(resolve));
      expect(resume).toHaveBeenCalledOnce();

      player.play("needsAttention");
      await new Promise((resolve) => setTimeout(resolve));
      expect(resume).toHaveBeenCalledTimes(2);
      expect(createOscillator).toHaveBeenCalledTimes(2);
      expect(createGain).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retires a failed context and recovers a later cue with lifecycle diagnostics", async () => {
    const events: string[] = [];
    const createOscillator = vi.fn(
      () =>
        ({
          type: "sine",
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        }) as unknown as OscillatorNode,
    );
    const createGain = vi.fn(
      () =>
        ({
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        }) as unknown as GainNode,
    );
    const firstClose = vi.fn().mockResolvedValue(undefined);
    const contexts = [
      {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: vi
          .fn()
          .mockRejectedValue(new Error("audio device unavailable")),
        close: firstClose,
        createGain,
        createOscillator,
      },
      {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        createGain,
        createOscillator,
      },
    ];
    const AudioContext = vi.fn(function () {
      return contexts.shift();
    });
    vi.stubGlobal("window", { AudioContext });

    try {
      const player = createDefaultSessionSoundPlayer({
        onDiagnostic: (event) => events.push(event.type),
      });
      player.play("completed");
      await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
      expect(createOscillator).not.toHaveBeenCalled();

      player.play("needsAttention");
      await vi.waitFor(() => expect(createOscillator).toHaveBeenCalledTimes(2));
      expect(AudioContext).toHaveBeenCalledTimes(2);
      expect(events).toEqual(
        expect.arrayContaining([
          "context-created",
          "resume-requested",
          "resume-failed",
          "context-invalidated",
          "context-retired",
          "resume-succeeded",
          "cue-scheduled",
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets one replacement play while a failed context is closing", async () => {
    let finishClose: (() => void) | undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const createOscillator = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("schedule failed");
      })
      .mockImplementation(
        () =>
          ({
            type: "sine",
            frequency: { setValueAtTime: vi.fn() },
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
          }) as unknown as OscillatorNode,
      );
    const createGain = vi.fn(
      () =>
        ({
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        }) as unknown as GainNode,
    );
    const contexts = [
      {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: vi.fn().mockResolvedValue(undefined),
        close,
        createGain,
        createOscillator,
      },
      {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        createGain,
        createOscillator,
      },
    ];
    const AudioContext = vi.fn(function () {
      return contexts.shift();
    });
    vi.stubGlobal("window", { AudioContext });

    try {
      const events: string[] = [];
      const player = createDefaultSessionSoundPlayer({
        onDiagnostic: (event) => events.push(event.type),
      });
      player.play("needsAttention");
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      player.play("completed");
      await vi.waitFor(() => expect(AudioContext).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(createOscillator).toHaveBeenCalledTimes(4));

      finishClose?.();
      await vi.waitFor(() => expect(events).toContain("context-retired"));
      player.play("needsAttention");
      await vi.waitFor(() => expect(createOscillator).toHaveBeenCalledTimes(6));
      expect(AudioContext).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defers close until overlapping nodes end, then lets a replacement serve the next cue", async () => {
    type FakeNode = OscillatorNode & { end(): void; ended: boolean };
    const firstNodes: FakeNode[] = [];
    const firstCloseSawOnlyEndedNodes: boolean[] = [];
    const createFirstNode = vi.fn(() => {
      const node = {
        type: "sine",
        ended: false,
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
        end() {
          node.ended = true;
          node.onended?.();
        },
      } as unknown as FakeNode;
      firstNodes.push(node);
      return node;
    });
    const createGain = vi.fn(
      () =>
        ({
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        }) as unknown as GainNode,
    );
    const firstClose = vi.fn(() => {
      firstCloseSawOnlyEndedNodes.push(firstNodes.every((node) => node.ended));
      return Promise.resolve();
    });
    const contexts = [
      {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("later resume failed")),
        close: firstClose,
        createGain,
        createOscillator: createFirstNode,
      },
      {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        createGain,
        createOscillator: vi.fn(
          () =>
            ({
              type: "sine",
              frequency: { setValueAtTime: vi.fn() },
              connect: vi.fn(),
              start: vi.fn(),
              stop: vi.fn(),
            }) as unknown as OscillatorNode,
        ),
      },
    ];
    const AudioContext = vi.fn(function () {
      return contexts.shift();
    });
    vi.stubGlobal("window", { AudioContext });

    try {
      const player = createDefaultSessionSoundPlayer();
      player.play("completed");
      await vi.waitFor(() => expect(firstNodes).toHaveLength(3));

      player.play("needsAttention");
      await vi.waitFor(() => expect(firstClose).not.toHaveBeenCalled());
      player.play("needsAttention");
      await vi.waitFor(() => expect(AudioContext).toHaveBeenCalledTimes(2));
      expect(firstClose).not.toHaveBeenCalled();

      for (const node of firstNodes) {
        node.end();
      }
      await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
      expect(firstCloseSawOnlyEndedNodes).toEqual([true]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not close a quarantined context when a stalled source misses its deadline", async () => {
    type FakeNode = OscillatorNode & { end(): void };
    const nodes: FakeNode[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    const AudioContext = vi.fn(function () {
      return {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("later resume failed")),
        close,
        createGain: vi.fn(
          () =>
            ({
              gain: {
                setValueAtTime: vi.fn(),
                exponentialRampToValueAtTime: vi.fn(),
              },
              connect: vi.fn(),
            }) as unknown as GainNode,
        ),
        createOscillator: vi.fn(() => {
          const node = {
            type: "sine",
            frequency: { setValueAtTime: vi.fn() },
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
            onended: null as (() => void) | null,
            end() {
              node.onended?.();
            },
          } as unknown as FakeNode;
          nodes.push(node);
          return node;
        }),
      } as unknown as AudioContext;
    });
    vi.stubGlobal("window", { AudioContext });

    try {
      const player = createDefaultSessionSoundPlayer();
      player.play("needsAttention");
      await vi.waitFor(() => expect(nodes).toHaveLength(2));
      player.play("completed");
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(
        nodes.every((node) => vi.mocked(node.stop).mock.calls.length >= 2),
      ).toBe(true);
      expect(close).not.toHaveBeenCalled();

      for (const node of nodes) {
        node.end();
      }
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("quarantines failed closes without accumulating beyond two contexts", async () => {
    const close = vi.fn().mockRejectedValue(new Error("close failed"));
    const contexts = Array.from({ length: 2 }, () => ({
      currentTime: 0,
      destination: {} as AudioNode,
      resume: vi.fn().mockRejectedValue(new Error("resume failed")),
      close,
      createGain: vi.fn(),
      createOscillator: vi.fn(),
    }));
    const AudioContext = vi.fn(function () {
      return contexts.shift();
    });
    vi.stubGlobal("window", { AudioContext });

    try {
      const events: string[] = [];
      const player = createDefaultSessionSoundPlayer({
        onDiagnostic: (event) => events.push(event.type),
      });
      player.play("completed");
      await vi.waitFor(() =>
        expect(events).toContain("context-retirement-failed"),
      );
      player.play("needsAttention");
      await vi.waitFor(() => expect(AudioContext).toHaveBeenCalledTimes(2));
      player.play("completed");
      expect(AudioContext).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("quarantines an uncloseable fallback instead of reusing it", async () => {
    const suspend = vi.fn().mockResolvedValue(undefined);
    const createOscillator = vi.fn(
      () =>
        ({
          type: "sine",
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        }) as unknown as OscillatorNode,
    );
    const AudioContext = vi.fn(function () {
      return {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: vi.fn().mockResolvedValue(undefined),
        suspend,
        createGain: vi.fn(
          () =>
            ({
              gain: {
                setValueAtTime: vi.fn(),
                exponentialRampToValueAtTime: vi.fn(),
              },
              connect: vi.fn(),
            }) as unknown as GainNode,
        ),
        createOscillator,
      } as unknown as AudioContext;
    });
    vi.stubGlobal("window", { AudioContext });

    try {
      const player = createDefaultSessionSoundPlayer();
      player.unlock();
      await vi.waitFor(() => expect(AudioContext).toHaveBeenCalledOnce());
      player.deactivate();
      await vi.waitFor(() => expect(suspend).toHaveBeenCalledOnce());
      player.play("needsAttention");
      await vi.waitFor(() => expect(createOscillator).toHaveBeenCalledTimes(2));
      expect(AudioContext).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hard cleanup stops sources and closes only after they end", async () => {
    type FakeNode = OscillatorNode & { end(): void; ended: boolean };
    const nodes: FakeNode[] = [];
    const closeSawOnlyEndedNodes: boolean[] = [];
    const close = vi.fn(() => {
      closeSawOnlyEndedNodes.push(nodes.every((node) => node.ended));
      return Promise.resolve();
    });
    const AudioContext = vi.fn(function () {
      return {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: vi.fn().mockResolvedValue(undefined),
        close,
        createGain: vi.fn(
          () =>
            ({
              gain: {
                setValueAtTime: vi.fn(),
                exponentialRampToValueAtTime: vi.fn(),
              },
              connect: vi.fn(),
            }) as unknown as GainNode,
        ),
        createOscillator: vi.fn(() => {
          const node = {
            type: "sine",
            ended: false,
            frequency: { setValueAtTime: vi.fn() },
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
            onended: null as (() => void) | null,
            end() {
              node.ended = true;
              node.onended?.();
            },
          } as unknown as FakeNode;
          nodes.push(node);
          return node;
        }),
      } as unknown as AudioContext;
    });
    vi.stubGlobal("window", { AudioContext });

    try {
      const player = createDefaultSessionSoundPlayer();
      player.play("needsAttention");
      await vi.waitFor(() => expect(nodes).toHaveLength(2));
      player.deactivate();
      expect(close).not.toHaveBeenCalled();
      expect(
        nodes.every((node) =>
          vi.mocked(node.stop).mock.calls.some(([at]) => at === 0),
        ),
      ).toBe(true);

      for (const node of nodes) {
        node.end();
      }
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(closeSawOnlyEndedNodes).toEqual([true]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a replacement resume pending when an old context settles", async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const firstResume = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const secondResume = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSecond = resolve;
        }),
    );
    const firstClose = vi.fn().mockResolvedValue(undefined);
    const contexts = [
      {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: firstResume,
        close: firstClose,
        createGain: vi.fn(),
        createOscillator: vi.fn(),
      },
      {
        currentTime: 0,
        destination: {} as AudioNode,
        resume: secondResume,
        close: vi.fn().mockResolvedValue(undefined),
        createGain: vi.fn(),
        createOscillator: vi.fn(),
      },
    ];
    const AudioContext = vi.fn(function () {
      return contexts.shift();
    });
    vi.stubGlobal("window", { AudioContext });

    try {
      const events: string[] = [];
      const player = createDefaultSessionSoundPlayer({
        onDiagnostic: (event) => events.push(event.type),
      });
      player.unlock();
      player.deactivate();
      await vi.waitFor(() => expect(events).toContain("context-retired"));
      player.unlock();
      await vi.waitFor(() => expect(secondResume).toHaveBeenCalledOnce());
      resolveFirst?.();
      await vi.waitFor(() => expect(resolveFirst).toBeDefined());
      player.unlock();
      expect(secondResume).toHaveBeenCalledOnce();
      resolveSecond?.();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("contains sound failures without changing Work transition requests", async () => {
    vi.stubGlobal("window", {
      AudioContext: class {
        readonly currentTime = 0;
        readonly destination = {} as AudioNode;
        readonly resume = vi.fn().mockRejectedValue(new Error("unavailable"));
        readonly createGain = vi.fn();
        readonly createOscillator = vi.fn();
      },
    });

    try {
      createDefaultSessionSoundPlayer().play("completed");
      const result = collect(
        { "runtime:runtime-1": projection({ status: "inProgress" }) },
        [source({ completedAtMs: 100 })],
      );
      expect(result.requests).toEqual([
        { key: "runtime:runtime-1", cue: "completed" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("session sound transitions", () => {
  it("plays attention once for an in-progress to needs-attention transition", () => {
    const cue = sessionSoundCueForTransition(
      projection({ status: "inProgress" }),
      projection({ status: "needsAttention" }),
      { needsAttention: true, completed: true },
    );

    expect(cue).toBe("needsAttention");
  });

  it("does not request attention sound for a failed tool_execution_end", () => {
    let reduced = createInitialReducedSessionState();
    reduced = reduceSessionRuntimeEvent(reduced, { type: "agent_start" });
    reduced = reduceSessionRuntimeEvent(reduced, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      name: "bash",
    });
    reduced = reduceSessionRuntimeEvent(reduced, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      status: "failed",
      output: "command failed",
    });

    const result = collect(
      { "runtime:runtime-1": projection({ status: "inProgress" }) },
      [
        source({
          baseState: reduced.baseState,
          overlays: reduced.overlays,
        }),
      ],
    );

    expect(reduced.toolCards["tool-1"]).toMatchObject({
      status: "error",
      isError: true,
    });
    expect(result.next["runtime:runtime-1"]?.status).toBe("inProgress");
    expect(result.requests).toEqual([]);
  });

  it("plays attention when pending extension input survives a production provider error update", () => {
    const failedAssistant = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Provider quota exhausted.",
    };
    let reduced = createInitialReducedSessionState();
    reduced = reduceSessionRuntimeEvent(reduced, { type: "agent_start" });
    reduced = reduceSessionRuntimeEvent(reduced, {
      type: "extension_ui_request",
      requestId: "approval-1",
      method: "confirm",
    });
    reduced = reduceSessionRuntimeEvent(reduced, {
      type: "message_update",
      message: failedAssistant,
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: failedAssistant,
      },
    });

    const result = collect(
      { "runtime:runtime-1": projection({ status: "inProgress" }) },
      [
        source({
          baseState: reduced.baseState,
          overlays: reduced.overlays,
        }),
      ],
    );

    expect(result.next["runtime:runtime-1"]?.status).toBe("needsAttention");
    expect(result.requests).toEqual([
      { key: "runtime:runtime-1", cue: "needsAttention" },
    ]);
  });

  it("keeps an unplanned extension-response race Failed without an attention cue", () => {
    let reduced = createInitialReducedSessionState();
    reduced = reduceSessionRuntimeEvent(reduced, { type: "agent_start" });
    reduced = reduceSessionRuntimeEvent(reduced, {
      type: "extension_ui_request",
      requestId: "approval-1",
      method: "confirm",
    });
    const exited = reduceSessionRuntimeEvent(reduced, {
      type: "worker_exit",
      intentional: false,
    });
    reduced = reduceSessionRuntimeEvent(exited, {
      type: "extension_ui_response_sent",
      requestId: "approval-1",
    });

    const result = collect(
      { "runtime:runtime-1": projection({ status: "inProgress" }) },
      [
        source({
          baseState: reduced.baseState,
          overlays: reduced.overlays,
        }),
      ],
    );

    expect(reduced).toBe(exited);
    expect(reduced.pendingExtensionUiQueue).toEqual([]);
    expect(result.next["runtime:runtime-1"]?.status).toBe("failed");
    expect(result.requests).toEqual([]);
  });

  it("keeps production extension input and sound attention aligned through retry failure", () => {
    const finalError = "Retry exhausted while approval is pending.";
    let reduced = createInitialReducedSessionState();
    const events = [
      { type: "agent_start" },
      { type: "extension_ui_request", id: "approval-1", method: "confirm" },
      { type: "tool_execution_start", toolCallId: "tool-1", name: "bash" },
      {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        output: "checking",
      },
      { type: "tool_execution_end", toolCallId: "tool-1", output: "done" },
      { type: "agent_end", willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 1 },
      {
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError,
      },
    ];
    for (const event of events) {
      reduced = reduceSessionRuntimeEvent(reduced, event);
    }

    const waiting = collect(
      { "runtime:runtime-1": projection({ status: "inProgress" }) },
      [
        source({
          baseState: reduced.baseState,
          overlays: reduced.overlays,
        }),
      ],
    );
    expect(waiting.next["runtime:runtime-1"]?.status).toBe("needsAttention");
    expect(waiting.requests).toEqual([
      { key: "runtime:runtime-1", cue: "needsAttention" },
    ]);

    reduced = reduceSessionRuntimeEvent(reduced, {
      type: "extension_ui_response_sent",
      requestId: "approval-1",
    });
    const resolved = collect(waiting.next, [
      source({ baseState: reduced.baseState, overlays: reduced.overlays }),
    ]);
    expect(reduced.diagnostics).toContain(finalError);
    expect(resolved.next["runtime:runtime-1"]?.status).toBe("failed");
    expect(resolved.requests).toEqual([]);
  });

  it("does not play attention for first observed or non-working needs-attention state", () => {
    const cue = sessionSoundCueForTransition(
      projection({ status: "none" }),
      projection({ status: "needsAttention" }),
      { needsAttention: true, completed: true },
    );

    expect(cue).toBeUndefined();
  });

  it("does not replay attention while a refresh remains needs-attention", () => {
    const cue = sessionSoundCueForTransition(
      projection({ status: "needsAttention" }),
      projection({ status: "needsAttention" }),
      { needsAttention: true, completed: true },
    );

    expect(cue).toBeUndefined();
  });

  it("can play attention again after the session returns to working", () => {
    let state: SessionSoundMemoryByKey = {
      "runtime:runtime-1": projection({ status: "needsAttention" }),
    };
    state = collect(state, [source({ baseState: "working" })]).next;
    const result = collect(state, [
      source({
        baseState: "waitingForInput",
        status: "waiting",
        overlays: { needsUserInput: true },
      }),
    ]);

    expect(result.requests).toEqual([
      { key: "runtime:runtime-1", cue: "needsAttention" },
    ]);
  });

  it("plays completion once for an active to completed transition", () => {
    expect(
      sessionSoundCueForTransition(
        projection({ status: "inProgress" }),
        projection({ status: "completed", completedTurnKey: "100" }),
        { needsAttention: true, completed: true },
      ),
    ).toBe("completed");
    expect(
      sessionSoundCueForTransition(
        projection({ status: "queued" }),
        projection({ status: "completed", completedTurnKey: "100" }),
        { needsAttention: true, completed: true },
      ),
    ).toBe("completed");
  });

  it("does not replay duplicate terminal or reconciliation completions", () => {
    const first = collect(
      {
        "file:/tmp/session.jsonl": projection({
          key: "file:/tmp/session.jsonl",
          status: "inProgress",
        }),
      },
      [
        source({
          id: "runtime-1",
          runtimeId: "runtime-1",
          sessionFile: "/tmp/session.jsonl",
          completedAtMs: 100,
        }),
      ],
    );
    const second = collect(first.next, [
      source({
        id: "runtime-1",
        runtimeId: "runtime-1",
        sessionFile: "/tmp/session.jsonl",
        completedAtMs: 100,
      }),
    ]);

    expect(first.requests).toEqual([
      { key: "file:/tmp/session.jsonl", cue: "completed" },
    ]);
    expect(second.requests).toEqual([]);
  });

  it("does not play completion when opening or first observing an already-completed session", () => {
    const result = collect({}, [
      source({
        id: "saved-1",
        runtimeId: undefined,
        sessionFile: "/tmp/session.jsonl",
        completedAtMs: 100,
      }),
    ]);

    expect(result.requests).toEqual([]);
  });

  it("does not play completion on relaunch rehydration of completed state", () => {
    const result = collect({}, [
      source({
        id: "saved-1",
        runtimeId: undefined,
        sessionFile: "/tmp/session.jsonl",
        completedAtMs: 100,
      }),
      source({
        id: "runtime-1",
        runtimeId: "runtime-1",
        sessionFile: "/tmp/session.jsonl",
        completedAtMs: 100,
      }),
    ]);

    expect(result.requests).toEqual([]);
  });

  it("plays completion for a later follow-up after the session worked again", () => {
    let state = collect({}, [
      source({ sessionFile: "/tmp/session.jsonl", completedAtMs: 100 }),
    ]).next;
    state = collect(state, [
      source({ sessionFile: "/tmp/session.jsonl", baseState: "working" }),
    ]).next;
    const result = collect(state, [
      source({ sessionFile: "/tmp/session.jsonl", completedAtMs: 200 }),
    ]);

    expect(result.requests).toEqual([
      { key: "file:/tmp/session.jsonl", cue: "completed" },
    ]);
  });

  it("suppresses only the disabled attention cue", () => {
    expect(
      sessionSoundCueForTransition(
        projection({ status: "inProgress" }),
        projection({ status: "needsAttention" }),
        { needsAttention: false, completed: true },
      ),
    ).toBeUndefined();
    expect(
      sessionSoundCueForTransition(
        projection({ status: "inProgress" }),
        projection({ status: "completed", completedTurnKey: "100" }),
        { needsAttention: false, completed: true },
      ),
    ).toBe("completed");
  });

  it("suppresses only the disabled completion cue", () => {
    expect(
      sessionSoundCueForTransition(
        projection({ status: "inProgress" }),
        projection({ status: "completed", completedTurnKey: "100" }),
        { needsAttention: true, completed: false },
      ),
    ).toBeUndefined();
    expect(
      sessionSoundCueForTransition(
        projection({ status: "inProgress" }),
        projection({ status: "needsAttention" }),
        { needsAttention: true, completed: false },
      ),
    ).toBe("needsAttention");
  });

  it("allows disabling all sounds", () => {
    expect(
      sessionSoundCueForTransition(
        projection({ status: "inProgress" }),
        projection({ status: "needsAttention" }),
        { needsAttention: false, completed: false },
      ),
    ).toBeUndefined();
    expect(
      sessionSoundCueForTransition(
        projection({ status: "inProgress" }),
        projection({ status: "completed", completedTurnKey: "100" }),
        { needsAttention: false, completed: false },
      ),
    ).toBeUndefined();
  });

  it("plays for background sessions because selection is not part of the projection", () => {
    const result = collect(
      {
        "runtime:background-runtime": projection({
          key: "runtime:background-runtime",
          status: "inProgress",
        }),
      },
      [
        source({
          id: "background-runtime",
          runtimeId: "background-runtime",
          completedAtMs: 100,
        }),
      ],
    );

    expect(result.requests).toEqual([
      { key: "runtime:background-runtime", cue: "completed" },
    ]);
  });

  it("does not duplicate playback when workspace navigation re-observes completed state", () => {
    const state = collect(
      {
        "file:/tmp/session.jsonl": projection({
          key: "file:/tmp/session.jsonl",
          status: "completed",
          completedTurnKey: "100",
        }),
      },
      [],
    ).next;
    const result = collect(state, [
      source({ sessionFile: "/tmp/session.jsonl", completedAtMs: 100 }),
    ]);

    expect(result.requests).toEqual([]);
  });

  it("retains lifecycle memory when a runtime gains a session file", () => {
    let state = collect({}, [source({ baseState: "working" })]).next;
    const result = collect(state, [
      source({
        baseState: "idle",
        sessionFile: "/tmp/session.jsonl",
        completedAtMs: 100,
      }),
    ]);

    expect(result.requests).toEqual([
      { key: "file:/tmp/session.jsonl", cue: "completed" },
    ]);
    expect(result.next).not.toHaveProperty("runtime:runtime-1");
  });

  it("deduplicates runtime and saved representations by canonical session file", () => {
    const result = collect(
      {
        "file:/tmp/session.jsonl": projection({
          key: "file:/tmp/session.jsonl",
          status: "inProgress",
        }),
      },
      [
        source({ sessionFile: "/tmp/session.jsonl", completedAtMs: 100 }),
        source({
          id: "saved-1",
          runtimeId: undefined,
          sessionFile: "/tmp/session.jsonl",
          completedAtMs: 100,
        }),
      ],
    );

    expect(result.requests).toEqual([
      { key: "file:/tmp/session.jsonl", cue: "completed" },
    ]);
  });

  it("ignores ordinary tool, thinking, progress, and queued updates", () => {
    const previous = {
      "runtime:runtime-1": projection({ status: "inProgress" }),
    };
    expect(
      collect(previous, [
        source({ baseState: "working", overlays: { toolRunning: true } }),
      ]).requests,
    ).toEqual([]);
    expect(
      collect(previous, [
        source({ baseState: "working", overlays: { compacting: true } }),
      ]).requests,
    ).toEqual([]);
    expect(
      collect(previous, [
        source({
          baseState: "idle",
          overlays: { piQueuedFollowUpCount: 1 },
        }),
      ]).requests,
    ).toEqual([]);
  });

  it("does not play completion for failed state", () => {
    const result = collect(
      { "runtime:runtime-1": projection({ status: "inProgress" }) },
      [
        source({
          baseState: "error",
          status: "error",
          completedAtMs: undefined,
        }),
      ],
    );

    expect(result.requests).toEqual([]);
  });

  it("projects needs-attention and completed from the same activity state used by Work", () => {
    expect(
      sessionSoundProjectionFromActivitySource(
        source({
          baseState: "waitingForInput",
          status: "waiting",
          overlays: { needsUserInput: true },
        }),
      ),
    ).toMatchObject({ status: "needsAttention" });
    expect(
      sessionSoundProjectionFromActivitySource(source({ completedAtMs: 100 })),
    ).toMatchObject({ status: "completed", completedTurnKey: "100" });
  });
});
