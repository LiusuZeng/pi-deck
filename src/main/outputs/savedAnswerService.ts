import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CurrentOutputDescriptor,
  OutputSource,
} from "./outputLibraryStore.js";
import { OutputLibraryStore } from "./outputLibraryStore.js";

export const MAX_SAVED_ANSWER_BYTES = 2 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;

export type OutputReviewState = "unreviewed" | "changes-requested" | "accepted";

export interface SavedAnswerRevisionSummary {
  revisionId: string;
  displayNumber: number;
  createdAtMs: number;
  size: number;
  integrity: "available" | "damaged";
  reviewState: OutputReviewState;
}

export interface SavedAnswerReviewEvent {
  revisionId: string;
  createdAtMs: number;
  action: "note" | "changes-requested" | "accepted" | "reopened";
  note?: string | undefined;
}

export interface SavedAnswerSummary {
  outputId: string;
  revisionId: string;
  workspaceId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  displayNumber: number;
  revisionCount: number;
  reviewState: OutputReviewState;
  size: number;
  origin: "manual-save";
}

export interface SavedAnswerDetail extends SavedAnswerSummary {
  content: string;
  selectedRevisionId: string;
  selectedDisplayNumber: number;
  revisions: SavedAnswerRevisionSummary[];
  reviews: SavedAnswerReviewEvent[];
}

export interface SaveAnswerInput {
  requestId: string;
  workspaceId: string;
  source: OutputSource;
  title: string;
  content: string;
  target?: { outputId: string; expectedRevisionId: string };
}

/**
 * Customer-facing boundary for the deliberately narrow Saved answers slice.
 * It accepts text already authorized from a visible parent assistant message;
 * arbitrary renderer paths never cross this API.
 */
export class SavedAnswerService {
  readonly root: string;
  private readonly markerPath: string;
  private readonly store: OutputLibraryStore;
  private initialization: Promise<void> | undefined;

  public constructor(private readonly piDeckHome: string) {
    this.root = path.join(piDeckHome, "saved-answers");
    this.markerPath = path.join(piDeckHome, ".saved-answers-initialized-v1");
    this.store = new OutputLibraryStore(this.root);
  }

