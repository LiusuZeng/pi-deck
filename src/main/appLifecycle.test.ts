import { describe, expect, it, vi } from "vitest";
import {
  chatRuntimeHasActiveWork,
  consumeHiddenWindowDialogOutcome,
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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

  it("runs one confirmed escalation after an ordinary dialog cancels", async () => {
    const dialog = deferred<"cancel">();
    const cleanup = vi.fn(async () => undefined);
    const requestFinalQuit = vi.fn();
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => ({ ...inactive, activeChats: 1 }),
      confirmQuit: vi.fn(() => dialog.promise),
      cleanup,
      requestFinalQuit,
      recordDiagnostic: vi.fn(),
    });

    const ordinary = coordinator.requestQuit("application");
    await vi.waitFor(() => expect(coordinator.isStopping).toBe(false));
    const confirmed = coordinator.requestQuit("renderer-crash", {
      confirmed: true,
    });
    const repeatedConfirmed = coordinator.requestQuit("renderer-crash", {
      confirmed: true,
    });
    expect(repeatedConfirmed).toBe(confirmed);
    expect(coordinator.isStopping).toBe(true);

    dialog.resolve("cancel");
    await expect(ordinary).resolves.toBe("cancelled");
    await expect(confirmed).resolves.toBe("quitting");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(requestFinalQuit).toHaveBeenCalledOnce();
  });

  it("joins confirmed escalation to cleanup when the ordinary dialog quits", async () => {
    const dialog = deferred<"quit">();
    const cleanupBarrier = deferred<void>();
    const cleanup = vi.fn(() => cleanupBarrier.promise);
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => ({ ...inactive, activeChats: 1 }),
      confirmQuit: () => dialog.promise,
      cleanup,
      requestFinalQuit: vi.fn(),
      recordDiagnostic: vi.fn(),
    });

    const ordinary = coordinator.requestQuit("application");
    const confirmed = coordinator.requestQuit("renderer-crash", {
      confirmed: true,
    });
    dialog.resolve("quit");
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    cleanupBarrier.resolve();

    await expect(Promise.all([ordinary, confirmed])).resolves.toEqual([
      "quitting",
      "quitting",
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("records bounded cleanup failure before requesting final exit", async () => {
    const recordDiagnostic = vi.fn();
    const requestFinalQuit = vi.fn();
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => inactive,
      confirmQuit: vi.fn(),
      cleanup: async () => {
        throw new Error("worker close failed");
      },
      requestFinalQuit,
      recordDiagnostic,
    });

    await expect(coordinator.requestQuit("application")).resolves.toBe(
      "quitting",
    );
    expect(recordDiagnostic).toHaveBeenCalledWith(
      "Application cleanup failed before quit: worker close failed",
    );
    expect(requestFinalQuit).toHaveBeenCalledOnce();
  });

  it("restores the exit gate and repeats cleanup when final quit throws", async () => {
    const cleanup = vi.fn(async () => undefined);
    const requestFinalQuit = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("Electron quit failed");
      })
      .mockImplementationOnce(() => undefined);
    const coordinator = new QuitLifecycleCoordinator({
      inspectActivity: async () => inactive,
      confirmQuit: vi.fn(),
      cleanup,
      requestFinalQuit,
      recordDiagnostic: vi.fn(),
    });

    await expect(coordinator.requestQuit("application")).resolves.toBe(
      "cancelled",
    );
    expect(coordinator.allowsExit).toBe(false);
    expect(coordinator.isStopping).toBe(false);

    await expect(coordinator.requestQuit("application")).resolves.toBe(
      "quitting",
    );
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(requestFinalQuit).toHaveBeenCalledTimes(2);
    expect(coordinator.allowsExit).toBe(true);
  });
});

it("uses scripted hidden-window responses without enabling broader E2E hooks", () => {
  const environment: NodeJS.ProcessEnv = {
    PI_DECK_E2E_HIDE_WINDOWS: "1",
    PI_DECK_E2E_QUIT_DIALOG_RESPONSES: "cancel,quit",
  };
  expect(
    consumeHiddenWindowDialogOutcome(
      environment,
      "PI_DECK_E2E_QUIT_DIALOG_RESPONSES",
      "quit",
    ),
  ).toBe("cancel");
  expect(environment.PI_DECK_E2E_QUIT_DIALOG_RESPONSES).toBe("quit");
  expect(
    consumeHiddenWindowDialogOutcome(
      environment,
      "PI_DECK_E2E_QUIT_DIALOG_RESPONSES",
      "quit",
    ),
  ).toBe("quit");
});

