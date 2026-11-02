import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  attemptSchema,
  type AttemptRecord,
  type OutputFileRecord,
  type OutputRecord,
  outputSchema,
  reviewRecordSchema,
  reviewsSchema,
  type ReviewRecord,
  type ReviewsRecord,
  type RevisionRecord,
  revisionSchema,
} from "./outputSchemas.js";

export interface OutputSource {
  kind: "normal-parent" | "parallel-parent";
  runtimeId: string;
}

export interface CreateOutputAttemptInput {
  workspaceId: string;
  source: OutputSource;
  target?: { outputId: string; expectedRevisionId: string };
  /** Stable operation identity used to make a user retry idempotent. */
  attemptId?: string;
}

export interface PublishFileInput {
  sourcePath: string;
  relativePath: string;
}

export interface PublishAttemptInput {
  attemptId: string;
  title: string;
  primaryFile: string;
  files: readonly PublishFileInput[];
  origin?: "agent" | "manual-save" | "import";
}

export interface CurrentOutputDescriptor {
  output: OutputRecord;
  revision: RevisionRecord;
}

export interface OutputRevisionDescriptor {
  revision: RevisionRecord;
  integrity: "available" | "damaged";
}

export interface PublicationReceipt {
  outputId: string;
  revisionId: string;
  displayNumber: number;
}

const MAX_FILES = 100;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;

/** Test-only fault-injection seam for filesystem commit-boundary fixtures. */
export interface OutputLibraryStoreHooks {
  afterCommitBeforeReceipt?: () => Promise<void> | void;
}

/**
 * Slice-0 durable publication boundary. This deliberately has no IPC or model
 * surface: callers must have already authorized a parent-bound attempt.
 *
 * A revision directory is immutable once made visible. For a new output the
 * complete package is renamed into place. For later revisions, a durable
 * revision is installed before atomically advancing output.json; recovery can
 * therefore discard an unreferenced prepared revision but never exposes it as
 * current. The durable attempt receipt makes acknowledgement replay idempotent.
 */
export class OutputLibraryStore {
  private queue = Promise.resolve();

  public constructor(
    private readonly root: string,
    private readonly now = () => Date.now(),
    private readonly hooks: OutputLibraryStoreHooks = {},
  ) {}

  public async createAttempt(
    input: CreateOutputAttemptInput,
  ): Promise<AttemptRecord> {
    return this.serial(async () => {
      await this.requireRoot();
      const attemptId = input.attemptId ?? randomUUID();
      // Parse the caller-provided operation id before using it in a pathname.
      attemptSchema.shape.attemptId.parse(attemptId);
      return this.withPublicationLock(`attempt-${attemptId}`, async () => {
        const existing = await this.readAttempt(attemptId).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (existing !== undefined) {
          const targetMatches = input.target
            ? existing.target.kind === "revision" &&
              existing.target.outputId === input.target.outputId &&
              existing.target.expectedRevisionId ===
                input.target.expectedRevisionId
            : existing.target.kind === "new";
          if (
            existing.workspaceId !== input.workspaceId ||
            existing.source.kind !== input.source.kind ||
            existing.source.runtimeId !== input.source.runtimeId ||
            !targetMatches
          ) {
            throw new Error("Output attempt identity is already in use.");
          }
          return existing;
        }
        const attempt: AttemptRecord = {
          schemaVersion: 1,
          attemptId,
          workspaceId: input.workspaceId,
          source: input.source,
          target: input.target
            ? { kind: "revision", ...input.target }
            : { kind: "new", outputId: randomUUID() },
          state: "preparing",
          createdAtMs: this.now(),
        };
        attemptSchema.parse(attempt);
        await fs.mkdir(this.attemptDir(attempt.attemptId), {
          recursive: true,
          mode: PRIVATE_DIRECTORY_MODE,
        });
        await this.writeJsonAtomic(
          this.attemptPath(attempt.attemptId),
          attempt,
        );
        return attempt;
      });
    });
  }

