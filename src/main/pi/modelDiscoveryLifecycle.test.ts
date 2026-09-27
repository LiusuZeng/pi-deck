import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  discoverPiModels,
  discoverPiRuntimeModels,
  PiRuntimeModelDiscoveryError,
} from "./modelDiscovery.js";
import { PiWorker } from "./piWorker.js";

vi.mock("./piWorker.js", () => ({ PiWorker: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const options = {
  command: "not-a-real-pi-command",
  cwd: process.cwd(),
  env: process.env,
};

function mockWorker() {
  const exit = deferred<void>();
  const worker = {
    getState: vi.fn().mockResolvedValue({ thinkingLevel: "medium" }),
    request: vi.fn().mockResolvedValue({ models: [], levels: ["medium"] }),
    closeSession: vi.fn(() => exit.promise),
  };
  vi.mocked(PiWorker).mockImplementation(function () {
    return worker as unknown as PiWorker;
  });
  return { worker, exit };
}

beforeEach(() => vi.resetAllMocks());

describe("model discovery child ownership", () => {
  it("does not spawn an RPC worker after cancellation", async () => {
    const reason = new Error("reset");
    await expect(
      discoverPiRuntimeModels({
        ...options,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(PiWorker).not.toHaveBeenCalled();
  });

  it("does not spawn the command fallback after cancellation", async () => {
    const reason = new Error("quit");
    // The nonexistent command would produce ENOENT if a spawn were attempted.
    await expect(
      discoverPiModels({ ...options, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
  });

  it("awaits terminal child confirmation on successful discovery", async () => {
    const { worker, exit } = mockWorker();
    let settled = false;
    const discovery = discoverPiRuntimeModels(options).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(worker.closeSession).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    exit.resolve();
    await expect(discovery).resolves.toMatchObject({ thinkingLevel: "medium" });
  });

  it("awaits terminal child confirmation on RPC failure", async () => {
    const { worker, exit } = mockWorker();
    const reason = new Error("RPC failed");
    worker.getState.mockRejectedValue(reason);
    let settled = false;
    const outcome = discoverPiRuntimeModels(options).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(worker.closeSession).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    exit.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(PiRuntimeModelDiscoveryError);
    const discoveryError = error as PiRuntimeModelDiscoveryError;
    expect(discoveryError.failedCommands).toEqual(["get_state"]);
    expect(discoveryError.partialResult).toEqual({
      models: [],
      thinkingLevels: ["medium"],
    });
    expect(discoveryError.cause).toBe(reason);
  });

  it("retains a slower get_state default when model inventory fails first", async () => {
    const { worker, exit } = mockWorker();
    const state = deferred<{ thinkingLevel: string }>();
    const reason = new Error("model inventory failed");
    worker.getState.mockReturnValue(state.promise);
    worker.request.mockImplementation((command: string) =>
      command === "get_available_models"
        ? Promise.reject(reason)
        : Promise.resolve({ levels: ["off", "medium", "high"] }),
    );

    const outcome = discoverPiRuntimeModels(options).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(worker.request).toHaveBeenCalledWith("get_available_models"),
    );
    expect(worker.closeSession).not.toHaveBeenCalled();
    state.resolve({ thinkingLevel: "medium" });
    await vi.waitFor(() => expect(worker.closeSession).toHaveBeenCalledOnce());
    exit.resolve();

    const error = await outcome;
    expect(error).toBeInstanceOf(PiRuntimeModelDiscoveryError);
    const discoveryError = error as PiRuntimeModelDiscoveryError;
    expect(discoveryError.failedCommands).toEqual(["get_available_models"]);
    expect(discoveryError.partialResult).toEqual({
      models: [],
      thinkingLevel: "medium",
      thinkingLevels: ["off", "medium", "high"],
    });
    expect(discoveryError.cause).toBe(reason);
    expect(worker.closeSession).toHaveBeenCalledOnce();
  });

  it("cancels pending RPC and retains ownership until close completes", async () => {
    const { worker, exit } = mockWorker();
    const request = deferred<unknown>();
    worker.getState.mockReturnValue(request.promise);
    worker.closeSession.mockImplementation(() => {
      request.reject(new Error("worker exited"));
      return exit.promise;
    });
    const controller = new AbortController();
    const reason = new Error("reset");
    let settled = false;
    const outcome = discoverPiRuntimeModels({
      ...options,
      signal: controller.signal,
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    controller.abort(reason);
    await vi.waitFor(() => expect(worker.closeSession).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    exit.resolve();
    await expect(outcome).resolves.toBe(reason);
    expect(worker.closeSession).toHaveBeenCalledOnce();
  });

  it("does not publish a successful result if cancelled during child cleanup", async () => {
    const { worker, exit } = mockWorker();
    const controller = new AbortController();
    const reason = new Error("quit during cleanup");
    const outcome = discoverPiRuntimeModels({
      ...options,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(worker.closeSession).toHaveBeenCalledOnce());
    controller.abort(reason);
    exit.resolve();
    await expect(outcome).resolves.toBe(reason);
    expect(worker.closeSession).toHaveBeenCalledOnce();
  });
});
