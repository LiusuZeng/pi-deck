import { describe, expect, it } from "vitest";
import { selectAvailableRuntime } from "./runtimeSelection.js";

describe("selectAvailableRuntime", () => {
  it("keeps a requested runtime when it is available", () => {
    const available = new Set(["runtime-a", "runtime-b"]);

    expect(
      selectAvailableRuntime({
        requestedRuntimeId: "runtime-a",
        hasRuntime: (runtimeId) => available.has(runtimeId),
      }),
    ).toEqual({ runtimeId: "runtime-a", reason: "requested" });
  });

  it("rejects a stale request even when another runtime is active", () => {
    const available = new Set(["runtime-current"]);

    expect(
      selectAvailableRuntime({
        requestedRuntimeId: "runtime-stale",
        hasRuntime: (runtimeId) => available.has(runtimeId),
      }),
    ).toEqual({ reason: "none" });
  });
});
