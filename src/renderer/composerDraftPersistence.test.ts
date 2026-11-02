import { describe, expect, it } from "vitest";
import {
  COMPOSER_DRAFT_SCHEMA_VERSION,
  COMPOSER_DRAFT_STORAGE_KEY,
  MAX_COMPOSER_DRAFT_ENTRIES,
  MAX_COMPOSER_DRAFT_SERIALIZED_LENGTH,
  MAX_COMPOSER_DRAFT_TEXT_LENGTH,
  ComposerDraftPersistence,
  composerDraftIdentityKey,
  readComposerDraftStore,
  type ComposerDraftStorage,
} from "./composerDraftPersistence.js";

class MemoryStorage implements ComposerDraftStorage {
  readonly values = new Map<string, string>();
  getError = false;
  setError = false;
  removeCalls = 0;
  writes: Array<string | null> = [];

  getItem(key: string): string | null {
    if (this.getError) throw new Error("read denied");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.setError) throw new Error("quota denied");
    this.values.set(key, value);
    this.writes.push(value);
  }

  removeItem(key: string): void {
    if (this.setError) throw new Error("remove denied");
    this.removeCalls += 1;
    this.values.delete(key);
    this.writes.push(null);
  }
}

const workspaceDraftSession = {
  id: "runtime-only-shell",
  workspaceId: "workspace-a",
  draftSession: true,
};
const nativeSession = {
  id: "transient-runtime-42",
  workspaceId: "workspace-a",
  sessionFile: "/sessions/stable.jsonl",
};

