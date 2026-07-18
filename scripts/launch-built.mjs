#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..");
const distDir = path.join(repoRoot, "dist");
export const requiredOutputs = [
  "main/main.js",
  "preload/index.js",
  "renderer/index.html",
];
const buildInputs = [
  "index.html",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.main.json",
  "tsconfig.renderer.json",
  "vite.config.ts",
];

async function fileStats(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

async function newestSourceMtime(directory) {
  let newest = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestSourceMtime(entryPath));
    } else if (
      entry.isFile() &&
      /\.(?:ts|tsx|css)$/.test(entry.name) &&
      !/\.test\.(?:ts|tsx)$/.test(entry.name)
    ) {
      newest = Math.max(newest, (await stat(entryPath)).mtimeMs);
    }
  }
  return newest;
}

export async function validateBuiltApp(root = repoRoot) {
  const rootDistDir = path.join(root, "dist");
  const rootManifestPath = path.join(rootDistDir, ".pi-deck-build.json");
  const errors = [];
  let manifest;

  try {
    manifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
  } catch {
    errors.push(
      "No complete Pi Deck build was found (dist/.pi-deck-build.json is missing or invalid).",
    );
  }

  if (
    manifest &&
    (manifest.schemaVersion !== 1 ||
      typeof manifest.builtAtMs !== "number" ||
      !manifest.outputs ||
      typeof manifest.outputs !== "object")
  ) {
    errors.push("The Pi Deck build manifest is invalid.");
    manifest = undefined;
  }

  for (const relativePath of requiredOutputs) {
    const outputStats = await fileStats(path.join(rootDistDir, relativePath));
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
    const rendererHtml = await readFile(rendererIndex, "utf8");
    const assetPaths = [
      ...rendererHtml.matchAll(/(?:src|href)="\.\/([^"?#]+)(?:[?#][^"]*)?"/g),
    ].map((match) => match[1]);
    for (const assetPath of assetPaths) {
      const assetStats = await fileStats(
        path.join(rootDistDir, "renderer", assetPath),
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

  if (manifest) {
    let newestInputMtime = 0;
    for (const relativePath of buildInputs) {
      const inputStats = await fileStats(path.join(root, relativePath));
      newestInputMtime = Math.max(newestInputMtime, inputStats?.mtimeMs ?? 0);
    }
    const sourceDirectory = path.join(root, "src");
    if ((await fileStats(sourceDirectory))?.isDirectory()) {
      newestInputMtime = Math.max(
        newestInputMtime,
        await newestSourceMtime(sourceDirectory),
      );
    }
    if (newestInputMtime > manifest.builtAtMs) {
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

async function main() {
  const errors = await validateBuiltApp();
  if (errors.length > 0) {
    printBuildError(errors);
    process.exit(1);
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
