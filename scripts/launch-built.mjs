#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkMacOsGuiLaunch } from "./check-macos-gui-launch.mjs";
import { newestBuildInputMtime } from "./build-freshness.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..");
const distDir = path.join(repoRoot, "dist");
export const requiredOutputs = [
  "main/main.js",
  "preload/index.js",
  "renderer/index.html",
  "renderer/pi-deck-app-icon.png",
];

function record(metrics, key) {
  if (metrics) {
    metrics[key] = (metrics[key] ?? 0) + 1;
  }
}

async function fileStats(filePath, metrics) {
  record(metrics, "statCalls");
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

async function readText(filePath, metrics) {
  record(metrics, "readFileCalls");
  return readFile(filePath, "utf8");
}

export async function validateBuiltApp(
  root = repoRoot,
  { deep = false, metrics } = {},
) {
  const rootDistDir = path.join(root, "dist");
  const rootManifestPath = path.join(rootDistDir, ".pi-deck-build.json");
  const errors = [];
  let manifest;

  try {
    manifest = JSON.parse(await readText(rootManifestPath, metrics));
  } catch {
    errors.push(
      "No complete Pi Deck build was found (dist/.pi-deck-build.json is missing or invalid).",
    );
  }

  if (
    manifest &&
    (manifest.schemaVersion !== 2 ||
      typeof manifest.builtAtMs !== "number" ||
      typeof manifest.sourceMtimeMs !== "number" ||
      !manifest.outputs ||
      typeof manifest.outputs !== "object")
  ) {
    errors.push("The Pi Deck build manifest is invalid.");
    manifest = undefined;
  }

  for (const relativePath of requiredOutputs) {
    const outputStats = await fileStats(
      path.join(rootDistDir, relativePath),
      metrics,
    );
    if (!outputStats?.isFile() || outputStats.size === 0) {
      errors.push(
        `Required build output is missing or empty: dist/${relativePath}`,
      );
      continue;
    }
    const recorded = manifest?.outputs[relativePath];
    if (
      !recorded ||
      recorded.size !== outputStats.size ||
      recorded.mtimeMs !== outputStats.mtimeMs
    ) {
      errors.push(
        `Build output does not match the completed build: dist/${relativePath}`,
      );
    }
  }

  const rendererIndex = path.join(rootDistDir, "renderer", "index.html");
  try {
    const rendererHtml = await readText(rendererIndex, metrics);
    const assetPaths = [
      ...rendererHtml.matchAll(/(?:src|href)="\.\/([^"?#]+)(?:[?#][^"]*)?"/g),
    ].map((match) => match[1]);
    for (const assetPath of assetPaths) {
      const assetStats = await fileStats(
        path.join(rootDistDir, "renderer", assetPath),
        metrics,
      );
      if (!assetStats?.isFile() || assetStats.size === 0) {
        errors.push(
          `Required renderer asset is missing or empty: dist/renderer/${assetPath}`,
        );
      }
    }
  } catch {
    // The required renderer index error above explains this condition.
  }

  if (deep && manifest) {
    const currentSourceMtimeMs = await newestBuildInputMtime(root, metrics);
    if (currentSourceMtimeMs > manifest.sourceMtimeMs) {
      errors.push(
        "Source or build configuration changed after the completed build.",
      );
    }
  }

  return errors;
}

function printBuildError(errors) {
  console.error("Pi Deck cannot launch the existing dist output:");
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  console.error(
    "Run `npm run build` and retry, or use `npm run launch:build` to build and launch.",
  );
}

function printValidationMetrics(metrics, elapsedMs, deep) {
  console.error(
    `Pi Deck ${deep ? "deep " : ""}build validation: ${elapsedMs.toFixed(1)} ms; ${metrics.statCalls ?? 0} stat calls; ${metrics.readFileCalls ?? 0} file reads; ${metrics.readdirCalls ?? 0} directory reads.`,
  );
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const knownArgs = new Set(["--deep", "--metrics", "--validate-only"]);
  for (const arg of args) {
    if (!knownArgs.has(arg)) {
      throw new Error(`Unknown launch argument: ${arg}`);
    }
  }

  if (!checkMacOsGuiLaunch()) {
    process.exitCode = 2;
    return;
  }

  const deep = args.has("--deep");
  const metrics = {};
  const validationStartedAt = performance.now();
  const errors = await validateBuiltApp(repoRoot, { deep, metrics });
  const validationElapsedMs = performance.now() - validationStartedAt;
  if (args.has("--metrics")) {
    printValidationMetrics(metrics, validationElapsedMs, deep);
  }
  if (errors.length > 0) {
    printBuildError(errors);
    process.exit(1);
  }
  if (args.has("--validate-only")) {
    return;
  }

  const electron = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
  const child = spawn(electron, [path.join(distDir, "main", "main.js")], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`Could not start Electron: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
