/**
 * Stats are optional accounting telemetry, never a prerequisite for releasing
 * a delegated worker. A short bounded collection window retains prompt final
 * Pi stats while preventing an unresponsive RPC from holding capacity.
 */
export const taskSessionStatsCollectionTimeoutMs = 250;

export interface TaskSessionTerminalData<T> {
  messages: T;
  sessionStats: unknown | undefined;
}

export async function collectTaskSessionTerminalData<T>(options: {
  getMessages(): Promise<T>;
  getSessionStats(): Promise<unknown>;
  statsTimeoutMs?: number;
}): Promise<TaskSessionTerminalData<T>> {
  // Start collection immediately, in parallel with the required transcript.
  // The bounded promise owns both resolve and reject paths, so a late response
  // cannot publish telemetry after terminal finalization.
  const sessionStats = boundedBestEffort(
    Promise.resolve().then(() => options.getSessionStats()),
    options.statsTimeoutMs ?? taskSessionStatsCollectionTimeoutMs,
  );
  const messages = await options.getMessages();
  return { messages, sessionStats: await sessionStats };
}

export function boundedBestEffort<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  const safeTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1_500;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, safeTimeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}
