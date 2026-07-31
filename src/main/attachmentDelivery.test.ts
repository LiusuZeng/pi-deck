import { describe, expect, it, vi } from "vitest";
import { AttachmentSelectionStore } from "./attachmentSelectionStore.js";
import { deliverWithAttachmentConsumption } from "./attachmentDelivery.js";

function storeWithImage(): AttachmentSelectionStore {
  const store = new AttachmentSelectionStore({
    maxSelections: 2,
    maxRetainedBytes: 100,
    ttlMs: 1_000,
  });
  store.add("image-token", {
    ownerId: "owner-generation-a",
    sessionId: "runtime-a",
    kind: "image",
    imageDataBase64: "YWJjZA==",
  });
  return store;
}

describe("deliverWithAttachmentConsumption", () => {
  it("keeps owned retry attachments when input construction or delivery fails", async () => {
    const store = storeWithImage();
    const deliver = vi.fn(async () => {
      throw new Error("Pi RPC rejected prompt");
    });

    await expect(
      deliverWithAttachmentConsumption({
        store,
        ownerId: "owner-generation-a",
        selectedPathTokens: ["image-token"],
        deliver,
      }),
    ).rejects.toThrow("Pi RPC rejected prompt");

    expect(deliver).toHaveBeenCalledOnce();
    expect(
      store.getOwned("image-token", "owner-generation-a", "runtime-a"),
    ).toBeDefined();
    expect(store.getStats()).toEqual({ selectionCount: 1, retainedBytes: 8 });
  });

  it("consumes only the delivered runtime's tokens after a successful RPC", async () => {
    const store = storeWithImage();

    await expect(
      deliverWithAttachmentConsumption({
        store,
        ownerId: "owner-generation-a",
        selectedPathTokens: ["image-token"],
        deliver: async () => "accepted",
      }),
    ).resolves.toBe("accepted");

    expect(store.get("image-token")).toBeUndefined();
    expect(store.getStats()).toEqual({ selectionCount: 0, retainedBytes: 0 });
  });
});
