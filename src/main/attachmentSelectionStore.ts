import { Buffer } from "node:buffer";
import type { AttachmentDraft } from "../shared/types.js";

/**
 * Main-process-only metadata behind an opaque attachment token. `ownerId` is
 * the current composer/runtime that may consume or release the token; it is
 * never a filesystem authority.
 */
export interface AttachmentSelectionRecord {
  /** Unique renderer generation; revoked generations are never reused. */
  ownerId: string;
  /** Stable draft, saved-session, or runtime lifecycle identity. */
  sessionId: string;
  filePath?: string;
  kind: AttachmentDraft["kind"];
  mimeType?: string;
  imageDataBase64?: string;
  size?: number;
}

export interface AttachmentSelectionStoreOptions {
  maxSelections: number;
  /** Bytes retained by the store's base64 strings, not decoded image size. */
  maxRetainedBytes: number;
  ttlMs: number;
  now?: () => number;
}

export interface AttachmentSelectionStoreStats {
  selectionCount: number;
  retainedBytes: number;
}

interface StoredSelection {
  record: AttachmentSelectionRecord;
  retainedBytes: number;
  expiresAtMs: number;
}

export interface AttachmentSelectionEntry {
  token: string;
  record: AttachmentSelectionRecord;
}

/**
 * Bounded, expiring main-process authority for renderer-selected attachments.
 * Image payloads stay here only until delivery, explicit release, owner
 * teardown, or expiry. File references use a count slot but retain no payload
 * bytes.
 */
