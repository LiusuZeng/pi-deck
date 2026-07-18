import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBuiltApp } from "./launch-built.mjs";

describe("built launch validation", () => {
  it("reports actionable missing completed-build outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-build-"));
    try {
      const errors = await validateBuiltApp(root);

      expect(errors).toContain(
        "No complete Pi Deck build was found (dist/.pi-deck-build.json is missing or invalid).",
      );
      expect(errors).toContain(
        "Required build output is missing or empty: dist/main/main.js",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
