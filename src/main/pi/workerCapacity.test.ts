import assert from "node:assert/strict";
import { it as test } from "vitest";
import { WorkerCapacity, WorkerCapacityError } from "./workerCapacity.js";

test("WorkerCapacity makes concurrent allocation honor a hard maximum", async () => {
  const workers = new Set<string>();
  const capacity = new WorkerCapacity(() => workers.size);
  let releaseFirstCreation: (() => void) | undefined;
  const firstCreationStarted = new Promise<void>((resolve) => {
    releaseFirstCreation = resolve;
  });
  let allowFirstCreation: (() => void) | undefined;
  const firstCreationMayFinish = new Promise<void>((resolve) => {
    allowFirstCreation = resolve;
  });

  const first = capacity.allocate(
    async () => 2,
    async () => {
      releaseFirstCreation?.();
      await firstCreationMayFinish;
      workers.add("real-worker");
    },
  );
  await firstCreationStarted;

  const second = capacity.allocate(
    async () => 2,
    () => workers.add("fake-worker"),
  );
  const third = capacity.allocate(
    async () => 2,
    () => workers.add("must-not-start"),
  );

  allowFirstCreation?.();
  await Promise.all([first, second]);
  await assert.rejects(third, (error: unknown) => {
    assert.ok(error instanceof WorkerCapacityError);
    assert.equal(error.maxRunningSessions, 2);
    return true;
  });
  assert.deepEqual(workers, new Set(["real-worker", "fake-worker"]));
});

test("WorkerCapacity counts a warm worker and reads settings for each allocation", async () => {
  const workers = new Set(["warm-worker"]);
  let maxRunningSessions = 1;
  const capacity = new WorkerCapacity(() => workers.size);

  await assert.rejects(
    capacity.allocate(
      async () => maxRunningSessions,
      () => workers.add("new-worker"),
    ),
    /capacity \(1\) reached/,
  );

  maxRunningSessions = 2;
  await capacity.allocate(
    async () => maxRunningSessions,
    () => workers.add("new-worker"),
  );
  assert.deepEqual(workers, new Set(["warm-worker", "new-worker"]));
});

test("WorkerCapacity releases a failed worker creation reservation", async () => {
  const workers = new Set<string>();
  const capacity = new WorkerCapacity(() => workers.size);

  await assert.rejects(
    capacity.allocate(
      async () => 1,
      () => {
        throw new Error("spawn failed");
      },
    ),
    /spawn failed/,
  );
  await capacity.allocate(
    async () => 1,
    () => workers.add("replacement"),
  );
  assert.deepEqual(workers, new Set(["replacement"]));
});
