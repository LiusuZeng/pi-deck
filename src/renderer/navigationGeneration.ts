/** Monotonic ownership token for route-affecting asynchronous work. */
export function nextNavigationGeneration(current: number): number {
  return current + 1;
}

export function isNavigationGenerationCurrent(
  current: number,
  expected: number,
): boolean {
  return current === expected;
}

type BootstrapSessionRefresh = {
  disposed: boolean;
  sessionListRequest: number;
  currentSessionListRequest: number;
  bootstrapWorkspaceId: string;
  currentWorkspaceId: string;
};

/** A discovery result still belongs to its bootstrap workspace and request. */
export function canReportBootstrapSessionRefresh(
  input: BootstrapSessionRefresh,
): boolean {
  return (
    !input.disposed &&
    input.sessionListRequest === input.currentSessionListRequest &&
    input.currentWorkspaceId === input.bootstrapWorkspaceId
  );
}

/**
 * Startup discovery may finish after the user has opened a session. Its
 * session-list result must not commit state owned by that newer route.
 */
export function canApplyBootstrapSessionRefresh(
  input: BootstrapSessionRefresh & {
    navigationRequest: number;
    currentNavigation: number;
  },
): boolean {
  return (
    canReportBootstrapSessionRefresh(input) &&
    isNavigationGenerationCurrent(
      input.currentNavigation,
      input.navigationRequest,
    )
  );
}
