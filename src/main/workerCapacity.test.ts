import { describe, expect, it } from "vitest";
import {
  availableSessionCapacity,
  safeRealWarmWorkerCapacity,
  warmWorkerCapacity,
} from "./workerCapacity.js";

const settings = {
  maxRunningSessions: 4,
  warmWorkerLimit: 3,
};

describe("worker capacity", () => {
  it("reserves session capacity for attached and launching workers", () => {
    expect(availableSessionCapacity(settings, 1, 1)).toBe(2);
    expect(availableSessionCapacity(settings, 4)).toBe(0);
    expect(availableSessionCapacity(settings, 10)).toBe(0);
  });

  it("clamps the configured warm-worker target to remaining session capacity", () => {
    expect(warmWorkerCapacity(settings, 1)).toBe(3);
    expect(warmWorkerCapacity(settings, 2)).toBe(2);
    expect(warmWorkerCapacity(settings, 1, 2)).toBe(1);
  });

  it("does not prewarm real Pi workers that would persist empty sessions", () => {
    expect(safeRealWarmWorkerCapacity(settings, 0)).toBe(0);
    expect(safeRealWarmWorkerCapacity(settings, 4)).toBe(0);
  });
});
