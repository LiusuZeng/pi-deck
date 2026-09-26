/**
 * Ensures persisted multitask state is rehydrated once per attached parent.
 * Snapshot/state reads must not invoke destructive supervisor.resume().
 */
export class PersistedRuntimeResumeGuard {
  private readonly reconciled = new Set<string>();

  public claim(runtimeId: string, hasPersistedState: boolean): boolean {
    if (this.reconciled.has(runtimeId)) return false;
    // The first reconciliation is the attachment boundary even when the store
    // is empty. Live work may persist immediately afterward, but ordinary
    // snapshot reads must never mistake that new state for startup recovery.
    this.reconciled.add(runtimeId);
    return hasPersistedState;
  }

  public forget(runtimeId: string): void {
    this.reconciled.delete(runtimeId);
  }
}
