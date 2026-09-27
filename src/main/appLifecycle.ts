export type QuitRequestSource =
  | "application"
  | "last-window"
  | "renderer-crash";

export interface QuitActivitySummary {
  activeChats: number;
  privateTasks: number;
  workflowRuntimes: number;
  pendingOperations: number;
}

export type QuitDialogOutcome = "cancel" | "quit";
export type CrashRecoveryOutcome = "recover" | "quit";

export interface QuitLifecyclePorts {
  inspectActivity(): Promise<QuitActivitySummary>;
  confirmQuit(
    activity: QuitActivitySummary,
    source: QuitRequestSource,
  ): Promise<QuitDialogOutcome>;
  cleanup(): Promise<void>;
  requestFinalQuit(): void;
  recordDiagnostic(message: string): void;
}

export interface QuitRequestOptions {
  /** The crash fallback already presented the destructive choice. */
  confirmed?: boolean;
}

export type QuitRequestOutcome = "cancelled" | "quitting";

export function hasActiveWork(activity: QuitActivitySummary): boolean {
  return (
    activity.activeChats > 0 ||
    activity.privateTasks > 0 ||
    activity.workflowRuntimes > 0 ||
    activity.pendingOperations > 0
  );
}

export function chatRuntimeHasActiveWork(status: {
  isAgentActive?: boolean;
  isStreaming?: boolean;
}): boolean {
  return status.isAgentActive === true || status.isStreaming === true;
}

