import { describe, expect, it, vi } from "vitest";
import {
  QuitLifecycleCoordinator,
  RendererCrashRecovery,
  type QuitActivitySummary,
} from "./appLifecycle.js";

const inactive: QuitActivitySummary = {
  activeChats: 0,
  privateTasks: 0,
  workflowRuntimes: 0,
  pendingOperations: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("QuitLifecycleCoordinator", () => {
  it("quits inactive work without presenting a dialog", async () => {
    const confirmQuit = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const requestFinalQuit = vi.fn();
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => inactive,
      confirmQuit,
      cleanup,
      requestFinalQuit,
      recordDiagnostic: vi.fn(),
    });

    await expect(coordinator.requestQuit("application")).resolves.toBe(
      "quitting",
    );
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(coordinator.allowsExit).toBe(true);
    expect(requestFinalQuit).toHaveBeenCalledOnce();
  });

  it("treats pending lifecycle operations as confirmable active work", async () => {
    const confirmQuit = vi.fn(async () => "cancel" as const);
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => ({ ...inactive, pendingOperations: 1 }),
      confirmQuit,
      cleanup: vi.fn(),
      requestFinalQuit: vi.fn(),
      recordDiagnostic: vi.fn(),
    });

    await expect(coordinator.requestQuit("application")).resolves.toBe(
      "cancelled",
    );
    expect(confirmQuit).toHaveBeenCalledWith(
      { ...inactive, pendingOperations: 1 },
      "application",
    );
  });

  it("leaves the window and work intact when active-work quit is cancelled", async () => {
    const cleanup = vi.fn();
    const requestFinalQuit = vi.fn();
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => ({ ...inactive, activeChats: 1 }),
      confirmQuit: async () => "cancel",
      cleanup,
      requestFinalQuit,
      recordDiagnostic: vi.fn(),
    });

    await expect(coordinator.requestQuit("last-window")).resolves.toBe(
      "cancelled",
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(requestFinalQuit).not.toHaveBeenCalled();
    expect(coordinator.allowsExit).toBe(false);
  });

  it("shares one transaction across repeated requests while the dialog is pending", async () => {
    const dialog = deferred<"quit">();
    const cleanup = vi.fn(async () => undefined);
    const requestFinalQuit = vi.fn();
    const confirmQuit = vi.fn(() => dialog.promise);
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => ({ ...inactive, privateTasks: 2 }),
      confirmQuit,
      cleanup,
      requestFinalQuit,
      recordDiagnostic: vi.fn(),
    });

    const first = coordinator.requestQuit("application");
    await vi.waitFor(() => expect(confirmQuit).toHaveBeenCalledOnce());
    const repeated = coordinator.requestQuit("last-window");
    expect(repeated).toBe(first);
    dialog.resolve("quit");
    await expect(Promise.all([first, repeated])).resolves.toEqual([
      "quitting",
      "quitting",
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(requestFinalQuit).toHaveBeenCalledOnce();
  });

  it("keeps repeated requests behind the same pending cleanup barrier", async () => {
    const cleanupBarrier = deferred<void>();
    const cleanup = vi.fn(() => cleanupBarrier.promise);
    const requestFinalQuit = vi.fn();
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => inactive,
      confirmQuit: vi.fn(),
      cleanup,
      requestFinalQuit,
      recordDiagnostic: vi.fn(),
    });

    const first = coordinator.requestQuit("application");
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    const repeated = coordinator.requestQuit("application");
    expect(repeated).toBe(first);
    expect(coordinator.allowsExit).toBe(false);
    expect(requestFinalQuit).not.toHaveBeenCalled();

    cleanupBarrier.resolve();
    await repeated;
    expect(coordinator.allowsExit).toBe(true);
    expect(requestFinalQuit).toHaveBeenCalledOnce();
  });

  it("does not show a second prompt after a crash fallback confirmed quit", async () => {
    const confirmQuit = vi.fn();
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => ({ ...inactive, workflowRuntimes: 1 }),
      confirmQuit,
      cleanup: async () => undefined,
      requestFinalQuit: vi.fn(),
      recordDiagnostic: vi.fn(),
    });

    await coordinator.requestQuit("renderer-crash", { confirmed: true });
    expect(confirmQuit).not.toHaveBeenCalled();
  });
});

describe("RendererCrashRecovery", () => {
  it("automatically reloads the first crash while preserving main ownership", async () => {
    const reloadRenderer = vi.fn(async () => true);
    const showFallback = vi.fn();
    const recovery = new RendererCrashRecovery({
      reloadRenderer,
      showFallback,
      recreateRenderer: vi.fn(),
      stopWorkAndQuit: vi.fn(),
      recordDiagnostic: vi.fn(),
    });

    await recovery.handleCrash("crashed (1)");
    expect(reloadRenderer).toHaveBeenCalledOnce();
    expect(showFallback).not.toHaveBeenCalled();
  });

  it("uses a fallback after the one-crash automatic recovery budget", async () => {
    const reloadRenderer = vi.fn(async () => true);
    const showFallback = vi.fn(async () => "recover" as const);
    const recreateRenderer = vi.fn(async () => undefined);
    const recovery = new RendererCrashRecovery({
      reloadRenderer,
      showFallback,
      recreateRenderer,
      stopWorkAndQuit: vi.fn(),
      recordDiagnostic: vi.fn(),
    });

    await recovery.handleCrash("first");
    await recovery.handleCrash("second");
    expect(reloadRenderer).toHaveBeenCalledOnce();
    expect(showFallback).toHaveBeenCalledOnce();
    expect(recreateRenderer).toHaveBeenCalledOnce();
  });

  it("coalesces crashes while recovery and fallback are pending", async () => {
    const reload = deferred<boolean>();
    const showFallback = vi.fn(async () => "quit" as const);
    const stopWorkAndQuit = vi.fn(async () => undefined);
    const recovery = new RendererCrashRecovery({
      reloadRenderer: () => reload.promise,
      showFallback,
      recreateRenderer: vi.fn(),
      stopWorkAndQuit,
      recordDiagnostic: vi.fn(),
    });

    const first = recovery.handleCrash("first");
    const repeated = recovery.handleCrash("repeat");
    expect(repeated).toBe(first);
    reload.resolve(false);
    await repeated;
    expect(showFallback).toHaveBeenCalledOnce();
    expect(stopWorkAndQuit).toHaveBeenCalledOnce();
  });
});
