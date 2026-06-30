import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import {
  spawnJsonlRpcClient,
  type JsonlRpcClient,
} from "../main/pi/jsonlClient.js";

let builtFakePath: string | undefined;

export function buildFakeRpcServer(): string {
  if (!builtFakePath) {
    const outdir = path.join(tmpdir(), "pi-deck-fake-rpc-tests");
    mkdirSync(outdir, { recursive: true });
    builtFakePath = path.join(outdir, "fakeRpcServer.cjs");
    buildSync({
      entryPoints: [
        fileURLToPath(
          new URL("../main/pi/fakeRpc/fakeRpcServer.ts", import.meta.url),
        ),
      ],
      outfile: builtFakePath,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node26",
    });
  }
  return builtFakePath;
}

export function spawnFakeRpc(args: string[] = []): JsonlRpcClient {
  return spawnJsonlRpcClient(
    process.execPath,
    [buildFakeRpcServer(), ...args],
    { cwd: process.cwd(), env: process.env },
    { requestTimeoutMs: 2_000 },
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