  public async publish(
    input: PublishAttemptInput,
  ): Promise<PublicationReceipt> {
    return this.serial(async () => {
      await this.requireRoot();
      const attempt = await this.readAttempt(input.attemptId);
      if (attempt.state === "saved" && attempt.receipt) return attempt.receipt;
      if (attempt.state !== "preparing") {
        throw new Error(`Output attempt is ${attempt.state}.`);
      }
      this.assertFiles(input.files, input.primaryFile);
      const stagedFiles = path.join(
        this.attemptDir(attempt.attemptId),
        "files",
      );
      await fs.rm(stagedFiles, { recursive: true, force: true });
      await fs.mkdir(stagedFiles, { recursive: true });
      const inventory = await this.copyAndInventory(input.files, stagedFiles);
      const revisionTarget =
        attempt.target.kind === "revision" ? attempt.target : undefined;
      // Staging is deliberately outside the publication lock. The lock covers
      // the expected-head read through pointer advancement across all store
      // instances that share this library root.
      return this.withPublicationLock(attempt.target.outputId, async () => {
        await this.requireRoot();
        const existing = revisionTarget
          ? await this.readOutput(revisionTarget.outputId)
          : undefined;
        if (
          existing &&
          revisionTarget !== undefined &&
          (existing.workspaceId !== attempt.workspaceId ||
            existing.currentRevisionId !== revisionTarget.expectedRevisionId)
        ) {
          await this.writeAttempt({ ...attempt, state: "conflict" });
          throw new Error(
            "A newer revision exists; staged candidate was retained.",
          );
        }
        const revisionId = randomUUID();
        const displayNumber = existing ? existing.currentDisplayNumber + 1 : 1;
        const revision: RevisionRecord = {
          schemaVersion: 1,
          outputId: attempt.target.outputId,
          revisionId,
          displayNumber,
          createdAtMs: this.now(),
          primaryFile: input.primaryFile,
          files: inventory,
          origin: input.origin ?? "agent",
          publicationAttemptId: attempt.attemptId,
        };
        revisionSchema.parse(revision);
        const receipt: PublicationReceipt = {
          outputId: revision.outputId,
          revisionId,
          displayNumber,
        };
        if (!existing)
          await this.commitNew(attempt, input.title, revision, stagedFiles);
        else
          await this.commitRevision(attempt, existing, revision, stagedFiles);
        await this.hooks.afterCommitBeforeReceipt?.();
        await this.writeAttempt({ ...attempt, state: "saved", receipt });
        return receipt;
      });
    });
  }

  /** Replays a committed receipt after a crash between package commit and acknowledgement. */
  public async recoverAttempt(
    attemptId: string,
  ): Promise<PublicationReceipt | undefined> {
    return this.serial(async () => {
      await this.requireRoot();
      const attempt = await this.readAttempt(attemptId);
      if (attempt.receipt) return attempt.receipt;
      const output = await this.readOutput(attempt.target.outputId).catch(
        () => undefined,
      );
      if (!output) return undefined;
      const revisions = await this.revisionsFor(output.outputId);
      const revision = revisions.find(
        (item) => item.publicationAttemptId === attempt.attemptId,
      );
      if (!revision) return undefined;
      if (output.currentRevisionId !== revision.revisionId) {
        // A crash can install the immutable revision immediately before the
        // pointer write. Reconcile only when the durable expected head still
        // matches; otherwise it is a retained conflict candidate.
        const target = attempt.target;
        if (target.kind !== "revision") return undefined;
        await this.withPublicationLock(output.outputId, async () => {
          const current = await this.readOutput(output.outputId);
          if (
            current.workspaceId !== attempt.workspaceId ||
            current.currentRevisionId !== target.expectedRevisionId ||
            !(await this.verifyRevisionUnlocked(revision))
          )
            return;
          await this.writeJsonAtomic(this.outputPath(output.outputId), {
            ...current,
            updatedAtMs: revision.createdAtMs,
            currentRevisionId: revision.revisionId,
            currentDisplayNumber: revision.displayNumber,
          });
        });
        const reconciled = await this.readOutput(output.outputId);
        if (reconciled.currentRevisionId !== revision.revisionId)
          return undefined;
      }
      const receipt = {
        outputId: output.outputId,
        revisionId: revision.revisionId,
        displayNumber: revision.displayNumber,
      };
      await this.writeAttempt({ ...attempt, state: "saved", receipt });
      return receipt;
    });
  }

