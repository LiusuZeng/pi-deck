#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

export function macOsGuiLaunchBlockReason({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== "darwin" || env.CODEX_SANDBOX !== "seatbelt") {
    return undefined;
  }

  return [
    "Pi Deck cannot start a macOS GUI process from Codex's Seatbelt sandbox.",
    "macOS LaunchServices would abort Electron before Pi Deck starts and show an ‘Electron quit unexpectedly’ dialog.",
    "Run this command from Terminal, or ask Codex to rerun it with elevated GUI permission outside the sandbox.",
  ].join("\n");
}

export function checkMacOsGuiLaunch(options) {
  const reason = macOsGuiLaunchBlockReason(options);
  if (reason === undefined) {
    return true;
  }
  console.error(reason);
  return false;
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule() && !checkMacOsGuiLaunch()) {
  process.exitCode = 2;
}
