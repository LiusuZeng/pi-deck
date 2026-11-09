import { describe, expect, it } from "vitest";
import {
  canApplyBootstrapSessionRefresh,
  canReportBootstrapSessionRefresh,
  isNavigationGenerationCurrent,
  nextNavigationGeneration,
} from "./navigationGeneration.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((complete) => {
      resolve = complete;
    }),
    resolve,
  };
}

describe("renderer navigation generations", () => {
  it("invalidates an older route owner when a newer intent starts", () => {
    const first = nextNavigationGeneration(0);
    const second = nextNavigationGeneration(first);

    expect(isNavigationGenerationCurrent(first, first)).toBe(true);
    expect(isNavigationGenerationCurrent(second, first)).toBe(false);
    expect(isNavigationGenerationCurrent(second, second)).toBe(true);
  });

  it("blocks a late bootstrap session-list commit after an active session opens", async () => {
    const sessionList = deferred<readonly string[]>();
    const refresh = {
      disposed: false,
      sessionListRequest: 1,
      currentSessionListRequest: 1,
      navigationRequest: 0,
      currentNavigation: 0,
      bootstrapWorkspaceId: "workspace-a",
      currentWorkspaceId: "workspace-a",
    };
    let selectedSessionId = "draft-new";
    let primaryView = "new-session";

    expect(canApplyBootstrapSessionRefresh(refresh)).toBe(true);
    const bootstrapProducer = sessionList.promise.then((sessionIds) => {
      if (!canApplyBootstrapSessionRefresh(refresh)) return;
      selectedSessionId = sessionIds[0]!;
      primaryView = "new-session";
    });

    // The user opens an attached session before the delayed list resolves.
    refresh.currentNavigation = nextNavigationGeneration(
      refresh.currentNavigation,
    );
    expect(canApplyBootstrapSessionRefresh(refresh)).toBe(false);
    expect(canReportBootstrapSessionRefresh(refresh)).toBe(true);
    selectedSessionId = "runtime-active";
    primaryView = "session:runtime-active";
    sessionList.resolve(["draft-new"]);
    await bootstrapProducer;

    expect(selectedSessionId).toBe("runtime-active");
    expect(primaryView).toBe("session:runtime-active");
  });
});
