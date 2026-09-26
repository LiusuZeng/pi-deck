import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { build, type Plugin } from "esbuild";
import { it as test } from "vitest";

interface WorkerResult {
  bundlePath: string;
  sessionId: string;
}

function runWorker(
  workerFile: string,
  workers: Worker[],
): Promise<WorkerResult> {
  const worker = new Worker(workerFile);
  workers.push(worker);

  return new Promise((resolve, reject) => {
    let result: WorkerResult | undefined;
    let workerError: Error | undefined;
    worker.once("message", (message: WorkerResult | { error: string }) => {
      if ("error" in message) {
        workerError = new Error(message.error);
      } else {
        result = message;
      }
    });
    worker.once("error", (error) => {
      workerError = error;
    });
    worker.once("exit", (code) => {
      if (workerError) {
        reject(workerError);
      } else if (code !== 0) {
        reject(new Error(`fake-RPC worker exited with code ${code}`));
      } else if (!result) {
        reject(new Error("fake-RPC worker exited without a result"));
      } else {
        resolve(result);
      }
    });
  });
}

const vitestShim: Plugin = {
  name: "vitest-after-all-shim",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^vitest$/ }, () => ({
      path: "vitest",
      namespace: "vitest-shim",
    }));
    buildContext.onLoad({ filter: /.*/, namespace: "vitest-shim" }, () => ({
      contents: "export function afterAll() {}",
    }));
  },
};

test("isolated workers concurrently use buildFakeRpcServer and serve RPCs", async () => {
  const workerDirectory = mkdtempSync(
    path.join(tmpdir(), "pi-deck-fake-rpc-workers-"),
  );
  const workerFile = path.join(workerDirectory, "worker.mjs");
  const workers: Worker[] = [];

  try {
    // Keep esbuild native loading external in the generated worker while making
    // this checkout's package available from the otherwise isolated temp dir.
    symlinkSync(
      path.join(process.cwd(), "node_modules"),
      path.join(workerDirectory, "node_modules"),
      "dir",
    );
    const harnessPath = path.join(process.cwd(), "src/test/fakeRpcHarness.ts");
    const harnessUrl = pathToFileURL(harnessPath).href;
    const workerSource = `
      import { parentPort } from "node:worker_threads";
      import { buildFakeRpcServer, spawnFakeRpc } from ${JSON.stringify(harnessPath)};

      let client;
      try {
        const bundlePath = buildFakeRpcServer();
        client = spawnFakeRpc();
        const state = await client.request("get_state");
        await new Promise((resolve) => {
          client.child.once("close", resolve);
          client.close();
        });
        parentPort.postMessage({ bundlePath, sessionId: state.sessionId });
      } catch (error) {
        parentPort.postMessage({ error: error?.stack ?? String(error) });
        process.exitCode = 1;
      } finally {
        if (client && client.child.exitCode === null && client.child.signalCode === null) {
          client.close();
        }
      }
    `;
    await build({
      stdin: {
        contents: workerSource,
        resolveDir: process.cwd(),
        sourcefile: "fakeRpcHarness.worker.ts",
        loader: "ts",
      },
      outfile: workerFile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      external: ["esbuild"],
      define: { "import.meta.url": JSON.stringify(harnessUrl) },
      plugins: [vitestShim],
    });

    // Each Worker has an independent module cache and invokes the actual
    // synchronous builder. The distinct returned paths make the old fixed-path
    // implementation fail deterministically even if its writes do not overlap.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runWorker(workerFile, workers)),
    );
    assert.deepEqual(
      results.map((result) => result.sessionId),
      Array(4).fill("fake-session-1"),
    );
    assert.equal(
      new Set(results.map((result) => result.bundlePath)).size,
      results.length,
    );
    assert.ok(
      results.every((result) => !existsSync(path.dirname(result.bundlePath))),
      "each worker must remove its owned bundle on exit",
    );
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    rmSync(workerDirectory, { recursive: true, force: true });
  }
});
