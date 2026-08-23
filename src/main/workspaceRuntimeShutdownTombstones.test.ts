import assert from "node:assert/strict";
import { test } from "vitest";
import { WorkspaceRuntimeShutdownTombstones } from "./workspaceRuntimeShutdownTombstones.js";

test("a reset adapter watcher releases a failed close after worker exit", () => {
  const tombstones = new WorkspaceRuntimeShutdownTombstones();
  let workerExit:
    | ((event: { type: string; runtimeId: string }) => void)
    | undefined;
  let unsubscribed = false;
  let disposeWatcher: (() => void) | undefined;

  tombstones.beginClose("runtime-a", "workspace-a");
  disposeWatcher = tombstones.watchAdapter(
    (listener) => {
      workerExit = listener;
      return () => {
        unsubscribed = true;
      };
    },
    new Set(["runtime-a"]),
    () => {
      if (!tombstones.has("runtime-a")) disposeWatcher?.();
    },
  );

  // The reset path has detached its normal event router and the adapter close
  // rejects, so the old adapter watcher is the only remaining exit proof.
  tombstones.markCloseFailed("runtime-a", "workspace-a");
  tombstones.finishClose("runtime-a", false);
  assert.equal(tombstones.isWorkspaceBlocked("workspace-a"), true);

  workerExit?.({ type: "worker_exit", runtimeId: "runtime-a" });

  assert.equal(tombstones.isWorkspaceBlocked("workspace-a"), false);
  assert.equal(tombstones.has("runtime-a"), false);
  assert.equal(unsubscribed, true);
});

test("an exit observed during close clears the tombstone when close finishes", () => {
  const tombstones = new WorkspaceRuntimeShutdownTombstones();
  let workerExit:
    | ((event: { type: string; runtimeId: string }) => void)
    | undefined;

  tombstones.beginClose("runtime-a", "workspace-a");
  tombstones.watchAdapter(
    (listener) => {
      workerExit = listener;
      return () => undefined;
    },
    new Set(["runtime-a"]),
  );

  workerExit?.({ type: "worker_exit", runtimeId: "runtime-a" });

  assert.equal(tombstones.isWorkspaceBlocked("workspace-a"), false);
  assert.equal(tombstones.has("runtime-a"), true);
  tombstones.finishClose("runtime-a", false);
  assert.equal(tombstones.has("runtime-a"), false);
});
