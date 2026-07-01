import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it as test } from "vitest";
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
