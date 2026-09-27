export const COMPOSER_DRAFT_STORAGE_KEY = "pi-deck:composer-drafts";
export const COMPOSER_DRAFT_SCHEMA_VERSION = 2;
export const MAX_COMPOSER_DRAFT_ENTRIES = 100;
export const MAX_COMPOSER_DRAFT_TEXT_LENGTH = 200_000;
export const MAX_COMPOSER_DRAFT_TOTAL_TEXT_LENGTH = 1_000_000;
export const MAX_COMPOSER_DRAFT_SERIALIZED_LENGTH = 2_000_000;

const MAX_WORKSPACE_ID_LENGTH = 512;
const MAX_SESSION_FILE_LENGTH = 4_096;
const MAX_DRAFT_ID_LENGTH = 128;

export interface ComposerDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ComposerDraftIdentity =
  | {
      kind: "workspaceDraft";
      workspaceId: string;
      draftId: string;
    }
  | {
      kind: "sessionFile";
      workspaceId: string;
      sessionFile: string;
    };

export type ComposerSubmissionDestination =
  | "parent"
  | "newTaskSession"
  | "steer"
  | "followUp";

/**
 * A renderer reload can interrupt the prompt IPC after main accepted it but
 * before the renderer observed the result. This metadata deliberately stores
 * no attachment tokens or paths. Until authoritative receipt evidence is
 * supplied, `text` is quarantined and must never be restored as a fresh draft.
 */
export interface DurablePendingComposerSubmission {
  text: string;
  startedAtMs: number;
  destination: ComposerSubmissionDestination;
  attachmentsNeedReselection: boolean;
}

export type DurableComposerDraft = ComposerDraftIdentityFields & {
  /** Current unsent text. Pending submission text lives separately below. */
  text: string;
  updatedAtMs: number;
  attachmentsNeedReselection: boolean;
  pendingSubmission?: DurablePendingComposerSubmission | undefined;
};

type ComposerDraftIdentityFields =
  | {
      kind: "workspaceDraft";
      workspaceId: string;
      draftId: string;
    }
  | {
      kind: "sessionFile";
      workspaceId: string;
      sessionFile: string;
    };

interface ComposerDraftStoreV2 {
  version: 2;
  drafts: DurableComposerDraft[];
}

export interface ComposerDraftSessionIdentitySource {
  id: string;
  workspaceId: string;
  sessionFile?: string | undefined;
  draftSession?: boolean | undefined;
}

export interface ComposerDraftSnapshot {
  text: string;
  attachmentCount: number;
}

export interface RestoredComposerDraft {
  sessionId: string;
  identity: ComposerDraftIdentity;
  text: string;
  attachmentsNeedReselection: boolean;
}

export interface RestoredWorkspaceDraftShell {
  sessionId: string;
  identity: Extract<ComposerDraftIdentity, { kind: "workspaceDraft" }>;
  text: string;
  attachmentsNeedReselection: boolean;
}

export interface PendingComposerSubmissionRecovery {
  sessionId: string;
  identity: ComposerDraftIdentity;
  text: string;
  startedAtMs: number;
  destination: ComposerSubmissionDestination;
  attachmentsNeedReselection: boolean;
}

export interface ComposerDraftRestorationPlan {
  restored: RestoredComposerDraft[];
  workspaceShells: RestoredWorkspaceDraftShell[];
  pendingSubmissions: PendingComposerSubmissionRecovery[];
  prunedStaleWorkspaceCount: number;
}

export interface ComposerDraftPersistenceResult {
  status:
    | "ok"
    | "unchanged"
    | "skipped-not-hydrated"
    | "unsupported-version"
    | "storage-error";
  truncated: boolean;
  pruned: number;
}

export type ComposerDraftLoadStatus =
  | "ok"
  | "empty"
  | "invalid"
  | "unsupported-version"
  | "storage-error";

export interface ComposerDraftPersistenceOptions {
  now?: () => number;
  createDraftId?: () => string;
}

interface ParsedStore {
  status: ComposerDraftLoadStatus;
  records: DurableComposerDraft[];
}

/**
 * Renderer-profile-local draft storage. The serialized contract contains only
 * bounded text, stable workspace/native-file identity, timestamps, a delivery
 * destination, and booleans that say attachment selection must be repeated.
 * Attachment tokens, paths, image bytes, task IDs, and runtime IDs never enter
 * this module.
 */
export class ComposerDraftPersistence {
  readonly loadStatus: ComposerDraftLoadStatus;