  public async verifyRevision(
    outputId: string,
    revisionId: string,
  ): Promise<boolean> {
    return this.serial(async () =>
      this.verifyRevisionUnlocked(
        await this.readRevision(outputId, revisionId),
      ),
    );
  }

  public async describeCurrent(
    outputId: string,
    workspaceId: string,
  ): Promise<CurrentOutputDescriptor> {
    return this.serial(async () => {
      await this.requireRoot();
      const output = await this.readOutput(outputId);
      if (output.workspaceId !== workspaceId) {
        throw new Error("Saved answer does not belong to this workspace.");
      }
      const revision = await this.readRevision(
        output.outputId,
        output.currentRevisionId,
      );
      if (!(await this.verifyRevisionUnlocked(revision))) {
        throw new Error("Saved answer files are missing or damaged.");
      }
      return { output, revision };
    });
  }

  public async readCurrentPrimaryText(
    outputId: string,
    workspaceId: string,
    maxBytes: number,
  ): Promise<{ descriptor: CurrentOutputDescriptor; content: string }> {
    return this.readRevisionPrimaryText(
      outputId,
      workspaceId,
      undefined,
      maxBytes,
    );
  }

  public async readRevisionPrimaryText(
    outputId: string,
    workspaceId: string,
    revisionId: string | undefined,
    maxBytes: number,
  ): Promise<{ descriptor: CurrentOutputDescriptor; content: string }> {
    return this.serial(async () => {
      await this.requireRoot();
      const output = await this.readOutput(outputId);
      if (output.workspaceId !== workspaceId) {
        throw new Error("Output does not belong to this workspace.");
      }
      const revision = await this.readRevision(
        output.outputId,
        revisionId ?? output.currentRevisionId,
      );
      if (!(await this.verifyRevisionUnlocked(revision))) {
        throw new Error("Output files are missing or damaged.");
      }
      return {
        descriptor: { output, revision },
        content: await this.readPrimaryTextUnlocked(revision, maxBytes),
      };
    });
  }

  public async listRevisions(
    outputId: string,
    workspaceId: string,
  ): Promise<OutputRevisionDescriptor[]> {
    return this.serial(async () => {
      await this.requireRoot();
      const output = await this.readOutput(outputId);
      if (output.workspaceId !== workspaceId) {
        throw new Error("Output does not belong to this workspace.");
      }
      const revisions = await this.revisionsFor(outputId);
      const descriptors = await Promise.all(
        revisions.map(async (revision) => ({
          revision,
          integrity: (await this.verifyRevisionUnlocked(revision))
            ? ("available" as const)
            : ("damaged" as const),
        })),
      );
      return descriptors.sort(
        (a, b) => b.revision.displayNumber - a.revision.displayNumber,
      );
    });
  }

  public async getReviews(
    outputId: string,
    workspaceId: string,
  ): Promise<ReviewsRecord> {
    return this.serial(async () => {
      await this.requireRoot();
      const output = await this.readOutput(outputId);
      if (output.workspaceId !== workspaceId) {
        throw new Error("Output does not belong to this workspace.");
      }
      return this.readReviews(outputId);
    });
  }

