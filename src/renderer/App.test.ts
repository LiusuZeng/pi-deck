import { describe, expect, it } from "vitest";
import { emptyOverlays } from "./sessionState.js";
import { __rendererTestHooks } from "./App.js";

function baseSession() {
  return {
    id: "session-1",
    title: "Session",
    project: "Project",
    projectPath: "/tmp/project",
    subtitle: "Idle",
    status: "idle",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline: [],
    baseState: "idle",
    overlays: emptyOverlays,
    runtimeBacked: true,
    backendMode: "real",
  } as const;
}

describe("renderer attachment actions", () => {
  it("deduplicates dropped and picked attachments by displayed file identity", () => {
    const existing = [
      {
        id: "draft-1",
        selectedPathToken: "token-1",
        fileName: "notes.txt",
        displayPath: "/project/notes.txt",
        kind: "textFile",
        sendMode: "pathReference",
        outsideProject: false,
        status: "ready",
        size: 12,
      },
    ];
    const incoming = [
      { ...existing[0], id: "draft-2", selectedPathToken: "token-2" },
      {
        ...existing[0],
        id: "draft-3",
        selectedPathToken: "token-3",
        fileName: "other.txt",
        displayPath: "/project/other.txt",
      },
    ];

    expect(
      __rendererTestHooks.mergeAttachmentDrafts(
        existing as any,
        incoming as any,
      ),
    ).toHaveLength(2);
  });
});

describe("renderer resume recovery", () => {
  it("recognizes missing saved session files as refreshable rows", () => {
    expect(
      __rendererTestHooks.isMissingSessionFileError(
        "Session file is missing or unreadable: /tmp/deleted.jsonl",
      ),
    ).toBe(true);
    expect(
      __rendererTestHooks.isMissingSessionFileError(
        "Session belongs to a different project.",
      ),
    ).toBe(false);
  });
});

describe("renderer project API compatibility", () => {
  it("falls back when running with an older preload without projects.list", async () => {
    const fallbackProject = {
      id: "/tmp/project",
      path: "/tmp/project",
      canonicalPath: "/tmp/project",
      displayName: "project",
      lastOpenedAt: 1,
    };

    const result = await __rendererTestHooks.listProjectsIfAvailable(
      { projects: { pickProject: async () => ({ selected: false }) } } as any,
      fallbackProject,
    );

    expect(result.activeProject).toEqual(fallbackProject);
    expect(result.projects[0]).toMatchObject({ id: "/tmp/project" });
  });

  it("falls back when running with an older preload without projects.select", async () => {
    const project = {
      id: "/tmp/project",
      path: "/tmp/project",
      canonicalPath: "/tmp/project",
      displayName: "project",
      lastOpenedAt: 1,
    };

    const result = await __rendererTestHooks.selectProjectIfAvailable(
      { projects: { pickProject: async () => ({ selected: false }) } } as any,
      project,
    );

    expect(result.activeProject).toEqual(project);
    expect(result.activeProjectId).toBe(project.id);
  });
});

describe("renderer session actions", () => {
  it("keeps a saved session deletable after it is resumed", () => {
    expect(
      __rendererTestHooks.isSessionDeletable(
        {
          ...baseSession(),
          sessionFile: "/Users/example/.pi/agent/sessions/session.jsonl",
          runtimeBacked: true,
          resumeBacked: false,
        } as any,
        true,
      ),
    ).toBe(true);
  });

  it("keeps an inactive saved session deletable before resume", () => {
    expect(
      __rendererTestHooks.isSessionDeletable(
        {
          ...baseSession(),
          id: "saved-1",
          sessionFile: "/Users/example/.pi/agent/sessions/session.jsonl",
          runtimeBacked: false,
          resumeBacked: true,
        } as any,
        true,
      ),
    ).toBe(true);
  });
});