  private readonly records = new Map<string, DurableComposerDraft>();
  private readonly identitiesBySessionId = new Map<
    string,
    ComposerDraftIdentity
  >();
  private readonly restoredKeys = new Set<string>();
  private readonly attachmentReselectionKeys = new Set<string>();
  private readonly now: () => number;
  private readonly createDraftId: () => string;
  private hydrated = false;
  private writable = false;
  private writeBlockedStatus: "unsupported-version" | "storage-error" =
    "storage-error";
  private lastSerialized: string | undefined;

  constructor(
    private readonly storage: ComposerDraftStorage | undefined,
    options: ComposerDraftPersistenceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.createDraftId = options.createDraftId ?? defaultDraftId;
    const loaded = readComposerDraftStore(storage);
    this.loadStatus = loaded.status;
    this.writable = loaded.status === "ok" || loaded.status === "empty";
    this.writeBlockedStatus =
      loaded.status === "unsupported-version"
        ? "unsupported-version"
        : "storage-error";
    for (const record of loaded.records) {
      this.records.set(composerDraftIdentityKey(record), record);
    }
    if (loaded.status === "ok") {
      this.lastSerialized = serializeRecords([...this.records.values()]);
    }
  }

  /**
   * Hydration is an explicit write barrier: bootstrap's empty React state can
   * never overwrite loaded records before the caller has applied this plan.
   */
  hydrate(
    sessions: readonly ComposerDraftSessionIdentitySource[],
    activeWorkspaceIds: readonly string[],
  ): ComposerDraftRestorationPlan {
    const activeWorkspaceSet = new Set(activeWorkspaceIds);
    let prunedStaleWorkspaceCount = 0;
    for (const [key, record] of this.records) {
      if (!activeWorkspaceSet.has(record.workspaceId)) {
        this.records.delete(key);
        this.attachmentReselectionKeys.delete(key);
        prunedStaleWorkspaceCount += 1;
      }
    }

    const plan = this.planRestoration(sessions, activeWorkspaceSet, true);
    this.hydrated = true;
    if (prunedStaleWorkspaceCount > 0) {
      this.write();
    }
    return { ...plan, prunedStaleWorkspaceCount };
  }

  /** Restore native session drafts that appeared in a later background scan. */
  restoreAvailableSessions(
    sessions: readonly ComposerDraftSessionIdentitySource[],
  ): Pick<ComposerDraftRestorationPlan, "restored" | "pendingSubmissions"> {
    if (!this.hydrated) return { restored: [], pendingSubmissions: [] };
    const plan = this.planRestoration(sessions, undefined, false);
    return {
      restored: plan.restored,
      pendingSubmissions: plan.pendingSubmissions,
    };
  }

  /**
   * Retry a failed constructor read without risking an empty-state overwrite.
   * A successful read is merged with newer in-memory edits before writes thaw.
   */
  recoverStorage(): ComposerDraftPersistenceResult {
    const loaded = readComposerDraftStore(this.storage);
    if (loaded.status !== "ok" && loaded.status !== "empty") {
      this.writable = false;
      this.writeBlockedStatus =
        loaded.status === "unsupported-version"
          ? "unsupported-version"
          : "storage-error";
      return this.blockedWriteResult();
    }
    for (const durable of loaded.records) {
      const key = composerDraftIdentityKey(durable);
      const memory = this.records.get(key);
      // Existing memory was created after the failed constructor read, so it
      // wins regardless of wall-clock skew. The successful retry fills only
      // identities that were previously unknown.
      if (memory === undefined) {
        this.records.set(key, durable);
      }
    }
    this.writable = true;
    this.lastSerialized = serializeRecords(loaded.records);
    return { status: "ok", truncated: false, pruned: 0 };
  }

