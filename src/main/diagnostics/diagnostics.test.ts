import {
  mkdtemp,
  rm,
  stat,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Stats } from "node:fs";
import {
  applyLogRetention,
  DiagnosticsService,
  redactSettings,
} from "./diagnostics.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("diagnostics", () => {
  it("creates a diagnostics summary with userData and log paths", async () => {
    const dir = await tempDir();
    const service = new DiagnosticsService("0.1.0", dir);
    await service.initialize();
    service.recordError("sample error");

    expect(
      service.getSummary({
        maxRunningSessions: 4,
        warmWorkerLimit: 1,
        enableLoginShellEnvCapture: true,
      }),
    ).toMatchObject({
      appVersion: "0.1.0",
      userDataPath: dir,
      logPath: path.join(dir, "logs"),
      recentErrors: ["sample error"],
    });
  });

  it("redacts secret-like setting names recursively", () => {
    const redacted = redactSettings({
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: true,
      apiKey: "secret-value",
    } as never);

    expect((redacted as unknown as { apiKey: string }).apiKey).toBe(
      "[REDACTED]",
    );
  });

  it("truncates oversized logs and removes expired logs", async () => {
    const dir = await tempDir();
    const logs = path.join(dir, "logs");
    const oversized = path.join(logs, "oversized.log");
    const expired = path.join(logs, "expired.log");
    await applyLogRetention(logs);
    await writeFile(oversized, Buffer.alloc(6 * 1024 * 1024));
    await writeFile(expired, "old");
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(expired, oldDate, oldDate);

    await applyLogRetention(logs);

    await expect(stat(oversized)).resolves.toMatchObject({
      size: 5 * 1024 * 1024,
    });
    await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates per-entry retention failures and continues other cleanup", async () => {
    const dir = await tempDir();
    const logs = path.join(dir, "logs");
    const failStat = path.join(logs, "fail-stat.log");
    const failUnlink = path.join(logs, "fail-unlink.log");
    const failTruncate = path.join(logs, "fail-truncate.log");
    const removeOk = path.join(logs, "remove-ok.log");
    const truncateOk = path.join(logs, "truncate-ok.log");
    await applyLogRetention(logs);
    await Promise.all([
      writeFile(failStat, "stat"),
      writeFile(failUnlink, "unlink"),
      writeFile(failTruncate, Buffer.alloc(6 * 1024 * 1024)),
      writeFile(removeOk, "remove"),
      writeFile(truncateOk, Buffer.alloc(6 * 1024 * 1024)),
    ]);
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await Promise.all([
      utimes(failUnlink, oldDate, oldDate),
      utimes(removeOk, oldDate, oldDate),
    ]);
    const warnings: string[] = [];

    await expect(
      applyLogRetention(logs, {
        operations: {
          stat: async (filePath): Promise<Stats> => {
            if (path.basename(filePath) === "fail-stat.log") {
              throw errorWithCode("injected stat failure", "EACCES");
            }
            return stat(filePath);
          },
          unlink: async (filePath): Promise<void> => {
            if (path.basename(filePath) === "fail-unlink.log") {
              throw errorWithCode("injected unlink failure", "EACCES");
            }
            await unlink(filePath);
          },
          truncate: async (filePath, length): Promise<void> => {
            if (path.basename(filePath) === "fail-truncate.log") {
              throw errorWithCode("injected truncate failure", "EACCES");
            }
            await truncate(filePath, length);
          },
        },
        onWarning: (warning) => warnings.push(warning),
      }),
    ).resolves.toBeUndefined();

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('stat failed for "fail-stat.log"'),
        expect.stringContaining('unlink failed for "fail-unlink.log"'),
        expect.stringContaining('truncate failed for "fail-truncate.log"'),
      ]),
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.every((warning) => warning.length <= 500)).toBe(true);
    await expect(stat(removeOk)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(truncateOk)).resolves.toMatchObject({
      size: 5 * 1024 * 1024,
    });
    await expect(stat(failUnlink)).resolves.toBeDefined();
    await expect(stat(failTruncate)).resolves.toMatchObject({
      size: 6 * 1024 * 1024,
    });
  });

  it("treats files disappearing during retention as benign races", async () => {
    const dir = await tempDir();
    const logs = path.join(dir, "logs");
    const missing = path.join(logs, "missing.log");
    await applyLogRetention(logs);
    await writeFile(missing, "missing");
    const warnings: string[] = [];

    await expect(
      applyLogRetention(logs, {
        operations: {
          stat: async () => {
            throw errorWithCode("already gone", "ENOENT");
          },
        },
        onWarning: (warning) => warnings.push(warning),
      }),
    ).resolves.toBeUndefined();

    expect(warnings).toEqual([]);
  });
});

function errorWithCode(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-deck-diagnostics-"));
  tempDirs.push(dir);
  return dir;
}
