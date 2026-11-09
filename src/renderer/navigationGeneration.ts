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

/**
 * Startup discovery may finish after the user has opened a session. Its
 * session-list result must not commit state owned by that newer route.
 */
export function canApplyBootstrapSessionRefresh(input: {
  disposed: boolean;
  sessionListRequest: number;
  currentSessionListRequest: number;
  navigationRequest: number;
  currentNavigation: number;
  bootstrapWorkspaceId: string;
  currentWorkspaceId: string;
}): boolean {
  return (
    !input.disposed &&
    input.sessionListRequest === input.currentSessionListRequest &&
    isNavigationGenerationCurrent(
      input.currentNavigation,
      input.navigationRequest,
    ) &&
    input.currentWorkspaceId === input.bootstrapWorkspaceId
  );
}
