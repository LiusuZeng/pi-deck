import { expect, it } from "vitest";
import type { ChatListModelsResult } from "../shared/types.js";
import {
  createDraftAfterWorkspaceActivation,
  draftDefaultsForWorkspace,
  emptyDraftModelConfiguration,
} from "./draftDefaults.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const discovered: ChatListModelsResult = {
  models: [{ id: "fake-model", provider: "fake-provider", name: "Fake model" }],
  activeModel: {
    id: "fake-model",
    provider: "fake-provider",
    name: "Fake model",
  },
  thinkingLevel: "high",
  thinkingLevels: ["off", "medium", "high"],
};

it("creates after activation with latest workspace defaults while preserving explicit choices", async () => {
  const activation = deferred<{ workspaceId: string }>();
  let defaults = new Map<string, ChatListModelsResult>([
    ["workspace-a", emptyDraftModelConfiguration()],
  ]);
  const creation = createDraftAfterWorkspaceActivation({
    workspaceId: "workspace-a",
    activation: activation.promise,
    readDefaults: () => defaults,
    createDraft: (result, configuration) => ({
      workspaceId: result.workspaceId,
      // Production draft creation supplies defaults only for unset fields.
      modelLabel: "explicit/model",
      thinkingLevel: configuration?.thinkingLevel,
    }),
  });

  defaults = new Map(defaults).set("workspace-a", discovered);
  activation.resolve({ workspaceId: "workspace-a" });

  await expect(creation).resolves.toEqual({
    activation: { workspaceId: "workspace-a" },
    draft: {
      workspaceId: "workspace-a",
      modelLabel: "explicit/model",
      thinkingLevel: "high",
    },
  });
});

it("keeps delayed workspace A discovery isolated while workspace B activates", async () => {
  const activation = deferred<{ workspaceId: string }>();
  const workspaceB: ChatListModelsResult = {
    models: [{ id: "model-b", provider: "provider-b" }],
    activeModel: { id: "model-b", provider: "provider-b" },
    thinkingLevel: "medium",
    thinkingLevels: ["off", "medium"],
  };
  let defaults = new Map<string, ChatListModelsResult>([
    ["workspace-b", workspaceB],
  ]);
  const creation = createDraftAfterWorkspaceActivation({
    workspaceId: "workspace-b",
    activation: activation.promise,
    readDefaults: () => defaults,
    createDraft: (_result, configuration) => configuration,
  });

  // A discovery completion lands while B's activation is pending. Keyed
  // storage retains A without replacing what B's draft will read.
  defaults = new Map(defaults).set("workspace-a", discovered);
  activation.resolve({ workspaceId: "workspace-b" });

  await expect(creation).resolves.toMatchObject({ draft: workspaceB });
  expect(draftDefaultsForWorkspace(defaults, "workspace-a")).toBe(discovered);
  expect(draftDefaultsForWorkspace(defaults, "workspace-b")).toBe(workspaceB);
  expect(draftDefaultsForWorkspace(defaults, "workspace-c")).toBeUndefined();
});
