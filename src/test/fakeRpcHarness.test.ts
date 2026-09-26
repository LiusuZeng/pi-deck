import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { it as test } from "vitest";
import {
  createFakeRpcServerBundle,
  type FakeRpcServerBundle,
} from "./fakeRpcHarness.js";
import type { JsonlRpcClient } from "../main/pi/jsonlClient.js";

function closeAndWait(client: JsonlRpcClient): Promise<void> {
  if (client.child.exitCode !== null || client.child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    client.child.once("close", () => resolve());
    client.close();
  });
}

test("concurrent fake-RPC builds spawn isolated servers and serve RPCs", async () => {
  // These asynchronous esbuild calls overlap intentionally. This exercises the
  // same builder/write/spawn boundary that separate Vitest workers and parallel
  // checkouts reach, rather than repeatedly reading one cached bundle.
  const bundles = await Promise.all(
    Array.from({ length: 4 }, () => createFakeRpcServerBundle()),
  );
  const clients: JsonlRpcClient[] = [];

  try {
    assert.equal(new Set(bundles.map((bundle) => bundle.path)).size, 4);
    assert.equal(
      new Set(bundles.map((bundle) => path.dirname(bundle.path))).size,
      4,
    );
    assert.ok(bundles.every((bundle) => existsSync(bundle.path)));

    // Spawn every child before awaiting any response so process startup and RPC
    // traffic are genuinely concurrent as well.
    clients.push(...bundles.map((bundle) => bundle.spawn()));
    const states = await Promise.all(
      clients.map((client) => client.request("get_state")),
    );
    assert.deepEqual(
      states.map((state) => (state as { sessionId?: string }).sessionId),
      Array(4).fill("fake-session-1"),
    );
  } finally {
    await Promise.allSettled(clients.map((client) => closeAndWait(client)));
    bundles.forEach((bundle: FakeRpcServerBundle) => bundle.dispose());
  }

  assert.ok(bundles.every((bundle) => !existsSync(path.dirname(bundle.path))));
});
