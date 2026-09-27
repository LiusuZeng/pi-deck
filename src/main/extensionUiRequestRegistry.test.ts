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
  it("projects the full request for renderer recovery and clears after a claim", () => {
    const { value } = registry();
    const request: Request = {
      id: "approval-1",
      method: "confirm",
      title: "Approve",
      timeout: 100,
    };
    value.register("runtime-1", request);

    expect(value.snapshot("runtime-1")).toEqual([request]);
    const claimed = value.claim("runtime-1", request.id);
    expect(claimed?.request).toEqual(request);
    expect(value.snapshot("runtime-1")).toEqual([]);
    expect(value.claim("runtime-1", request.id)).toBeUndefined();
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

  it("does not restore an old claim over a newer request with the same id", () => {
    const { value } = registry();
    value.register("runtime-1", {
      id: "approval-1",
      method: "confirm",
      title: "Old",
    });
    const claimed = value.claim("runtime-1", "approval-1")!;
    value.register("runtime-1", {
      id: "approval-1",
      method: "confirm",
      title: "New",
    });

    expect(value.restore(claimed)).toBe("superseded");
    expect(value.snapshot("runtime-1")).toMatchObject([{ title: "New" }]);
  });
});
