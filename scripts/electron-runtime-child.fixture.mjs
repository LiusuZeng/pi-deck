import { cp } from "node:fs/promises";
import { preparePiDeckElectronExecutable } from "./electron-runtime.mjs";

const options = JSON.parse(process.env.PI_DECK_RUNTIME_CHILD_OPTIONS);
let continueCopy;
const copyMayFinish = new Promise((resolve) => {
  continueCopy = resolve;
});
let continueLockPublication;
const lockPublicationMayFinish = new Promise((resolve) => {
  continueLockPublication = resolve;
});
let continueLockWait;
const lockWaitMayFinish = new Promise((resolve) => {
  continueLockWait = resolve;
});

function send(message) {
  process.send?.(message);
}

process.on("message", (message) => {
  if (message === "continue-copy") {
    continueCopy();
  }
  if (message === "continue-lock-publication") {
    continueLockPublication();
  }
  if (message === "continue-lock-wait") {
    continueLockWait();
  }
});

try {
  const executable = await preparePiDeckElectronExecutable({
    platform: "darwin",
    electronExecutable: options.electronExecutable,
    runtimeCacheRoot: options.runtimeCacheRoot,
    copyBundle: async (source, destination) => {
      if (options.copyMode === "exit") {
        send({ type: "copy-started" });
        process.exit(0);
      }
      if (options.copyMode === "hold") {
        send({ type: "copy-started" });
        await copyMayFinish;
      }
      if (options.copyMode === "fail") {
        send({ type: "contender-copy-started" });
        await copyMayFinish;
        throw new Error("contender copy should not run");
      }
      await cp(source, destination, {
        recursive: true,
        preserveTimestamps: true,
      });
    },
    patchBundleIdentity: async () => undefined,
    beforeRuntimePreparationLockPublish:
      options.holdLockPublication === true
        ? async () => {
            send({ type: "lock-candidate-ready" });
            await lockPublicationMayFinish;
          }
        : undefined,
    onRuntimePreparationLockWait:
      options.waitForLock === true
        ? async () => {
            send({ type: "lock-waiting" });
            await lockWaitMayFinish;
          }
        : undefined,
  });
  send({ type: "result", ok: true, executable });
  process.disconnect?.();
} catch (error) {
  send({ type: "result", ok: false, error: error.message });
  process.exitCode = 1;
  process.disconnect?.();
}
