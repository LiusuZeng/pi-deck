import { describe, expect, it } from "vitest";
import { PersistedRuntimeResumeGuard } from "./persistedRuntimeResumeGuard.js";

describe("PersistedRuntimeResumeGuard", () => {
  it("rehydrates persisted state only on the first attachment read", () => {
    const guard = new PersistedRuntimeResumeGuard();
    expect(guard.claim("parent", true)).toBe(true);
    // Subsequent state/snapshot reconciliation must retain live children.
    expect(guard.claim("parent", true)).toBe(false);
  });

  it("treats an empty first read as reconciled before live state is persisted", () => {
    const guard = new PersistedRuntimeResumeGuard();
    expect(guard.claim("parent", false)).toBe(false);
    // This state was created by the attached runtime, not loaded at startup.
    expect(guard.claim("parent", true)).toBe(false);
  });

  it("allows a new attachment lifecycle after the runtime is forgotten", () => {
    const guard = new PersistedRuntimeResumeGuard();
    expect(guard.claim("parent", false)).toBe(false);
    guard.forget("parent");
    expect(guard.claim("parent", true)).toBe(true);
  });
});
