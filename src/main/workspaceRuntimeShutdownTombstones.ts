export interface ShutdownRuntimeEvent {
  type: string;
  runtimeId: string;
}

export type ShutdownRuntimeEventSubscription = (
  listener: (event: ShutdownRuntimeEvent) => void,
) => () => void;

type ShutdownAttempt = {
  workspaceId: string;
  closeInFlight: boolean;
  exitConfirmed: boolean;
};

/**
 * Keeps a failed runtime close conservative without making the archive guard
 * permanent when the old adapter later proves that the worker exited.
 *
 * A close is provisionally tracked before teardown detaches the normal adapter
 * listener. Exit confirmation may therefore race the close promise: the
 * tombstone remains in the table until that attempt finishes, but it is never
 * archive-blocking after confirmation. A failed attempt leaves the entry until
 * a later exit event proves cleanup.
 */
export class WorkspaceRuntimeShutdownTombstones {
  private readonly attempts = new Map<string, ShutdownAttempt>();

  beginClose(runtimeId: string, workspaceId: string): void {
    const existing = this.attempts.get(runtimeId);
    if (existing?.exitConfirmed === true) return;
    this.attempts.set(runtimeId, {
      workspaceId,
      closeInFlight: true,
      exitConfirmed: false,
    });
  }

  /** Record a close failure only for a close that was provisionally tracked. */
  markCloseFailed(runtimeId: string, workspaceId: string): void {
    const attempt = this.attempts.get(runtimeId);
    if (attempt === undefined || attempt.exitConfirmed) return;
    attempt.workspaceId = workspaceId;
  }

  /**
   * Finish one close attempt. A successful close follows the adapter's normal
   * cleanup contract; a failed close remains a tombstone unless an exit was
   * observed meanwhile. Reset teardown passes false so a late event from the
   * discarded adapter can still release the archive block.
   */
  finishClose(runtimeId: string, confirmed: boolean): void {
    const attempt = this.attempts.get(runtimeId);
    if (attempt === undefined) return;
    attempt.closeInFlight = false;
    if (confirmed || attempt.exitConfirmed) this.attempts.delete(runtimeId);
  }

  /**
   * Accept a worker-exit proof from either the normal router or an old-adapter
   * teardown watcher. The return value tells callers whether this runtime was
   * one of the tracked shutdown attempts.
   */
  confirmExit(runtimeId: string): boolean {
    const attempt = this.attempts.get(runtimeId);
    if (attempt === undefined) return false;
    attempt.exitConfirmed = true;
    if (!attempt.closeInFlight) this.attempts.delete(runtimeId);
    return true;
  }

  has(runtimeId: string): boolean {
    return this.attempts.has(runtimeId);
  }

  isWorkspaceBlocked(workspaceId: string): boolean {
    for (const attempt of this.attempts.values()) {
      if (!attempt.exitConfirmed && attempt.workspaceId === workspaceId)
        return true;
    }
    return false;
  }

  /**
   * Listen only for worker exits belonging to one discarded adapter. The
   * optional callback lets the owner dispose the watcher once every attempt
   * has either been confirmed or cleaned up.
   */
  watchAdapter(
    subscribe: ShutdownRuntimeEventSubscription,
    runtimeIds: ReadonlySet<string>,
    onExit?: (runtimeId: string) => void,
  ): () => void {
    let disposed = false;
    const unsubscribe = subscribe((event) => {
      if (
        disposed ||
        event.type !== "worker_exit" ||
        !runtimeIds.has(event.runtimeId)
      )
        return;
      this.confirmExit(event.runtimeId);
      onExit?.(event.runtimeId);
    });
    return () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    };
  }
}
