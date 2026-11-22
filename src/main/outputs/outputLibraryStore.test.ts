import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputLibraryStore } from "./outputLibraryStore.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-output-library-"),
  );
  temporaryRoots.push(root);
  const library = path.join(root, "library");
  const sources = path.join(root, "sources");
  await fs.mkdir(library);
  await fs.mkdir(sources);
  await fs.writeFile(path.join(sources, "report.md"), "durable report\n");
  await fs.writeFile(path.join(sources, "data.csv"), "name,value\na,1\n");
  return {
    root,
    library,
    sources,
    store: new OutputLibraryStore(library, () => 100),
  };
}

function source() {
  return { kind: "normal-parent" as const, runtimeId: "parent-runtime" };
}

describe("OutputLibraryStore Slice-0 publication protocol", () => {
  it("commits a complete multi-file package and replays the same receipt", async () => {
    const { store, sources, library } = await fixture();
    const attempt = await store.createAttempt({
      workspaceId: randomUUID(),
      source: source(),
    });
    const receipt = await store.publish({
      attemptId: attempt.attemptId,
      title: "Vendor report",
      primaryFile: "report.md",
      files: [
        {
          sourcePath: path.join(sources, "report.md"),
          relativePath: "report.md",
        },
        {
          sourcePath: path.join(sources, "data.csv"),
          relativePath: "data.csv",
        },
      ],
    });
    expect(
      await store.publish({
        attemptId: attempt.attemptId,
        title: "ignored replay",
        primaryFile: "report.md",
        files: [],
      }),
    ).toEqual(receipt);
    expect(
      await store.verifyRevision(receipt.outputId, receipt.revisionId),
    ).toBe(true);
    expect(
      await fs.readFile(
        path.join(
          library,
          "outputs",
          receipt.outputId,
          "revisions",
          receipt.revisionId,
          "files",
          "data.csv",
        ),
        "utf8",
      ),
    ).toContain("name,value");
  });

  it("recovers a committed receipt after a failure at the receipt boundary", async () => {
    const { store, sources, library } = await fixture();
    const attempt = await store.createAttempt({
      workspaceId: randomUUID(),
      source: source(),
    });
    const crashingStore = new OutputLibraryStore(library, () => 100, {
      afterCommitBeforeReceipt: () => {
        throw new Error("injected receipt failure");
      },
    });
    await expect(
      crashingStore.publish({
        attemptId: attempt.attemptId,
        title: "Report",
        primaryFile: "report.md",
        files: [
          {
            sourcePath: path.join(sources, "report.md"),
            relativePath: "report.md",
          },
        ],
      }),
    ).rejects.toThrow("injected receipt failure");
    expect(await store.recoverAttempt(attempt.attemptId)).toMatchObject({
      outputId: attempt.target.outputId,
      displayNumber: 1,
    });
  });

  it("fences concurrent revisions from independent store instances", async () => {
    const { store, sources, library } = await fixture();
    const first = await store.createAttempt({
      workspaceId: randomUUID(),
      source: source(),
    });
    const r1 = await store.publish({
      attemptId: first.attemptId,
      title: "Report",
      primaryFile: "report.md",
      files: [
        {
          sourcePath: path.join(sources, "report.md"),
          relativePath: "report.md",
        },
      ],
    });
    const a = await store.createAttempt({
      workspaceId: (await store.rebuild()).outputs[0].workspaceId,
      source: source(),
      target: { outputId: r1.outputId, expectedRevisionId: r1.revisionId },
    });
    const b = await store.createAttempt({
      workspaceId: (await store.rebuild()).outputs[0].workspaceId,
      source: source(),
      target: { outputId: r1.outputId, expectedRevisionId: r1.revisionId },
    });
    const otherStore = new OutputLibraryStore(library, () => 101);
    const results = await Promise.allSettled([
      store.publish({
        attemptId: a.attemptId,
        title: "Report",
        primaryFile: "report.md",
        files: [
          {
            sourcePath: path.join(sources, "report.md"),
            relativePath: "report.md",
          },
        ],
      }),
      otherStore.publish({
        attemptId: b.attemptId,
        title: "Report",
        primaryFile: "report.md",
        files: [
          {
            sourcePath: path.join(sources, "report.md"),
            relativePath: "report.md",
          },
        ],
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")[0].reason
        .message,
    ).toContain("newer revision");
    const rejectedAttempt = results[0]?.status === "rejected" ? a : b;
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(
            library,
            ".staging",
            rejectedAttempt.attemptId,
            "attempt.json",
          ),
          "utf8",
        ),
      ).state,
    ).toBe("conflict");
  });

  it("reacquires a lock that disappears before its age check", async () => {
    const { store, sources, library } = await fixture();
    const workspaceId = randomUUID();
    const initial = await store.createAttempt({
      workspaceId,
      source: source(),
    });
    const first = await store.publish({
      attemptId: initial.attemptId,
      title: "Report",
      primaryFile: "report.md",
      files: [
        {
          sourcePath: path.join(sources, "report.md"),
          relativePath: "report.md",
        },
      ],
    });
    const stale = await store.createAttempt({
      workspaceId,
      source: source(),
      target: {
        outputId: first.outputId,
        expectedRevisionId: first.revisionId,
      },
    });
    const current = await store.createAttempt({
      workspaceId,
      source: source(),
      target: {
        outputId: first.outputId,
        expectedRevisionId: first.revisionId,
      },
    });
    await store.publish({
      attemptId: current.attemptId,
      title: "Report",
      primaryFile: "report.md",
      files: [
        {
          sourcePath: path.join(sources, "report.md"),
          relativePath: "report.md",
        },
      ],
    });

    const lock = path.join(library, ".locks", `${first.outputId}.lock`);
    const ownerPath = path.join(lock, "owner");
    await fs.mkdir(lock);
    const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    let disappeared = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      if (file === ownerPath && !disappeared) {
        disappeared = true;
        await actualFs.rm(lock, { recursive: true, force: true });
        const error = new Error(
          "lock owner disappeared",
        ) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return await actualFs.readFile(file, options);
    });

    try {
      await expect(
        store.publish({
          attemptId: stale.attemptId,
          title: "Report",
          primaryFile: "report.md",
          files: [
            {
              sourcePath: path.join(sources, "report.md"),
              relativePath: "report.md",
            },
          ],
        }),
      ).rejects.toThrow("newer revision");
    } finally {
      vi.restoreAllMocks();
    }

    expect(disappeared).toBe(true);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(library, ".staging", stale.attemptId, "attempt.json"),
          "utf8",
        ),
      ).state,
    ).toBe("conflict");
  });

  it("creates an empty durable review log with each output", async () => {
    const { store, sources, library } = await fixture();
    const attempt = await store.createAttempt({
      workspaceId: randomUUID(),
      source: source(),
    });
    const receipt = await store.publish({
      attemptId: attempt.attemptId,
      title: "Report",
      primaryFile: "report.md",
      files: [
        {
          sourcePath: path.join(sources, "report.md"),
          relativePath: "report.md",
        },
      ],
    });
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(library, "outputs", receipt.outputId, "reviews.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ outputId: receipt.outputId, events: [] });
  });

  it("retains staging and refuses publication files over documented bounds", async () => {
    const { store, sources, library } = await fixture();
    const attempt = await store.createAttempt({
      workspaceId: randomUUID(),
      source: source(),
    });
    const oversized = path.join(sources, "large.bin");
    const largeFile = await fs.open(oversized, "w");
    await largeFile.truncate(100 * 1024 * 1024 + 1);
    await largeFile.close();
    await expect(
      store.publish({
        attemptId: attempt.attemptId,
        title: "Large",
        primaryFile: "large.bin",
        files: [{ sourcePath: oversized, relativePath: "large.bin" }],
      }),
    ).rejects.toThrow("100 MiB");
    await expect(
      fs.stat(path.join(library, ".staging", attempt.attemptId, "files")),
    ).resolves.toBeDefined();
  });

  it("rebuilds from package files and detects external mutation", async () => {
    const { store, sources, library } = await fixture();
    const attempt = await store.createAttempt({
      workspaceId: randomUUID(),
      source: source(),
    });
    const receipt = await store.publish({
      attemptId: attempt.attemptId,
      title: "Report",
      primaryFile: "report.md",
      files: [
        {
          sourcePath: path.join(sources, "report.md"),
          relativePath: "report.md",
        },
      ],
    });
    expect(
      (await store.rebuild()).outputs.map((item) => item.outputId),
    ).toEqual([receipt.outputId]);
    await fs.writeFile(
      path.join(
        library,
        "outputs",
        receipt.outputId,
        "revisions",
        receipt.revisionId,
        "files",
        "report.md",
      ),
      "changed",
    );
    expect(
      await store.verifyRevision(receipt.outputId, receipt.revisionId),
    ).toBe(false);
    expect((await store.rebuild()).errors).toHaveLength(1);
  });

  it("rejects an intermediate package symlink during verified reads", async () => {
    const { store, sources, library, root } = await fixture();
    const workspaceId = randomUUID();
    const attempt = await store.createAttempt({
      workspaceId,
      source: source(),
    });
    const receipt = await store.publish({
      attemptId: attempt.attemptId,
      title: "Report",
      primaryFile: "report.md",
      files: [
        {
          sourcePath: path.join(sources, "report.md"),
          relativePath: "report.md",
        },
      ],
    });
    const outputDir = path.join(library, "outputs", receipt.outputId);
    const revisionsDir = path.join(outputDir, "revisions");
    const escaped = path.join(root, "escaped-revisions");
    await fs.rename(revisionsDir, escaped);
    await fs.symlink(escaped, revisionsDir);

    await expect(
      store.readCurrentPrimaryText(receipt.outputId, workspaceId, 1024),
    ).rejects.toThrow(/symlink/);
    expect((await store.rebuild()).errors).toHaveLength(1);
  });

  it("rejects traversal, duplicate names, and symlink sources before publication", async () => {
    const { store, sources } = await fixture();
    const attempt = await store.createAttempt({
      workspaceId: randomUUID(),
      source: source(),
    });
    await expect(
      store.publish({
        attemptId: attempt.attemptId,
        title: "Unsafe",
        primaryFile: "../report.md",
        files: [
          {
            sourcePath: path.join(sources, "report.md"),
            relativePath: "../report.md",
          },
        ],
      }),
    ).rejects.toThrow("Invalid or duplicate");
    await expect(
      store.publish({
        attemptId: attempt.attemptId,
        title: "Unsafe",
        primaryFile: "report.md",
        files: [
          {
            sourcePath: path.join(sources, "report.md"),
            relativePath: "report.md",
          },
          {
            sourcePath: path.join(sources, "data.csv"),
            relativePath: "report.md",
          },
        ],
      }),
    ).rejects.toThrow("duplicate");
    const link = path.join(sources, "link.md");
    await fs.symlink(path.join(sources, "report.md"), link);
    await expect(
      store.publish({
        attemptId: attempt.attemptId,
        title: "Unsafe",
        primaryFile: "link.md",
        files: [{ sourcePath: link, relativePath: "link.md" }],
      }),
    ).rejects.toThrow(/ELOOP|non-symlink/);
  });
});
