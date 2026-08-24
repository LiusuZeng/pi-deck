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
