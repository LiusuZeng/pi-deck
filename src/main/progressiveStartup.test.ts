import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticsService } from "./diagnostics/diagnostics.js";
import { startProgressiveStartup } from "./progressiveStartup.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("progressive startup", () => {
  it("prepares the shell before scheduled backend initialization", async () => {
    const order: string[] = [];
    let now = 100;
    let scheduled: (() => void) | undefined;
    const startup = startProgressiveStartup({
      startedAtMs: 90,
      now: () => now,
      schedule: (callback) => {
        scheduled = callback;
      },
      prepareShell: () => {
        order.push("shell");
        now = 105;
      },
      initializeBackend: async () => {
        order.push("backend");
        now = 140;
      },
    });

    expect(order).toEqual(["shell"]);
    expect(startup.shellReadyMs).toBe(15);
    expect(scheduled).toBeTypeOf("function");

    scheduled?.();
    const timings = await startup.backendReady;
    expect(order).toEqual(["shell", "backend"]);
    expect(timings).toEqual({
      shellReadyMs: 15,
      backendReadyMs: 50,
    });
  });

  it("keeps shell preparation independent from backend failure", async () => {
    let shellPrepared = false;
    let scheduled: (() => void) | undefined;
    const startup = startProgressiveStartup({
      startedAtMs: 0,
      now: () => 1,
      schedule: (callback) => {
        scheduled = callback;
      },
      prepareShell: () => {
        shellPrepared = true;
      },
      initializeBackend: async () => {
        throw new Error("backend failed");
      },
    });

    expect(shellPrepared).toBe(true);
    scheduled?.();
    await expect(startup.backendReady).rejects.toThrow("backend failed");
  });

  it("does not reject backend readiness for optional diagnostics retention failures", async () => {
    const userData = await tempDir();
    const service = new DiagnosticsService("test", userData, {
      operations: {
        truncate: async (filePath, length): Promise<void> => {
          if (path.basename(filePath) === "oversized.log") {
            const error = new Error(
              "injected diagnostics truncate failure",
            ) as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          }
          await truncate(filePath, length);
        },
      },
    });
    await mkdir(service.logPath, { recursive: true });
    await writeFile(
      path.join(service.logPath, "oversized.log"),
      Buffer.alloc(6 * 1024 * 1024),
    );
    let shellPrepared = false;
    let scheduled: (() => void) | undefined;
    const startup = startProgressiveStartup({
      startedAtMs: 0,
      now: () => 1,
      schedule: (callback) => {
        scheduled = callback;
      },
      prepareShell: () => {
        shellPrepared = true;
      },
      initializeBackend: () => service.initialize(),
    });

    expect(shellPrepared).toBe(true);
    scheduled?.();
    await expect(startup.backendReady).resolves.toEqual({
      shellReadyMs: 1,
      backendReadyMs: 1,
    });
    expect(
      service.getSummary({
        maxRunningSessions: 4,
        warmWorkerLimit: 1,
        enableLoginShellEnvCapture: true,
      }).recentErrors,
    ).toEqual([expect.stringContaining('truncate failed for "oversized.log"')]);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-deck-startup-"));
  tempDirs.push(dir);
  return dir;
}
