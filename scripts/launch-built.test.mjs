import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBuiltApp } from "./launch-built.mjs";

async function writeCompletedBuild(
  root,
  { includeIcon = true, sourceMtimeMs = Date.now() } = {},
) {
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
      schemaVersion: 2,
      builtAtMs: Date.now(),
      sourceMtimeMs,
      outputs: manifestOutputs,
    }),
  );
}

async function writeSourceRows(sourceDir, start, end) {
  for (let index = start; index < end; index += 1) {
    const sourcePath = path.join(sourceDir, `row-${index}.ts`);
    await writeFile(sourcePath, "export {};\n");
  }
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

  it("rejects required outputs changed after build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-build-"));
    try {
      await writeCompletedBuild(root);
      await writeFile(path.join(root, "dist", "main", "main.js"), "changed");

      await expect(validateBuiltApp(root)).resolves.toContain(
        "Build output does not match the completed build: dist/main/main.js",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps normal validation constant-cost as source grows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-build-"));
    try {
      await writeCompletedBuild(root);
      const sourceDir = path.join(root, "src", "renderer", "history");
      await mkdir(sourceDir, { recursive: true });
      await writeSourceRows(sourceDir, 0, 200);

      const firstMetrics = {};
      await expect(
        validateBuiltApp(root, { metrics: firstMetrics }),
      ).resolves.toEqual([]);
      expect(firstMetrics.readdirCalls ?? 0).toBe(0);

      await writeSourceRows(sourceDir, 200, 400);
      const secondMetrics = {};
      await expect(
        validateBuiltApp(root, { metrics: secondMetrics }),
      ).resolves.toEqual([]);

      expect(secondMetrics.readdirCalls ?? 0).toBe(0);
      expect(secondMetrics.statCalls).toBe(firstMetrics.statCalls);
      expect(secondMetrics.readFileCalls).toBe(firstMetrics.readFileCalls);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("retains stale-source detection in deep validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-build-"));
    try {
      await writeCompletedBuild(root, { sourceMtimeMs: 1 });
      const sourceDir = path.join(root, "src");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(path.join(sourceDir, "changed.ts"), "export {};\n");

      await expect(validateBuiltApp(root)).resolves.toEqual([]);
      await expect(validateBuiltApp(root, { deep: true })).resolves.toContain(
        "Source or build configuration changed after the completed build.",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
