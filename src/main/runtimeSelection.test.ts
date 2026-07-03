import { describe, expect, it } from "vitest";
import { selectAvailableRuntime } from "./runtimeSelection.js";

describe("selectAvailableRuntime", () => {
  it("keeps a requested runtime when it is both registered and available", () => {
    const available = new Set(["runtime-a"]);

    expect(
      selectAvailableRuntime({
        requestedRuntimeId: "runtime-a",
        activeRuntimeId: "runtime-b",
        runtimeIds: ["runtime-a", "runtime-b"],
        hasRuntime: (runtimeId) => available.has(runtimeId),
      }),
    ).toEqual({ runtimeId: "runtime-a", reason: "requested" });
  });

  it("falls back instead of returning a registered but unavailable runtime", () => {
    const available = new Set(["runtime-current"]);

    expect(
      selectAvailableRuntime({
        requestedRuntimeId: "runtime-stale",
        activeRuntimeId: "runtime-current",
        runtimeIds: ["runtime-stale", "runtime-current"],
        hasRuntime: (runtimeId) => available.has(runtimeId),
      }),
    ).toEqual({ runtimeId: "runtime-current", reason: "active" });
  });

  it("uses another available registered runtime when the active runtime is stale too", () => {
    const available = new Set(["runtime-warm"]);

    expect(
      selectAvailableRuntime({
        requestedRuntimeId: "runtime-stale",
        activeRuntimeId: "runtime-stale",
        runtimeIds: ["runtime-stale", "runtime-warm"],
        hasRuntime: (runtimeId) => available.has(runtimeId),
      }),
    ).toEqual({ runtimeId: "runtime-warm", reason: "fallback" });
  });

  it("reports no runtime instead of selecting an unavailable stale runtime", () => {
    expect(
      selectAvailableRuntime({
        requestedRuntimeId: "runtime-stale",
        activeRuntimeId: "runtime-stale",
        runtimeIds: ["runtime-stale"],
        hasRuntime: () => false,
      }),
    ).toEqual({ reason: "none" });
  });
});
