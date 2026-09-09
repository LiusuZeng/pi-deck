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
}

interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNode;
  createGain(): GainNode;
  createOscillator(): OscillatorNode;
  resume?(): Promise<void>;
}

type AudioContextConstructor = new () => AudioContextLike;

type WindowWithAudioContext = Window & {
  webkitAudioContext?: AudioContextConstructor;
};

export function createDefaultSessionSoundPlayer(): SessionSoundPlayer {
  let audioContext: AudioContextLike | undefined;
  let resumePromise: Promise<boolean> | undefined;

  function getAudioContext(): AudioContextLike | undefined {
    if (audioContext !== undefined) {
      return audioContext;
    }
    if (typeof window === "undefined") {
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
      return audioContext;
    } catch {
      return undefined;
    }
  }

  function resume(context: AudioContextLike): Promise<boolean> {
    if (resumePromise !== undefined) {
      return resumePromise;
    }
    resumePromise = (async () => {
      try {
        await context.resume?.();
        return true;
      } catch {
        return false;
      } finally {
        resumePromise = undefined;
      }
    })();
    return resumePromise;
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
        if (!resumed) {
          return;
        }
        try {
          playCue(context, cue);
        } catch {
          // Sound is supplemental; playback failures must never affect Work state.
        }
      });
    },
  };
}

function playCue(context: AudioContextLike, cue: SessionSoundCue): void {
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
    oscillator.stop(startAt + tone.offset + tone.duration + 0.02);
  }
}