export class AttachmentSelectionStore {
  private readonly selections = new Map<string, StoredSelection>();
  private readonly tokensByOwner = new Map<string, Set<string>>();
  private readonly tokensBySession = new Map<string, Set<string>>();
  // A releaseOwner call is a lifecycle tombstone, not merely a bulk delete:
  // it prevents a late IPC import from resurrecting a discarded runtime/draft.
  // It is itself bounded/expiring so stale renderer requests cannot turn the
  // tombstone list into another unbounded store.
  private readonly revokedOwners = new Map<string, number>();
  private readonly maxRevokedOwners: number;
  private readonly now: () => number;
  private retainedBytes = 0;
  private expiryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: AttachmentSelectionStoreOptions) {
    if (
      !Number.isSafeInteger(options.maxSelections) ||
      options.maxSelections < 1 ||
      !Number.isSafeInteger(options.maxRetainedBytes) ||
      options.maxRetainedBytes < 0 ||
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs < 1
    ) {
      throw new Error(
        "Attachment selection store limits must be non-negative safe integers.",
      );
    }
    this.now = options.now ?? (() => Date.now());
    this.maxRevokedOwners = Math.max(100, options.maxSelections * 2);
  }

  add(token: string, record: AttachmentSelectionRecord): void {
    this.addMany([{ token, record }]);
  }

  /**
   * Check aggregate admission before doing expensive image decoding or file
   * work. It never retains an entry, and addMany repeats the check atomically
   * before mutating the store.
   */
  assertCanAddMany(entries: readonly AttachmentSelectionEntry[]): void {
    this.pruneExpired();
    this.assertAdmission(entries);
  }

  /** Validate aggregate limits before retaining any item in the batch. */
  addMany(entries: readonly AttachmentSelectionEntry[]): void {
    this.pruneExpired();
    this.assertAdmission(entries);
    if (entries.length === 0) {
      return;
    }

    const expiresAtMs = this.now() + this.options.ttlMs;
    for (const entry of entries) {
      this.remove(entry.token);
      const retainedBytes = retainedBytesForRecord(entry.record);
      const record = { ...entry.record };
      this.selections.set(entry.token, {
        record,
        retainedBytes,
        expiresAtMs,
      });
      this.addOwnerToken(record.ownerId, entry.token);
      this.addSessionToken(record.sessionId, entry.token);
      this.retainedBytes += retainedBytes;
    }
    this.scheduleExpirySweep();
  }

  get(token: string): AttachmentSelectionRecord | undefined {
    this.pruneExpired();
    const selection = this.selections.get(token);
    return selection ? { ...selection.record } : undefined;
  }

  /** Return a selection only to its owner generation and lifecycle session. */
  getOwned(
    token: string,
    ownerId: string,
    sessionId: string,
  ): AttachmentSelectionRecord | undefined {
    this.assertOwnerId(ownerId);
    this.assertSessionId(sessionId);
    const selection = this.get(token);
    return selection?.ownerId === ownerId && selection.sessionId === sessionId
      ? selection
      : undefined;
  }

  /** Consume only after successful RPC delivery. Failed delivery keeps tokens. */
  consumeOwned(ownerId: string, tokens: readonly string[]): number {
    return this.releaseOwned(ownerId, tokens);
  }

  /** Explicit chip removal/discard must not revoke a token rehomed elsewhere. */
  releaseOwned(ownerId: string, tokens: readonly string[]): number {
    this.assertOwnerId(ownerId);
    this.pruneExpired();
    let released = 0;
    for (const token of new Set(tokens)) {
      const selection = this.selections.get(token);
      if (selection?.record.ownerId !== ownerId) {
        continue;
      }
      this.remove(token);
      released += 1;
    }
    this.scheduleExpirySweep();
    return released;
  }

  /** Used only by trusted main-process cleanup paths. */
  release(tokens: readonly string[]): number {
    this.pruneExpired();
    let released = 0;
    for (const token of new Set(tokens)) {
      if (this.selections.has(token)) {
        this.remove(token);
        released += 1;
      }
    }
    this.scheduleExpirySweep();
    return released;
  }

  /** Transfer a complete token set atomically to a new owner generation/session. */
  assignOwner(
    tokens: readonly string[],
    previousOwnerId: string,
    previousSessionId: string,
    ownerId: string,
    sessionId: string,
  ): void {
    this.assertOwnerId(previousOwnerId);
    this.assertSessionId(previousSessionId);
    this.assertUsableOwnerId(ownerId);
    this.assertSessionId(sessionId);
    this.pruneExpired();
    const uniqueTokens = [...new Set(tokens)];
    const unavailable = uniqueTokens.some((token) => {
      const selection = this.selections.get(token);
      return (
        selection === undefined ||
        selection.record.ownerId !== previousOwnerId ||
        selection.record.sessionId !== previousSessionId
      );
    });
    if (unavailable) {
      throw new Error(
        "Attachment is no longer available in this composer; reselect it and retry.",
      );
    }

    if (previousOwnerId === ownerId && previousSessionId === sessionId) {
      return;
    }
    for (const token of uniqueTokens) {
      const selection = this.selections.get(token)!;
      this.removeOwnerToken(previousOwnerId, token);
      this.removeSessionToken(previousSessionId, token);
      selection.record.ownerId = ownerId;
      selection.record.sessionId = sessionId;
      this.addOwnerToken(ownerId, token);
      this.addSessionToken(sessionId, token);
    }
  }

  /** Release all pending selections when an owner generation is discarded. */
  releaseOwner(ownerId: string): number {
    // forgetChatRuntime can be reached by a stale renderer runtime id. Ignore
    // malformed internal cleanup input instead of retaining it as a tombstone.
    if (!this.isValidOwnerId(ownerId)) {
      return 0;
    }
    this.pruneExpired();
    this.revokeOwner(ownerId);
    const tokens = [...(this.tokensByOwner.get(ownerId) ?? [])];
    for (const token of tokens) {
      this.remove(token);
    }
    this.scheduleExpirySweep();
    return tokens.length;
  }

  /** Trusted teardown for every owner generation attached to one session. */
  releaseSession(sessionId: string): number {
    if (!this.isValidSessionId(sessionId)) {
      return 0;
    }
    this.pruneExpired();
    const tokens = [...(this.tokensBySession.get(sessionId) ?? [])];
    const ownerIds = new Set(
      tokens.flatMap((token) => {
        const ownerId = this.selections.get(token)?.record.ownerId;
        return ownerId === undefined ? [] : [ownerId];
      }),
    );
    for (const ownerId of ownerIds) {
      this.revokeOwner(ownerId);
    }
    for (const token of tokens) {
      this.remove(token);
    }
    this.scheduleExpirySweep();
    return tokens.length;
  }

  clear(): void {
    this.selections.clear();
    this.tokensByOwner.clear();
    this.tokensBySession.clear();
    this.revokedOwners.clear();
    this.retainedBytes = 0;
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
  }

  /** Exposed for focused tests and scheduled automatically in production. */
  pruneExpired(now = this.now()): void {
    for (const [token, selection] of this.selections) {
      if (selection.expiresAtMs <= now) {
        this.remove(token);
      }
    }
    for (const [ownerId, expiresAtMs] of this.revokedOwners) {
      if (expiresAtMs <= now) {
        this.revokedOwners.delete(ownerId);
      }
    }
    this.scheduleExpirySweep();
  }

  getStats(): AttachmentSelectionStoreStats {
    this.pruneExpired();
    return {
      selectionCount: this.selections.size,
      retainedBytes: this.retainedBytes,
    };
  }

  private assertAdmission(entries: readonly AttachmentSelectionEntry[]): void {
    if (entries.length === 0) {
      return;
    }

    const tokens = new Set<string>();
    let replacedBytes = 0;
    let replacedCount = 0;
    let addedBytes = 0;
    for (const entry of entries) {
      if (entry.token.trim().length === 0) {
        throw new Error("Attachment selection token must not be empty.");
      }
      this.assertUsableOwnerId(entry.record.ownerId);
      this.assertSessionId(entry.record.sessionId);
      if (tokens.has(entry.token)) {
        throw new Error(
          "Attachment selection batch contains a duplicate token.",
        );
      }
      tokens.add(entry.token);
      const existing = this.selections.get(entry.token);
      if (existing !== undefined) {
        replacedCount += 1;
        replacedBytes += existing.retainedBytes;
      }
      addedBytes += retainedBytesForRecord(entry.record);
    }

    const nextCount = this.selections.size - replacedCount + entries.length;
    const nextRetainedBytes = this.retainedBytes - replacedBytes + addedBytes;
    if (!Number.isSafeInteger(nextRetainedBytes)) {
      throw new Error("Pending attachment accounting exceeds safe limits.");
    }
    if (nextCount > this.options.maxSelections) {
      throw new Error(
        `Too many pending attachments. Release or send existing attachments before selecting more than ${this.options.maxSelections}.`,
      );
    }
    if (nextRetainedBytes > this.options.maxRetainedBytes) {
      throw new Error(
        "Pending image attachments exceed the main-process memory limit. Send, remove, or wait for existing attachments to expire before importing more images.",
      );
    }
  }

  private isValidOwnerId(ownerId: string): boolean {
    return ownerId.trim().length > 0 && ownerId.length <= 1_024;
  }

  private isValidSessionId(sessionId: string): boolean {
    return sessionId.trim().length > 0 && sessionId.length <= 1_024;
  }

  private assertOwnerId(ownerId: string): void {
    if (!this.isValidOwnerId(ownerId)) {
      throw new Error("Attachment selection owner is invalid.");
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!this.isValidSessionId(sessionId)) {
      throw new Error("Attachment selection session is invalid.");
    }
  }

  private assertUsableOwnerId(ownerId: string): void {
    this.assertOwnerId(ownerId);
    if (this.revokedOwners.has(ownerId)) {
      throw new Error(
        "Attachment owner is no longer active; reselect the attachment in the current session.",
      );
    }
  }

  private revokeOwner(ownerId: string): void {
    this.revokedOwners.delete(ownerId);
    this.revokedOwners.set(ownerId, this.now() + this.options.ttlMs);
    while (this.revokedOwners.size > this.maxRevokedOwners) {
      const oldestOwnerId = this.revokedOwners.keys().next().value;
      if (oldestOwnerId === undefined) {
        break;
      }
      this.revokedOwners.delete(oldestOwnerId);
    }
  }

  private addOwnerToken(ownerId: string, token: string): void {
    const tokens = this.tokensByOwner.get(ownerId) ?? new Set<string>();
    tokens.add(token);
    this.tokensByOwner.set(ownerId, tokens);
  }

  private removeOwnerToken(ownerId: string, token: string): void {
    const tokens = this.tokensByOwner.get(ownerId);
    if (tokens === undefined) {
      return;
    }
    tokens.delete(token);
    if (tokens.size === 0) {
      this.tokensByOwner.delete(ownerId);
    }
  }

  private addSessionToken(sessionId: string, token: string): void {
    const tokens = this.tokensBySession.get(sessionId) ?? new Set<string>();
    tokens.add(token);
    this.tokensBySession.set(sessionId, tokens);
  }

  private removeSessionToken(sessionId: string, token: string): void {
    const tokens = this.tokensBySession.get(sessionId);
    if (tokens === undefined) {
      return;
    }
    tokens.delete(token);
    if (tokens.size === 0) {
      this.tokensBySession.delete(sessionId);
    }
  }

  private remove(token: string): void {
    const existing = this.selections.get(token);
    if (existing === undefined) {
      return;
    }
    this.selections.delete(token);
    this.removeOwnerToken(existing.record.ownerId, token);
    this.removeSessionToken(existing.record.sessionId, token);
    this.retainedBytes -= existing.retainedBytes;
  }

  private scheduleExpirySweep(): void {
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    let nextExpiryMs: number | undefined;
    for (const selection of this.selections.values()) {
      nextExpiryMs =
        nextExpiryMs === undefined
          ? selection.expiresAtMs
          : Math.min(nextExpiryMs, selection.expiresAtMs);
    }
    for (const expiresAtMs of this.revokedOwners.values()) {
      nextExpiryMs =
        nextExpiryMs === undefined
          ? expiresAtMs
          : Math.min(nextExpiryMs, expiresAtMs);
    }
    if (nextExpiryMs === undefined) {
      return;
    }
    const delayMs = Math.max(
      0,
      Math.min(nextExpiryMs - this.now(), 2 ** 31 - 1),
    );
    const timer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.pruneExpired();
    }, delayMs);
    timer.unref?.();
    this.expiryTimer = timer;
  }
}

function retainedBytesForRecord(record: AttachmentSelectionRecord): number {
  return typeof record.imageDataBase64 === "string"
    ? Buffer.byteLength(record.imageDataBase64, "utf8")
    : 0;
}