/** Hidden E2E must never allocate a native dialog. Production never uses this. */
export function consumeHiddenWindowDialogOutcome(
  environment: NodeJS.ProcessEnv,
  environmentName: string,
  defaultOutcome: string,
): string | undefined {
  // PI_DECK_E2E_HIDE_WINDOWS is itself an explicit test-only switch. Several
  // established fixtures intentionally do not enable broader E2E hooks.
  if (environment.PI_DECK_E2E_HIDE_WINDOWS !== "1") return undefined;
  const outcomes = (environment[environmentName] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const outcome = outcomes.shift() ?? defaultOutcome;
  environment[environmentName] = outcomes.join(",");
  return outcome;
}

/**
 * Owns the one application-wide asynchronous quit transaction. Electron quit
 * and last-window close handlers must keep preventing exit until allowsExit is
 * true; repeated requests only join this transaction.
 */
export class QuitLifecycleCoordinator {
  private transaction: Promise<QuitRequestOutcome> | undefined;
  private confirmedEscalation: Promise<QuitRequestOutcome> | undefined;
  private finalExitAllowed = false;
  private stopping = false;

  constructor(private readonly ports: QuitLifecyclePorts) {}

  get allowsExit(): boolean {
    return this.finalExitAllowed;
  }

  /** True once exit is guaranteed and renderer recovery must be fenced. */
  get isStopping(): boolean {
    return this.stopping || this.finalExitAllowed;
  }

  requestQuit(
    source: QuitRequestSource,
    options: QuitRequestOptions = {},
  ): Promise<QuitRequestOutcome> {
    if (this.finalExitAllowed) return Promise.resolve("quitting");
    const activeTransaction = this.transaction;
    if (activeTransaction !== undefined) {
      if (options.confirmed !== true) return activeTransaction;
      if (this.confirmedEscalation !== undefined)
        return this.confirmedEscalation;

      // A crash dialog's Stop Work choice is stronger than a concurrently
      // pending ordinary prompt. It joins that prompt if it chooses Quit, or
      // starts exactly one confirmed transaction if the prompt is cancelled.
      this.stopping = true;
      const escalation = activeTransaction.then((outcome) =>
        outcome === "quitting"
          ? outcome
          : this.requestQuit(source, { confirmed: true }),
      );
      this.confirmedEscalation = escalation;
      void escalation.finally(() => {
        if (this.confirmedEscalation === escalation) {
          this.confirmedEscalation = undefined;
        }
      });
      return escalation;
    }

    if (options.confirmed === true) this.stopping = true;
    const transaction = this.runQuit(source, options);
    this.transaction = transaction;
    void transaction.finally(() => {
      if (this.transaction === transaction && !this.finalExitAllowed) {
        this.transaction = undefined;
      }
    });
    return transaction;
  }

  private async runQuit(
    source: QuitRequestSource,
    options: QuitRequestOptions,
  ): Promise<QuitRequestOutcome> {
    try {
      if (options.confirmed !== true) {
        const activity = await this.ports.inspectActivity();
        if (hasActiveWork(activity)) {
          const outcome = await this.ports.confirmQuit(activity, source);
          if (outcome === "cancel") return "cancelled";
        }
      }

      this.stopping = true;
      try {
        await this.ports.cleanup();
      } catch (error) {
        // Cleanup owns its escalation and best-effort persistence policy. Do
        // not create an unquittable desktop process after that bounded attempt.
        this.ports.recordDiagnostic(
          `Application cleanup failed before quit: ${errorMessage(error)}`,
        );
      }
      this.finalExitAllowed = true;
      try {
        this.ports.requestFinalQuit();
      } catch (error) {
        // A synchronous Electron exit failure must not strand the bypass gate
        // open. A later request repeats the cleanup barrier before retrying.
        this.finalExitAllowed = false;
        throw error;
      }
      return "quitting";
    } catch (error) {
      this.stopping = false;
      this.ports.recordDiagnostic(
        `Application quit request failed: ${errorMessage(error)}`,
      );
      return "cancelled";
    }
  }
}

export interface RendererCrashRecoveryPorts {
  reloadRenderer(): Promise<boolean>;
  showFallback(details: string): Promise<CrashRecoveryOutcome>;
  recreateRenderer(): Promise<void>;
  stopWorkAndQuit(): Promise<void>;
  isStopping(): boolean;
  recordDiagnostic(message: string): void;
}

/**
 * Grants one automatic renderer reload per app lifetime. Further crashes (or a
 * failed/timed-out reload) always go through a native recovery choice, so a
 * bad renderer cannot enter an automatic crash loop while main-owned work runs.
 */
export class RendererCrashRecovery {
  private automaticRecoveryUsed = false;
  private recovery: Promise<void> | undefined;
  private phase: "idle" | "automatic" | "fallback" | "recreating" = "idle";
  private pendingFallbackDetails: string | undefined;
  private failedRecreationFallbackUsed = false;

  constructor(private readonly ports: RendererCrashRecoveryPorts) {}

  handleCrash(details: string): Promise<void> {
    if (this.ports.isStopping()) return Promise.resolve();
    if (this.recovery !== undefined) {
      // A replacement renderer can die before explicit recreation settles.
      // Coalesce the event now, then present one fresh fallback afterwards.
      if (this.phase === "recreating") this.pendingFallbackDetails = details;
      return this.recovery;
    }
    const recovery = this.recover(details);
    this.recovery = recovery;
    void recovery.finally(() => {
      if (this.recovery !== recovery) return;
      this.recovery = undefined;
      this.phase = "idle";
      const pending = this.pendingFallbackDetails;
      this.pendingFallbackDetails = undefined;
      if (pending !== undefined && !this.ports.isStopping()) {
        void this.handleCrash(pending);
      }
    });
    return recovery;
  }

  private async recover(details: string): Promise<void> {
    if (this.ports.isStopping()) return;
    this.ports.recordDiagnostic(`Renderer process gone: ${details}`);
    if (!this.automaticRecoveryUsed) {
      this.automaticRecoveryUsed = true;
      this.phase = "automatic";
      try {
        const reloaded = await this.ports.reloadRenderer();
        if (this.ports.isStopping()) return;
        if (reloaded) {
          this.ports.recordDiagnostic(
            "Renderer recovered with the existing main-process runtimes.",
          );
          return;
        }
      } catch (error) {
        if (this.ports.isStopping()) return;
        this.ports.recordDiagnostic(
          `Automatic renderer recovery failed: ${errorMessage(error)}`,
        );
      }
    }

    if (this.ports.isStopping()) return;
    this.phase = "fallback";
    let outcome: CrashRecoveryOutcome;
    try {
      outcome = await this.ports.showFallback(details);
    } catch (error) {
      if (this.ports.isStopping()) return;
      this.ports.recordDiagnostic(
        `Renderer recovery dialog failed: ${errorMessage(error)}`,
      );
      // With no usable renderer and no native choice, retaining live work is
      // unsafe. Stop once; never retry a failing native dialog in a hot loop.
      await this.stopWorkAndQuitSafely();
      return;
    }
    if (this.ports.isStopping()) return;
    if (outcome === "quit") {
      await this.stopWorkAndQuitSafely();
      return;
    }

    this.phase = "recreating";
    try {
      await this.ports.recreateRenderer();
      if (this.ports.isStopping()) return;
      this.ports.recordDiagnostic(
        "Renderer UI was recreated with the existing main-process runtimes.",
      );
    } catch (error) {
      if (this.ports.isStopping()) return;
      this.ports.recordDiagnostic(
        `Renderer recreation failed: ${errorMessage(error)}`,
      );
      // The automatic reload budget remains spent. Present at most one fresh
      // native choice after a failed recreation; another failure stops safely
      // rather than allowing hidden/default responses to create a loop.
      if (!this.failedRecreationFallbackUsed) {
        this.failedRecreationFallbackUsed = true;
        this.pendingFallbackDetails ??= `replacement failed: ${errorMessage(error)}`;
      } else {
        await this.stopWorkAndQuitSafely();
      }
    }
  }

  private async stopWorkAndQuitSafely(): Promise<void> {
    try {
      await this.ports.stopWorkAndQuit();
    } catch (error) {
      this.ports.recordDiagnostic(
        `Crash fallback cleanup failed: ${errorMessage(error)}`,
      );
    }
  }
}

export async function withTimeoutResult<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> {
  const boundedMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1;
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(timeoutValue);
    }, boundedMs);
    operation.then(
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
        resolve(timeoutValue);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