describe("composer draft persistence schema", () => {
  it("serializes only bounded text and stable identity, never attachment authority", () => {
    const storage = new MemoryStorage();
    let now = 10;
    const persistence = new ComposerDraftPersistence(storage, {
      now: () => now++,
      createDraftId: () => "stable-draft-a",
    });
    persistence.hydrate([workspaceDraftSession], ["workspace-a"]);

    expect(
      persistence.persist([workspaceDraftSession], {
        [workspaceDraftSession.id]: {
          text: "private unsent text",
          attachmentCount: 2,
        },
      }),
    ).toMatchObject({ status: "ok", truncated: false });

    const raw = storage.values.get(COMPOSER_DRAFT_STORAGE_KEY)!;
    expect(JSON.parse(raw)).toEqual({
      version: COMPOSER_DRAFT_SCHEMA_VERSION,
      drafts: [
        {
          kind: "workspaceDraft",
          workspaceId: "workspace-a",
          draftId: "stable-draft-a",
          text: "private unsent text",
          updatedAtMs: 10,
          attachmentsNeedReselection: true,
        },
      ],
    });
    expect(raw).not.toMatch(/token|image|task|runtime-only-shell/);
  });

  it("validates versions, malformed records, and per-draft limits", () => {
    const future = new MemoryStorage();
    future.values.set(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({ version: 3, drafts: [] }),
    );
    expect(readComposerDraftStore(future)).toEqual({
      status: "unsupported-version",
      records: [],
    });

    const mixed = new MemoryStorage();
    mixed.values.set(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        drafts: [
          {
            kind: "sessionFile",
            workspaceId: "workspace-a",
            sessionFile: "/good.jsonl",
            text: "good",
            updatedAtMs: 1,
            attachmentsNeedReselection: false,
            selectedPathToken: "must be ignored",
          },
          {
            kind: "sessionFile",
            workspaceId: "workspace-a",
            sessionFile: "/oversized.jsonl",
            text: "x".repeat(MAX_COMPOSER_DRAFT_TEXT_LENGTH + 1),
            updatedAtMs: 2,
            attachmentsNeedReselection: false,
          },
          { kind: "workspaceDraft", workspaceId: "", text: "bad" },
        ],
      }),
    );
    expect(readComposerDraftStore(mixed)).toEqual({
      status: "ok",
      records: [
        {
          kind: "sessionFile",
          workspaceId: "workspace-a",
          sessionFile: "/good.jsonl",
          text: "good",
          updatedAtMs: 1,
          attachmentsNeedReselection: false,
        },
      ],
    });
  });

  it("bounds text and total entry count deterministically", () => {
    const storage = new MemoryStorage();
    let draft = 0;
    const persistence = new ComposerDraftPersistence(storage, {
      now: () => 100,
      createDraftId: () => `draft-${draft++}`,
    });
    const sessions = Array.from(
      { length: MAX_COMPOSER_DRAFT_ENTRIES + 2 },
      (_, index) => ({
        id: `shell-${index}`,
        workspaceId: "workspace-a",
        draftSession: true,
      }),
    );
    persistence.hydrate(sessions, ["workspace-a"]);
    const result = persistence.persist(
      sessions,
      Object.fromEntries(
        sessions.map((session, index) => [
          session.id,
          {
            text:
              index === 0
                ? "x".repeat(MAX_COMPOSER_DRAFT_TEXT_LENGTH + 50)
                : `draft ${index}`,
            attachmentCount: 0,
          },
        ]),
      ),
    );

    expect(result).toMatchObject({
      status: "ok",
      truncated: true,
      pruned: 2,
    });
    const parsed = readComposerDraftStore(storage);
    expect(parsed.records).toHaveLength(MAX_COMPOSER_DRAFT_ENTRIES);
    expect(
      parsed.records.find((record) => record.text.startsWith("x"))?.text,
    ).toHaveLength(MAX_COMPOSER_DRAFT_TEXT_LENGTH);
  });

  it("bounds the actual escaped JSON representation and round-trips it", () => {
    const create = () => {
      const storage = new MemoryStorage();
      const persistence = new ComposerDraftPersistence(storage, {
        now: () => 42,
      });
      const sessions = Array.from({ length: 5 }, (_, index) => ({
        id: `runtime-${index}`,
        workspaceId: `workspace-${index}-${"\\".repeat(500)}`,
        sessionFile: `/sessions/${index}-${"\\".repeat(4_000)}`,
      }));
      persistence.hydrate(
        sessions,
        sessions.map((session) => session.workspaceId),
      );
      const result = persistence.persist(
        sessions,
        Object.fromEntries(
          sessions.map((session) => [
            session.id,
            {
              text: "\\".repeat(MAX_COMPOSER_DRAFT_TEXT_LENGTH),
              attachmentCount: 0,
            },
          ]),
        ),
      );
      return { storage, result };
    };

    const first = create();
    const second = create();
    const raw = first.storage.values.get(COMPOSER_DRAFT_STORAGE_KEY)!;
    expect(first.result).toMatchObject({ status: "ok", truncated: true });
    expect(raw.length).toBeLessThanOrEqual(
      MAX_COMPOSER_DRAFT_SERIALIZED_LENGTH,
    );
    expect(raw).toBe(second.storage.values.get(COMPOSER_DRAFT_STORAGE_KEY));
    const roundTrip = readComposerDraftStore(first.storage);
    expect(roundTrip.status).toBe("ok");
    expect(roundTrip.records.length).toBeGreaterThan(0);
    expect(roundTrip.records.map((record) => record.text)).toEqual(
      (JSON.parse(raw) as { drafts: Array<{ text: string }> }).drafts.map(
        (record) => record.text,
      ),
    );
  });
});

