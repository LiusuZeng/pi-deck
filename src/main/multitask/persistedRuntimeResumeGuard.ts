/**
 * Ensures persisted multitask state is rehydrated once per attached parent.
 * Snapshot/state reads must not invoke destructive supervisor.resume().
 */
export class PersistedRuntimeResumeGuard {
  private readonly resumed = new Set<string>();

  public claim(runtimeId: string, hasPersistedState: boolean): boolean {
    if (!hasPersistedState || this.resumed.has(runtimeId)) return false;
    this.resumed.add(runtimeId);
    return true;
  }

  public forget(runtimeId: string): void {
    this.resumed.delete(runtimeId);
  }
}