  persist(
    sessions: readonly ComposerDraftSessionIdentitySource[],
    draftsBySessionId: Readonly<
      Record<string, ComposerDraftSnapshot | undefined>
    >,
  ): ComposerDraftPersistenceResult {
    if (!this.hydrated) {
      return {
        status: "skipped-not-hydrated",
        truncated: false,
        pruned: 0,
      };
    }
    if (!this.writable) {
      return this.blockedWriteResult();
    }

    let truncated = false;
    for (const session of sessions) {
      const identity = this.identityForSession(session);
      if (identity === undefined) continue;
      const key = composerDraftIdentityKey(identity);
      const draft = draftsBySessionId[session.id];
      if (
        draft === undefined ||
        (draft.text.length === 0 && draft.attachmentCount === 0)
      ) {
        // The UI may clear optimistically while IPC is pending. Keep its
        // quarantined submission until authoritative acceptance/rejection.
        const existing = this.records.get(key);
        if (existing?.pendingSubmission === undefined) {
          this.records.delete(key);
          this.attachmentReselectionKeys.delete(key);
        } else if (
          existing.text.length > 0 ||
          existing.attachmentsNeedReselection
        ) {
          this.records.set(key, {
            ...existing,
            text: "",
            attachmentsNeedReselection: false,
            updatedAtMs: this.now(),
          });
        }
        continue;
      }
      const text = draft.text.slice(0, MAX_COMPOSER_DRAFT_TEXT_LENGTH);
      truncated ||= text.length !== draft.text.length;
      const attachmentsNeedReselection =
        draft.attachmentCount > 0 || this.attachmentReselectionKeys.has(key);
      const existing = this.records.get(key);
      if (
        existing?.text === text &&
        existing.attachmentsNeedReselection === attachmentsNeedReselection
      ) {
        continue;
      }
      this.records.set(key, {
        ...identity,
        text,
        updatedAtMs: this.now(),
        attachmentsNeedReselection,
        ...(existing?.pendingSubmission === undefined
          ? {}
          : { pendingSubmission: existing.pendingSubmission }),
      });
    }

    const bounded = boundRecords([...this.records.values()]);
    truncated ||= bounded.truncated;
    this.replaceRecords(bounded.records);
    const result = this.write();
    return {
      ...result,
      truncated,
      pruned: bounded.pruned,
    };
  }

  /**
   * Pin the submitted text before an optimistic UI clear. The corresponding
   * finish call is the only path that may remove it after IPC acceptance.
   */
  beginSubmission(
    session: ComposerDraftSessionIdentitySource,
    text: string,
    attachmentCount: number,
    destination: ComposerSubmissionDestination = "parent",
  ): ComposerDraftPersistenceResult {
    const identity = this.identityForSession(session);
    if (identity === undefined) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    const key = composerDraftIdentityKey(identity);
    const boundedText = text.slice(0, MAX_COMPOSER_DRAFT_TEXT_LENGTH);
    const attachmentsNeedReselection =
      attachmentCount > 0 || this.attachmentReselectionKeys.has(key);
    this.records.set(key, {
      ...identity,
      // The visible composer is about to clear. Any later persist writes a
      // genuinely newer draft here, independently of the uncertain receipt.
      text: "",
      updatedAtMs: this.now(),
      attachmentsNeedReselection: false,
      pendingSubmission: {
        text: boundedText,
        startedAtMs: this.now(),
        destination,
        attachmentsNeedReselection,
      },
    });
    const result = this.write();
    return {
      ...result,
      truncated: result.truncated || boundedText.length !== text.length,
    };
  }

  /**
   * Resolve only from the live IPC result or another authoritative receipt.
   * Snapshot text equality is intentionally not evidence of acceptance.
   */
  finishSubmission(
    session: ComposerDraftSessionIdentitySource,
    outcome: "accepted" | "rejected",
    submittedDraftIsCurrent: boolean,
  ): ComposerDraftPersistenceResult {
    const identity = this.identityForSession(session);
    if (identity === undefined) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    const key = composerDraftIdentityKey(identity);
    const record = this.records.get(key);
    const pending = record?.pendingSubmission;
    if (record === undefined || pending === undefined) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    if (outcome === "accepted" && submittedDraftIsCurrent) {
      this.records.delete(key);
      this.attachmentReselectionKeys.delete(key);
    } else {
      const restoredRejectedText =
        outcome === "rejected" && submittedDraftIsCurrent
          ? pending.text
          : record.text;
      const restoredAttachments =
        outcome === "rejected" && submittedDraftIsCurrent
          ? pending.attachmentsNeedReselection
          : record.attachmentsNeedReselection;
      if (restoredRejectedText.length === 0 && !restoredAttachments) {
        this.records.delete(key);
      } else {
        this.records.set(key, {
          ...record,
          text: restoredRejectedText,
          attachmentsNeedReselection: restoredAttachments,
          pendingSubmission: undefined,
          updatedAtMs: this.now(),
        });
      }
    }
    return this.write();
  }

