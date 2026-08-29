import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it as test } from "vitest";
import {
  readPiSessionSummary,
  scanSessionRepository,
  validatePiSession,
  validatePiSessionFile,
} from "./sessionRepository.js";

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
  });
  assert.deepEqual(result.sessions.map((session) => session.sessionId).sort(), [
    "other",
    "session-one",
  ]);
  assert.equal(
    result.sessions.find((session) => session.sessionId === "session-one")?.cwd,
    await fs.realpath(project),
  );

  const filteredResult = await scanSessionRepository({
    sessionDir,
    projectCwd: project,
  });
  assert.equal(filteredResult.sessions.length, 1);
  assert.equal(filteredResult.sessions[0]?.sessionId, "session-one");
  assert.equal(
    filteredResult.sessions[0]?.title,
    "Resume this important session",
  );
  assert.equal(filteredResult.sessions[0]?.messageCount, 1);
});

test("refreshes one explicit session summary without scanning the repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-summary-"));
  const project = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "2026-08-03T03-48-31-582Z.jsonl");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "summary-session",
        timestamp: "2026-08-03T03:48:31.582Z",
        cwd: project,
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-03T03:48:32.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Use the prompt as the title" }],
        },
      }),
    ].join("\n"),
  );

  const result = await readPiSessionSummary({
    sessionFile,
    sessionDir,
  });

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary?.title, "Use the prompt as the title");
  assert.equal(result.summary?.messageCount, 1);
  assert.equal(result.summary?.sessionFile, await fs.realpath(sessionFile));

  // This is Pi's observed metadata record shape. Name selection is JSONL
  // append order, rather than timestamp order, because Pi may write updates
  // with timestamps that do not sort monotonically.
  await fs.appendFile(
    sessionFile,
    `\n${JSON.stringify({
      type: "session_info",
      timestamp: "2026-08-03T03:48:34.000Z",
      name: "  First\nname  ",
    })}`,
  );
  const named = await readPiSessionSummary({ sessionFile, sessionDir });
  assert.equal(named.summary?.title, "First name");

  await fs.appendFile(
    sessionFile,
    `\n${JSON.stringify({
      type: "session_info",
      timestamp: "2026-08-03T03:48:33.000Z",
      name: "Second name",
    })}`,
  );
  const latestByRecordOrder = await scanSessionRepository({ sessionDir });
  assert.equal(latestByRecordOrder.sessions[0]?.title, "Second name");

  await fs.appendFile(
    sessionFile,
    `\n${JSON.stringify({
      type: "session_info",
      timestamp: "2026-08-03T03:48:35.000Z",
      name: 42,
    })}`,
  );
  const malformedIgnored = await readPiSessionSummary({
    sessionFile,
    sessionDir,
  });
  assert.equal(malformedIgnored.summary?.title, "Second name");

  await fs.appendFile(
    sessionFile,
    `\n${JSON.stringify({
      type: "session_info",
      timestamp: "2026-08-03T03:48:36.000Z",
      name: " \t ",
    })}`,
  );
  const clearedName = await scanSessionRepository({ sessionDir });
  assert.equal(clearedName.sessions[0]?.title, "Use the prompt as the title");
  assert.equal(clearedName.sessions[0]?.messageCount, 1);
});

test("reconstructs Completed metadata from the latest durable assistant turn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-completed-"));
  const project = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "completed.jsonl");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  const completedAtMs = Date.parse("2026-08-03T03:49:00.000Z");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        id: "completed-session",
        timestamp: "2026-08-03T03:48:31.582Z",
        cwd: project,
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-03T03:48:32.000Z",
        message: { role: "user", content: "Durable completed prompt" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-03T03:49:01.000Z",
        message: {
          role: "assistant",
          content: "Durable completed answer",
          createdAt: completedAtMs,
        },
      }),
    ].join("\n"),
  );

  const completed = await readPiSessionSummary({ sessionFile, sessionDir });
  assert.equal(completed.summary?.completedAtMs, completedAtMs);
  assert.equal(completed.summary?.title, "Durable completed prompt");

  await fs.appendFile(
    sessionFile,
    `\n${JSON.stringify({
      type: "message",
      timestamp: "2026-08-03T03:50:00.000Z",
      message: { role: "user", content: "Unanswered follow-up" },
    })}`,
  );
  const unanswered = await readPiSessionSummary({ sessionFile, sessionDir });
  assert.equal(unanswered.summary?.completedAtMs, undefined);

  await fs.appendFile(
    sessionFile,
    `\n${JSON.stringify({
      type: "message",
      timestamp: "2026-08-03T03:51:00.000Z",
      message: {
        role: "assistant",
        content: "Provider failed",
        createdAt: Date.parse("2026-08-03T03:51:00.000Z"),
        stopReason: "error",
        errorMessage: "Usage limit reached",
      },
    })}`,
  );
  const failed = await readPiSessionSummary({ sessionFile, sessionDir });
  assert.equal(failed.summary?.completedAtMs, undefined);
});

