import { describe, expect, it } from "vitest";
import { startProgressiveStartup } from "./progressiveStartup.js";

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
});
