export interface ProgressiveStartupTimings {
  shellReadyMs: number;
  backendReadyMs: number;
}

export interface ProgressiveStartupOptions {
  startedAtMs: number;
  now(): number;
  schedule(callback: () => void): void;
  prepareShell(): void;
  initializeBackend(): Promise<void>;
}

/**
 * Creates the visible shell synchronously, then releases heavyweight
 * backend initialization on the caller-provided scheduler. Keeping the
 * scheduler injectable makes startup ordering deterministic in tests.
 */
export function startProgressiveStartup(options: ProgressiveStartupOptions): {
  shellReadyMs: number;
  backendReady: Promise<ProgressiveStartupTimings>;
} {
  let releaseBackend: (() => void) | undefined;
  const backendStart = new Promise<void>((resolve) => {
    releaseBackend = resolve;
  });
  const backendReady = backendStart.then(async () => {
    await options.initializeBackend();
    return {
      shellReadyMs: Math.max(0, shellReadyAtMs - options.startedAtMs),
      backendReadyMs: Math.max(0, options.now() - options.startedAtMs),
    };
  });

  options.prepareShell();
  const shellReadyAtMs = options.now();
  const startBackend = releaseBackend;
  if (startBackend === undefined) {
    throw new Error("Progressive startup backend gate was not initialized.");
  }
  options.schedule(startBackend);

  return {
    shellReadyMs: Math.max(0, shellReadyAtMs - options.startedAtMs),
    backendReady,
  };
}
