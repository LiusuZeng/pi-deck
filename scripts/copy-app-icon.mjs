#!/usr/bin/env node
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..");
export const appIconRelativePath = "renderer/pi-deck-app-icon.png";

export async function copyAppIcon(root = repoRoot) {
  const source = path.join(root, "assets", "branding", "pi-deck-app-icon.png");
  const destination = path.join(root, "dist", appIconRelativePath);
  const sourceStats = await stat(source);
  if (!sourceStats.isFile() || sourceStats.size === 0) {
    throw new Error("Pi Deck source app icon is missing or empty.");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return destination;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  copyAppIcon().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