  /**
   * Reconcile an interrupted renderer only with authoritative, correlation-
   * bearing durable receipt evidence. A pending Extension UI snapshot DTO is
   * not a prompt receipt, and a matching transcript string is never sufficient:
   * repeated prompts are valid. Pass `unknown` when receipt evidence is absent;
   * the text then stays quarantined for explicit user recovery.
   */
  reconcilePendingSubmission(
    session: ComposerDraftSessionIdentitySource,
    disposition: "accepted" | "rejected" | "unknown",
  ): ComposerDraftPersistenceResult {
    if (disposition === "unknown") {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    const identity = this.identityForSession(session);
    const record =
      identity === undefined
        ? undefined
        : this.records.get(composerDraftIdentityKey(identity));
    const submittedDraftIsCurrent =
      record !== undefined &&
      record.text.length === 0 &&
      !record.attachmentsNeedReselection;
    if (disposition === "rejected" && !submittedDraftIsCurrent) {
      // A newer draft and the rejected text are both user data. Keep the latter
      // quarantined rather than overwriting either value; explicit recovery is
      // available after the newer composer is cleared or copied.
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    return this.finishSubmission(session, disposition, submittedDraftIsCurrent);
  }

  /** User explicitly chose recovery after checking history; never auto-replay. */
  recoverPendingSubmission(
    session: ComposerDraftSessionIdentitySource,
  ): RestoredComposerDraft | undefined {
    const identity = this.identityForSession(session);
    if (identity === undefined) return undefined;
    const key = composerDraftIdentityKey(identity);
    const record = this.records.get(key);
    const pending = record?.pendingSubmission;
    if (record === undefined || pending === undefined) return undefined;
    const recovered: DurableComposerDraft = {
      ...record,
      text: pending.text,
      attachmentsNeedReselection: pending.attachmentsNeedReselection,
      pendingSubmission: undefined,
      updatedAtMs: this.now(),
    };
    this.records.set(key, recovered);
    if (recovered.attachmentsNeedReselection) {
      this.attachmentReselectionKeys.add(key);
    }
    this.write();
    return restorationFor(session.id, identity, recovered);
  }

  /**
   * Transfer renderer-row ownership to its replacement. This covers both a
   * workspace draft becoming native and a cached native row being superseded
   * by an attached runtime row; callers must invoke it in the same transaction
   * that moves composer state so stale non-runtime IDs cannot retain a binding.
   */
  migrateSession(
    from: ComposerDraftSessionIdentitySource,
    to: ComposerDraftSessionIdentitySource,
  ): ComposerDraftPersistenceResult {
    const fromIdentity = this.identityForSession(from);
    const toIdentity = nativeComposerDraftIdentity(to);
    if (fromIdentity === undefined || toIdentity === undefined) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    this.migrateIdentity(fromIdentity, toIdentity);
    this.identitiesBySessionId.delete(from.id);
    this.identitiesBySessionId.set(to.id, toIdentity);
    return this.write();
  }

  clearIdentity(
    identity: ComposerDraftIdentity,
  ): ComposerDraftPersistenceResult {
    const key = composerDraftIdentityKey(identity);
    const changed = this.records.delete(key);
    this.attachmentReselectionKeys.delete(key);
    if (!changed) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    return this.write();
  }

  discardSessions(
    sessions: readonly ComposerDraftSessionIdentitySource[],
  ): ComposerDraftPersistenceResult {
    let changed = false;
    for (const session of sessions) {
      const identity = this.identityForSession(session);
      if (identity !== undefined) {
        const key = composerDraftIdentityKey(identity);
        changed = this.records.delete(key) || changed;
        this.attachmentReselectionKeys.delete(key);
      }
      this.identitiesBySessionId.delete(session.id);
    }
    return changed
      ? this.write()
      : { status: "unchanged", truncated: false, pruned: 0 };
  }

  markAttachmentsNeedReselection(
    session: ComposerDraftSessionIdentitySource,
  ): ComposerDraftPersistenceResult {
    const identity = this.identityForSession(session);
    if (identity === undefined) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    const key = composerDraftIdentityKey(identity);
    const record = this.records.get(key);
    if (record === undefined) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    this.attachmentReselectionKeys.add(key);
    if (record.attachmentsNeedReselection) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    this.records.set(key, { ...record, attachmentsNeedReselection: true });
    return this.write();
  }

  identityForSession(
    session: ComposerDraftSessionIdentitySource,
  ): ComposerDraftIdentity | undefined {
    const nativeIdentity = nativeComposerDraftIdentity(session);
    const previous = this.identitiesBySessionId.get(session.id);
    if (nativeIdentity !== undefined) {
      if (
        previous !== undefined &&
        composerDraftIdentityKey(previous) !==
          composerDraftIdentityKey(nativeIdentity)
      ) {
        this.migrateIdentity(previous, nativeIdentity);
      }
      this.identitiesBySessionId.set(session.id, nativeIdentity);
      return nativeIdentity;
    }
    if (session.draftSession !== true) return undefined;

    if (previous?.kind === "workspaceDraft") {
      const identity = {
        ...previous,
        workspaceId: session.workspaceId,
      };
      if (
        composerDraftIdentityKey(previous) !==
        composerDraftIdentityKey(identity)
      ) {
        this.migrateIdentity(previous, identity);
        this.identitiesBySessionId.set(session.id, identity);
      }
      return identity;
    }

    const identity: ComposerDraftIdentity = {
      kind: "workspaceDraft",
      workspaceId: session.workspaceId,
      draftId: this.createDraftId(),
    };
    this.identitiesBySessionId.set(session.id, identity);
    return identity;
  }

  bindSession(sessionId: string, identity: ComposerDraftIdentity): void {
    this.identitiesBySessionId.set(sessionId, identity);
  }

  recordsForTesting(): DurableComposerDraft[] {
    return [...this.records.values()];
  }

  private planRestoration(
    sessions: readonly ComposerDraftSessionIdentitySource[],
    activeWorkspaceIds: ReadonlySet<string> | undefined,
    includeWorkspaceShells: boolean,
  ): Omit<ComposerDraftRestorationPlan, "prunedStaleWorkspaceCount"> {
    const restored: RestoredComposerDraft[] = [];
    const workspaceShells: RestoredWorkspaceDraftShell[] = [];
    const pendingSubmissions: PendingComposerSubmissionRecovery[] = [];
    const claimedSessionIds = new Set<string>();

    for (const record of [...this.records.values()].sort(
      (left, right) => left.updatedAtMs - right.updatedAtMs,
    )) {
      const identity = identityFromRecord(record);
      const key = composerDraftIdentityKey(identity);
      if (this.restoredKeys.has(key)) continue;
      if (
        activeWorkspaceIds !== undefined &&
        !activeWorkspaceIds.has(record.workspaceId)
      ) {
        continue;
      }

      let session: ComposerDraftSessionIdentitySource | undefined;
      if (record.kind === "sessionFile") {
        session = sessions.find(
          (candidate) =>
            !claimedSessionIds.has(candidate.id) &&
            candidate.workspaceId === record.workspaceId &&
            candidate.sessionFile === record.sessionFile,
        );
      } else {
        session = sessions.find(
          (candidate) =>
            !claimedSessionIds.has(candidate.id) &&
            candidate.workspaceId === record.workspaceId &&
            candidate.draftSession === true,
        );
      }

      if (session !== undefined) {
        claimedSessionIds.add(session.id);
        this.bindSession(session.id, identity);
        this.markRestored(key, record);
        if (record.text.length > 0) {
          restored.push(restorationFor(session.id, identity, record));
        }
        if (record.pendingSubmission !== undefined) {
          pendingSubmissions.push(
            pendingRecoveryFor(session.id, identity, record.pendingSubmission),
          );
        }
        continue;
      }
      if (record.kind === "workspaceDraft" && includeWorkspaceShells) {
        const sessionId = restoredComposerDraftSessionId(record.draftId);
        const workspaceIdentity: Extract<
          ComposerDraftIdentity,
          { kind: "workspaceDraft" }
        > = {
          kind: "workspaceDraft",
          workspaceId: record.workspaceId,
          draftId: record.draftId,
        };
        this.bindSession(sessionId, workspaceIdentity);
        this.markRestored(key, record);
        workspaceShells.push({
          sessionId,
          identity: workspaceIdentity,
          text: record.text,
          attachmentsNeedReselection: record.attachmentsNeedReselection,
        });
        if (record.pendingSubmission !== undefined) {
          pendingSubmissions.push(
            pendingRecoveryFor(
              sessionId,
              workspaceIdentity,
              record.pendingSubmission,
            ),
          );
        }
      }
    }

    return { restored, workspaceShells, pendingSubmissions };
  }

  private markRestored(key: string, record: DurableComposerDraft): void {
    this.restoredKeys.add(key);
    if (record.attachmentsNeedReselection) {
      this.attachmentReselectionKeys.add(key);
    }
  }

  private migrateIdentity(
    from: ComposerDraftIdentity,
    to: ComposerDraftIdentity,
  ): void {
    const fromKey = composerDraftIdentityKey(from);
    const toKey = composerDraftIdentityKey(to);
    if (fromKey === toKey) return;
    const source = this.records.get(fromKey);
    const destination = this.records.get(toKey);
    if (source !== undefined) {
      this.records.set(toKey, {
        ...to,
        text:
          destination !== undefined &&
          destination.updatedAtMs > source.updatedAtMs
            ? destination.text
            : source.text,
        updatedAtMs: Math.max(
          source.updatedAtMs,
          destination?.updatedAtMs ?? 0,
        ),
        attachmentsNeedReselection:
          source.attachmentsNeedReselection ||
          destination?.attachmentsNeedReselection === true,
        ...(source.pendingSubmission !== undefined
          ? { pendingSubmission: source.pendingSubmission }
          : destination?.pendingSubmission !== undefined
            ? { pendingSubmission: destination.pendingSubmission }
            : {}),
      });
      this.records.delete(fromKey);
    }
    if (this.attachmentReselectionKeys.delete(fromKey)) {
      this.attachmentReselectionKeys.add(toKey);
    }
    if (this.restoredKeys.delete(fromKey)) this.restoredKeys.add(toKey);
  }

  private replaceRecords(records: DurableComposerDraft[]): void {
    const retainedKeys = new Set(records.map(composerDraftIdentityKey));
    this.records.clear();
    for (const record of records) {
      this.records.set(composerDraftIdentityKey(record), record);
    }
    for (const key of this.attachmentReselectionKeys) {
      if (!retainedKeys.has(key)) this.attachmentReselectionKeys.delete(key);
    }
  }

  private write(): ComposerDraftPersistenceResult {
    if (!this.hydrated) {
      return {
        status: "skipped-not-hydrated",
        truncated: false,
        pruned: 0,
      };
    }
    if (!this.writable) {
      return this.blockedWriteResult();
    }
    const bounded = boundRecords([...this.records.values()]);
    this.replaceRecords(bounded.records);
    const serialized = serializeRecords(bounded.records);
    if (serialized === this.lastSerialized) {
      return {
        status: "unchanged",
        truncated: bounded.truncated,
        pruned: bounded.pruned,
      };
    }
    try {
      if (this.storage === undefined) throw new Error("Storage unavailable");
      if (this.records.size === 0) {
        this.storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      } else {
        this.storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, serialized);
      }
      this.lastSerialized = serialized;
      return {
        status: "ok",
        truncated: bounded.truncated,
        pruned: bounded.pruned,
      };
    } catch {
      // Treat any storage exception as loss of authority. Do not attempt a
      // later remove/set until an explicit read proves storage is available.
      this.writable = false;
      this.writeBlockedStatus = "storage-error";
      return {
        status: "storage-error",
        truncated: bounded.truncated,
        pruned: bounded.pruned,
      };
    }
  }

  private blockedWriteResult(): ComposerDraftPersistenceResult {
    return {
      status: this.writeBlockedStatus,
      truncated: false,
      pruned: 0,
    };
  }
}

export function nativeComposerDraftIdentity(
  session: ComposerDraftSessionIdentitySource,
): Extract<ComposerDraftIdentity, { kind: "sessionFile" }> | undefined {
  return typeof session.sessionFile === "string" &&
    session.sessionFile.length > 0
    ? {
        kind: "sessionFile",
        workspaceId: session.workspaceId,
        sessionFile: session.sessionFile,
      }
    : undefined;
}

export function composerDraftIdentityKey(
  identity: ComposerDraftIdentity,
): string {
  return identity.kind === "sessionFile"
    ? `session:${JSON.stringify([identity.workspaceId, identity.sessionFile])}`
    : `workspace-draft:${JSON.stringify([
        identity.workspaceId,
        identity.draftId,
      ])}`;
}

export function restoredComposerDraftSessionId(draftId: string): string {
  return `persisted-draft-${draftId}`;
}

export function readComposerDraftStore(
  storage: ComposerDraftStorage | undefined,
): ParsedStore {
  let raw: string | null;
  try {
    if (storage === undefined) throw new Error("Storage unavailable");
    raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  } catch {
    return { status: "storage-error", records: [] };
  }
  if (raw === null) return { status: "empty", records: [] };
  if (raw.length > MAX_COMPOSER_DRAFT_SERIALIZED_LENGTH) {
    return { status: "invalid", records: [] };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "invalid", records: [] };
  }
  if (!isObject(value) || typeof value.version !== "number") {
    return { status: "invalid", records: [] };
  }
  if (value.version !== 1 && value.version !== COMPOSER_DRAFT_SCHEMA_VERSION) {
    return { status: "unsupported-version", records: [] };
  }
  if (!Array.isArray(value.drafts)) {
    return { status: "invalid", records: [] };
  }

