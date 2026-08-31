import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBuiltApp } from "./launch-built.mjs";

async function writeCompletedBuild(root, { includeIcon = true } = {}) {
  const outputs = ["main/main.js", "preload/index.js", "renderer/index.html"];
  if (includeIcon) {
    outputs.push("renderer/pi-deck-app-icon.png");
  }
  const manifestOutputs = {};
  for (const relativePath of outputs) {
    const outputPath = path.join(root, "dist", relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      relativePath === "renderer/index.html" ? "<html />" : "x",
    );
    const outputStats = await stat(outputPath);
    manifestOutputs[relativePath] = {
      size: outputStats.size,
      mtimeMs: outputStats.mtimeMs,
    };
  }
  await writeFile(
    path.join(root, "dist", ".pi-deck-build.json"),
    JSON.stringify({
      schemaVersion: 1,
      builtAtMs: Date.now(),
      outputs: manifestOutputs,
    }),
  );
}

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

  it("requires the explicitly copied app icon in a completed build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-build-"));
    try {
      await writeCompletedBuild(root, { includeIcon: false });

      await expect(validateBuiltApp(root)).resolves.toContain(
        "Required build output is missing or empty: dist/renderer/pi-deck-app-icon.png",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