it("keeps production dialogs enabled and ignores harmless idle chats", () => {
  expect(
    consumeHiddenWindowDialogOutcome(
      { PI_DECK_E2E_TEST: "1" },
      "PI_DECK_E2E_QUIT_DIALOG_RESPONSES",
      "quit",
    ),
  ).toBeUndefined();
  expect(chatRuntimeHasActiveWork({ isAgentActive: false })).toBe(false);
  expect(chatRuntimeHasActiveWork({ isStreaming: true })).toBe(true);
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
      isStopping: () => false,
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
      isStopping: () => false,
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
      isStopping: () => false,
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

  it("offers one fresh fallback when a replacement crashes and recreation fails", async () => {
    const recreation = deferred<void>();
    const showFallback = vi
      .fn()
      .mockResolvedValueOnce("recover" as const)
      .mockResolvedValueOnce("quit" as const);
    const stopWorkAndQuit = vi.fn(async () => undefined);
    const recovery = new RendererCrashRecovery({
      reloadRenderer: async () => false,
      showFallback,
      recreateRenderer: () => recreation.promise,
      stopWorkAndQuit,
      isStopping: () => false,
      recordDiagnostic: vi.fn(),
    });

    const first = recovery.handleCrash("first");
    await vi.waitFor(() => expect(showFallback).toHaveBeenCalledOnce());
    const replacementCrash = recovery.handleCrash("replacement crashed");
    expect(replacementCrash).toBe(first);
    recreation.reject(new Error("replacement failed"));
    await first;

    await vi.waitFor(() => expect(showFallback).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(stopWorkAndQuit).toHaveBeenCalledOnce());
    expect(showFallback).toHaveBeenNthCalledWith(2, "replacement crashed");
  });

  it("bounds repeated failed explicit recreation without resetting reload", async () => {
    const showFallback = vi.fn(async () => "recover" as const);
    const recreateRenderer = vi.fn(async () => {
      throw new Error("replacement failed");
    });
    const stopWorkAndQuit = vi.fn(async () => undefined);
    const reloadRenderer = vi.fn(async () => false);
    const recovery = new RendererCrashRecovery({
      reloadRenderer,
      showFallback,
      recreateRenderer,
      stopWorkAndQuit,
      isStopping: () => false,
      recordDiagnostic: vi.fn(),
    });

    await recovery.handleCrash("crashed");
    await vi.waitFor(() => expect(stopWorkAndQuit).toHaveBeenCalledOnce());
    expect(reloadRenderer).toHaveBeenCalledOnce();
    expect(showFallback).toHaveBeenCalledTimes(2);
    expect(recreateRenderer).toHaveBeenCalledTimes(2);
  });

  it("stops work once when the native recovery dialog rejects", async () => {
    const stopWorkAndQuit = vi.fn(async () => undefined);
    const recovery = new RendererCrashRecovery({
      reloadRenderer: async () => false,
      showFallback: async () => {
        throw new Error("dialog unavailable");
      },
      recreateRenderer: vi.fn(),
      stopWorkAndQuit,
      isStopping: () => false,
      recordDiagnostic: vi.fn(),
    });

    await recovery.handleCrash("crashed");
    expect(stopWorkAndQuit).toHaveBeenCalledOnce();
  });

  it("does not recreate after quit starts while the fallback is pending", async () => {
    const fallback = deferred<"recover">();
    let stopping = false;
    const recreateRenderer = vi.fn(async () => undefined);
    const recovery = new RendererCrashRecovery({
      reloadRenderer: async () => false,
      showFallback: () => fallback.promise,
      recreateRenderer,
      stopWorkAndQuit: vi.fn(),
      isStopping: () => stopping,
      recordDiagnostic: vi.fn(),
    });

    const recovering = recovery.handleCrash("crashed");
    await vi.waitFor(() => expect(recreateRenderer).not.toHaveBeenCalled());
    stopping = true;
    fallback.resolve("recover");
    await recovering;
    expect(recreateRenderer).not.toHaveBeenCalled();
  });

  it("does not continue recovery after quit starts during recreation", async () => {
    const recreation = deferred<void>();
    let stopping = false;
    const recordDiagnostic = vi.fn();
    const recovery = new RendererCrashRecovery({
      reloadRenderer: async () => false,
      showFallback: async () => "recover",
      recreateRenderer: () => recreation.promise,
      stopWorkAndQuit: vi.fn(),
      isStopping: () => stopping,
      recordDiagnostic,
    });

    const recovering = recovery.handleCrash("crashed");
    await vi.waitFor(() => expect(recordDiagnostic).toHaveBeenCalled());
    stopping = true;
    recreation.resolve();
    await recovering;
    expect(recordDiagnostic).not.toHaveBeenCalledWith(
      "Renderer UI was recreated with the existing main-process runtimes.",
    );
  });
});