describe("identity restoration and migration", () => {
  it("maps transient runtime IDs to stable native files across reload", () => {
    const storage = new MemoryStorage();
    const first = new ComposerDraftPersistence(storage, { now: () => 1 });
    first.hydrate([nativeSession], ["workspace-a"]);
    first.persist([nativeSession], {
      [nativeSession.id]: { text: "native draft", attachmentCount: 0 },
    });

    const reloadedSession = { ...nativeSession, id: "different-runtime-99" };
    const second = new ComposerDraftPersistence(storage);
    const plan = second.hydrate([reloadedSession], ["workspace-a"]);
    expect(plan.restored).toEqual([
      {
        sessionId: "different-runtime-99",
        identity: {
          kind: "sessionFile",
          workspaceId: "workspace-a",
          sessionFile: "/sessions/stable.jsonl",
        },
        text: "native draft",
        attachmentsNeedReselection: false,
      },
    ]);
  });

  it("migrates a renderer-only draft to the created native session file", () => {
    const storage = new MemoryStorage();
    const persistence = new ComposerDraftPersistence(storage, {
      now: () => 5,
      createDraftId: () => "stable-shell-id",
    });
    persistence.hydrate([workspaceDraftSession], ["workspace-a"]);
    persistence.persist([workspaceDraftSession], {
      [workspaceDraftSession.id]: {
        text: "send me once",
        attachmentCount: 0,
      },
    });
    persistence.migrateSession(workspaceDraftSession, nativeSession);

    expect(persistence.recordsForTesting()).toEqual([
      {
        kind: "sessionFile",
        workspaceId: "workspace-a",
        sessionFile: "/sessions/stable.jsonl",
        text: "send me once",
        updatedAtMs: 5,
        attachmentsNeedReselection: false,
      },
    ]);
    expect(
      composerDraftIdentityKey(persistence.identityForSession(nativeSession)!),
    ).toContain("/sessions/stable.jsonl");
  });

  it("restores a definitely rejected first send after native row rebinding", () => {
    const storage = new MemoryStorage();
    const firstRuntimeSession = {
      id: "first-runtime-id",
      workspaceId: "workspace-a",
      sessionFile: "/sessions/rejected-first-send.jsonl",
    };
    const cachedNativeSession = {
      ...firstRuntimeSession,
      id: "saved-row-id",
    };
    const reloadedRuntimeSession = {
      ...firstRuntimeSession,
      id: "new-runtime-id",
    };
    const first = new ComposerDraftPersistence(storage, {
      now: () => 12,
      createDraftId: () => "first-send-draft",
    });
    first.hydrate([workspaceDraftSession], ["workspace-a"]);
    first.persist([workspaceDraftSession], {
      [workspaceDraftSession.id]: {
        text: "rejected first send remains editable",
        attachmentCount: 0,
      },
    });

    // A first send materializes the renderer-only shell as a native session.
    first.migrateSession(workspaceDraftSession, firstRuntimeSession);
    first.beginSubmission(
      firstRuntimeSession,
      "rejected first send remains editable",
      0,
    );
    first.finishSubmission(firstRuntimeSession, "rejected", true);

    // Reload hydration first finds the canonical file as a saved row, then a
    // resumed worker replaces that row with a new runtime id.
    const reloaded = new ComposerDraftPersistence(storage);
    expect(
      reloaded.hydrate([cachedNativeSession], ["workspace-a"]).restored,
    ).toMatchObject([
      {
        sessionId: "saved-row-id",
        text: "rejected first send remains editable",
      },
    ]);
    // A background/attached-runtime replacement can happen before React has
    // committed that saved-row restoration. Rebinding must requeue it for the
    // replacement row instead of treating the prior row id as permanently
    // restored. This fails if native-to-native migration leaves restoredKeys
    // unchanged.
    reloaded.migrateSession(cachedNativeSession, reloadedRuntimeSession);
    expect(
      reloaded.restoreAvailableSessions([reloadedRuntimeSession]).restored,
    ).toEqual([
      {
        sessionId: "new-runtime-id",
        identity: {
          kind: "sessionFile",
          workspaceId: "workspace-a",
          sessionFile: "/sessions/rejected-first-send.jsonl",
        },
        text: "rejected first send remains editable",
        attachmentsNeedReselection: false,
      },
    ]);
    expect(
      reloaded.pendingSubmissionForSession(reloadedRuntimeSession),
    ).toBeUndefined();
  });

  it("rebinds a restored rejected draft when discovery replaces its row", () => {
    const storage = new MemoryStorage();
    const cachedRow = {
      id: "cached-rejected-row",
      workspaceId: "workspace-a",
      sessionFile: "/sessions/rejected-discovery-race.jsonl",
    };
    const discoveredRuntime = {
      ...cachedRow,
      id: "discovered-runtime-row",
    };
    const first = new ComposerDraftPersistence(storage, { now: () => 20 });
    first.hydrate([cachedRow], ["workspace-a"]);
    first.beginSubmission(cachedRow, "definitely rejected during reload", 0);
    first.finishSubmission(cachedRow, "rejected", true);

    const reloaded = new ComposerDraftPersistence(storage);
    // Bootstrap restores the cached row first. A subsequent discovery can
    // replace it without the renderer receiving an explicit migration event.
    expect(reloaded.hydrate([cachedRow], ["workspace-a"]).restored).toEqual([
      {
        sessionId: "cached-rejected-row",
        identity: {
          kind: "sessionFile",
          workspaceId: "workspace-a",
          sessionFile: "/sessions/rejected-discovery-race.jsonl",
        },
        text: "definitely rejected during reload",
        attachmentsNeedReselection: false,
      },
    ]);
    expect(
      reloaded.restoreAvailableSessions([discoveredRuntime]).restored,
    ).toEqual([
      {
        sessionId: "discovered-runtime-row",
        identity: {
          kind: "sessionFile",
          workspaceId: "workspace-a",
          sessionFile: "/sessions/rejected-discovery-race.jsonl",
        },
        text: "definitely rejected during reload",
        attachmentsNeedReselection: false,
      },
    ]);

    // A stable replacement row is restored once; this cannot turn into a
    // repeated draft resurrection during ordinary renders.
    expect(
      reloaded.restoreAvailableSessions([discoveredRuntime]).restored,
    ).toEqual([]);
  });

  it("rekeys and restores an attachment-only reselection marker", () => {
    const storage = new MemoryStorage();
    const cached = {
      id: "cached-row",
      workspaceId: "workspace-a",
      sessionFile: "/sessions/reselection.jsonl",
    };
    const runtime = { ...cached, id: "attached-runtime" };
    const persistence = new ComposerDraftPersistence(storage, { now: () => 9 });
    persistence.hydrate([cached], ["workspace-a"]);

    persistence.markAttachmentsNeedReselection(cached);
    persistence.migrateSession(cached, runtime);

    const reloaded = new ComposerDraftPersistence(storage);
    expect(reloaded.hydrate([runtime], ["workspace-a"]).restored).toEqual([
      {
        sessionId: "attached-runtime",
        identity: {
          kind: "sessionFile",
          workspaceId: "workspace-a",
          sessionFile: "/sessions/reselection.jsonl",
        },
        text: "",
        attachmentsNeedReselection: true,
      },
    ]);
  });

  it("recreates multiple workspace draft shells and prunes deleted workspaces", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        drafts: [
          {
            kind: "workspaceDraft",
            workspaceId: "workspace-a",
            draftId: "a",
            text: "alpha",
            updatedAtMs: 1,
            attachmentsNeedReselection: false,
          },
          {
            kind: "workspaceDraft",
            workspaceId: "workspace-b",
            draftId: "b",
            text: "beta",
            updatedAtMs: 2,
            attachmentsNeedReselection: true,
          },
          {
            kind: "workspaceDraft",
            workspaceId: "deleted-workspace",
            draftId: "stale",
            text: "do not resurrect",
            updatedAtMs: 3,
            attachmentsNeedReselection: false,
          },
        ],
      }),
    );
    const persistence = new ComposerDraftPersistence(storage);
    const plan = persistence.hydrate([], ["workspace-a", "workspace-b"]);

    expect(plan.prunedStaleWorkspaceCount).toBe(1);
    expect(
      plan.workspaceShells.map(({ identity, text }) => ({ identity, text })),
    ).toEqual([
      {
        identity: {
          kind: "workspaceDraft",
          workspaceId: "workspace-a",
          draftId: "a",
        },
        text: "alpha",
      },
      {
        identity: {
          kind: "workspaceDraft",
          workspaceId: "workspace-b",
          draftId: "b",
        },
        text: "beta",
      },
    ]);
    expect(storage.values.get(COMPOSER_DRAFT_STORAGE_KEY)).not.toContain(
      "do not resurrect",
    );
  });
});

