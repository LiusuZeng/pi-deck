import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SavedAnswerService } from "./savedAnswerService.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-saved-answer-"),
  );
  roots.push(home);
  return { home, service: new SavedAnswerService(home) };
}

function saveInput(
  overrides: Partial<Parameters<SavedAnswerService["save"]>[0]> = {},
) {
  return {
    requestId: randomUUID(),
    workspaceId: randomUUID(),
    source: { kind: "normal-parent" as const, runtimeId: "parent-runtime" },
    title: "Useful answer",
    content: "# Exact answer\n\n<script>never execute</script>\n",
    ...overrides,
  };
}

describe("SavedAnswerService", () => {
  it("saves, lists, and reads exact text after a service restart", async () => {
    const { home, service } = await fixture();
    const input = saveInput();
    const saved = await service.save(input);

    const restarted = new SavedAnswerService(home);
    await expect(restarted.list(input.workspaceId)).resolves.toMatchObject({
      items: [{ outputId: saved.outputId, origin: "manual-save" }],
      warnings: [],
    });
    await expect(
      restarted.read(input.workspaceId, saved.outputId),
    ).resolves.toMatchObject({
      title: input.title,
      content: input.content,
    });
  });

  it("searches body text and preserves review state across immutable revisions", async () => {
    const { home, service } = await fixture();
    const workspaceId = randomUUID();
    const firstInput = saveInput({
      workspaceId,
      content: "A migration plan containing the distinctive phrase blue heron.",
    });
    const first = await service.save(firstInput);

    const otherWorkspaceId = randomUUID();
    const other = await service.save(
      saveInput({
        workspaceId: otherWorkspaceId,
        title: "A second plan",
        content: "Another blue heron result in a different workspace.",
      }),
    );
    await expect(
      service.list({ workspaceIds: [workspaceId], query: "BLUE heron" }),
    ).resolves.toMatchObject({ items: [{ outputId: first.outputId }] });
    const globalResults = await service.list({
      workspaceIds: [workspaceId, otherWorkspaceId],
      query: "blue heron",
    });
    expect(globalResults.items.map((item) => item.outputId).sort()).toEqual(
      [first.outputId, other.outputId].sort(),
    );
    const reviewed = await service.review({
      workspaceId,
      outputId: first.outputId,
      revisionId: first.revisionId,
      action: "changes-requested",
      note: "Add a rollback section.",
    });
    expect(reviewed.reviewState).toBe("changes-requested");

    const second = await service.save(
      saveInput({
        workspaceId,
        title: first.title,
        content: `${firstInput.content}\n\n## Rollback\nReverse each step.`,
        target: {
          outputId: first.outputId,
          expectedRevisionId: first.revisionId,
        },
      }),
    );
    expect(second.outputId).toBe(first.outputId);
    expect(second.displayNumber).toBe(2);
    expect(second.reviewState).toBe("unreviewed");

    const restarted = new SavedAnswerService(home);
    const current = await restarted.read(workspaceId, first.outputId);
    expect(current.revisionCount).toBe(2);
    expect(current.selectedDisplayNumber).toBe(2);
    expect(current.reviewState).toBe("unreviewed");
    const original = await restarted.read(
      workspaceId,
      first.outputId,
      first.revisionId,
    );
    expect(original.content).toBe(firstInput.content);
    expect(original.reviewState).toBe("changes-requested");
    expect(original.reviews).toContainEqual(
      expect.objectContaining({ note: "Add a rollback section." }),
    );

    await expect(
      service.save(
        saveInput({
          workspaceId,
          target: {
            outputId: first.outputId,
            expectedRevisionId: first.revisionId,
          },
        }),
      ),
    ).rejects.toThrow(/newer revision/i);
  });

  it("preserves concurrent review events across service instances", async () => {
    const { home, service } = await fixture();
    const input = saveInput();
    const saved = await service.save(input);
    const second = new SavedAnswerService(home);

    await Promise.all([
      service.review({
        workspaceId: input.workspaceId,
        outputId: saved.outputId,
        revisionId: saved.revisionId,
        action: "note",
        note: "First reviewer note",
      }),
      second.review({
        workspaceId: input.workspaceId,
        outputId: saved.outputId,
        revisionId: saved.revisionId,
        action: "note",
        note: "Second reviewer note",
      }),
    ]);

    const detail = await service.read(input.workspaceId, saved.outputId);
    expect(detail.reviews.map((event) => event.note).sort()).toEqual([
      "First reviewer note",
      "Second reviewer note",
    ]);
  });

  it("replays one request id without creating a duplicate output", async () => {
    const { service } = await fixture();
    const input = saveInput();
    const first = await service.save(input);
    const second = await service.save(input);

    expect(second).toEqual(first);
    await expect(service.list(input.workspaceId)).resolves.toMatchObject({
      items: [{ outputId: first.outputId }],
    });
  });

  it("keeps listing and reads scoped to the owning workspace", async () => {
    const { service } = await fixture();
    const input = saveInput();
    const saved = await service.save(input);
    const otherWorkspaceId = randomUUID();

    await expect(service.list(otherWorkspaceId)).resolves.toMatchObject({
      items: [],
    });
    await expect(
      service.read(otherWorkspaceId, saved.outputId),
    ).rejects.toThrow(/does not belong/);
  });

  it("blocks display, review, and reveal after coherent package mutation", async () => {
    const { home, service } = await fixture();
    const input = saveInput();
    const saved = await service.save(input);
    const contentPath = path.join(
      home,
      "saved-answers",
      "outputs",
      saved.outputId,
      "revisions",
      saved.revisionId,
      "files",
      "answer.md",
    );
    const changed = "changed";
    await fs.writeFile(contentPath, changed);
    const revisionPath = path.join(
      home,
      "saved-answers",
      "outputs",
      saved.outputId,
      "revisions",
      saved.revisionId,
      "revision.json",
    );
    const manifest = JSON.parse(await fs.readFile(revisionPath, "utf8")) as {
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    manifest.files[0] = {
      ...manifest.files[0]!,
      size: Buffer.byteLength(changed),
      sha256: createHash("sha256").update(changed).digest("hex"),
    };
    await fs.writeFile(revisionPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      service.read(input.workspaceId, saved.outputId),
    ).rejects.toThrow(/missing or damaged/);
    await expect(
      service.review({
        workspaceId: input.workspaceId,
        outputId: saved.outputId,
        revisionId: saved.revisionId,
        action: "accepted",
      }),
    ).rejects.toThrow(/damaged/i);
    await expect(
      service.reveal(input.workspaceId, saved.outputId),
    ).rejects.toThrow(/damaged/i);
    const listed = await service.list(input.workspaceId);
    expect(listed.items).toEqual([]);
    expect(listed.warnings).toHaveLength(1);
  });

  it("rejects a symlinked manual staging directory without writing outside the library", async () => {
    const { home, service } = await fixture();
    await service.initialize();
    const outside = path.join(home, "outside-staging");
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(home, "saved-answers", ".manual-inputs"),
    );

    await expect(service.save(saveInput())).rejects.toThrow(/not trusted/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("reports a previously initialized library as unavailable when its root disappears", async () => {
    const { home, service } = await fixture();
    await service.initialize();
    await fs.rm(path.join(home, "saved-answers"), {
      recursive: true,
      force: true,
    });

    await expect(new SavedAnswerService(home).initialize()).rejects.toThrow(
      /storage is missing/,
    );
  });
});
