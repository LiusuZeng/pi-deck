import type {
  ChatRuntimeEvent,
  ChatRuntimeStatus,
  ChatSnapshot,
} from "../shared/types.js";
import type { SessionViewModel } from "./sessionRuntimeReducer.js";

export const ATTACHED_SESSION_RECOVERY_TIMEOUT_MS = 10_000;

export interface AttachedSessionRecoveryApi {
  getSnapshot(request: { runtimeId: string }): Promise<ChatSnapshot>;
  getRuntimeStatus(request: { runtimeId: string }): Promise<ChatRuntimeStatus>;
}

export interface AttachedSessionRecoveryResult {
  snapshot: ChatSnapshot;
  status: ChatRuntimeStatus;
}

export class AttachedSessionRecoveryTimeoutError extends Error {
  constructor(runtimeId: string) {
    super(`Timed out restoring attached Pi runtime ${runtimeId}.`);
    this.name = "AttachedSessionRecoveryTimeoutError";
  }
}

/**
 * Read history and normalized activity without creating or resuming a worker.
 * The timeout bounds renderer loading only; late IPC replies are ignored by the
 * caller's request-generation guard.
 */
export async function loadAttachedSessionRecovery(options: {
  api: AttachedSessionRecoveryApi;
  runtimeId: string;
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): Promise<AttachedSessionRecoveryResult> {
  const timeoutMs = options.timeoutMs ?? ATTACHED_SESSION_RECOVERY_TIMEOUT_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const recovery = options.api
    .getSnapshot({ runtimeId: options.runtimeId })
    .then(async (snapshot) => {
      // Read compact lifecycle state after history so it is the freshest
      // authority if a quiet turn settles while get_messages is in flight.
      const status = await options.api.getRuntimeStatus({
        runtimeId: options.runtimeId,
      });
      if (
        snapshot.runtimeId !== options.runtimeId ||
        status.runtimeId !== options.runtimeId
      ) {
        throw new Error(
          `Attached Pi runtime identity changed while restoring ${options.runtimeId}.`,
        );
      }
      return { snapshot, status };
    });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimer(
      () => reject(new AttachedSessionRecoveryTimeoutError(options.runtimeId)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([recovery, timeout]);
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

function isSavedPreview(item: SessionViewModel["timeline"][number]): boolean {
  return (
    item.kind === "diagnostic" &&
    item.tone === "info" &&
    item.content.startsWith("Saved session preview:")
  );
}

function mergeRecoveryTimeline(
  recovered: SessionViewModel["timeline"],
  current: SessionViewModel["timeline"],
  preferCurrent: boolean,
): SessionViewModel["timeline"] {
  const merged = recovered.slice();
  for (const item of current) {
    if (isSavedPreview(item)) continue;
    const index = merged.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) {
      merged.push(item);
    } else if (preferCurrent) {
      merged[index] = item;
    }
  }
  return merged;
}

/**
 * Preserve app-owned membership/title metadata and any runtime event received
 * after recovery started while replacing the saved preview with real history.
 */
export function projectAttachedSessionRecovery(options: {
  snapshot: ChatSnapshot;
  status: ChatRuntimeStatus;
  current: SessionViewModel;
  runtimeEventObserved?: boolean;
  observedRuntimeEvents?: readonly ChatRuntimeEvent[];
  sessionFromSnapshot(snapshot: ChatSnapshot): SessionViewModel;
  reconcileRuntimeStatus(
    session: SessionViewModel,
    status: ChatRuntimeStatus,
  ): SessionViewModel;
  reduceRuntimeEvent?(
    session: SessionViewModel,
    event: ChatRuntimeEvent,
  ): SessionViewModel;
}): SessionViewModel {
  const observedEvents = options.observedRuntimeEvents ?? [];
  const recovered = mergeRecoveredAttachedSession(
    options.reconcileRuntimeStatus(
      options.sessionFromSnapshot(options.snapshot),
      options.status,
    ),
    options.current,
    options.runtimeEventObserved === true && observedEvents.length === 0,
  );
  if (options.reduceRuntimeEvent === undefined) return recovered;
  return observedEvents.reduce(options.reduceRuntimeEvent, recovered);
}

export function mergeRecoveredAttachedSession(
  recovered: SessionViewModel,
  current: SessionViewModel,
  runtimeEventObserved: boolean,
): SessionViewModel {
  const pendingInteraction =
    (current.pendingExtensionUiRequests?.length ?? 0) > 0;
  const merged: SessionViewModel = {
    ...recovered,
    workspaceId: current.workspaceId,
    ...(current.titleOverride === undefined
      ? {}
      : {
          title: current.titleOverride,
          titleOverride: current.titleOverride,
        }),
    timeline: mergeRecoveryTimeline(
      recovered.timeline,
      current.timeline,
      runtimeEventObserved,
    ),
  };

  if (!runtimeEventObserved && !pendingInteraction) return merged;

  return {
    ...merged,
    status: current.status,
    baseState: current.baseState,
    overlays: current.overlays,
    lifecycle: current.lifecycle,
    ...(current.pendingExtensionUiRequests === undefined
      ? {}
      : {
          pendingExtensionUiRequests: current.pendingExtensionUiRequests,
        }),
    ...(current.usageStats === undefined
      ? {}
      : { usageStats: current.usageStats }),
    ...(current.usageByMessageId === undefined
      ? {}
      : { usageByMessageId: current.usageByMessageId }),
    retryPrompt: current.retryPrompt,
    authVerified: current.authVerified,
    workingStartedAtMs: current.workingStartedAtMs,
    lastRuntimeEventLabel: current.lastRuntimeEventLabel,
    lastError: current.lastError,
    ...(current.awaitingAgentEnd === undefined
      ? {}
      : { awaitingAgentEnd: current.awaitingAgentEnd }),
    ...(current.providerErrorObserved === undefined
      ? {}
      : { providerErrorObserved: current.providerErrorObserved }),
    failureKind: current.failureKind,
    completedAtMs: current.completedAtMs,
    updatedAt: current.updatedAt,
    updatedAtMs: current.updatedAtMs,
  };
}