  public async appendReview(
    outputId: string,
    workspaceId: string,
    event: ReviewRecord,
  ): Promise<ReviewsRecord> {
    return this.serial(async () => {
      await this.requireRoot();
      reviewRecordSchema.parse(event);
      return this.withPublicationLock(outputId, async () => {
        const current = await this.readOutput(outputId);
        if (current.workspaceId !== workspaceId) {
          throw new Error("Output does not belong to this workspace.");
        }
        const lockedRevision = await this.readRevision(
          outputId,
          event.revisionId,
        );
        if (!(await this.verifyRevisionUnlocked(lockedRevision))) {
          throw new Error("Damaged output revisions cannot be reviewed.");
        }
        const reviews = await this.readReviews(outputId);
        const next = reviewsSchema.parse({
          ...reviews,
          events: [...reviews.events, event],
        });
        await this.writeJsonAtomic(
          path.join(this.outputDir(outputId), "reviews.json"),
          next,
        );
        return next;
      });
    });
  }

  public async revealDirectory(
    outputId: string,
    workspaceId: string,
  ): Promise<string> {
    return this.serial(async () => {
      await this.requireRoot();
      const output = await this.readOutput(outputId);
      if (output.workspaceId !== workspaceId) {
        throw new Error("Output does not belong to this workspace.");
      }
      const revisions = await this.revisionsFor(outputId);
      if (
        revisions.length === 0 ||
        !(
          await Promise.all(
            revisions.map((revision) => this.verifyRevisionUnlocked(revision)),
          )
        ).every(Boolean)
      ) {
        throw new Error("Damaged output packages cannot be revealed.");
      }
      const directory = this.outputDir(outputId);
      await this.assertTrustedPath(directory);
      return directory;
    });
  }

