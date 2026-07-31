import { describe, expect, it, vi } from "vitest";
import type { AttachmentDraft, PiDeckApi } from "../shared/types.js";
import {
  getOrCreateAttachmentOwnerGeneration,
  mergeAttachmentDrafts,
  releaseAttachmentOwner,
  releaseAttachmentTokens,
  transferAttachmentOwnership,
} from "./attachmentLifecycle.js";

function attachment(overrides: Partial<AttachmentDraft> = {}): AttachmentDraft {
  return {
    id: "draft-a",
    selectedPathToken: "token-a",
    fileName: "image.png",
    displayPath: "image.png",
    mimeType: "image/png",
    size: 10,
    kind: "image",
    sendMode: "imageInput",
    outsideProject: false,
    status: "ready",
    ...overrides,
  };
}

describe("renderer attachment lifecycle", () => {
  it("uses a fresh unblocked generation when a stable session id reappears", () => {
    const owners = new Map<string, string>();
    const blocked = new Set(["saved-session"]);
    const first = getOrCreateAttachmentOwnerGeneration(
      owners,
      blocked,
      "saved-session",
      () => "owner-generation-1",
    );
    expect(first).toBe("owner-generation-1");
    expect(blocked.has("saved-session")).toBe(false);

    owners.delete("saved-session");
    blocked.add("saved-session");
    const second = getOrCreateAttachmentOwnerGeneration(
      owners,
      blocked,
      "saved-session",
      () => "owner-generation-2",
    );
    expect(second).toBe("owner-generation-2");
    expect(second).not.toBe(first);
    expect(blocked.has("saved-session")).toBe(false);
  });

  it("identifies imported duplicates so their main-process tokens can be revoked", () => {
    const existing = attachment();
    const duplicatePath = attachment({
      id: "draft-b",
      selectedPathToken: "token-b",
    });
    const duplicateToken = attachment({
      id: "draft-c",
      displayPath: "another.png",
    });
    const distinct = attachment({
      id: "draft-d",
      selectedPathToken: "token-d",
      fileName: "other.png",
      displayPath: "other.png",
    });

    const merged = mergeAttachmentDrafts(
      [existing],
      [duplicatePath, duplicateToken, distinct],
    );

    expect(merged.attachments).toEqual([existing, distinct]);
    expect(merged.discarded).toEqual([duplicatePath, duplicateToken]);
  });

  it("uses owner-scoped release for removed/discarded chips", async () => {
    const release = vi.fn().mockResolvedValue(undefined);

    await releaseAttachmentTokens(
      { release } as unknown as Pick<PiDeckApi["attachments"], "release">,
      "runtime-a",
      ["token-a", "token-a", "token-b"],
    );

    expect(release).toHaveBeenCalledWith({
      ownerId: "runtime-a",
      selectedPathTokens: ["token-a", "token-b"],
    });
  });

  it("transfers only ready selections and tears down discarded owners", async () => {
    const assignOwner = vi.fn().mockResolvedValue(undefined);
    const releaseOwner = vi.fn().mockResolvedValue(undefined);
    const ready = attachment();
    const missing = attachment({
      id: "missing",
      selectedPathToken: "missing-token",
      status: "missing",
    });

    await transferAttachmentOwnership(
      { assignOwner } as unknown as Pick<
        PiDeckApi["attachments"],
        "assignOwner"
      >,
      "draft-owner-generation",
      "draft-a",
      "runtime-owner-generation",
      "runtime-a",
      [ready, missing],
    );
    await releaseAttachmentOwner(
      { releaseOwner } as unknown as Pick<
        PiDeckApi["attachments"],
        "releaseOwner"
      >,
      "runtime-a",
    );

    expect(assignOwner).toHaveBeenCalledWith({
      previousOwnerId: "draft-owner-generation",
      previousSessionId: "draft-a",
      ownerId: "runtime-owner-generation",
      sessionId: "runtime-a",
      selectedPathTokens: ["token-a"],
    });
    expect(releaseOwner).toHaveBeenCalledWith({ ownerId: "runtime-a" });
  });
});
