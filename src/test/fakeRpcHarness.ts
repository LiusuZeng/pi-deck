import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync, type BuildOptions } from "esbuild";
import { afterAll } from "vitest";
import {
  spawnJsonlRpcClient,
  type JsonlRpcClient,
  type JsonlRpcClientOptions,
} from "../main/pi/jsonlClient.js";

const fakeRpcEntryPoint = fileURLToPath(
  new URL("../main/pi/fakeRpc/fakeRpcServer.ts", import.meta.url),
);
const bundleDirectoryPrefix = path.join(tmpdir(), "pi-deck-fake-rpc-");

interface FakeRpcBundleLocation {
  directory: string;
  file: string;
}

let cachedBundle: FakeRpcBundleLocation | undefined;
const ownedBundleDirectories = new Set<string>();

function allocateBundle(): FakeRpcBundleLocation {
  // mkdtemp is atomic. Never derive this directory from a checkout path, PID,
  // or Vitest worker id: all of those can collide across concurrent runners.
  const directory = mkdtempSync(bundleDirectoryPrefix);
  ownedBundleDirectories.add(directory);
  return { directory, file: path.join(directory, "fakeRpcServer.cjs") };
}

function bundleOptions(outfile: string): BuildOptions {
  return {
    entryPoints: [fakeRpcEntryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node26",
  };
}

function removeBundle(bundle: FakeRpcBundleLocation | undefined): void {
  if (!bundle) return;
  rmSync(bundle.directory, { recursive: true, force: true });
  ownedBundleDirectories.delete(bundle.directory);
}

function removeOwnedBundles(): void {
  for (const directory of ownedBundleDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  ownedBundleDirectories.clear();
  cachedBundle = undefined;
}

// Vitest worker teardown does not necessarily emit this process's exit event
// (notably for worker threads), so bind cleanup to the owning suite as well as
// retaining process exit as a last-resort fallback.
afterAll(removeOwnedBundles);
process.once("exit", removeOwnedBundles);

/**
 * Build one immutable fake-RPC executable for this module/worker instance.
 * The atomic temporary directory prevents writes from racing other Vitest
 * workers, processes, or repository checkouts.
 */
export function buildFakeRpcServer(): string {
  if (cachedBundle) return cachedBundle.file;

  const bundle = allocateBundle();
  try {
    buildSync(bundleOptions(bundle.file));
  } catch (error) {
    removeBundle(bundle);
    throw error;
  }
  cachedBundle = bundle;
  return bundle.file;
}

export function spawnFakeRpc(
  args: string[] = [],
  options: JsonlRpcClientOptions = {},
): JsonlRpcClient {
  return spawnFakeRpcBundle(buildFakeRpcServer(), args, options);
}

function spawnFakeRpcBundle(
  bundle: string,
  args: string[],
  options: JsonlRpcClientOptions,
): JsonlRpcClient {
  return spawnJsonlRpcClient(
    process.execPath,
    [bundle, ...args],
    { cwd: process.cwd(), env: process.env },
    { requestTimeoutMs: 5_000, ...options },
  );
}

export function writeFakePiShim(file: string, extraArgs: string[] = []): void {
  const fakeServer = buildFakeRpcServer();
  const content = `#!${process.execPath}
const { spawn } = require('node:child_process');
if (process.argv.includes('--version')) {
  console.log('pi fake-rpc 0.0.0');
  process.exit(0);
}
const child = spawn(process.execPath, [${JSON.stringify(fakeServer)}, ...process.argv.slice(2), ...${JSON.stringify(extraArgs)}], { stdio: 'inherit' });
const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));
child.on('exit', (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code ?? 0);
});
`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  chmodSync(file, 0o755);
}