  const records: DurableComposerDraft[] = [];
  const keys = new Set<string>();
  let totalTextLength = 0;
  for (const candidate of value.drafts) {
    const record = parseRecord(candidate);
    if (record === undefined) continue;
    const key = composerDraftIdentityKey(record);
    if (keys.has(key)) continue;
    if (records.length >= MAX_COMPOSER_DRAFT_ENTRIES) break;
    const recordTextLength =
      record.text.length + (record.pendingSubmission?.text.length ?? 0);
    if (
      totalTextLength + recordTextLength >
      MAX_COMPOSER_DRAFT_TOTAL_TEXT_LENGTH
    ) {
      continue;
    }
    keys.add(key);
    totalTextLength += recordTextLength;
    records.push(record);
  }
  return { status: "ok", records };
}

function parseRecord(value: unknown): DurableComposerDraft | undefined {
  if (
    !isObject(value) ||
    !validBoundedString(value.workspaceId, MAX_WORKSPACE_ID_LENGTH) ||
    typeof value.text !== "string" ||
    value.text.length > MAX_COMPOSER_DRAFT_TEXT_LENGTH ||
    typeof value.updatedAtMs !== "number" ||
    !Number.isFinite(value.updatedAtMs) ||
    value.updatedAtMs < 0 ||
    typeof value.attachmentsNeedReselection !== "boolean"
  ) {
    return undefined;
  }
  const pendingSubmission = parsePendingSubmission(value.pendingSubmission);
  if (
    value.pendingSubmission !== undefined &&
    pendingSubmission === undefined
  ) {
    return undefined;
  }
  if (
    value.kind === "workspaceDraft" &&
    validBoundedString(value.draftId, MAX_DRAFT_ID_LENGTH)
  ) {
    return {
      kind: "workspaceDraft",
      workspaceId: value.workspaceId,
      draftId: value.draftId,
      text: value.text,
      updatedAtMs: value.updatedAtMs,
      attachmentsNeedReselection: value.attachmentsNeedReselection,
      ...(pendingSubmission === undefined ? {} : { pendingSubmission }),
    };
  }
  if (
    value.kind === "sessionFile" &&
    validBoundedString(value.sessionFile, MAX_SESSION_FILE_LENGTH)
  ) {
    return {
      kind: "sessionFile",
      workspaceId: value.workspaceId,
      sessionFile: value.sessionFile,
      text: value.text,
      updatedAtMs: value.updatedAtMs,
      attachmentsNeedReselection: value.attachmentsNeedReselection,
      ...(pendingSubmission === undefined ? {} : { pendingSubmission }),
    };
  }
  return undefined;
}

