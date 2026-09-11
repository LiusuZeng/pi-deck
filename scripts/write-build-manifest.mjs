#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newestBuildInputMtime } from "./build-freshness.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const distDir = path.join(repoRoot, "dist");
const manifestPath = path.join(distDir, ".pi-deck-build.json");
const requiredOutputs = [
  "main/main.js",
  "preload/index.js",
  "renderer/index.html",
  "renderer/pi-deck-app-icon.png",
];

async function main() {
  const outputs = {};
  for (const relativePath of requiredOutputs) {
    const outputPath = path.join(distDir, relativePath);
    const outputStats = await stat(outputPath);
    if (!outputStats.isFile() || outputStats.size === 0) {
      throw new Error(
        `Required build output is unusable: dist/${relativePath}`,
      );
    }
    outputs[relativePath] = {
      size: outputStats.size,
      mtimeMs: outputStats.mtimeMs,
    };
  }

  // Deep source traversal belongs to build/verification, not the repeated
  // launch path. Persist the newest build-input mtime so an explicit deep
  // validation can later detect a stale build without weakening normal launch.
  const sourceMtimeMs = await newestBuildInputMtime(repoRoot);

  await mkdir(distDir, { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        builtAtMs: Date.now(),
        sourceMtimeMs,
        outputs,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
