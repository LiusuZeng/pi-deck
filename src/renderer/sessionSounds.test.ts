import { describe, expect, it, vi } from "vitest";
import type { ActivitySourceSession } from "./activityInbox.js";
import { emptyOverlays } from "./sessionState.js";
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