function parsePendingSubmission(
  value: unknown,
): DurablePendingComposerSubmission | undefined {
  if (
    !isObject(value) ||
    typeof value.text !== "string" ||
    value.text.length > MAX_COMPOSER_DRAFT_TEXT_LENGTH ||
    typeof value.startedAtMs !== "number" ||
    !Number.isFinite(value.startedAtMs) ||
    value.startedAtMs < 0 ||
    (value.destination !== "parent" &&
      value.destination !== "newTaskSession" &&
      value.destination !== "steer" &&
      value.destination !== "followUp") ||
    typeof value.attachmentsNeedReselection !== "boolean"
  ) {
    return undefined;
  }
  return {
    text: value.text,
    startedAtMs: value.startedAtMs,
    destination: value.destination,
    attachmentsNeedReselection: value.attachmentsNeedReselection,
  };
}

function boundRecords(records: DurableComposerDraft[]): {
  records: DurableComposerDraft[];
  truncated: boolean;
  pruned: number;
} {
  const sorted = [...records].sort(
    (left, right) =>
      right.updatedAtMs - left.updatedAtMs ||
      composerDraftIdentityKey(left).localeCompare(
        composerDraftIdentityKey(right),
      ),
  );
  const bounded: DurableComposerDraft[] = [];
  let totalTextLength = 0;
  let serializedLength = serializeRecords([]).length;
  let truncated = false;
  for (const record of sorted) {
    if (bounded.length >= MAX_COMPOSER_DRAFT_ENTRIES) break;
    const availableRaw = MAX_COMPOSER_DRAFT_TOTAL_TEXT_LENGTH - totalTextLength;
    if (availableRaw <= 0) break;

    let text = record.text.slice(
      0,
      Math.min(MAX_COMPOSER_DRAFT_TEXT_LENGTH, availableRaw),
    );
    const remainingRaw = availableRaw - text.length;
    let pendingText = record.pendingSubmission?.text.slice(
      0,
      Math.min(MAX_COMPOSER_DRAFT_TEXT_LENGTH, remainingRaw),
    );
    let candidate: DurableComposerDraft = {
      ...record,
      text,
      ...(record.pendingSubmission === undefined
        ? {}
        : {
            pendingSubmission: {
              ...record.pendingSubmission,
              text: pendingText ?? "",
            },
          }),
    };

    const separatorLength = bounded.length === 0 ? 0 : 1;
    if (
      serializedLength + separatorLength + JSON.stringify(candidate).length >
      MAX_COMPOSER_DRAFT_SERIALIZED_LENGTH
    ) {
      const withoutText: DurableComposerDraft = {
        ...candidate,
        text: "",
        ...(candidate.pendingSubmission === undefined
          ? {}
          : {
              pendingSubmission: {
                ...candidate.pendingSubmission,
                text: "",
              },
            }),
      };
      const fixedLength =
        serializedLength + separatorLength + JSON.stringify(withoutText).length;
      if (fixedLength > MAX_COMPOSER_DRAFT_SERIALIZED_LENGTH) {
        truncated = true;
        continue;
      }
      let escapedBudget = MAX_COMPOSER_DRAFT_SERIALIZED_LENGTH - fixedLength;
      text = truncateJsonStringToEscapedLength(text, escapedBudget);
      escapedBudget -= jsonEscapedStringLength(text);
      if (pendingText !== undefined) {
        pendingText = truncateJsonStringToEscapedLength(
          pendingText,
          escapedBudget,
        );
      }
      candidate = {
        ...candidate,
        text,
        ...(candidate.pendingSubmission === undefined
          ? {}
          : {
              pendingSubmission: {
                ...candidate.pendingSubmission,
                text: pendingText ?? "",
              },
            }),
      };
    }

    truncated ||=
      text.length !== record.text.length ||
      (pendingText?.length ?? 0) !==
        (record.pendingSubmission?.text.length ?? 0);
    bounded.push(candidate);
    totalTextLength += text.length + (pendingText?.length ?? 0);
    serializedLength += separatorLength + JSON.stringify(candidate).length;
  }
  return {
    records: bounded,
    truncated,
    pruned: Math.max(0, records.length - bounded.length),
  };
}

