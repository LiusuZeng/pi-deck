import { expect, it } from "vitest";
import type { ChatListModelsResult } from "../shared/types.js";
import {
  draftDefaultsForWorkspace,
  emptyDraftModelConfiguration,
  type ScopedDraftDefaults,
} from "./draftDefaults.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

it("reads latest defaults after an async creation barrier instead of a stale closure", async () => {
  const workspaceId = "workspace-a";
  const discovered: ChatListModelsResult = {
    models: [
      {
        id: "fake-model",
        provider: "fake-provider",
        name: "Fake model",
      },
    ],
    activeModel: {
      id: "fake-model",
      provider: "fake-provider",
      name: "Fake model",
    },
    thinkingLevel: "medium",
    thinkingLevels: ["off", "medium", "high"],
  };
  let latest: ScopedDraftDefaults = {
    workspaceId,
    configuration: emptyDraftModelConfiguration(),
  };
  const barrier = deferred();

  const createAfterNavigation = async () => {
    await barrier.promise;
    return draftDefaultsForWorkspace(latest, workspaceId);
  };
  const creation = createAfterNavigation();
  latest = { workspaceId, configuration: discovered };
  barrier.resolve();

  await expect(creation).resolves.toBe(discovered);
});

it("does not borrow defaults from another workspace or invent missing thinking", () => {
  const fallbackOnly: ChatListModelsResult = {
    models: [{ id: "fallback-model", provider: "fallback" }],
    thinkingLevels: [],
  };
  const latest = {
    workspaceId: "workspace-a",
    configuration: fallbackOnly,
  };

  expect(draftDefaultsForWorkspace(latest, "workspace-b")).toBeUndefined();
  expect(
    draftDefaultsForWorkspace(latest, "workspace-a")?.thinkingLevel,
  ).toBeUndefined();
});