test("discovers the latest completion timestamp beyond the capped head parse", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-deck-completed-tail-"),
  );
  const project = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "long-completed.jsonl");
  const latestCompletedAtMs = Date.parse("2026-08-03T04:10:00.000Z");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session", id: "long-completed", cwd: project }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-03T03:48:32.000Z",
        message: { role: "user", content: "Older prompt title" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-03T03:49:00.000Z",
        message: {
          role: "assistant",
          content: "Older answer",
          createdAt: Date.parse("2026-08-03T03:49:00.000Z"),
        },
      }),
      "not-json\n".repeat(40_000),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-03T04:09:00.000Z",
        message: { role: "user", content: "Latest prompt" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-03T04:10:01.000Z",
        message: {
          role: "assistant",
          content: "Latest durable answer",
          createdAt: latestCompletedAtMs,
        },
      }),
    ].join("\n"),
  );

  const result = await readPiSessionSummary({
    sessionFile,
    sessionDir,
    maxBytesPerFile: 256,
  });
  assert.equal(result.summary?.completedAtMs, latestCompletedAtMs);
});

test("bounds explicit summary metadata bytes and wall time", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-metadata-"));
  const project = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "bounded.jsonl");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session", id: "bounded", cwd: project }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Prompt" },
      }),
      "not-json".repeat(1_000),
      JSON.stringify({ type: "session_info", name: "Durable name" }),
    ].join("\n"),
  );

  const byteCapped = await readPiSessionSummary({
    sessionFile,
    sessionDir,
    maxBytesPerFile: 256,
    maxTotalBytes: 256,
  });
  assert.ok(
    byteCapped.diagnostics.some((diagnostic) =>
      diagnostic.includes(
        "Stopped session metadata scan after reading 0 bytes",
      ),
    ),
  );

  const deadlineCapped = await readPiSessionSummary({
    sessionFile,
    sessionDir,
    maxBytesPerFile: 256,
    maxTotalBytes: 512,
    maxWallTimeMs: 0,
  });
  assert.ok(
    deadlineCapped.diagnostics.some((diagnostic) =>
      diagnostic.includes("wall-time limit"),
    ),
  );
});

test("discovers the latest valid session name beyond capped head and tail windows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-metadata-"));
  const project = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "long.jsonl");
  const authoritativeName = "Authoritative name outside bounded windows";
  // Keep the metadata more than 256 KiB from both EOF and the header. The
  // trailing malformed value must not erase the earlier valid update.
  const padding = "not-json\n".repeat(40_000);
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        id: "long-session",
        timestamp: "2026-08-03T03:48:31.582Z",
        cwd: project,
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Capped prompt title" },
      }),
      padding,
      JSON.stringify({ type: "session_info", name: authoritativeName }),
      padding,
      JSON.stringify({ type: "session_info", name: null }),
    ].join("\n"),
  );

  const scanned = await scanSessionRepository({ sessionDir });
  const explicit = await readPiSessionSummary({ sessionFile, sessionDir });
  for (const summary of [scanned.sessions[0], explicit.summary]) {
    assert.equal(summary?.title, authoritativeName);
    assert.equal(summary?.messageCount, 1);
    assert.equal(summary?.sessionFile, await fs.realpath(sessionFile));
  }
});

