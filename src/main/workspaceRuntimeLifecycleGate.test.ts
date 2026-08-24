import assert from "node:assert/strict";
import { test } from "vitest";
import { WorkspaceRuntimeLifecycleGate } from "./workspaceRuntimeLifecycleGate.js";

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("a creation claim blocks archive until persistence completes", async () => {
  const gate = new WorkspaceRuntimeLifecycleGate();
  const started = deferred();
  const finish = deferred();
  let archiveRan = false;
  const creation = gate.withCreation("workspace-a", async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;

  await assert.rejects(
    gate.withArchive("workspace-a", () => {
      archiveRan = true;
    }),
    /already being changed/i,
  );
  assert.equal(archiveRan, false);

  finish.resolve();
  await creation;
  await gate.withArchive("workspace-a", () => {
    archiveRan = true;
  });
  assert.equal(archiveRan, true);
});

test("an archive claim rejects a late creation before worker spawn", async () => {
  const gate = new WorkspaceRuntimeLifecycleGate();
  const started = deferred();
  const finish = deferred();
  let workerSpawned = false;
  const archive = gate.withArchive("workspace-a", async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;

  await assert.rejects(
    gate.withCreation("workspace-a", () => {
      workerSpawned = true;
    }),
    /already being changed/i,
  );
  assert.equal(workerSpawned, false);

  finish.resolve();
  await archive;
});

test("creation claims are workspace-scoped and count concurrent creations", async () => {
  const gate = new WorkspaceRuntimeLifecycleGate();
  const firstFinish = deferred();
  const secondFinish = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();

  const first = gate.withCreation("workspace-a", async () => {
    firstStarted.resolve();
    await firstFinish.promise;
  });
  const second = gate.withCreation("workspace-a", async () => {
    secondStarted.resolve();
    await secondFinish.promise;
  });
  await Promise.all([firstStarted.promise, secondStarted.promise]);

  // An unrelated workspace remains available while workspace A is creating.
  let unrelatedArchiveRan = false;
  await gate.withArchive("workspace-b", () => {
    unrelatedArchiveRan = true;
  });
  assert.equal(unrelatedArchiveRan, true);

  await assert.rejects(
    gate.withArchive("workspace-a", () => undefined),
    /already being changed/i,
  );
  firstFinish.resolve();
  await first;
  await assert.rejects(
    gate.withArchive("workspace-a", () => undefined),
    /already being changed/i,
  );
  secondFinish.resolve();
  await second;
  await gate.withArchive("workspace-a", () => undefined);
});

test("a failed creation releases its workspace claim", async () => {
  const gate = new WorkspaceRuntimeLifecycleGate();
  await assert.rejects(
    gate.withCreation("workspace-a", () => {
      throw new Error("spawn failed");
    }),
    /spawn failed/,
  );

  let archiveRan = false;
  await gate.withArchive("workspace-a", () => {
    archiveRan = true;
  });
  assert.equal(archiveRan, true);
});

test("notifies lifecycle listeners after an archive claim releases", async () => {
  const gate = new WorkspaceRuntimeLifecycleGate();
  const started = deferred();
  const finish = deferred();
  let notifications = 0;
  const unsubscribe = gate.onCreationAvailable("workspace-a", () => {
    notifications += 1;
  });

  const archive = gate.withArchive("workspace-a", async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  assert.equal(notifications, 0);

  finish.resolve();
  await archive;
  assert.equal(notifications, 1);

  unsubscribe();
  await gate.withArchive("workspace-a", () => undefined);
  assert.equal(notifications, 1);
});
