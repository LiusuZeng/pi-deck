import { describe, expect, it, vi } from "vitest";
import { ExtensionUiRequestRegistry } from "./extensionUiRequestRegistry.js";

interface Request {
  id: string;
  method: "confirm";
  title: string;
  timeout?: number;
}

function registry(onTimeout = vi.fn()) {
  return {
    onTimeout,
    value: new ExtensionUiRequestRegistry<Request>({
      timeoutGraceMs: 10,
      onTimeout,
    }),
  };
}

describe("ExtensionUiRequestRegistry", () => {
  it("counts an in-flight claim without projecting it into recovery", () => {
    const { value } = registry();
    const request: Request = {
      id: "approval-1",
      method: "confirm",
      title: "Approve",
      timeout: 100,
    };
    value.register("runtime-1", request);

    expect(value.pendingCount).toBe(1);
    expect(value.snapshot("runtime-1")).toEqual([request]);
    const claimed = value.claim("runtime-1", request.id)!;
    expect(claimed.request).toEqual(request);
    expect(value.pendingCount).toBe(1);
    expect(value.has("runtime-1")).toBe(true);
    expect([...value.keys()]).toEqual(["runtime-1"]);
    expect(value.snapshot("runtime-1")).toEqual([]);
    expect(value.claim("runtime-1", request.id)).toBeUndefined();

    expect(value.complete(claimed)).toBe(true);
    expect(value.complete(claimed)).toBe(false);
    expect(value.pendingCount).toBe(0);
    expect(value.has("runtime-1")).toBe(false);
  });

  it("makes an in-flight response win the timeout race without stale resurrection", async () => {
    vi.useFakeTimers();
    try {
      const { value, onTimeout } = registry();
      value.register("runtime-1", {
        id: "approval-1",
        method: "confirm",
        title: "Approve",
        timeout: 20,
      });
      const claimed = value.claim("runtime-1", "approval-1");
      expect(claimed).toBeDefined();

      await vi.advanceTimersByTimeAsync(100);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(value.snapshot("runtime-1")).toEqual([]);
      expect(value.complete(claimed!)).toBe(true);
      expect(value.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores a failed response before expiry and removes it on timeout", async () => {
    vi.useFakeTimers();
    try {
      const { value, onTimeout } = registry();
      value.register("runtime-1", {
        id: "approval-1",
        method: "confirm",
        title: "Approve",
        timeout: 20,
      });
      const claimed = value.claim("runtime-1", "approval-1")!;
      expect(value.restore(claimed)).toBe("restored");
      expect(value.snapshot("runtime-1")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(value.snapshot("runtime-1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never resurrects a claimed request after its deadline", async () => {
    vi.useFakeTimers();
    try {
      const { value, onTimeout } = registry();
      value.register("runtime-1", {
        id: "approval-1",
        method: "confirm",
        title: "Approve",
        timeout: 20,
      });
      const claimed = value.claim("runtime-1", "approval-1")!;
      await vi.advanceTimersByTimeAsync(30);

      expect(value.restore(claimed)).toBe("expired");
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(value.snapshot("runtime-1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore an old claim after a newer same-id request is also claimed", () => {
    const { value } = registry();
    value.register("runtime-1", {
      id: "approval-1",
      method: "confirm",
      title: "Old",
    });
    const oldClaim = value.claim("runtime-1", "approval-1")!;
    value.register("runtime-1", {
      id: "approval-1",
      method: "confirm",
      title: "New",
    });
    const newClaim = value.claim("runtime-1", "approval-1")!;

    expect(value.restore(oldClaim)).toBe("superseded");
    expect(value.restore(newClaim)).toBe("restored");
    expect(value.snapshot("runtime-1")).toMatchObject([{ title: "New" }]);
  });

  it("invalidates a claim when its runtime is cleared with no pending record", () => {
    const { value } = registry();
    value.register("runtime-1", {
      id: "approval-1",
      method: "confirm",
      title: "Approve",
    });
    const claimed = value.claim("runtime-1", "approval-1")!;
    expect(value.snapshot("runtime-1")).toEqual([]);

    value.clearRuntime("runtime-1");

    expect(value.pendingCount).toBe(0);
    expect(value.restore(claimed)).toBe("superseded");
    expect(value.snapshot("runtime-1")).toEqual([]);
  });

  it("only lets the exact current claim restore authorization", () => {
    const { value } = registry();
    value.register("runtime-1", {
      id: "approval-1",
      method: "confirm",
      title: "Approve",
    });
    const claimed = value.claim("runtime-1", "approval-1")!;

    expect(value.restore({ ...claimed })).toBe("superseded");
    expect(value.restore(claimed)).toBe("restored");
  });
});