test("uses a latest empty session name to clear an older name in a long file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-metadata-"));
  const project = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "cleared-long.jsonl");
  // Keep the older name outside normal bounded head/tail parsing windows.
  const padding = "not-json\n".repeat(40_000);
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session", id: "cleared-long", cwd: project }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Fallback prompt title" },
      }),
      padding,
      JSON.stringify({ type: "session_info", name: "Older durable name" }),
      padding,
      JSON.stringify({ type: "session_info", name: " \t " }),
    ].join("\n"),
  );

  const scanned = await scanSessionRepository({ sessionDir });
  const explicit = await readPiSessionSummary({ sessionFile, sessionDir });
  for (const summary of [scanned.sessions[0], explicit.summary]) {
    assert.equal(summary?.title, "Fallback prompt title");
    assert.equal(summary?.messageCount, 1);
  }
});

test("scans CRLF metadata across chunks and skips an oversized newline-free tail", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-metadata-"));
  const project = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "boundary.jsonl");
  const latestName = "Name split across reverse scan chunks";
  const metadata = JSON.stringify({ type: "session_info", name: latestName });
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  // Align the final reverse chunk boundary through the CRLF metadata record.
  const oversizedTailBytes =
    1024 * 1024 + 64 * 1024 - Math.floor(metadata.length / 2) - 2;
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session", id: "boundary", cwd: project }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Prompt title" },
      }),
      metadata,
      "z".repeat(oversizedTailBytes),
    ].join("\r\n"),
  );

  const result = await readPiSessionSummary({ sessionFile, sessionDir });
  assert.equal(result.summary?.title, latestName);
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.includes("Skipped oversized session metadata record"),
    ),
  );
});

test("counts reverse metadata reads against the repository byte budget", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-metadata-"));
  const project = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "metadata.jsonl"),
    [
      JSON.stringify({ type: "session", id: "metadata", cwd: project }),
      JSON.stringify({ type: "session_info", name: "Stored name" }),
    ].join("\n"),
  );

  const bytes = (await fs.stat(path.join(sessionDir, "metadata.jsonl"))).size;
  const result = await scanSessionRepository({
    sessionDir,
    maxBytesPerFile: 1024,
    maxTotalBytes: bytes * 2,
  });
  assert.equal(result.sessions[0]?.title, "Stored name");
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.includes(
        `Stopped session scan after reading ${bytes * 2} bytes`,
      ),
    ),
  );
});

