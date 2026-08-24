const WORKSPACE_ALREADY_CHANGING_MESSAGE =
  "Workspace is already being changed.";

export class WorkspaceRuntimeLifecycleConflictError extends Error {
  constructor() {
    super(WORKSPACE_ALREADY_CHANGING_MESSAGE);
    this.name = "WorkspaceRuntimeLifecycleConflictError";
  }
}

export function isWorkspaceRuntimeLifecycleConflictError(
  error: unknown,
): error is WorkspaceRuntimeLifecycleConflictError {
  return error instanceof WorkspaceRuntimeLifecycleConflictError;
}

type WorkspaceLifecycleState = {
  creationCount: number;
  archiving: boolean;
};

type CreationAvailableListener = () => void;

/**
 * Coordinates workspace archive transactions with runtime creation.
 *
 * Claims are per workspace. Runtime creations may proceed concurrently with
 * one another, but an archive cannot start while any creation is in flight and
 * a creation cannot start once an archive has claimed the workspace. The
 * caller owns the operation's full lifecycle, including eligibility checks,
 * worker registration, and durable metadata persistence.
 */
export class WorkspaceRuntimeLifecycleGate {
  private readonly states = new Map<string, WorkspaceLifecycleState>();
  private readonly creationAvailableListeners = new Map<
    string,
    Set<CreationAvailableListener>
  >();

  /**
   * Subscribe to the end of an archive claim for one workspace. This is a
   * release boundary, not a retry loop: listeners run once when the archive
   * claim ends, and callers decide whether the workspace is actually open
   * before attempting creation again.
   */
  onCreationAvailable(
    workspaceId: string,
    listener: CreationAvailableListener,
  ): () => void {
    const listeners =
      this.creationAvailableListeners.get(workspaceId) ??
      new Set<CreationAvailableListener>();
    listeners.add(listener);
    this.creationAvailableListeners.set(workspaceId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0)
        this.creationAvailableListeners.delete(workspaceId);
    };
  }

  withArchive<T>(
    workspaceId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const state = this.stateFor(workspaceId);
    if (state.archiving || state.creationCount > 0) {
      return Promise.reject(new WorkspaceRuntimeLifecycleConflictError());
    }
    state.archiving = true;
    return this.run(operation, () => {
      state.archiving = false;
      this.removeIfIdle(workspaceId, state);
      this.notifyCreationAvailable(workspaceId);
    });
  }

  withCreation<T>(
    workspaceId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const state = this.stateFor(workspaceId);
    if (state.archiving) {
      return Promise.reject(new WorkspaceRuntimeLifecycleConflictError());
    }
    state.creationCount += 1;
    return this.run(operation, () => {
      state.creationCount -= 1;
      this.removeIfIdle(workspaceId, state);
    });
  }

  private stateFor(workspaceId: string): WorkspaceLifecycleState {
    const existing = this.states.get(workspaceId);
    if (existing !== undefined) return existing;
    const created: WorkspaceLifecycleState = {
      creationCount: 0,
      archiving: false,
    };
    this.states.set(workspaceId, created);
    return created;
  }

  private removeIfIdle(
    workspaceId: string,
    state: WorkspaceLifecycleState,
  ): void {
    if (!state.archiving && state.creationCount === 0) {
      this.states.delete(workspaceId);
    }
  }

  private notifyCreationAvailable(workspaceId: string): void {
    for (const listener of [
      ...(this.creationAvailableListeners.get(workspaceId) ?? []),
    ]) {
      try {
        listener();
      } catch {
        // A release notification must never change the archive operation's
        // result. Scheduling listeners own their asynchronous error handling.
      }
    }
  }

  private run<T>(
    operation: () => Promise<T> | T,
    release: () => void,
  ): Promise<T> {
    let result: Promise<T> | T;
    try {
      result = operation();
    } catch (error) {
      release();
      return Promise.reject(error);
    }
    return Promise.resolve(result).finally(release);
  }
}
