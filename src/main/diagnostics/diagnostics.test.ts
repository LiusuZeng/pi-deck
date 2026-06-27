import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-deck-diagnostics-"));
  tempDirs.push(dir);
  return dir;
}