  /** Rebuild input: it reads only package files and reports malformed packages without repairing them. */
  public async rebuild(): Promise<{
    outputs: OutputRecord[];
    errors: string[];
  }> {
    return this.serial(async () => {
      await this.requireRoot();
      const outputs: OutputRecord[] = [];
      const errors: string[] = [];
      for (const entry of await fs.readdir(this.outputsDir(), {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          const output = await this.readOutput(entry.name);
          const revision = await this.readRevision(
            output.outputId,
            output.currentRevisionId,
          );
          await this.readReviews(output.outputId);
          if (
            revision.displayNumber !== output.currentDisplayNumber ||
            !(await this.verifyRevisionUnlocked(revision))
          )
            throw new Error("Current revision is missing or damaged.");
          outputs.push(output);
        } catch (error) {
          errors.push(
            `${entry.name}: ${error instanceof Error ? error.message : "Invalid package."}`,
          );
        }
      }
      outputs.sort(
        (a, b) =>
          b.updatedAtMs - a.updatedAtMs || a.outputId.localeCompare(b.outputId),
      );
      return { outputs, errors };
    });
  }

  private async commitNew(
    attempt: AttemptRecord,
    title: string,
    revision: RevisionRecord,
    stagedFiles: string,
  ): Promise<void> {
    const packageDir = path.join(this.attemptDir(attempt.attemptId), "package");
    await fs.rm(packageDir, { recursive: true, force: true });
    await fs.mkdir(path.join(packageDir, "revisions", revision.revisionId), {
      recursive: true,
    });
    await fs.rename(
      stagedFiles,
      path.join(packageDir, "revisions", revision.revisionId, "files"),
    );
    const output: OutputRecord = {
      schemaVersion: 1,
      outputId: revision.outputId,
      workspaceId: attempt.workspaceId,
      title,
      createdAtMs: revision.createdAtMs,
      updatedAtMs: revision.createdAtMs,
      currentRevisionId: revision.revisionId,
      currentDisplayNumber: 1,
    };
    outputSchema.parse(output);
    await this.writeJsonAtomic(path.join(packageDir, "output.json"), output);
    await this.writeJsonAtomic(
      path.join(packageDir, "revisions", revision.revisionId, "revision.json"),
      revision,
    );
    await this.writeRevisionAnchor(revision);
    await this.writeJsonAtomic(path.join(packageDir, "reviews.json"), {
      schemaVersion: 1,
      outputId: revision.outputId,
      events: [],
    });
    await this.assertTrustedPath(this.outputsDir());
    await fs.rename(packageDir, this.outputDir(revision.outputId));
    await this.syncDirectory(this.outputsDir());
  }

  private async commitRevision(
    attempt: AttemptRecord,
    output: OutputRecord,
    revision: RevisionRecord,
    stagedFiles: string,
  ): Promise<void> {
    const stagedRevision = path.join(
      this.attemptDir(attempt.attemptId),
      "revision",
    );
    await fs.rm(stagedRevision, { recursive: true, force: true });
    await fs.mkdir(stagedRevision, { recursive: true });
    await fs.rename(stagedFiles, path.join(stagedRevision, "files"));
    await this.writeJsonAtomic(
      path.join(stagedRevision, "revision.json"),
      revision,
    );
    await this.writeRevisionAnchor(revision);
    await fs.rename(
      stagedRevision,
      this.revisionDir(output.outputId, revision.revisionId),
    );
    await this.syncDirectory(
      path.join(this.outputDir(output.outputId), "revisions"),
    );
    await this.writeJsonAtomic(this.outputPath(output.outputId), {
      ...output,
      updatedAtMs: revision.createdAtMs,
      currentRevisionId: revision.revisionId,
      currentDisplayNumber: revision.displayNumber,
    });
  }

  private assertFiles(
    files: readonly PublishFileInput[],
    primaryFile: string,
  ): void {
    if (
      !primaryFile ||
      !files.some((file) => file.relativePath === primaryFile)
    )
      throw new Error("Primary file must be declared.");
    if (files.length < 1 || files.length > MAX_FILES)
      throw new Error(`A revision must contain 1 to ${MAX_FILES} files.`);
    const names = new Set<string>();
    for (const file of files) {
      if (
        !isSafeRelativePath(file.relativePath) ||
        names.has(file.relativePath)
      )
        throw new Error("Invalid or duplicate output file path.");
      names.add(file.relativePath);
    }
  }

  private async copyAndInventory(
    files: readonly PublishFileInput[],
    destination: string,
  ): Promise<OutputFileRecord[]> {
    const result: OutputFileRecord[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const source = await fs.open(
        file.sourcePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let sourceSize: number;
      try {
        const stat = await source.stat();
        if (!stat.isFile())
          throw new Error("Only regular non-symlink files may be published.");
        sourceSize = stat.size;
        if (sourceSize > MAX_FILE_BYTES)
          throw new Error("Output file exceeds the 100 MiB publication limit.");
        if (totalBytes + sourceSize > MAX_TOTAL_BYTES)
          throw new Error(
            "Output revision exceeds the 250 MiB publication limit.",
          );
        const target = path.join(destination, file.relativePath);
        await this.ensurePrivateDirectory(path.dirname(target));
        const targetFile = await fs.open(
          target,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o600,
        );
        const hash = createHash("sha256");
        let copiedBytes = 0;
        try {
          const buffer = Buffer.allocUnsafe(64 * 1024);
          for (;;) {
            const { bytesRead } = await source.read(
              buffer,
              0,
              buffer.length,
              null,
            );
            if (bytesRead === 0) break;
            await targetFile.write(buffer, 0, bytesRead);
            hash.update(buffer.subarray(0, bytesRead));
            copiedBytes += bytesRead;
          }
          await targetFile.sync();
        } finally {
          await targetFile.close();
        }
        if (copiedBytes !== sourceSize)
          throw new Error("Source file changed while it was being staged.");
        const copied = await fs.lstat(target);
        if (
          !copied.isFile() ||
          copied.isSymbolicLink() ||
          copied.size !== sourceSize
        )
          throw new Error("Failed to copy a regular output file safely.");
        totalBytes += copied.size;
        result.push({
          path: file.relativePath,
          size: copied.size,
          sha256: hash.digest("hex"),
        });
      } finally {
        await source.close();
      }
    }
    await this.syncDirectoryTree(destination);
    return result;
  }

  private async requireRoot(): Promise<void> {
    const stat = await fs.lstat(this.root).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        "Output library root must be an existing non-symlink directory.",
      );
    // A root writable by another account is not a trusted private root: that
    // account could replace a checked path between filesystem calls. Node does
    // not expose portable openat traversal, so all managed descendants are
    // created private and revalidated before sensitive pathname operations.
    if ((stat.mode & 0o022) !== 0)
      throw new Error(
        "Output library root must not be writable by group or others.",
      );
    await this.ensurePrivateDirectory(this.outputsDir());
    await this.ensurePrivateDirectory(this.stagingDir());
    await this.ensurePrivateDirectory(this.locksDir());
    await this.ensurePrivateDirectory(this.integrityDir());
  }
  private async ensurePrivateDirectory(directory: string): Promise<void> {
    const relative = path.relative(this.root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Managed directory escapes the output library root.");
    let current = this.root;
    for (const part of relative ? relative.split(path.sep) : []) {
      current = path.join(current, part);
      await fs
        .mkdir(current, { mode: PRIVATE_DIRECTORY_MODE })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      await this.assertTrustedPath(current);
    }
  }
  private async assertTrustedPath(filePath: string): Promise<void> {
    const relative = path.relative(this.root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Managed path escapes the output library root.");
    let current = this.root;
    const rootStat = await fs.lstat(current);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (rootStat.mode & 0o022) !== 0
    ) {
      throw new Error("Output library root is no longer trusted.");
    }
    for (const part of relative ? relative.split(path.sep) : []) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new Error("Output library contains a symlink.");
      if (stat.isDirectory() && (stat.mode & 0o022) !== 0)
        throw new Error(
          "Output library directory is writable by group or others.",
        );
    }
  }
  private async readAttempt(id: string): Promise<AttemptRecord> {
    await this.assertTrustedPath(this.attemptPath(id));
    await this.requireRegularFile(this.attemptPath(id));
    return attemptSchema.parse(
      JSON.parse(await fs.readFile(this.attemptPath(id), "utf8")),
    );
  }
  private async writeAttempt(value: AttemptRecord): Promise<void> {
    attemptSchema.parse(value);
    await this.writeJsonAtomic(this.attemptPath(value.attemptId), value);
  }
  private async readOutput(id: string): Promise<OutputRecord> {
    await this.assertTrustedPath(this.outputPath(id));
    await this.requireRegularFile(this.outputPath(id));
    const output = outputSchema.parse(
      JSON.parse(await fs.readFile(this.outputPath(id), "utf8")),
    );
    if (output.outputId !== id) {
      throw new Error("Output metadata does not match its package directory.");
    }
    return output;
  }
  private async readRevision(
    outputId: string,
    revisionId: string,
  ): Promise<RevisionRecord> {
    const directory = this.revisionDir(outputId, revisionId);
    await this.assertTrustedPath(directory);
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Revision directory is not a regular directory.");
    }
    const manifest = path.join(directory, "revision.json");
    await this.requireRegularFile(manifest);
    const revision = revisionSchema.parse(
      JSON.parse(await fs.readFile(manifest, "utf8")),
    );
    if (revision.outputId !== outputId || revision.revisionId !== revisionId) {
      throw new Error(
        "Revision metadata does not match its package directory.",
      );
    }
    return revision;
  }
  private async readReviews(outputId: string): Promise<ReviewsRecord> {
    const reviewsPath = path.join(this.outputDir(outputId), "reviews.json");
    await this.assertTrustedPath(reviewsPath);
    await this.requireRegularFile(reviewsPath);
    const reviews = reviewsSchema.parse(
      JSON.parse(await fs.readFile(reviewsPath, "utf8")),
    );
    if (reviews.outputId !== outputId)
      throw new Error("Review metadata does not match its package directory.");
    return reviews;
  }
  private async revisionsFor(outputId: string): Promise<RevisionRecord[]> {
    const dir = path.join(this.outputDir(outputId), "revisions");
    await this.assertTrustedPath(dir);
    return Promise.all(
      (await fs.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => this.readRevision(outputId, entry.name)),
    );
  }
  private async readPrimaryTextUnlocked(
    revision: RevisionRecord,
    maxBytes: number,
  ): Promise<string> {
    const primary = revision.files.find(
      (file) => file.path === revision.primaryFile,
    );
    if (primary === undefined || primary.size > maxBytes) {
      throw new Error("Output is too large to display.");
    }
    const filePath = path.join(
      this.revisionDir(revision.outputId, revision.revisionId),
      "files",
      primary.path,
    );
    await this.assertTrustedPath(filePath);
    const handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== primary.size) {
        throw new Error("Output files are missing or damaged.");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        after.size !== before.size ||
        createHash("sha256").update(bytes).digest("hex") !== primary.sha256
      ) {
        throw new Error("Output files are missing or damaged.");
      }
      return bytes.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  private async verifyRevisionUnlocked(
    revision: RevisionRecord,
  ): Promise<boolean> {
    const anchor = await this.readRevisionAnchor(
      revision.outputId,
      revision.revisionId,
    );
    const manifestHash = createHash("sha256")
      .update(this.serializedRevision(revision))
      .digest("hex");
    if (anchor !== manifestHash) return false;
    const filesDirectory = path.join(
      this.revisionDir(revision.outputId, revision.revisionId),
      "files",
    );
    const actualPaths = await this.listRegularFiles(filesDirectory).catch(
      () => undefined,
    );
    const expectedPaths = revision.files.map((file) => file.path).sort();
    if (
      actualPaths === undefined ||
      actualPaths.length !== expectedPaths.length ||
      actualPaths.some((file, index) => file !== expectedPaths[index])
    )
      return false;
    for (const file of revision.files) {
      const candidate = path.join(
        this.revisionDir(revision.outputId, revision.revisionId),
        "files",
        file.path,
      );
      await this.assertTrustedPath(candidate);
      const stat = await fs.lstat(candidate).catch(() => undefined);
      if (
        !stat?.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== file.size ||
        (await sha256File(candidate)) !== file.sha256
      )
        return false;
    }
    return true;
  }
  private async listRegularFiles(
    directory: string,
    prefix = "",
  ): Promise<string[]> {
    await this.assertTrustedPath(directory);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Output files directory is not a regular directory.");
    }
    const result: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const candidate = path.join(directory, entry.name);
      await this.assertTrustedPath(candidate);
      const entryStat = await fs.lstat(candidate);
      if (entryStat.isSymbolicLink()) {
        throw new Error("Output package contains a symlink.");
      }
      if (entryStat.isDirectory()) {
        result.push(...(await this.listRegularFiles(candidate, relativePath)));
      } else if (entryStat.isFile()) {
        result.push(relativePath);
      } else {
        throw new Error("Output package contains a non-regular file.");
      }
    }
    return result.sort();
  }
  private async requireRegularFile(filePath: string): Promise<void> {
    await this.assertTrustedPath(filePath);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Expected a regular non-symlink metadata file.");
    }
  }
  private serializedRevision(revision: RevisionRecord): string {
    return `${JSON.stringify(revision, null, 2)}\n`;
  }

  private async writeRevisionAnchor(revision: RevisionRecord): Promise<void> {
    await this.writeJsonAtomic(
      this.revisionAnchorPath(revision.outputId, revision.revisionId),
      {
        schemaVersion: 1,
        sha256: createHash("sha256")
          .update(this.serializedRevision(revision))
          .digest("hex"),
      },
    );
  }

  private async readRevisionAnchor(
    outputId: string,
    revisionId: string,
  ): Promise<string | undefined> {
    const anchorPath = this.revisionAnchorPath(outputId, revisionId);
    try {
      await this.assertTrustedPath(anchorPath);
      await this.requireRegularFile(anchorPath);
      const handle = await fs.open(
        anchorPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let raw: string;
      try {
        raw = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(",") !== "schemaVersion,sha256" ||
        value.schemaVersion !== 1 ||
        typeof value.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.sha256)
      ) {
        return undefined;
      }
      return value.sha256;
    } catch {
      return undefined;
    }
  }

  private async writeJsonAtomic(
    filePath: string,
    value: unknown,
  ): Promise<void> {
    const temp = `${filePath}.${randomUUID()}.tmp`;
    await this.ensurePrivateDirectory(path.dirname(filePath));
    await this.assertTrustedPath(path.dirname(filePath));
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.assertTrustedPath(path.dirname(filePath));
    await fs.rename(temp, filePath);
    await this.syncDirectory(path.dirname(filePath));
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectoryTree(directory: string): Promise<void> {
    const directories: string[] = [];
    const visit = async (current: string): Promise<void> => {
      directories.push(current);
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          await visit(path.join(current, entry.name));
        }
      }
    };
    await visit(directory);
    for (const current of directories.reverse()) {
      await this.syncDirectory(current);
    }
  }
  private outputDir(id: string): string {
    return path.join(this.outputsDir(), id);
  }
  private outputPath(id: string): string {
    return path.join(this.outputDir(id), "output.json");
  }
  private revisionDir(outputId: string, revisionId: string): string {
    return path.join(this.outputDir(outputId), "revisions", revisionId);
  }
  private attemptDir(id: string): string {
    return path.join(this.stagingDir(), id);
  }
  private attemptPath(id: string): string {
    return path.join(this.attemptDir(id), "attempt.json");
  }
  private outputsDir(): string {
    return path.join(this.root, "outputs");
  }
  private stagingDir(): string {
    return path.join(this.root, ".staging");
  }
  private locksDir(): string {
    return path.join(this.root, ".locks");
  }
  private integrityDir(): string {
    return path.join(this.root, ".integrity");
  }
  private revisionAnchorPath(outputId: string, revisionId: string): string {
    return path.join(this.integrityDir(), outputId, `${revisionId}.json`);
  }
  private async withPublicationLock<T>(
    outputId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lock = path.join(this.locksDir(), `${outputId}.lock`);
    const token = randomUUID();
    for (;;) {
      await this.requireRoot();
      try {
        await fs.mkdir(lock, { mode: PRIVATE_DIRECTORY_MODE });
        await fs.writeFile(
          path.join(lock, "owner"),
          `${process.pid}:${token}`,
          { mode: 0o600, flag: "wx" },
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Locks are process-wide and survive a crash only until their owner is
        // known dead. This avoids a permanent publication outage after restart.
        const owner = await fs
          .readFile(path.join(lock, "owner"), "utf8")
          .catch(() => "");
        // Another process may have created the directory but not yet written
        // its owner marker. Never steal that in-progress acquisition.
        if (!owner) {
          // A process killed between mkdir and owner creation leaves no PID.
          // Only reclaim a sufficiently old incomplete acquisition, avoiding a
          // race with the normal tiny owner-file write.
          let age: number;
          try {
            age = Date.now() - (await fs.stat(lock)).mtimeMs;
          } catch (error) {
            // A releasing owner can remove the lock after mkdir reported it.
            // Restart acquisition so the operation rechecks the current head.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (age > 30_000) await fs.rm(lock, { recursive: true, force: true });
          else await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        const pid = Number(owner.split(":")[0]);
        let alive = Number.isInteger(pid) && pid > 0;
        if (alive) {
          try {
            process.kill(pid, 0);
          } catch {
            alive = false;
          }
        }
        if (!alive) await fs.rm(lock, { recursive: true, force: true });
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      const owner = await fs
        .readFile(path.join(lock, "owner"), "utf8")
        .catch(() => "");
      if (owner === `${process.pid}:${token}`)
        await fs.rm(lock, { recursive: true, force: true });
    }
  }
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
async function sha256File(filePath: string): Promise<string> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
