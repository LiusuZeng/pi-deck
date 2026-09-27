import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  BlockedSessionCandidateTracker,
  enterSessionAttachmentTeardown,
  filterBlockedSessionCandidates,
  SessionAttachmentGate,
  SessionDiscoveryGate,
} from "./sessionDiscoveryGate.js";

const temporaryRoots: string[] = [];

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("test operation timed out")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("blocked candidate counts deduplicate canonical scan and cache identities", () => {
  const tracker = new BlockedSessionCandidateTracker();
  tracker.record("/sessions/source.jsonl");
  tracker.record("/sessions/target.jsonl");
  tracker.record("/sessions/source.jsonl");
  tracker.record("/sessions/target.jsonl");

  assert.equal(tracker.count, 2);
});

test("blocked cached candidates are hidden without mutation or adoption", async () => {
  const cached = [
    { sessionFile: "/sessions/committed.jsonl", title: "committed" },
    { sessionFile: "/sessions/uncommitted.jsonl", title: "uncommitted" },
  ] as const;
  const persisted: string[] = [];
  const { attachable, blocked } = await filterBlockedSessionCandidates(
    cached,
    async (sessionFile) => sessionFile.endsWith("uncommitted.jsonl"),
  );
  persisted.push(...attachable.map((candidate) => candidate.sessionFile));

  assert.deepEqual(
    attachable.map((candidate) => candidate.title),
    ["committed"],
  );
  assert.deepEqual(
    blocked.map((candidate) => candidate.title),
    ["uncommitted"],
  );
  assert.deepEqual(persisted, ["/sessions/committed.jsonl"]);
  assert.equal(cached.length, 2);
  assert.equal(cached[1].title, "uncommitted");
});

test("teardown closes registered snapshot workers before awaiting its barrier", async () => {
  const attachment = new SessionAttachmentGate();
  const snapshotLease = await attachment.enter(3);
  const registeredCloseStarted = deferred();
  const events: string[] = [];

  const teardown = enterSessionAttachmentTeardown({
    gate: attachment,
    generation: 4,
    closePendingWorkers: async () => {
      events.push("close-pending");
    },
    closeRegisteredWorkers: async () => {
      events.push("close-registered");
      registeredCloseStarted.resolve();
      // Worker exit rejects the pending snapshot RPC, whose finally releases
      // the old lease. If teardown awaited its barrier first, neither side
      // could make progress.
      snapshotLease.release();
    },
  });

  await bounded(registeredCloseStarted.promise);
  const teardownLease = await bounded(teardown);
  assert.deepEqual(events, ["close-pending", "close-registered"]);
  assert.equal(teardownLease.generation, 4);
  teardownLease.release();

  const next = await bounded(attachment.enter(5));
  next.release();
});

test("pending count includes queued and entered discovery work", async () => {
  const attachment = new SessionAttachmentGate();
  const blocker = await attachment.enter(0);
  const discovery = new SessionDiscoveryGate(attachment, {});
  const operationStarted = deferred();
  const finishOperation = deferred();
  const listing = discovery.run({
    generation: 0,
    assertActive: () => undefined,
    operation: async () => {
      operationStarted.resolve();
      await finishOperation.promise;
    },
  });

  assert.equal(discovery.pendingCount, 1);
  blocker.release();
  await bounded(operationStarted.promise);
  assert.equal(discovery.pendingCount, 1);
  finishOperation.resolve();
  await bounded(listing);
  assert.equal(discovery.pendingCount, 0);
});

test("fork-first ordering holds discovery through admission and persistence", async () => {
  const attachment = new SessionAttachmentGate();
  const discovery = new SessionDiscoveryGate(attachment, {});
  const fork = await attachment.enter(0);
  const scanned = deferred();
  const releasePersistence = deferred();
  const events: string[] = [];

  const listing = discovery.run({
    kind: "project",
    generation: 0,
    assertActive: () => undefined,
    operation: async (assertActive) => {
      events.push("scan");
      scanned.resolve();
      assertActive();
      events.push("admit");
      await releasePersistence.promise;
      events.push("persist");
      return "listed";
    },
  });

  await Promise.resolve();
  assert.deepEqual(events, []);
  fork.release();
  await bounded(scanned.promise);
  assert.deepEqual(events, ["scan", "admit"]);
  releasePersistence.resolve();
  assert.equal(await bounded(listing), "listed");
  assert.deepEqual(events, ["scan", "admit", "persist"]);
});

