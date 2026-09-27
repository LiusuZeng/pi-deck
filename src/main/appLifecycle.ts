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

/**
 * Owns the one application-wide asynchronous quit transaction. Electron quit
 * and last-window close handlers must keep preventing exit until allowsExit is
 * true; repeated requests only join this transaction.
 */
export class QuitLifecycleCoordinator {
  private transaction: Promise<QuitRequestOutcome> | undefined;
  private finalExitAllowed = false;

  constructor(private readonly ports: QuitLifecyclePorts) {}

  get allowsExit(): boolean {
    return this.finalExitAllowed;
  }

  requestQuit(
    source: QuitRequestSource,
    options: QuitRequestOptions = {},
  ): Promise<QuitRequestOutcome> {
    if (this.finalExitAllowed) return Promise.resolve("quitting");
    if (this.transaction !== undefined) return this.transaction;

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
      this.ports.requestFinalQuit();
      return "quitting";
    } catch (error) {
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

  constructor(private readonly ports: RendererCrashRecoveryPorts) {}

  handleCrash(details: string): Promise<void> {
    if (this.recovery !== undefined) return this.recovery;
    const recovery = this.recover(details);
    this.recovery = recovery;
    void recovery.finally(() => {
      if (this.recovery === recovery) this.recovery = undefined;
    });
    return recovery;
  }

  private async recover(details: string): Promise<void> {
    this.ports.recordDiagnostic(`Renderer process gone: ${details}`);
    if (!this.automaticRecoveryUsed) {
      this.automaticRecoveryUsed = true;
      try {
        if (await this.ports.reloadRenderer()) {
          this.ports.recordDiagnostic(
            "Renderer recovered with the existing main-process runtimes.",
          );
          return;
        }
      } catch (error) {
        this.ports.recordDiagnostic(
          `Automatic renderer recovery failed: ${errorMessage(error)}`,
        );
      }
    }

    let outcome: CrashRecoveryOutcome;
    try {
      outcome = await this.ports.showFallback(details);
    } catch (error) {
      this.ports.recordDiagnostic(
        `Renderer recovery dialog failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (outcome === "quit") {
      try {
        await this.ports.stopWorkAndQuit();
      } catch (error) {
        this.ports.recordDiagnostic(
          `Crash fallback cleanup failed: ${errorMessage(error)}`,
        );
      }
      return;
    }
    try {
      await this.ports.recreateRenderer();
      this.ports.recordDiagnostic(
        "Renderer UI was recreated with the existing main-process runtimes.",
      );
    } catch (error) {
      this.ports.recordDiagnostic(
        `Renderer recreation failed: ${errorMessage(error)}`,
      );
      // A failed explicit recovery remains bounded. A subsequent crash or user
      // quit will offer/enter the safe stop-work path rather than auto-looping.
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