describe("Pi session eligibility validation", () => {
  async function createSessionFixture(): Promise<{
    root: string;
    project: string;
    otherProject: string;
    sessionDir: string;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-delete-"));
    const project = path.join(root, "project");
    const otherProject = path.join(root, "other-project");
    const sessionDir = path.join(root, "sessions");
    await Promise.all(
      [project, otherProject, sessionDir].map((directory) =>
        fs.mkdir(directory, { recursive: true }),
      ),
    );
    return { root, project, otherProject, sessionDir };
  }

  function piHeader(cwd: string): string {
    return `${JSON.stringify({
      type: "session",
      version: 3,
      id: "saved-session",
      timestamp: "2026-06-29T10:00:00.000Z",
      cwd,
    })}\n`;
  }

  test("accepts a canonical Pi session for resume in the active repository", async () => {
    const { project, sessionDir } = await createSessionFixture();
    const sessionFile = path.join(sessionDir, "saved.jsonl");
    await fs.writeFile(sessionFile, piHeader(project));

    const result = await validatePiSession({
      sessionFile,
      sessionDir,
      projectCwd: project,
    });

    assert.deepEqual(result, {
      ok: true,
      sessionFile: await fs.realpath(sessionFile),
    });
  });

  test("validates a contained Pi session independently of its workspace cwd", async () => {
    const { project, otherProject, sessionDir } = await createSessionFixture();
    const sessionFile = path.join(sessionDir, "other-workspace.jsonl");
    const projectAlias = path.join(path.dirname(project), "project-alias");
    await fs.symlink(otherProject, projectAlias);
    await fs.writeFile(sessionFile, piHeader(projectAlias));

    const fileValidation = await validatePiSessionFile({
      sessionFile,
      sessionDir,
    });
    assert.deepEqual(fileValidation, {
      ok: true,
      sessionFile: await fs.realpath(sessionFile),
      cwd: await fs.realpath(otherProject),
    });

    const legacyValidation = await validatePiSession({
      sessionFile,
      sessionDir,
      projectCwd: project,
    });
    assert.deepEqual(legacyValidation, {
      ok: false,
      reason: "session belongs to a different project",
    });
  });

  test("rejects arbitrary paths outside the configured repository", async () => {
    const { project, sessionDir, root } = await createSessionFixture();
    const sessionFile = path.join(root, "not-a-session-dir.jsonl");
    await fs.writeFile(sessionFile, piHeader(project));

    const result = await validatePiSession({
      sessionFile,
      sessionDir,
      projectCwd: project,
    });

    assert.deepEqual(result, {
      ok: false,
      reason: "session file is outside the configured session directory",
    });
  });

  test("rejects project-store-like files with a forged or missing Pi session header", async () => {
    const { project, otherProject, sessionDir } = await createSessionFixture();
    const wrongProject = path.join(sessionDir, "wrong-project.jsonl");
    const malformed = path.join(sessionDir, "not-a-pi-session.jsonl");
    await fs.writeFile(wrongProject, piHeader(otherProject));
    await fs.writeFile(
      malformed,
      `${JSON.stringify({ cwd: project, id: "forged" })}\n`,
    );

    const [wrongProjectResult, malformedResult] = await Promise.all([
      validatePiSession({
        sessionFile: wrongProject,
        sessionDir,
        projectCwd: project,
      }),
      validatePiSession({
        sessionFile: malformed,
        sessionDir,
        projectCwd: project,
      }),
    ]);

    assert.deepEqual(wrongProjectResult, {
      ok: false,
      reason: "session belongs to a different project",
    });
    assert.deepEqual(malformedResult, {
      ok: false,
      reason: "session file does not have a valid Pi session header",
    });
  });

  test("rejects unavailable files and sessions with a malformed first line", async () => {
    const { project, sessionDir } = await createSessionFixture();
    const missing = path.join(sessionDir, "missing.jsonl");
    const malformedFirstLine = path.join(
      sessionDir,
      "malformed-first-line.jsonl",
    );
    await fs.writeFile(malformedFirstLine, `not-json\n${piHeader(project)}`);

    const [missingResult, malformedResult] = await Promise.all([
      validatePiSession({
        sessionFile: missing,
        sessionDir,
        projectCwd: project,
      }),
      validatePiSession({
        sessionFile: malformedFirstLine,
        sessionDir,
        projectCwd: project,
      }),
    ]);

    assert.deepEqual(missingResult, {
      ok: false,
      reason: "session file is missing or unreadable",
    });
    assert.deepEqual(malformedResult, {
      ok: false,
      reason: "session file does not have a valid Pi session header",
    });
  });

  test("rejects non-regular files and symlinks resolving outside the session directory", async () => {
    const { project, sessionDir, root } = await createSessionFixture();
    const directory = path.join(sessionDir, "directory.jsonl");
    const outsideFile = path.join(root, "outside.jsonl");
    const linkedFile = path.join(sessionDir, "linked.jsonl");
    await fs.mkdir(directory);
    await fs.writeFile(outsideFile, piHeader(project));
    await fs.symlink(outsideFile, linkedFile);

    const [directoryResult, linkedResult] = await Promise.all([
      validatePiSession({
        sessionFile: directory,
        sessionDir,
        projectCwd: project,
      }),
      validatePiSession({
        sessionFile: linkedFile,
        sessionDir,
        projectCwd: project,
      }),
    ]);

    assert.deepEqual(directoryResult, {
      ok: false,
      reason: "session path is not a regular file",
    });
    assert.deepEqual(linkedResult, {
      ok: false,
      reason: "session file is outside the configured session directory",
    });
  });

  test("rejects symlinks even when their target remains inside the session directory", async () => {
    const { project, sessionDir } = await createSessionFixture();
    const target = path.join(sessionDir, "target.jsonl");
    const linkedFile = path.join(sessionDir, "linked-inside.jsonl");
    await fs.writeFile(target, piHeader(project));
    await fs.symlink(target, linkedFile);

    const result = await validatePiSessionFile({
      sessionFile: linkedFile,
      sessionDir,
    });

    assert.deepEqual(result, {
      ok: false,
      reason: "session path must not be a symbolic link",
    });
  });
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