  public initialize(): Promise<void> {
    this.initialization ??= this.initializeOnce().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  public async save(input: SaveAnswerInput): Promise<SavedAnswerSummary> {
    await this.initialize();
    const title = input.title.trim();
    if (title.length < 1 || title.length > 240) {
      throw new Error("Saved answer title must contain 1 to 240 characters.");
    }
    const contentBytes = Buffer.byteLength(input.content, "utf8");
    if (contentBytes < 1 || contentBytes > MAX_SAVED_ANSWER_BYTES) {
      throw new Error("Saved answers must contain 1 byte to 2 MiB of text.");
    }

    const sourceDirectory = await this.requireManualInputDirectory();
    const attempt = await this.store.createAttempt({
      attemptId: input.requestId,
      workspaceId: input.workspaceId,
      source: input.source,
      ...(input.target === undefined ? {} : { target: input.target }),
    });
    const sourcePath = path.join(sourceDirectory, `${attempt.attemptId}.md`);
    const recovered = await this.store.recoverAttempt(attempt.attemptId);
    if (recovered !== undefined) {
      await fs.rm(sourcePath, { force: true });
      return this.summaryWithMetadata(
        await this.store.describeCurrent(recovered.outputId, input.workspaceId),
      );
    }

    await this.writeIdempotentSource(sourcePath, input.content);
    try {
      const receipt = await this.store.publish({
        attemptId: attempt.attemptId,
        title,
        primaryFile: "answer.md",
        files: [{ sourcePath, relativePath: "answer.md" }],
        origin: "manual-save",
      });
      return this.summaryWithMetadata(
        await this.store.describeCurrent(receipt.outputId, input.workspaceId),
      );
    } finally {
      await this.requireManualInputDirectory();
      await fs.rm(sourcePath, { force: true });
      await this.syncDirectory(sourceDirectory);
    }
  }

  public async list(
    scope: string | { workspaceIds: readonly string[]; query?: string },
  ): Promise<{ items: SavedAnswerSummary[]; warnings: string[] }> {
    await this.initialize();
    const workspaceIds = new Set(
      typeof scope === "string" ? [scope] : scope.workspaceIds,
    );
    const terms =
      typeof scope === "string"
        ? []
        : (scope.query ?? "")
            .trim()
            .toLocaleLowerCase()
            .split(/\s+/u)
            .filter(Boolean);
    const rebuilt = await this.store.rebuild();
    const warnings = [...rebuilt.errors];
    const items: SavedAnswerSummary[] = [];
    for (const output of rebuilt.outputs) {
      if (!workspaceIds.has(output.workspaceId)) continue;
      try {
        const { descriptor, content } = await this.store.readCurrentPrimaryText(
          output.outputId,
          output.workspaceId,
          MAX_SAVED_ANSWER_BYTES,
        );
        if (descriptor.revision.origin !== "manual-save") continue;
        const searchable = `${output.title}\n${content}`.toLocaleLowerCase();
        if (!terms.every((term) => searchable.includes(term))) continue;
        items.push(await this.summaryWithMetadata(descriptor));
      } catch (error) {
        warnings.push(
          `${output.outputId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    items.sort(
      (a, b) =>
        b.updatedAtMs - a.updatedAtMs || a.outputId.localeCompare(b.outputId),
    );
    return { items, warnings };
  }

  public async read(
    workspaceId: string,
    outputId: string,
    revisionId?: string,
  ): Promise<SavedAnswerDetail> {
    await this.initialize();
    const { descriptor, content } = await this.store.readRevisionPrimaryText(
      outputId,
      workspaceId,
      revisionId,
      MAX_SAVED_ANSWER_BYTES,
    );
    if (descriptor.revision.origin !== "manual-save") {
      throw new Error("This output is not a manually saved answer.");
    }
    const [revisions, reviews] = await Promise.all([
      this.store.listRevisions(outputId, workspaceId),
      this.store.getReviews(outputId, workspaceId),
    ]);
    const summary = this.summary(descriptor, reviews.events, revisions.length);
    return {
      ...summary,
      content,
      selectedRevisionId: descriptor.revision.revisionId,
      selectedDisplayNumber: descriptor.revision.displayNumber,
      revisions: revisions.map(({ revision, integrity }) => ({
        revisionId: revision.revisionId,
        displayNumber: revision.displayNumber,
        createdAtMs: revision.createdAtMs,
        size:
          revision.files.find((file) => file.path === revision.primaryFile)
            ?.size ?? 0,
        integrity,
        reviewState: this.reviewState(reviews.events, revision.revisionId),
      })),
      reviews: reviews.events.map(({ actor: _actor, ...event }) => event),
    };
  }

  public async review(input: {
    workspaceId: string;
    outputId: string;
    revisionId: string;
    action: "note" | "changes-requested" | "accepted" | "reopened";
    note?: string | undefined;
  }): Promise<SavedAnswerDetail> {
    await this.initialize();
    const note = input.note?.trim();
    if (note !== undefined && note.length > 4_000) {
      throw new Error("Review feedback must be 4,000 characters or fewer.");
    }
    if (input.action === "changes-requested" && !note) {
      throw new Error("Describe the changes you want before requesting them.");
    }
    await this.store.appendReview(input.outputId, input.workspaceId, {
      revisionId: input.revisionId,
      createdAtMs: Date.now(),
      actor: "user",
      action: input.action,
      ...(note ? { note } : {}),
    });
    return this.read(input.workspaceId, input.outputId, input.revisionId);
  }

  public async reveal(workspaceId: string, outputId: string): Promise<string> {
    await this.initialize();
    return this.store.revealDirectory(outputId, workspaceId);
  }

  private async summaryWithMetadata(
    descriptor: CurrentOutputDescriptor,
  ): Promise<SavedAnswerSummary> {
    const [revisions, reviews] = await Promise.all([
      this.store.listRevisions(
        descriptor.output.outputId,
        descriptor.output.workspaceId,
      ),
      this.store.getReviews(
        descriptor.output.outputId,
        descriptor.output.workspaceId,
      ),
    ]);
    return this.summary(descriptor, reviews.events, revisions.length);
  }

  private summary(
    descriptor: CurrentOutputDescriptor,
    reviews: readonly SavedAnswerReviewEvent[],
    revisionCount: number,
  ): SavedAnswerSummary {
    const primary = descriptor.revision.files.find(
      (file) => file.path === descriptor.revision.primaryFile,
    );
    if (descriptor.revision.origin !== "manual-save" || primary === undefined) {
      throw new Error("Saved answer metadata is incomplete.");
    }
    return {
      outputId: descriptor.output.outputId,
      revisionId: descriptor.revision.revisionId,
      workspaceId: descriptor.output.workspaceId,
      title: descriptor.output.title,
      createdAtMs: descriptor.output.createdAtMs,
      updatedAtMs: descriptor.output.updatedAtMs,
      displayNumber: descriptor.revision.displayNumber,
      revisionCount,
      reviewState: this.reviewState(reviews, descriptor.revision.revisionId),
      size: primary.size,
      origin: "manual-save",
    };
  }

  private reviewState(
    reviews: readonly SavedAnswerReviewEvent[],
    revisionId: string,
  ): OutputReviewState {
    let state: OutputReviewState = "unreviewed";
    for (const event of reviews) {
      if (event.revisionId !== revisionId) continue;
      if (event.action === "accepted") state = "accepted";
      if (event.action === "changes-requested") state = "changes-requested";
      if (event.action === "reopened") state = "unreviewed";
    }
    return state;
  }

  private async initializeOnce(): Promise<void> {
    await fs.mkdir(this.piDeckHome, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    const [marker, root] = await Promise.all([
      fs.lstat(this.markerPath).catch(() => undefined),
      fs.lstat(this.root).catch(() => undefined),
    ]);
    if (marker !== undefined && (!marker.isFile() || marker.isSymbolicLink())) {
      throw new Error("Saved answers initialization marker is invalid.");
    }
    if (root === undefined) {
      if (marker !== undefined) {
        throw new Error(
          "Saved answers storage is missing. Restore it or remove the initialization marker to start a new empty library.",
        );
      }
      await fs.mkdir(this.root, { mode: PRIVATE_DIRECTORY_MODE });
      await this.syncDirectory(this.piDeckHome);
    } else if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("Saved answers storage is unavailable.");
    }
    // Trigger the store's root/private-directory validation before recording
    // first-use completion.
    await this.store.rebuild();
    if (marker === undefined) {
      const handle = await fs.open(this.markerPath, "wx", 0o600);
      try {
        await handle.writeFile("saved-answers-v1\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.syncDirectory(this.piDeckHome);
    }
  }

  private async requireManualInputDirectory(): Promise<string> {
    const root = await fs.lstat(this.root);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (root.mode & 0o022) !== 0
    ) {
      throw new Error("Saved answers storage is no longer trusted.");
    }
    const directory = path.join(this.root, ".manual-inputs");
    await fs
      .mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error("Saved answer staging directory is not trusted.");
    }
    return directory;
  }

  private async writeIdempotentSource(
    sourcePath: string,
    content: string,
  ): Promise<void> {
    await this.requireManualInputDirectory();
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(
        sourcePath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existingHandle = await fs.open(
        sourcePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const existing = await existingHandle.readFile("utf8");
        if (existing !== content) {
          throw new Error(
            "Saved answer request was replayed with different text.",
          );
        }
      } finally {
        await existingHandle.close();
      }
    } finally {
      await handle?.close();
    }
    await this.syncDirectory(path.dirname(sourcePath));
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export function newSavedAnswerRequestId(): string {
  return randomUUID();
}
