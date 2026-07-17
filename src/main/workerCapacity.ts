import type { AppSettings } from "../shared/types.js";

/**
 * Returns the number of session slots not already claimed by attached workers
 * or worker launches. A warm worker is a session worker and must consume one
 * of these slots too.
 */
export function availableSessionCapacity(
  settings: Pick<AppSettings, "maxRunningSessions">,
  attachedWorkerCount: number,
  pendingWorkerCount = 0,
): number {
  return Math.max(
    0,
    settings.maxRunningSessions - attachedWorkerCount - pendingWorkerCount,
  );
}

/**
 * Bounds the configured warm-worker target by the session capacity left after
 * attached and starting workers. The configured limit itself may be higher
 * than the capacity so it remains useful if the session limit is raised.
 */
export function warmWorkerCapacity(
  settings: Pick<AppSettings, "maxRunningSessions" | "warmWorkerLimit">,
  attachedWorkerCount: number,
  pendingWorkerCount = 0,
): number {
  return Math.min(
    settings.warmWorkerLimit,
    availableSessionCapacity(settings, attachedWorkerCount, pendingWorkerCount),
  );
}

/**
 * Pi's --no-session mode is ephemeral, and an RPC worker cannot be changed
 * into a persisted session later. Starting a normal worker solely to warm it
 * therefore creates an empty session JSONL file. Until Pi supports promoting
 * an ephemeral RPC session, real-mode prewarming must remain disabled.
 */
export function safeRealWarmWorkerCapacity(
  settings: Pick<AppSettings, "maxRunningSessions" | "warmWorkerLimit">,
  attachedWorkerCount: number,
  pendingWorkerCount = 0,
): number {
  void warmWorkerCapacity(settings, attachedWorkerCount, pendingWorkerCount);
  return 0;
}
