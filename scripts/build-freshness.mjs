import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const buildInputs = [
  "index.html",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.main.json",
  "tsconfig.renderer.json",
  "vite.config.ts",
  "scripts/copy-app-icon.mjs",
];

export const buildTrees = ["src", "public", "assets"];

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

async function newestBuildTreeMtime(directory, metrics) {
  let newest = 0;
  record(metrics, "readdirCalls");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const childMtime = await newestBuildTreeMtime(entryPath, metrics);
      newest = Math.max(newest, childMtime);
    } else if (
      entry.isFile() &&
      !/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(entry.name)
    ) {
      // Renderer imports can include JSON, SVG, fonts, and images in addition
      // to TS/CSS. Conservatively include every non-test file in build trees.
      const entryStats = await fileStats(entryPath, metrics);
      newest = Math.max(newest, entryStats?.mtimeMs ?? 0);
    }
  }
  return newest;
}

export async function newestBuildInputMtime(root, metrics) {
  let newest = 0;
  for (const relativePath of buildInputs) {
    const inputStats = await fileStats(path.join(root, relativePath), metrics);
    newest = Math.max(newest, inputStats?.mtimeMs ?? 0);
  }
  for (const buildTree of buildTrees) {
    const directory = path.join(root, buildTree);
    if ((await fileStats(directory, metrics))?.isDirectory()) {
      const treeMtime = await newestBuildTreeMtime(directory, metrics);
      newest = Math.max(newest, treeMtime);
    }
  }
  return newest;
}
