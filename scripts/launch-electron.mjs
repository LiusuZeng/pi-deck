#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preparePiDeckElectronExecutable } from "./electron-runtime.mjs";

export async function launchElectron(
  entry,
  args = [],
  { cwd = process.cwd(), env = process.env, stdio = "inherit" } = {},
) {
  const electron = await preparePiDeckElectronExecutable();
  const child = spawn(electron, [path.resolve(cwd, entry), ...args], {
    cwd,
    env,
    stdio,
  });
  child.once("error", (error) => {
    console.error(`Could not start Pi Deck Electron runtime: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
  });
  return child;
}

async function main() {
  const [entry, ...args] = process.argv.slice(2);
  if (!entry) {
    throw new Error(
      "Usage: node scripts/launch-electron.mjs <entry> [args...]",
    );
  }
  await launchElectron(entry, args);
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
