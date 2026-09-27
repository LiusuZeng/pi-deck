export const COMPOSER_DRAFT_STORAGE_KEY = "pi-deck:composer-drafts";
export const COMPOSER_DRAFT_SCHEMA_VERSION = 1;
export const MAX_COMPOSER_DRAFT_ENTRIES = 100;
export const MAX_COMPOSER_DRAFT_TEXT_LENGTH = 200_000;
export const MAX_COMPOSER_DRAFT_TOTAL_TEXT_LENGTH = 1_000_000;

const MAX_WORKSPACE_ID_LENGTH = 512;
const MAX_SESSION_FILE_LENGTH = 4_096;
const MAX_DRAFT_ID_LENGTH = 128;
const MAX_SERIALIZED_STORE_LENGTH = 2_000_000;

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

export type DurableComposerDraft = ComposerDraftIdentityFields & {
  text: string;
  updatedAtMs: number;
  attachmentsNeedReselection: boolean;
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

interface ComposerDraftStoreV1 {
  version: 1;
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

export interface ComposerDraftRestorationPlan {
  restored: RestoredComposerDraft[];
  workspaceShells: RestoredWorkspaceDraftShell[];
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
 * bounded text, stable workspace/native-file identity, a timestamp, and a
 * boolean that says attachment selection must be repeated. Attachment tokens,
 * paths, image bytes, task IDs, and runtime IDs never enter this module.
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
  private readonly pendingSubmissionKeys = new Set<string>();
  private readonly now: () => number;
  private readonly createDraftId: () => string;
  private hydrated = false;
  private writable = true;
  private lastSerialized: string | undefined;

  constructor(
    private readonly storage: ComposerDraftStorage | undefined,
    options: ComposerDraftPersistenceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.createDraftId = options.createDraftId ?? defaultDraftId;
    const loaded = readComposerDraftStore(storage);
    this.loadStatus = loaded.status;
    this.writable = loaded.status !== "unsupported-version";
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
  ): RestoredComposerDraft[] {
    if (!this.hydrated) return [];
    return this.planRestoration(sessions, undefined, false).restored;
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
      return {
        status: "unsupported-version",
        truncated: false,
        pruned: 0,
      };
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
        // durable record until acceptance or rejection resolves explicitly.
        if (!this.pendingSubmissionKeys.has(key)) {
          this.records.delete(key);
          this.attachmentReselectionKeys.delete(key);
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
      text: boundedText,
      updatedAtMs: this.now(),
      attachmentsNeedReselection,
    });
    this.pendingSubmissionKeys.add(key);
    const result = this.write();
    return {
      ...result,
      truncated: result.truncated || boundedText.length !== text.length,
    };
  }

  finishSubmission(
    session: ComposerDraftSessionIdentitySource,
    acceptedAndStillCurrent: boolean,
  ): ComposerDraftPersistenceResult {
    const identity = this.identityForSession(session);
    if (identity === undefined) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    const key = composerDraftIdentityKey(identity);
    this.pendingSubmissionKeys.delete(key);
    if (acceptedAndStillCurrent) {
      this.records.delete(key);
      this.attachmentReselectionKeys.delete(key);
    }
    return this.write();
  }

  /** Move a renderer-only identity to the native file returned by create. */
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
    this.pendingSubmissionKeys.delete(key);
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
        this.pendingSubmissionKeys.delete(key);
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
        restored.push(restorationFor(session.id, identity, record));
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
      }
    }

    return { restored, workspaceShells };
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
      });
      this.records.delete(fromKey);
    }
    if (this.attachmentReselectionKeys.delete(fromKey)) {
      this.attachmentReselectionKeys.add(toKey);
    }
    if (this.pendingSubmissionKeys.delete(fromKey)) {
      this.pendingSubmissionKeys.add(toKey);
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
      return {
        status: "unsupported-version",
        truncated: false,
        pruned: 0,
      };
    }
    const serialized = serializeRecords([...this.records.values()]);
    if (serialized === this.lastSerialized) {
      return { status: "unchanged", truncated: false, pruned: 0 };
    }
    try {
      if (this.storage === undefined) throw new Error("Storage unavailable");
      if (this.records.size === 0) {
        this.storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      } else {
        this.storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, serialized);
      }
      this.lastSerialized = serialized;
      return { status: "ok", truncated: false, pruned: 0 };
    } catch {
      return { status: "storage-error", truncated: false, pruned: 0 };
    }
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
  if (raw.length > MAX_SERIALIZED_STORE_LENGTH) {
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
  if (value.version !== COMPOSER_DRAFT_SCHEMA_VERSION) {
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
    if (
      totalTextLength + record.text.length >
      MAX_COMPOSER_DRAFT_TOTAL_TEXT_LENGTH
    ) {
      continue;
    }
    keys.add(key);
    totalTextLength += record.text.length;
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
    };
  }
  return undefined;
}

function boundRecords(records: DurableComposerDraft[]): {
  records: DurableComposerDraft[];
  truncated: boolean;
  pruned: number;
} {
  const sorted = [...records].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  );
  const bounded: DurableComposerDraft[] = [];
  let totalTextLength = 0;
  let truncated = false;
  for (const record of sorted) {
    if (bounded.length >= MAX_COMPOSER_DRAFT_ENTRIES) break;
    const available = MAX_COMPOSER_DRAFT_TOTAL_TEXT_LENGTH - totalTextLength;
    if (available <= 0) break;
    const text = record.text.slice(
      0,
      Math.min(MAX_COMPOSER_DRAFT_TEXT_LENGTH, available),
    );
    truncated ||= text.length !== record.text.length;
    bounded.push({ ...record, text });
    totalTextLength += text.length;
  }
  return {
    records: bounded,
    truncated,
    pruned: Math.max(0, records.length - bounded.length),
  };
}

function serializeRecords(records: DurableComposerDraft[]): string {
  const store: ComposerDraftStoreV1 = {
    version: COMPOSER_DRAFT_SCHEMA_VERSION,
    drafts: [...records].sort((left, right) =>
      composerDraftIdentityKey(left).localeCompare(
        composerDraftIdentityKey(right),
      ),
    ),
  };
  return JSON.stringify(store);
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
