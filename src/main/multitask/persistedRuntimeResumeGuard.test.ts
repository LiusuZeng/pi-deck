import { describe, expect, it } from "vitest";
import { PersistedRuntimeResumeGuard } from "./persistedRuntimeResumeGuard.js";

describe("PersistedRuntimeResumeGuard", () => {
  it("claims persisted state once and never claims ordinary snapshots", () => {
    const guard = new PersistedRuntimeResumeGuard();
    expect(guard.claim("parent", true)).toBe(true);
    // Subsequent state/snapshot reconciliation must retain live children.
    expect(guard.claim("parent", true)).toBe(false);
    expect(guard.claim("other", false)).toBe(false);
    guard.forget("parent");
    expect(guard.claim("parent", true)).toBe(true);
  });
});
