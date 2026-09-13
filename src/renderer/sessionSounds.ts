import {
  classifyActivity,
  type ActivitySourceSession,
  type ActivityStatus,
} from "./activityInbox.js";

export type SessionSoundCue = "needsAttention" | "completed";

export interface SessionSoundSettings {
  needsAttention: boolean;
  completed: boolean;
}

export interface SessionSoundProjection {
  key: string;
  status: ActivityStatus | "none";
  completedTurnKey?: string;
}

export type SessionSoundMemoryByKey = Record<string, SessionSoundProjection>;

export interface SessionSoundRequest {
  key: string;
  cue: SessionSoundCue;
}

export const defaultSessionSoundSettings: SessionSoundSettings = Object.freeze({
  needsAttention: true,
  completed: true,
});

export function normalizeSessionSoundSettings(
  settings: Partial<SessionSoundSettings> | undefined,
): SessionSoundSettings {
  return {
    needsAttention:
      settings?.needsAttention ?? defaultSessionSoundSettings.needsAttention,
    completed: settings?.completed ?? defaultSessionSoundSettings.completed,
  };
}

export function sessionSoundKey(
  source: Pick<
    ActivitySourceSession,
    "id" | "runtimeId" | "sessionFile" | "sessionId" | "workspaceId"
  >,
): string {
  if (source.sessionFile !== undefined) {
    return `file:${source.sessionFile}`;
  }
  if (source.sessionId !== undefined) {
    return `session:${source.sessionId}`;
  }
  if (source.runtimeId !== undefined) {
    return `runtime:${source.runtimeId}`;
  }
  return `workspace:${source.workspaceId}:${source.id}`;
}

export function sessionSoundProjectionFromActivitySource(
  source: ActivitySourceSession,
): SessionSoundProjection | undefined {
  if (source.draftSession === true) {
    return undefined;
  }
  const completedTurnKey = finiteCompletedTurnKey(source.completedAtMs);
  const status = classifyActivity(source) ?? "none";
  return {
    key: sessionSoundKey(source),
    status,
    ...(completedTurnKey !== undefined ? { completedTurnKey } : {}),
  };
}

export function sessionSoundCueForTransition(
  previous: SessionSoundProjection | undefined,
  next: SessionSoundProjection,
  settings: Partial<SessionSoundSettings> | undefined,
): SessionSoundCue | undefined {
  if (previous === undefined) {
    return undefined;
  }

  const normalized = normalizeSessionSoundSettings(settings);
  if (
    normalized.needsAttention &&
    isActiveStatus(previous.status) &&
    next.status === "needsAttention"
  ) {
    return "needsAttention";
  }

  if (
    normalized.completed &&
    isActiveStatus(previous.status) &&
    next.status === "completed" &&
    next.completedTurnKey !== undefined &&
    next.completedTurnKey !== previous.completedTurnKey
  ) {
    return "completed";
  }

  return undefined;
}

export function collectSessionSoundRequests(input: {
  previous: SessionSoundMemoryByKey;
  sources: readonly ActivitySourceSession[];
  settings: Partial<SessionSoundSettings> | undefined;
}): { next: SessionSoundMemoryByKey; requests: SessionSoundRequest[] } {
  const projections = new Map<
    string,
    { projection: SessionSoundProjection; aliases: Set<string> }
  >();
  for (const source of input.sources) {
    const projection = sessionSoundProjectionFromActivitySource(source);
    if (projection === undefined) {
      continue;
    }
    const aliases = new Set(sessionSoundKeys(source));
    const existing = projections.get(projection.key);
    if (existing === undefined) {
      projections.set(projection.key, { projection, aliases });
      continue;
    }
    for (const alias of aliases) {
      existing.aliases.add(alias);
    }
    existing.projection = chooseCanonicalProjection(
      existing.projection,
      projection,
    );
  }

  const next: SessionSoundMemoryByKey = { ...input.previous };
  const requests: SessionSoundRequest[] = [];

  for (const { projection, aliases } of projections.values()) {
    const previous = firstKnownProjection(input.previous, aliases);
    const cue = sessionSoundCueForTransition(
      previous,
      projection,
      input.settings,
    );
    if (cue !== undefined) {
      requests.push({ key: projection.key, cue });
    }
    for (const alias of aliases) {
      if (alias !== projection.key) {
        delete next[alias];
      }
    }
    next[projection.key] = projection;
  }

  return { next, requests };
}