describe("ordering, acceptance, and storage failures", () => {
  it("does not write empty bootstrap state before hydration", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        drafts: [
          {
            kind: "sessionFile",
            workspaceId: "workspace-a",
            sessionFile: "/sessions/stable.jsonl",
            text: "survives bootstrap",
            updatedAtMs: 1,
            attachmentsNeedReselection: false,
          },
        ],
      }),
    );
    const original = storage.values.get(COMPOSER_DRAFT_STORAGE_KEY);
    const persistence = new ComposerDraftPersistence(storage);

    expect(persistence.persist([nativeSession], {})).toMatchObject({
      status: "skipped-not-hydrated",
    });
    expect(storage.values.get(COMPOSER_DRAFT_STORAGE_KEY)).toBe(original);
    expect(
      persistence.hydrate([nativeSession], ["workspace-a"]).restored[0],
    ).toMatchObject({ text: "survives bootstrap" });
  });

  it("quarantines an optimistic clear until acceptance while rejection retains text", () => {
    const storage = new MemoryStorage();
    const persistence = new ComposerDraftPersistence(storage, { now: () => 1 });
    persistence.hydrate([nativeSession], ["workspace-a"]);
    persistence.persist([nativeSession], {
      [nativeSession.id]: { text: "reject me", attachmentCount: 0 },
    });
    persistence.beginSubmission(nativeSession, "reject me", 0);

    // React may clear the visible composer while IPC is pending. The submitted
    // text is durable but quarantined, not represented as a fresh draft.
    persistence.persist([nativeSession], {
      [nativeSession.id]: { text: "", attachmentCount: 0 },
    });
    expect(
      readComposerDraftStore(storage).records[0]?.pendingSubmission?.text,
    ).toBe("reject me");
    persistence.finishSubmission(nativeSession, "rejected", true);
    expect(readComposerDraftStore(storage).records[0]?.text).toBe("reject me");

    persistence.beginSubmission(nativeSession, "reject me", 0);
    persistence.finishSubmission(nativeSession, "accepted", true);
    expect(readComposerDraftStore(storage)).toEqual({
      status: "empty",
      records: [],
    });

    persistence.beginSubmission(nativeSession, "submitted", 0);
    persistence.persist([nativeSession], {
      [nativeSession.id]: { text: "newer draft", attachmentCount: 0 },
    });
    persistence.finishSubmission(nativeSession, "rejected", false);
    expect(readComposerDraftStore(storage).records[0]).toMatchObject({
      text: "newer draft",
      pendingSubmission: { text: "submitted", destination: "parent" },
    });

    // A second send cannot overwrite the older unrecovered quarantine slot.
    persistence.beginSubmission(nativeSession, "newer draft", 0);
    expect(readComposerDraftStore(storage).records[0]).toMatchObject({
      text: "newer draft",
      pendingSubmission: { text: "submitted" },
    });
    persistence.discardPendingSubmission(nativeSession);

    // Text equality is not ownership: a new generation can intentionally type
    // the exact same text while acceptance is deferred.
    persistence.beginSubmission(nativeSession, "identical", 0);
    persistence.persist([nativeSession], {
      [nativeSession.id]: { text: "identical", attachmentCount: 0 },
    });
    persistence.finishSubmission(nativeSession, "accepted", false);
    expect(readComposerDraftStore(storage).records[0]?.text).toBe("identical");
  });

  it("freezes writes after a failed read until explicit successful recovery", () => {
    const unreadable = new MemoryStorage();
    const existing = JSON.stringify({
      version: COMPOSER_DRAFT_SCHEMA_VERSION,
      drafts: [
        {
          kind: "sessionFile",
          workspaceId: nativeSession.workspaceId,
          sessionFile: nativeSession.sessionFile,
          text: "must survive transient denial",
          updatedAtMs: 1,
          attachmentsNeedReselection: false,
        },
      ],
    });
    unreadable.values.set(COMPOSER_DRAFT_STORAGE_KEY, existing);
    unreadable.getError = true;
    const failedRead = new ComposerDraftPersistence(unreadable);
    expect(failedRead.loadStatus).toBe("storage-error");
    expect(() =>
      failedRead.hydrate([nativeSession], ["workspace-a"]),
    ).not.toThrow();

    // Hydration and its following empty persist must not translate an unknown
    // read into removeItem.
    expect(failedRead.persist([nativeSession], {})).toMatchObject({
      status: "storage-error",
    });
    expect(unreadable.removeCalls).toBe(0);
    expect(unreadable.values.get(COMPOSER_DRAFT_STORAGE_KEY)).toBe(existing);

    unreadable.getError = false;
    expect(failedRead.recoverStorage()).toMatchObject({ status: "ok" });
    expect(
      failedRead.restoreAvailableSessions([nativeSession]).restored[0],
    ).toMatchObject({ text: "must survive transient denial" });
  });

  it("contains write failures without throwing or forgetting memory state", () => {
    const storage = new MemoryStorage();
    const persistence = new ComposerDraftPersistence(storage, {
      now: () => 1,
      createDraftId: () => "retained",
    });
    persistence.hydrate([workspaceDraftSession], ["workspace-a"]);
    storage.setError = true;
    expect(
      persistence.persist([workspaceDraftSession], {
        [workspaceDraftSession.id]: {
          text: "still held in memory",
          attachmentCount: 0,
        },
      }),
    ).toMatchObject({ status: "storage-error" });
    expect(persistence.recordsForTesting()[0]?.text).toBe(
      "still held in memory",
    );
  });

  it("quarantines in-flight reloads until authoritative acceptance or rejection", () => {
    const acceptedStorage = new MemoryStorage();
    const firstAccepted = new ComposerDraftPersistence(acceptedStorage, {
      now: () => 10,
    });
    firstAccepted.hydrate([nativeSession], ["workspace-a"]);
    firstAccepted.beginSubmission(nativeSession, "possibly accepted", 1);

    const acceptedReload = new ComposerDraftPersistence(acceptedStorage, {
      now: () => 20,
    });
    const uncertain = acceptedReload.hydrate([nativeSession], ["workspace-a"]);
    expect(uncertain.restored).toEqual([]);
    expect(uncertain.pendingSubmissions[0]).toMatchObject({
      text: "possibly accepted",
      destination: "parent",
      attachmentsNeedReselection: true,
    });
    expect(
      acceptedReload.reconcilePendingSubmission(nativeSession, "unknown"),
    ).toMatchObject({ status: "unchanged" });
    acceptedReload.reconcilePendingSubmission(nativeSession, "accepted");
    expect(readComposerDraftStore(acceptedStorage).records).toEqual([]);

    const acceptedWithNewerStorage = new MemoryStorage();
    const acceptedWithNewer = new ComposerDraftPersistence(
      acceptedWithNewerStorage,
      { now: () => 25 },
    );
    acceptedWithNewer.hydrate([nativeSession], ["workspace-a"]);
    acceptedWithNewer.beginSubmission(nativeSession, "accepted old text", 0);
    acceptedWithNewer.persist([nativeSession], {
      [nativeSession.id]: { text: "new unsent text", attachmentCount: 0 },
    });
    acceptedWithNewer.reconcilePendingSubmission(nativeSession, "accepted");
    expect(
      readComposerDraftStore(acceptedWithNewerStorage).records[0]?.text,
    ).toBe("new unsent text");

    const rejectedStorage = new MemoryStorage();
    const firstRejected = new ComposerDraftPersistence(rejectedStorage, {
      now: () => 30,
    });
    firstRejected.hydrate([nativeSession], ["workspace-a"]);
    firstRejected.beginSubmission(nativeSession, "definitely rejected", 0);
    const rejectedReload = new ComposerDraftPersistence(rejectedStorage, {
      now: () => 40,
    });
    rejectedReload.hydrate([nativeSession], ["workspace-a"]);
    rejectedReload.reconcilePendingSubmission(nativeSession, "rejected");
    const rejectedRecord = readComposerDraftStore(rejectedStorage).records[0];
    expect(rejectedRecord).toMatchObject({ text: "definitely rejected" });
    expect(rejectedRecord?.pendingSubmission).toBeUndefined();
  });

  it("preserves newer text beside an unknown delivery through reload and recovery", () => {
    const storage = new MemoryStorage();
    const first = new ComposerDraftPersistence(storage, { now: () => 50 });
    first.hydrate([nativeSession], ["workspace-a"]);
    first.beginSubmission(nativeSession, "possibly accepted text", 0);
    first.persist([nativeSession], {
      [nativeSession.id]: { text: "newer unsent draft", attachmentCount: 0 },
    });

    const reloaded = new ComposerDraftPersistence(storage, { now: () => 60 });
    const plan = reloaded.hydrate([nativeSession], ["workspace-a"]);
    expect(plan.restored).toMatchObject([
      { sessionId: nativeSession.id, text: "newer unsent draft" },
    ]);
    expect(plan.pendingSubmissions).toMatchObject([
      { sessionId: nativeSession.id, text: "possibly accepted text" },
    ]);
    expect(
      reloaded.reconcilePendingSubmission(nativeSession, "unknown"),
    ).toMatchObject({ status: "unchanged" });

    // An explicit recovery may not overwrite newer user input. Both values
    // remain durable until the newer draft is deliberately handled.
    expect(reloaded.recoverPendingSubmission(nativeSession)).toBeUndefined();
    expect(readComposerDraftStore(storage).records[0]).toMatchObject({
      text: "newer unsent draft",
      pendingSubmission: { text: "possibly accepted text" },
    });
  });

  it.each(["parent", "newTaskSession"] as const)(
    "preserves rejected %s text beside a newer draft until explicit recovery",
    (destination) => {
      const storage = new MemoryStorage();
      const persistence = new ComposerDraftPersistence(storage, {
        now: () => 50,
      });
      persistence.hydrate([nativeSession], ["workspace-a"]);
      persistence.beginSubmission(
        nativeSession,
        `rejected ${destination}`,
        1,
        destination,
      );
      persistence.persist([nativeSession], {
        [nativeSession.id]: { text: "newer unsent draft", attachmentCount: 0 },
      });

      persistence.finishSubmission(nativeSession, "rejected", false);
      expect(
        persistence.pendingSubmissionForSession(nativeSession),
      ).toMatchObject({
        text: `rejected ${destination}`,
        destination,
        attachmentsNeedReselection: true,
      });
      expect(
        persistence.recoverPendingSubmission(nativeSession),
      ).toBeUndefined();

      // Clearing the newer draft is explicit user handling. Recovery then
      // restores the rejected text without automatically replaying it.
      persistence.persist([nativeSession], {
        [nativeSession.id]: { text: "", attachmentCount: 0 },
      });
      expect(persistence.recoverPendingSubmission(nativeSession)).toMatchObject(
        {
          text: `rejected ${destination}`,
          attachmentsNeedReselection: true,
        },
      );
      const recovered = readComposerDraftStore(storage).records[0];
      expect(recovered?.text).toBe(`rejected ${destination}`);
      expect(recovered?.pendingSubmission).toBeUndefined();
    },
  );

  it("recovers uncertain text only after an explicit action and never stores tokens", () => {
    const storage = new MemoryStorage();
    const first = new ComposerDraftPersistence(storage, { now: () => 1 });
    first.hydrate([nativeSession], ["workspace-a"]);
    first.beginSubmission(nativeSession, "check history first", 2);
    const raw = storage.values.get(COMPOSER_DRAFT_STORAGE_KEY)!;
    expect(raw).not.toContain("selectedPathToken");

    const reloaded = new ComposerDraftPersistence(storage, { now: () => 2 });
    reloaded.hydrate([nativeSession], ["workspace-a"]);
    expect(reloaded.recoverPendingSubmission(nativeSession)).toMatchObject({
      text: "check history first",
      attachmentsNeedReselection: true,
    });
    const recoveredRecord = readComposerDraftStore(storage).records[0];
    expect(recoveredRecord).toMatchObject({ text: "check history first" });
    expect(recoveredRecord?.pendingSubmission).toBeUndefined();
  });
});