function serializeRecords(records: DurableComposerDraft[]): string {
  const store: ComposerDraftStoreV2 = {
    version: COMPOSER_DRAFT_SCHEMA_VERSION,
    drafts: [...records].sort((left, right) =>
      composerDraftIdentityKey(left).localeCompare(
        composerDraftIdentityKey(right),
      ),
    ),
  };
  return JSON.stringify(store);
}

function jsonEscapedStringLength(value: string): number {
  return JSON.stringify(value).length - 2;
}

/** Return the longest code-point-safe prefix whose JSON payload fits. */
function truncateJsonStringToEscapedLength(
  value: string,
  maximumEscapedLength: number,
): string {
  let index = 0;
  let escapedLength = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    const isPair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff;
    const width = isPair ? 2 : 1;
    const cost = isPair
      ? 2
      : code === 0x22 || code === 0x5c
        ? 2
        : code === 0x08 ||
            code === 0x09 ||
            code === 0x0a ||
            code === 0x0c ||
            code === 0x0d
          ? 2
          : code < 0x20 || (code >= 0xd800 && code <= 0xdfff)
            ? 6
            : 1;
    if (escapedLength + cost > maximumEscapedLength) break;
    escapedLength += cost;
    index += width;
  }
  return value.slice(0, index);
}

function pendingRecoveryFor(
  sessionId: string,
  identity: ComposerDraftIdentity,
  pending: DurablePendingComposerSubmission,
): PendingComposerSubmissionRecovery {
  return {
    sessionId,
    identity,
    text: pending.text,
    startedAtMs: pending.startedAtMs,
    destination: pending.destination,
    attachmentsNeedReselection: pending.attachmentsNeedReselection,
  };
}

function restorationFor(
  sessionId: string,
  identity: ComposerDraftIdentity,
  record: DurableComposerDraft,
): RestoredComposerDraft {
  return {
    sessionId,
    identity,
    text: record.text,
    attachmentsNeedReselection: record.attachmentsNeedReselection,
  };
}

function identityFromRecord(
  record: DurableComposerDraft,
): ComposerDraftIdentity {
  return record.kind === "sessionFile"
    ? {
        kind: "sessionFile",
        workspaceId: record.workspaceId,
        sessionFile: record.sessionFile,
      }
    : {
        kind: "workspaceDraft",
        workspaceId: record.workspaceId,
        draftId: record.draftId,
      };
}

function defaultDraftId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function validBoundedString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