test("discovery-first ordering keeps a fork out until cache persistence finishes", async () => {
  const attachment = new SessionAttachmentGate();
  const discovery = new SessionDiscoveryGate(attachment, {});
  const discoveryEntered = deferred();
  const finishPersistence = deferred();
  const forkEntered = deferred();

  const listing = discovery.run({
    kind: "workspace",
    generation: 4,
    assertActive: () => undefined,
    operation: async () => {
      discoveryEntered.resolve();
      await finishPersistence.promise;
    },
  });
  await bounded(discoveryEntered.promise);

  const forkPromise = attachment.enter(4).then((lease) => {
    forkEntered.resolve();
    return lease;
  });
  let forkHasEntered = false;
  void forkEntered.promise.then(() => {
    forkHasEntered = true;
  });
  await Promise.resolve();
  assert.equal(forkHasEntered, false);

  finishPersistence.resolve();
  await bounded(listing);
  const fork = await bounded(forkPromise);
  fork.release();
});

test("generation cancellation rejects a queued discovery before scan or admission", async () => {
  const attachment = new SessionAttachmentGate();
  const discovery = new SessionDiscoveryGate(attachment, {});
  const blocker = await attachment.enter(8);
  let generation = 8;
  let operationRan = false;

  const listing = discovery.run({
    kind: "unassigned",
    generation,
    assertActive: () => {
      if (generation !== 8) throw new Error("discovery cancelled");
    },
    operation: async () => {
      operationRan = true;
    },
  });
  generation += 1;
  blocker.release();

  await assert.rejects(bounded(listing), /discovery cancelled/);
  assert.equal(operationRan, false);
  const next = await bounded(attachment.enter(generation));
  next.release();
});

test("cancellation after a scan prevents admission and releases the gate", async () => {
  const attachment = new SessionAttachmentGate();
  const discovery = new SessionDiscoveryGate(attachment, {});
  const scanStarted = deferred();
  const finishScan = deferred();
  let generation = 12;
  let persisted = false;

  const listing = discovery.run({
    kind: "project",
    generation,
    assertActive: () => {
      if (generation !== 12) throw new Error("discovery cancelled");
    },
    operation: async (assertActive) => {
      scanStarted.resolve();
      await finishScan.promise;
      assertActive();
      persisted = true;
    },
  });
  await bounded(scanStarted.promise);
  generation += 1;
  finishScan.resolve();

  await assert.rejects(bounded(listing), /discovery cancelled/);
  assert.equal(persisted, false);
  const next = await bounded(attachment.enter(generation));
  next.release();
});

test("operation and marker failures release the queue for later attachment", async () => {
  const attachment = new SessionAttachmentGate();
  const failingDiscovery = new SessionDiscoveryGate(attachment, {});
  await assert.rejects(
    failingDiscovery.run({
      generation: 0,
      assertActive: () => undefined,
      operation: async () => {
        throw new Error("persistence failed");
      },
    }),
    /persistence failed/,
  );
  (await bounded(attachment.enter(0))).release();

  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-discovery-marker-failure-"),
  );
  temporaryRoots.push(root);
  const markerFile = path.join(root, "not-a-directory");
  await fs.writeFile(markerFile, "file");
  const markerFailure = new SessionDiscoveryGate(attachment, {
    PI_DECK_E2E_TEST: "1",
    PI_DECK_TEST_DISCOVERY_GATE_DIR: markerFile,
  });
  await assert.rejects(
    markerFailure.run({
      kind: "project",
      generation: 0,
      assertActive: () => undefined,
      operation: async () => undefined,
    }),
  );
  (await bounded(attachment.enter(0))).release();
});

test("discovery markers stay disabled outside the E2E environment", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-disabled-discovery-markers-"),
  );
  temporaryRoots.push(root);
  const attachment = new SessionAttachmentGate();
  const discovery = new SessionDiscoveryGate(attachment, {
    PI_DECK_TEST_DISCOVERY_GATE_DIR: root,
  });

  await bounded(
    discovery.run({
      kind: "project",
      generation: 0,
      assertActive: () => undefined,
      operation: async () => undefined,
    }),
  );
  assert.deepEqual(await fs.readdir(root), []);
});

test("E2E markers are opt-in and queued is durable before entered", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-discovery-markers-"),
  );
  temporaryRoots.push(root);
  const attachment = new SessionAttachmentGate();
  const blocker = await attachment.enter(0);
  const queuedMarkerWritten = deferred();
  const discovery = new SessionDiscoveryGate(
    attachment,
    {
      PI_DECK_E2E_TEST: "1",
      PI_DECK_TEST_DISCOVERY_GATE_DIR: root,
    },
    (_kind, phase) => {
      if (phase === "queued") queuedMarkerWritten.resolve();
    },
  );
  const entered = deferred();
  const listing = discovery.run({
    kind: "workspace",
    generation: 0,
    assertActive: () => undefined,
    operation: async () => {
      entered.resolve();
    },
  });

  await bounded(queuedMarkerWritten.promise);
  await bounded(fs.readFile(path.join(root, "workspace-queued"), "utf8"));
  await assert.rejects(
    fs.readFile(path.join(root, "workspace-entered"), "utf8"),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  blocker.release();
  await bounded(entered.promise);
  await bounded(listing);
  assert.equal(
    await fs.readFile(path.join(root, "workspace-entered"), "utf8"),
    "entered\n",
  );
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});
