import { describe, expect, it } from "vitest";
import {
  isNavigationGenerationCurrent,
  nextNavigationGeneration,
} from "./navigationGeneration.js";

describe("renderer navigation generations", () => {
  it("invalidates an older route owner when a newer intent starts", () => {
    const first = nextNavigationGeneration(0);
    const second = nextNavigationGeneration(first);

    expect(isNavigationGenerationCurrent(first, first)).toBe(true);
    expect(isNavigationGenerationCurrent(second, first)).toBe(false);
    expect(isNavigationGenerationCurrent(second, second)).toBe(true);
  });
});
