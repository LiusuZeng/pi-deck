import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it as test } from "vitest";
import { scanSessionRepository } from "./sessionRepository.js";

test("session repository scans project jsonl sessions without following other projects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-sessions-"));
  const project = path.join(root, "project");
  const otherProject = path.join(root, "other");
  const sessionDir = path.join(root, "sessions", "--project--");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(otherProject, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });

  await fs.writeFile(
    path.join(sessionDir, "one.jsonl"),
    [
      JSON.stringify({
        type: "session",
        id: "session-one",
        timestamp: "2026-06-29T10:00:00.000Z",
        cwd: project,
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-29T10:01:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Resume this important session" }],
        },
      }),
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(sessionDir, "other.jsonl"),
    `${JSON.stringify({ type: "session", id: "other", cwd: otherProject })}\n`,
  );

  const result = await scanSessionRepository({
    sessionDir,
    projectCwd: project,
  });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.sessionId, "session-one");
  assert.equal(result.sessions[0]?.title, "Resume this important session");
  assert.equal(result.sessions[0]?.messageCount, 1);
});

describe("messy session repository scanning", () => {
  test("skips symlinks, malformed files, other projects, and too-deep folders", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-messy-sessions-"),
    );
    const project = path.join(root, "project");
    const otherProject = path.join(root, "other");
    const sessionDir = path.join(root, "sessions");
    const nestedDir = path.join(sessionDir, "nested");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(otherProject, { recursive: true });
    await fs.mkdir(nestedDir, { recursive: true });

    await fs.writeFile(
      path.join(sessionDir, "valid.jsonl"),
      [
        JSON.stringify({
          type: "session",
          id: "valid-session",
          timestamp: "2026-06-29T10:00:00.000Z",
          cwd: project,
        }),
        "not-json",
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-29T10:02:00.000Z",
          message: { role: "user", content: "Keep this one" },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(sessionDir, "other-project.jsonl"),
      `${JSON.stringify({ type: "session", id: "other", cwd: otherProject })}\n`,
    );
    await fs.writeFile(path.join(sessionDir, "invalid.jsonl"), "{ nope\n");
    await fs.writeFile(
      path.join(nestedDir, "too-deep.jsonl"),
      `${JSON.stringify({ type: "session", id: "deep", cwd: project })}\n`,
    );
    await fs.symlink(
      path.join(sessionDir, "valid.jsonl"),
      path.join(sessionDir, "linked.jsonl"),
    );

    const result = await scanSessionRepository({
      sessionDir,
      projectCwd: project,
      maxDepth: 0,
      maxFiles: 100,
      maxBytesPerFile: 1024,
    });

    assert.deepEqual(
      result.sessions.map((session) => session.sessionId),
      ["valid-session"],
    );
    assert.equal(result.sessions[0]?.title, "Keep this one");
    assert.ok(
      result.diagnostics.some((diagnostic) =>
        diagnostic.includes("max scan depth"),
      ),
    );
  });

  test("reports when the file scan cap is reached", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-capped-sessions-"),
    );
    const project = path.join(root, "project");
    const sessionDir = path.join(root, "sessions");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    for (let index = 0; index < 2; index += 1) {
      await fs.writeFile(
        path.join(sessionDir, `session-${index}.jsonl`),
        `${JSON.stringify({ type: "session", id: `session-${index}`, cwd: project })}\n`,
      );
    }

    const result = await scanSessionRepository({
      sessionDir,
      projectCwd: project,
      maxFiles: 1,
    });

    assert.equal(result.sessions.length, 1);
    assert.ok(
      result.diagnostics.some((diagnostic) =>
        diagnostic.includes("Stopped session scan"),
      ),
    );
  });

  test("reports partial results when the total byte cap is reached", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-byte-capped-sessions-"),
    );
    const project = path.join(root, "project");
    const sessionDir = path.join(root, "sessions");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    await fs.writeFile(
      path.join(sessionDir, "a.jsonl"),
      `${JSON.stringify({ type: "session", id: "a", cwd: project })}\n`,
    );
    await fs.writeFile(
      path.join(sessionDir, "b.jsonl"),
      `${JSON.stringify({ type: "session", id: "b", cwd: project })}\n`,
    );

    const result = await scanSessionRepository({
      sessionDir,
      projectCwd: project,
      maxFiles: 100,
      maxBytesPerFile: 1024,
      maxTotalBytes: 1,
    });

    assert.ok(result.sessions.length <= 1);
    assert.ok(
      result.diagnostics.some((diagnostic) =>
        diagnostic.includes("Stopped session scan after reading 1 bytes"),
      ),
    );
  });

  test("reports when the wall-time scan cap is reached", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-time-capped-sessions-"),
    );
    const project = path.join(root, "project");
    const sessionDir = path.join(root, "sessions");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.jsonl"),
      `${JSON.stringify({ type: "session", id: "session", cwd: project })}\n`,
    );

    const result = await scanSessionRepository({
      sessionDir,
      projectCwd: project,
      maxWallTimeMs: -1,
    });

    assert.equal(result.sessions.length, 0);
    assert.ok(
      result.diagnostics.some((diagnostic) =>
        diagnostic.includes("wall-time limit"),
      ),
    );
  });
});