function sessionSoundKeys(
  source: Pick<
    ActivitySourceSession,
    "id" | "runtimeId" | "sessionFile" | "sessionId" | "workspaceId"
  >,
): string[] {
  return [
    ...(source.sessionFile === undefined ? [] : [`file:${source.sessionFile}`]),
    ...(source.sessionId === undefined ? [] : [`session:${source.sessionId}`]),
    ...(source.runtimeId === undefined ? [] : [`runtime:${source.runtimeId}`]),
    `workspace:${source.workspaceId}:${source.id}`,
  ];
}

function firstKnownProjection(
  previous: SessionSoundMemoryByKey,
  aliases: ReadonlySet<string>,
): SessionSoundProjection | undefined {
  for (const key of aliases) {
    const projection = previous[key];
    if (projection !== undefined) {
      return projection;
    }
  }
  return undefined;
}

function isActiveStatus(status: SessionSoundProjection["status"]): boolean {
  return status === "inProgress" || status === "queued";
}

function chooseCanonicalProjection(
  left: SessionSoundProjection,
  right: SessionSoundProjection,
): SessionSoundProjection {
  const leftRank = projectionRank(left);
  const rightRank = projectionRank(right);
  if (rightRank > leftRank) {
    return right;
  }
  if (leftRank > rightRank) {
    return left;
  }
  if (left.status === "completed" && right.status === "completed") {
    return Number(right.completedTurnKey ?? 0) >
      Number(left.completedTurnKey ?? 0)
      ? right
      : left;
  }
  return left;
}

function projectionRank(projection: SessionSoundProjection): number {
  switch (projection.status) {
    case "needsAttention":
      return 6;
    case "inProgress":
      return 5;
    case "failed":
      return 4;
    case "queued":
      return 3;
    case "completed":
      return 2;
    case "none":
      return 1;
    default:
      return 0;
  }
}

function finiteCompletedTurnKey(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

export interface SessionSoundPlayer {
  unlock(): void;
  play(cue: SessionSoundCue): void;
  deactivate(): void;
}

export type SessionSoundDiagnosticEvent =
  | { type: "context-created" }
  | { type: "context-create-failed" }
  | { type: "resume-requested" }
  | { type: "resume-succeeded" }
  | { type: "resume-failed" }
  | { type: "cue-scheduled"; cue: SessionSoundCue }
  | { type: "cue-failed"; cue: SessionSoundCue }
  | {
      type: "context-invalidated";
      reason: "deactivated" | "resume-failed" | "cue-failed";
    }
  | { type: "context-retired" }
  | { type: "context-retirement-failed" }
  | { type: "context-suspended" }
  | { type: "context-suspend-failed" };

export interface SessionSoundPlayerOptions {
  /**
   * Optional, non-logging lifecycle telemetry for diagnostics and tests. A
   * listener failure is ignored so sound diagnostics remain supplemental.
   */
  onDiagnostic?(event: SessionSoundDiagnosticEvent): void;
}

interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNode;
  readonly state?: AudioContextState;
  createGain(): GainNode;
  createOscillator(): OscillatorNode;
  resume?(): Promise<void>;
  close?(): Promise<void>;
  suspend?(): Promise<void>;
}

interface SourceLease {
  readonly oscillator: OscillatorNode;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  released: boolean;
}

interface RetiringContext {
  readonly context: AudioContextLike;
  closeRequested: boolean;
  suspendRequested: boolean;
}

type AudioContextConstructor = new () => AudioContextLike;

type WindowWithAudioContext = Window & {
  webkitAudioContext?: AudioContextConstructor;
};

export function hasEnabledSessionSound(
  settings: Partial<SessionSoundSettings> | undefined,
): boolean {
  const normalized = normalizeSessionSoundSettings(settings);
  return normalized.needsAttention || normalized.completed;
}

