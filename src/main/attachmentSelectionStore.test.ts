import { describe, expect, it, vi } from "vitest";
import { AttachmentSelectionStore } from "./attachmentSelectionStore.js";

function createStore(
  now: () => number = () => 1_000,
): AttachmentSelectionStore {
  return new AttachmentSelectionStore({
    maxSelections: 3,
    maxRetainedBytes: 16,
    ttlMs: 100,
    now,
  });
}

function image(ownerId: string, sessionId = ownerId) {
  return {
    ownerId,
    sessionId,
    kind: "image" as const,
    imageDataBase64: "YWJjZA==",
  };
}

describe("AttachmentSelectionStore", () => {
  it("accounts for retained base64 bytes and releases them on owned consume", () => {
    const store = createStore();
    store.addMany([
      { token: "image-a", record: image("runtime-a") },
      {
        token: "path-a",
        record: {
          ownerId: "runtime-a",
          sessionId: "runtime-a",
          kind: "textFile",
          filePath: "/project/a.txt",
        },
      },
    ]);

    expect(store.getStats()).toEqual({ selectionCount: 2, retainedBytes: 8 });
    expect(store.consumeOwned("runtime-a", ["image-a"])).toBe(1);
    expect(store.getStats()).toEqual({ selectionCount: 1, retainedBytes: 0 });
    expect(store.get("image-a")).toBeUndefined();
  });

  it("enforces ownership for reads, release, and draft-to-runtime transfer", () => {
    const store = createStore();
    store.add("image-a", image("draft-a"));

    expect(store.getOwned("image-a", "runtime-a", "runtime-a")).toBeUndefined();
    expect(store.releaseOwned("runtime-a", ["image-a"])).toBe(0);
    expect(store.getOwned("image-a", "draft-a", "draft-a")).toEqual(
      image("draft-a"),
    );

    store.assignOwner(
      ["image-a"],
      "draft-a",
      "draft-a",
      "runtime-owner-a",
      "runtime-a",
    );
    expect(store.getOwned("image-a", "draft-a", "draft-a")).toBeUndefined();
    expect(store.getOwned("image-a", "runtime-owner-a", "runtime-a")).toEqual(
      image("runtime-owner-a", "runtime-a"),
    );
    expect(store.releaseOwner("runtime-owner-a")).toBe(1);
    expect(store.getStats()).toEqual({ selectionCount: 0, retainedBytes: 0 });
  });

  it("does not let a late import resurrect a discarded owner", () => {
    const store = createStore();
    store.add("image-a", image("draft-a"));

    store.releaseOwner("draft-a");
    expect(() => store.add("late-image", image("draft-a"))).toThrow(
      /no longer active/i,
    );
    expect(store.getStats()).toEqual({ selectionCount: 0, retainedBytes: 0 });
  });

  it("allows a stable session id to use a fresh generation after project return", () => {
    const store = createStore();
    store.add("old", image("owner-generation-1", "saved-session"));
    store.releaseOwner("owner-generation-1");

    expect(() =>
      store.add("fresh", image("owner-generation-2", "saved-session")),
    ).not.toThrow();
    expect(
      store.getOwned("fresh", "owner-generation-2", "saved-session"),
    ).toBeDefined();
    expect(store.releaseSession("saved-session")).toBe(1);
  });

  it("clears payloads and teardown tombstones for a full application reset", () => {
    const store = createStore();
    store.add("image-a", image("runtime-a"));
    store.releaseOwner("draft-a");

    store.clear();

    expect(store.getStats()).toEqual({ selectionCount: 0, retainedBytes: 0 });
    expect(() => store.add("fresh", image("draft-a"))).not.toThrow();
  });

  it("bounds revoked-owner tombstones while retaining recent teardown protection", () => {
    const store = createStore();
    for (let index = 0; index <= 100; index += 1) {
      store.releaseOwner(`owner-${index}`);
    }

    // The oldest tombstone is evicted at the bounded cap; an old in-flight
    // import still has normal selection limits, while recent teardown remains
    // protected from resurrection.
    expect(() => store.add("old-owner", image("owner-0"))).not.toThrow();
    expect(() => store.add("recent-owner", image("owner-100"))).toThrow(
      /no longer active/i,
    );
  });

  it("does not partially transfer a batch with a stale or foreign token", () => {
    const store = createStore();
    store.addMany([
      { token: "one", record: image("draft-a") },
      { token: "two", record: image("draft-b") },
    ]);

    expect(() =>
      store.assignOwner(
        ["one", "two"],
        "draft-a",
        "draft-a",
        "runtime-owner-a",
        "runtime-a",
      ),
    ).toThrow(/no longer available/i);
    expect(store.getOwned("one", "draft-a", "draft-a")).toBeDefined();
    expect(store.getOwned("two", "draft-b", "draft-b")).toBeDefined();
  });

  it("expires stale selections through the scheduled sweep", () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const store = createStore(() => now);
      store.add("expired", image("draft-a"));

      now += 101;
      vi.advanceTimersByTime(100);
      expect(store.getStats()).toEqual({ selectionCount: 0, retainedBytes: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an over-limit batch before retaining a partial image payload", () => {
    const store = createStore();
    expect(() =>
      store.addMany([
        { token: "first", record: image("draft-a") },
        { token: "second", record: image("draft-a") },
        { token: "third", record: image("draft-a") },
      ]),
    ).toThrow(/memory limit/i);

    expect(store.getStats()).toEqual({ selectionCount: 0, retainedBytes: 0 });
  });

  it("preflights aggregate limits before imports and leaves existing records intact", () => {
    const store = createStore();
    store.addMany([
      { token: "existing", record: image("runtime-a") },
      {
        token: "existing-path",
        record: {
          ownerId: "runtime-a",
          sessionId: "runtime-a",
          kind: "textFile",
        },
      },
    ]);

    expect(() =>
      store.assertCanAddMany([
        { token: "new-one", record: image("draft-a") },
        { token: "new-two", record: image("draft-a") },
      ]),
    ).toThrow(/too many pending attachments/i);
    expect(store.getStats()).toEqual({ selectionCount: 2, retainedBytes: 8 });
    expect(store.getOwned("existing", "runtime-a", "runtime-a")).toBeDefined();
  });

  it("enforces aggregate selection count without retaining a partial batch", () => {
    const store = createStore();
    expect(() =>
      store.addMany([
        {
          token: "one",
          record: {
            ownerId: "draft-a",
            sessionId: "draft-a",
            kind: "textFile",
          },
        },
        {
          token: "two",
          record: {
            ownerId: "draft-a",
            sessionId: "draft-a",
            kind: "textFile",
          },
        },
        {
          token: "three",
          record: {
            ownerId: "draft-a",
            sessionId: "draft-a",
            kind: "textFile",
          },
        },
        {
          token: "four",
          record: {
            ownerId: "draft-a",
            sessionId: "draft-a",
            kind: "textFile",
          },
        },
      ]),
    ).toThrow(/too many pending attachments/i);
    expect(store.getStats()).toEqual({ selectionCount: 0, retainedBytes: 0 });
  });
});