describe("renderer message_update reduction", () => {
  it("does not render toolcall JSON deltas as assistant text", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "message_update",
      message: {
        id: "assistant-1",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "pwd" },
          },
        ],
      },
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "}",
        partial: {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "pwd" },
        },
      },
    } as any);

    expect(next.timeline).toEqual([]);
  });

  it("renders tool execution events so active tool work does not look stuck", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "tool_execution_start",
      runtimeId: "session-1",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "npm test" },
    } as any);

    expect(next.status).toBe("working");
    expect(next.overlays.toolRunning).toBe(true);
    expect(next.timeline).toMatchObject([
      {
        id: "tool-1",
        kind: "tool",
        title: "bash",
        status: "running",
        summary: "npm test",
      },
    ]);
  });

  it("reduces queue, compaction, and retry events into sidebar overlays", () => {
    const queued = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "queue_update",
      runtimeId: "session-1",
      steeringCount: 1,
      followUpCount: 2,
    } as any);
    expect(queued.overlays).toMatchObject({
      piQueuedSteeringCount: 1,
      piQueuedFollowUpCount: 2,
    });

    const compacting = __rendererTestHooks.reduceRuntimeEvent(queued, {
      type: "compaction_start",
      runtimeId: "session-1",
    } as any);
    expect(compacting.overlays.compacting).toBe(true);

    const retrying = __rendererTestHooks.reduceRuntimeEvent(compacting, {
      type: "auto_retry_start",
      runtimeId: "session-1",
    } as any);
    expect(retrying.overlays.retrying).toBe(true);
  });

  it("marks extension UI dialog events as waiting for input", () => {
    const waiting = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "extension_ui_request",
      runtimeId: "session-1",
      requestId: "ext-1",
      method: "confirm",
      params: { title: "Confirm", message: "Approve?" },
    } as any);

    expect(waiting.status).toBe("waiting");
    expect(waiting.baseState).toBe("waitingForInput");
    expect(waiting.overlays.needsUserInput).toBe(true);
    expect(waiting.timeline).toMatchObject([
      {
        kind: "diagnostic",
        content: "Extension UI request (Confirm): Approve?",
      },
    ]);
  });

  it("still appends text deltas from assistantMessageEvent", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "message_update",
      message: {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Hello",
        partial: { type: "text", text: "Hello" },
      },
    } as any);

    expect(next.timeline).toMatchObject([
      { id: "assistant-1", kind: "assistant", content: "Hello" },
    ]);
  });

  it("surfaces asynchronous message update errors instead of returning to idle", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "message_update",
      runtimeId: "session-1",
      messageId: "assistant-1",
      role: "assistant",
      content: "Usage limit reached",
      done: true,
      error: "Usage limit reached",
    } as any);

    expect(next.status).toBe("error");
    expect(next.baseState).toBe("error");
    expect(next.overlays.streaming).toBe(false);
    expect(next.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "diagnostic",
          content: "Usage limit reached",
        }),
      ]),
    );
  });

  it("surfaces agent_end errors instead of swallowing provider failures", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "working",
        baseState: "working",
        overlays: { ...emptyOverlays, streaming: true },
      } as any,
      {
        type: "agent_end",
        runtimeId: "session-1",
        status: "error",
        error: "Usage limit reached",
      } as any,
    );

    expect(next.status).toBe("error");
    expect(next.baseState).toBe("error");
    expect(next.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "diagnostic",
          content: "Usage limit reached",
        }),
      ]),
    );
  });

  it("merges refreshed Pi usage without replacing streamed timeline", () => {
    const current = {
      ...baseSession(),
      timeline: [
        { id: "user-1", kind: "user", content: "hello", createdAt: "now" },
      ],
    } as any;
    const refreshed = {
      ...baseSession(),
      usageStats: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
      },
      timeline: [],
    } as any;

    const next = __rendererTestHooks.mergeSessionUsageFromSnapshot(
      current,
      refreshed,
    );

    expect(next.timeline).toEqual(current.timeline);
    expect(next.usageStats).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("does not render persisted empty assistant messages as waiting forever", () => {
    const session = __rendererTestHooks.sessionFromSnapshot({
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { cwd: "/tmp/project" },
      messages: [
        {
          id: "assistant-empty",
          role: "assistant",
          content: "",
        },
      ],
    } as any);

    expect(session.timeline).toEqual([]);
  });

  it("clears empty assistant placeholders when an agent turn ends", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "working",
        baseState: "working",
        timeline: [
          {
            id: "assistant-empty",
            kind: "assistant",
            content: "",
            createdAt: "now",
            streaming: true,
          },
        ],
      } as any,
      { type: "agent_end", runtimeId: "session-1" } as any,
    );

    expect(next.timeline).toEqual([]);
  });

  it("restores image previews from resumed user messages", () => {
    const session = __rendererTestHooks.sessionFromSnapshot({
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { cwd: "/tmp/project" },
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "What is this?",
          imageAttachments: [
            {
              id: "image-1",
              fileName: "screenshot.png",
              mimeType: "image/png",
              dataBase64: "abc123",
            },
          ],
        },
      ],
    } as any);

    expect(session.timeline).toMatchObject([
      {
        id: "user-1",
        kind: "user",
        attachments: [
          {
            fileName: "screenshot.png",
            previewDataUrl: "data:image/png;base64,abc123",
          },
        ],
      },
    ]);
  });

  it("summarizes Pi message usage and model context window", () => {
    const session = __rendererTestHooks.sessionFromSnapshot({
      runtimeId: "runtime-1",
      backendMode: "real",
      state: {
        cwd: "/tmp/project",
        model: { id: "model-1", provider: "test", contextWindow: 200000 },
      },
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Done",
          usage: {
            input: 1200,
            output: 300,
            cacheRead: 40,
            cacheWrite: 10,
            cost: { total: 0.0123 },
          },
        },
      ],
    } as any);

    expect(session.usageStats).toMatchObject({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      contextUsedTokens: 1250,
      contextWindowTokens: 200000,
      totalCostUsd: 0.0123,
    });
  });
});