/**
 * A failed context is immediately removed from scheduling, but any sources it
 * already started are allowed to drain before close(). One quarantined context
 * may overlap its replacement; a second quarantine blocks further creation,
 * which bounds device contexts even if close() itself fails.
 */
export function createDefaultSessionSoundPlayer(
  options: SessionSoundPlayerOptions = {},
): SessionSoundPlayer {
  let audioContext: AudioContextLike | undefined;
  const sourceLeases = new Map<AudioContextLike, Set<SourceLease>>();
  const retiringContexts = new Map<AudioContextLike, RetiringContext>();
  let resumePromise:
    | { context: AudioContextLike; promise: Promise<boolean> }
    | undefined;

  function diagnose(event: SessionSoundDiagnosticEvent): void {
    try {
      options.onDiagnostic?.(event);
    } catch {
      // Diagnostics must never change player or Work behavior.
    }
  }

  function getAudioContext(): AudioContextLike | undefined {
    if (audioContext !== undefined) {
      return audioContext;
    }
    // One draining context may overlap a replacement. A second quarantined
    // context blocks creation, bounding this player to two device contexts.
    if (retiringContexts.size >= 2 || typeof window === "undefined") {
      return undefined;
    }
    const contextWindow = window as WindowWithAudioContext;
    const AudioContextCtor =
      (Reflect.get(contextWindow, "AudioContext") as
        | AudioContextConstructor
        | undefined) ?? contextWindow.webkitAudioContext;
    if (AudioContextCtor === undefined) {
      return undefined;
    }
    try {
      audioContext = new AudioContextCtor();
      diagnose({ type: "context-created" });
      return audioContext;
    } catch {
      diagnose({ type: "context-create-failed" });
      return undefined;
    }
  }

  function releaseSource(context: AudioContextLike, lease: SourceLease): void {
    if (lease.released) {
      return;
    }
    lease.released = true;
    if (lease.fallbackTimer !== undefined) {
      clearTimeout(lease.fallbackTimer);
    }
    const leases = sourceLeases.get(context);
    leases?.delete(lease);
    if (leases?.size === 0) {
      sourceLeases.delete(context);
    }
    const retiring = retiringContexts.get(context);
    if (retiring !== undefined) {
      closeWhenDrained(retiring);
    }
  }

  function trackSource(
    context: AudioContextLike,
    oscillator: OscillatorNode,
    endAt: number,
  ): void {
    const leases = sourceLeases.get(context) ?? new Set<SourceLease>();
    sourceLeases.set(context, leases);
    const lease: SourceLease = { oscillator, released: false };
    leases.add(lease);
    oscillator.onended = () => releaseSource(context, lease);
    // `ended` is authoritative. The bounded deadline asks a stalled source to
    // stop, but keeps it leased until it actually drains, so close() cannot
    // truncate output that is still active.
    const delayMs = Math.max(
      0,
      Math.min(2_000, (endAt - context.currentTime) * 1_000 + 50),
    );
    lease.fallbackTimer = setTimeout(() => {
      try {
        oscillator.stop(context.currentTime);
      } catch {
        // A stuck source remains quarantined; the two-context cap prevents a
        // broken implementation from creating an unbounded device leak.
      }
    }, delayMs);
  }

  function stopSources(context: AudioContextLike): void {
    for (const lease of sourceLeases.get(context) ?? []) {
      try {
        lease.oscillator.stop(context.currentTime);
      } catch {
        // A stuck source remains quarantined; the context cap bounds teardown.
      }
    }
  }

  function closeWhenDrained(retiring: RetiringContext): void {
    if (
      retiring.closeRequested ||
      (sourceLeases.get(retiring.context)?.size ?? 0) > 0
    ) {
      return;
    }
    if (retiring.context.close === undefined) {
      if (retiring.context.suspend === undefined || retiring.suspendRequested) {
        return;
      }
      retiring.suspendRequested = true;
      void Promise.resolve()
        .then(() => retiring.context.suspend?.())
        .then(() => diagnose({ type: "context-suspended" }))
        .catch(() => diagnose({ type: "context-suspend-failed" }));
      return;
    }

    retiring.closeRequested = true;
    void Promise.resolve()
      .then(() => retiring.context.close?.())
      .then(() => {
        if (retiringContexts.delete(retiring.context)) {
          diagnose({ type: "context-retired" });
        }
      })
      .catch(() => {
        // A failed close remains quarantined. Creation is bounded by the two
        // retirement slots rather than accumulating live device contexts.
        diagnose({ type: "context-retirement-failed" });
      });
  }

  function retire(
    context: AudioContextLike,
    reason: "deactivated" | "resume-failed" | "cue-failed",
    hardCleanup = false,
  ): void {
    if (audioContext !== context && !retiringContexts.has(context)) {
      return;
    }
    if (audioContext === context) {
      audioContext = undefined;
      diagnose({ type: "context-invalidated", reason });
    }
    const retiring = retiringContexts.get(context) ?? {
      context,
      closeRequested: false,
      suspendRequested: false,
    };
    retiringContexts.set(context, retiring);
    if (hardCleanup) {
      stopSources(context);
    }
    closeWhenDrained(retiring);
  }

  function resume(context: AudioContextLike): Promise<boolean> {
    if (resumePromise?.context === context) {
      return resumePromise.promise;
    }
    diagnose({ type: "resume-requested" });
    let pending:
      | { context: AudioContextLike; promise: Promise<boolean> }
      | undefined;
    const promise = (async () => {
      try {
        await context.resume?.();
        if (context.state === "closed") {
          diagnose({ type: "resume-failed" });
          retire(context, "resume-failed");
          return false;
        }
        if (audioContext !== context) {
          return false;
        }
        diagnose({ type: "resume-succeeded" });
        return true;
      } catch {
        diagnose({ type: "resume-failed" });
        retire(context, "resume-failed");
        return false;
      } finally {
        if (resumePromise === pending) {
          resumePromise = undefined;
        }
      }
    })();
    pending = { context, promise };
    resumePromise = pending;
    return promise;
  }

  return {
    unlock() {
      const context = getAudioContext();
      if (context !== undefined) {
        void resume(context);
      }
    },
    play(cue) {
      const context = getAudioContext();
      if (context === undefined) {
        return;
      }
      void resume(context).then((resumed) => {
        if (!resumed || audioContext !== context) {
          return;
        }
        try {
          playCue(context, cue, trackSource);
          diagnose({ type: "cue-scheduled", cue });
        } catch {
          diagnose({ type: "cue-failed", cue });
          retire(context, "cue-failed");
        }
      });
    },
    deactivate() {
      if (audioContext !== undefined) {
        retire(audioContext, "deactivated", true);
      }
      // Teardown also stops sources owned by an already quarantined context.
      for (const retiring of retiringContexts.values()) {
        retire(retiring.context, "deactivated", true);
      }
    },
  };
}

function playCue(
  context: AudioContextLike,
  cue: SessionSoundCue,
  trackSource: (
    context: AudioContextLike,
    oscillator: OscillatorNode,
    endAt: number,
  ) => void,
): void {
  const startAt = context.currentTime + 0.01;
  const tones =
    cue === "needsAttention"
      ? [
          { frequency: 880, offset: 0, duration: 0.08 },
          { frequency: 660, offset: 0.11, duration: 0.12 },
        ]
      : [
          { frequency: 523.25, offset: 0, duration: 0.06 },
          { frequency: 659.25, offset: 0.07, duration: 0.06 },
          { frequency: 783.99, offset: 0.14, duration: 0.09 },
        ];

  for (const tone of tones) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(tone.frequency, startAt + tone.offset);
    gain.gain.setValueAtTime(0.0001, startAt + tone.offset);
    gain.gain.exponentialRampToValueAtTime(0.04, startAt + tone.offset + 0.01);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      startAt + tone.offset + tone.duration,
    );
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt + tone.offset);
    const endAt = startAt + tone.offset + tone.duration + 0.02;
    trackSource(context, oscillator, endAt);
    oscillator.stop(endAt);
  }
}
