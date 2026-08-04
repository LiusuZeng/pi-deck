import { describe, expect, it } from "vitest";
import { emptyOverlays } from "./sessionState.js";
import { __rendererTestHooks } from "./App.js";

function baseSession() {
  return {
    id: "session-1",
    workspaceId: "workspace-a",
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

function productionAssistantMessage(
  stopReason: "error" | "stop" | "aborted",
  errorMessage?: string,
) {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "fake-provider",
    model: "fake-model",
    responseId: "response-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 1,
  };
}

function runtimeErrorDiagnostics(session: any): any[] {
  return session.timeline.filter(
    (item: any) => item.kind === "diagnostic" && item.tone === "error",
  );
}

describe("renderer Pi 0.81 terminal and retry events", () => {
  it("keeps a production-shaped provider error visible after agent_end", () => {
    const errorMessage = "Provider quota exhausted.";
    const failedAssistant = productionAssistantMessage("error", errorMessage);
    const afterMessage = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "working",
        baseState: "working",
        overlays: { ...emptyOverlays, streaming: true },
      } as any,
      {
        type: "message_update",
        runtimeId: "session-1",
        message: failedAssistant,
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: failedAssistant,
        },
      } as any,
    );

    expect(afterMessage.status).toBe("error");
    expect(runtimeErrorDiagnostics(afterMessage)).toMatchObject([
      { content: errorMessage },
    ]);

    const afterEnd = __rendererTestHooks.reduceRuntimeEvent(afterMessage, {
      type: "agent_end",
      runtimeId: "session-1",
      messages: [failedAssistant],
      willRetry: false,
    } as any);

    expect(afterEnd.status).toBe("error");
    expect(afterEnd.baseState).toBe("error");
    expect(runtimeErrorDiagnostics(afterEnd)).toHaveLength(1);
    expect(runtimeErrorDiagnostics(afterEnd)[0]).toMatchObject({
      content: errorMessage,
    });
  });

  it("does not turn a production abort terminal event into a provider error", () => {
    const abortedAssistant = productionAssistantMessage(
      "aborted",
      "Request aborted by user.",
    );
    const afterMessage = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "working",
        baseState: "working",
        overlays: { ...emptyOverlays, streaming: true },
      } as any,
      {
        type: "message_update",
        runtimeId: "session-1",
        message: abortedAssistant,
        assistantMessageEvent: {
          type: "error",
          reason: "aborted",
          error: abortedAssistant,
        },
      } as any,
    );
    const afterEnd = __rendererTestHooks.reduceRuntimeEvent(afterMessage, {
      type: "agent_end",
      runtimeId: "session-1",
      messages: [abortedAssistant],
      willRetry: false,
    } as any);

    expect(afterEnd.status).toBe("idle");
    expect(runtimeErrorDiagnostics(afterEnd)).toEqual([]);
  });

  it("derives a terminal error from the final Pi agent_end message", () => {
    const errorMessage = "Pi returned a terminal provider error.";
    const failedAssistant = productionAssistantMessage("error", errorMessage);
    const afterEnd = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "working",
        baseState: "working",
        overlays: { ...emptyOverlays, streaming: true },
      } as any,
      {
        type: "agent_end",
        runtimeId: "session-1",
        messages: [failedAssistant],
        willRetry: false,
      } as any,
    );

    expect(afterEnd.status).toBe("error");
    expect(runtimeErrorDiagnostics(afterEnd)).toMatchObject([
      { content: errorMessage },
    ]);
  });

  it("keeps Pi retries busy until the eventual successful agent_end", () => {
    const firstFailure = productionAssistantMessage(
      "error",
      "Retryable provider failure.",
    );
    let session = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "working",
        baseState: "working",
        overlays: { ...emptyOverlays, streaming: true },
      } as any,
      {
        type: "agent_end",
        runtimeId: "session-1",
        messages: [firstFailure],
        willRetry: true,
      } as any,
    );

    expect(session.status).toBe("working");
    expect(session.overlays.retrying).toBe(true);
    expect(__rendererTestHooks.isSessionBusy(session)).toBe(true);

    session = __rendererTestHooks.reduceRuntimeEvent(session, {
      type: "auto_retry_start",
      runtimeId: "session-1",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 250,
      errorMessage: "Retryable provider failure.",
    } as any);
    expect(__rendererTestHooks.isSessionBusy(session)).toBe(true);

    session = __rendererTestHooks.reduceRuntimeEvent(session, {
      type: "auto_retry_end",
      runtimeId: "session-1",
      success: true,
      attempt: 1,
    } as any);
    expect(session.status).toBe("working");
    expect(session.overlays.retrying).toBe(false);
    expect(__rendererTestHooks.isSessionBusy(session)).toBe(true);

    session = __rendererTestHooks.reduceRuntimeEvent(session, {
      type: "agent_end",
      runtimeId: "session-1",
      messages: [productionAssistantMessage("stop")],
      willRetry: false,
    } as any);
    expect(session.status).toBe("idle");
    expect(__rendererTestHooks.isSessionBusy(session)).toBe(false);

    expect(
      __rendererTestHooks.isSessionBusy({
        ...baseSession(),
        overlays: { ...emptyOverlays, retrying: true },
      } as any),
    ).toBe(true);
  });

  it("surfaces auto_retry_end finalError without duplicate diagnostics", () => {
    const finalError = "Retry failed after 2 attempts: quota exhausted.";
    const failedAssistant = productionAssistantMessage("error", finalError);
    let session = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "working",
        baseState: "working",
        overlays: { ...emptyOverlays, streaming: true, retrying: true },
      } as any,
      {
        type: "agent_end",
        runtimeId: "session-1",
        messages: [failedAssistant],
        willRetry: false,
      } as any,
    );

    session = __rendererTestHooks.reduceRuntimeEvent(session, {
      type: "auto_retry_end",
      runtimeId: "session-1",
      success: false,
      attempt: 2,
      finalError,
    } as any);

    expect(session.status).toBe("error");
    expect(session.overlays.retrying).toBe(false);
    expect(runtimeErrorDiagnostics(session)).toHaveLength(1);
    expect(runtimeErrorDiagnostics(session)[0]).toMatchObject({
      content: finalError,
    });
  });

  it("treats Pi 0.81 retry cancellation after a user abort as a normal terminal event", () => {
    const retryableFailure = productionAssistantMessage(
      "error",
      "Retryable provider failure.",
    );
    let session = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "working",
        baseState: "working",
        overlays: { ...emptyOverlays, streaming: true },
      } as any,
      {
        type: "agent_end",
        runtimeId: "session-1",
        messages: [retryableFailure],
        willRetry: true,
      } as any,
    );
    session = __rendererTestHooks.reduceRuntimeEvent(session, {
      type: "auto_retry_start",
      runtimeId: "session-1",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1_000,
      errorMessage: "Retryable provider failure.",
    } as any);

    // This is the state set synchronously by the Abort control before Pi's
    // AgentSession.abort() cancels the backoff sleep.
    session = { ...session, status: "aborting", baseState: "working" };
    session = __rendererTestHooks.reduceRuntimeEvent(session, {
      type: "auto_retry_end",
      runtimeId: "session-1",
      success: false,
      attempt: 1,
      finalError: "Retry cancelled",
    } as any);

    expect(session.status).toBe("idle");
    expect(session.baseState).toBe("idle");
    expect(session.overlays.retrying).toBe(false);
    expect(__rendererTestHooks.isSessionBusy(session)).toBe(false);
    expect(session.lastError).toBeUndefined();
    expect(runtimeErrorDiagnostics(session)).toEqual([]);
  });

  it("does not treat a prior local error state as a provider terminal failure", () => {
    const localError = "Attachment picker failed locally.";
    const afterEnd = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "error",
        baseState: "error",
        lastError: localError,
        timeline: [
          {
            id: "local-error",
            kind: "diagnostic",
            tone: "error",
            content: localError,
            createdAt: "Now",
          },
        ],
      } as any,
      {
        type: "agent_end",
        runtimeId: "session-1",
        messages: [productionAssistantMessage("stop")],
        willRetry: false,
      } as any,
    );

    expect(afterEnd.status).toBe("idle");
    expect(afterEnd.baseState).toBe("idle");
    expect(afterEnd.lastError).toBeUndefined();
    expect(runtimeErrorDiagnostics(afterEnd)).toEqual([
      expect.objectContaining({ content: localError }),
    ]);
  });
});

describe("renderer per-session composer drafts", () => {
  it("cycles slash picker selection and honors Home and End", () => {
    const { nextSlashCommandIndex } = __rendererTestHooks;

    expect(nextSlashCommandIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextSlashCommandIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextSlashCommandIndex("Home", 2, 3)).toBe(0);
    expect(nextSlashCommandIndex("End", 0, 3)).toBe(2);
    expect(nextSlashCommandIndex("ArrowDown", 0, 0)).toBeUndefined();
  });

  it("restores text, attachments, and slash state after switching sessions", () => {
    const attachment = {
      id: "attachment-a",
      selectedPathToken: "token-a",
      fileName: "notes.txt",
      displayPath: "/project/notes.txt",
      kind: "textFile",
      sendMode: "pathReference",
      outsideProject: false,
      status: "ready",
    } as const;
    let drafts = {};
    drafts = __rendererTestHooks.updateComposerDraft(
      drafts,
      "session-a",
      () => ({
        text: "/review this",
        attachments: [attachment],
        slashOpen: true,
      }),
    );
    drafts = __rendererTestHooks.updateComposerDraft(
      drafts,
      "session-b",
      () => ({ text: "Different session", attachments: [], slashOpen: false }),
    );

    expect(
      __rendererTestHooks.composerDraftForSession(drafts, "session-a"),
    ).toEqual({
      text: "/review this",
      attachments: [attachment],
      slashOpen: true,
    });
    expect(
      __rendererTestHooks.composerDraftForSession(drafts, "session-b"),
    ).toEqual({ text: "Different session", attachments: [], slashOpen: false });
    expect(__rendererTestHooks.hasComposerDraft(drafts, "session-a")).toBe(
      true,
    );
  });

  it("keeps the hidden new-session landing draft until its worker gets an id", () => {
    const drafts = __rendererTestHooks.updateComposerDraft(
      {},
      "new-session",
      () => ({ text: "Start here", attachments: [], slashOpen: false }),
    );
    const moved = __rendererTestHooks.moveComposerDraft(
      drafts,
      "new-session",
      "runtime-1",
    );

    expect(
      __rendererTestHooks.composerDraftForSession(moved, "runtime-1").text,
    ).toBe("Start here");
    expect(__rendererTestHooks.hasComposerDraft(moved, "new-session")).toBe(
      false,
    );
  });

  it("reports invalid attachments or image models before work is started", () => {
    const missingAttachment = {
      id: "missing",
      selectedPathToken: "missing-token",
      fileName: "missing.png",
      displayPath: "/project/missing.png",
      kind: "image",
      sendMode: "imageInput",
      outsideProject: false,
      status: "missing",
    } as const;
    const imageAttachment = { ...missingAttachment, status: "ready" as const };

    expect(
      __rendererTestHooks.validateComposerInput({
        attachments: [missingAttachment],
        supportsImages: true,
      }),
    ).toBe("Remove or reselect deleted/unreadable attachments before sending.");
    expect(
      __rendererTestHooks.validateComposerInput({
        attachments: [imageAttachment],
        supportsImages: false,
      }),
    ).toBe("Selected model does not support image input.");
  });
});

describe("renderer saved-session deletion ownership", () => {
  function savedSession(id: string, sessionFile: string) {
    return {
      ...baseSession(),
      id,
      sessionFile,
      projectId: "project-a",
      resumeBacked: true,
    } as any;
  }

  it("clears only drafts whose saved session files main confirms removed", () => {
    const removed = savedSession("saved-a", "/sessions/a.jsonl");
    const retained = savedSession("saved-b", "/sessions/b.jsonl");
    const drafts = {
      [removed.id]: {
        text: "delete me only after confirmation",
        attachments: [],
        slashOpen: false,
      },
      [retained.id]: {
        text: "keep this draft",
        attachments: [],
        slashOpen: false,
      },
    };
    const confirmedRemoved = __rendererTestHooks.savedSessionsForDeletedFiles(
      [removed, retained],
      [removed.sessionFile],
    );

    expect(confirmedRemoved).toEqual([removed]);
    expect(
      __rendererTestHooks.clearComposerDraftsForSessions(
        drafts,
        confirmedRemoved.map((session: any) => session.id),
      ),
    ).toEqual({ [retained.id]: drafts[retained.id] });
  });

  it("retains every draft when a rejected delete has no confirmed removals", () => {
    const first = savedSession("saved-a", "/sessions/a.jsonl");
    const second = savedSession("saved-b", "/sessions/b.jsonl");
    const drafts = {
      [first.id]: { text: "first", attachments: [], slashOpen: false },
      [second.id]: { text: "second", attachments: [], slashOpen: false },
    };

    expect(
      __rendererTestHooks.savedSessionsForDeletedFiles([first, second], []),
    ).toEqual([]);
    expect(__rendererTestHooks.clearComposerDraftsForSessions(drafts, [])).toBe(
      drafts,
    );
  });
});

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

  it("keeps the active main-process project in the compact recent switcher", () => {
    const activeProject = {
      id: "/tmp/project-b",
      path: "/tmp/project-b",
      canonicalPath: "/tmp/project-b",
      displayName: "project-b",
      lastOpenedAt: 2,
    };
    const recentProject = {
      id: "/tmp/project-a",
      path: "/tmp/project-a",
      canonicalPath: "/tmp/project-a",
      displayName: "project-a",
      lastOpenedAt: 1,
    };

    expect(
      __rendererTestHooks.projectsForSwitcher(activeProject, [
        recentProject,
        activeProject,
      ]),
    ).toEqual([activeProject, recentProject]);
  });
});

describe("Pi draft defaults and thinking capabilities", () => {
  it("uses Pi's model-specific levels, including max and unsupported holes", () => {
    expect(
      __rendererTestHooks.thinkingLevelsForModel(
        {
          id: "reasoning-model",
          provider: "provider",
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            xhigh: null,
            max: "max",
          },
        },
        [],
      ),
    ).toEqual(["off", "low", "medium", "high", "max"]);
  });

  it("initializes a draft with Pi's effective model and thinking defaults", () => {
    const draft = __rendererTestHooks.draftSessionForProject(
      {
        id: "/tmp/project",
        path: "/tmp/project",
        canonicalPath: "/tmp/project",
        displayName: "project",
        lastOpenedAt: 1,
      },
      "draft-1",
      "real",
      {
        models: [],
        activeModel: {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai-codex",
        },
        thinkingLevel: "xhigh",
        thinkingLevels: ["off", "low", "high", "xhigh", "max"],
      },
    );

    expect(draft.modelLabel).toBe("openai-codex / gpt-5.6-sol");
    expect(draft.thinkingLevel).toBe("xhigh");
  });

  it("discovers models through a folderless workspace", () => {
    expect(
      __rendererTestHooks.modelDiscoveryRequestForWorkspace({
        id: "workspace-folderless",
        name: "Folderless",
        lastOpenedAt: 1,
      }),
    ).toEqual({ workspaceId: "workspace-folderless" });

    expect(
      __rendererTestHooks.modelDiscoveryRequestForWorkspace({
        id: "workspace-migrated",
        name: "Migrated",
        defaultProjectId: "project-a",
        lastOpenedAt: 1,
      }),
    ).toEqual({
      workspaceId: "workspace-migrated",
      projectId: "project-a",
    });
  });

  it("applies folderless workspace defaults without replacing draft choices", () => {
    const configuration = {
      models: [],
      activeModel: {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai-codex",
      },
      thinkingLevel: "high",
      thinkingLevels: ["off", "low", "high"],
    };
    const untouchedChoice = {
      ...baseSession(),
      id: "chosen-draft",
      workspaceId: "workspace-folderless",
      draftSession: true,
      runtimeBacked: false,
      modelLabel: "another-provider / chosen-model",
      thinkingLevel: "low",
    };
    const emptyFolderlessDraft = {
      ...baseSession(),
      id: "empty-draft",
      workspaceId: "workspace-folderless",
      draftSession: true,
      runtimeBacked: false,
      projectId: undefined,
    };
    const otherWorkspaceDraft = {
      ...emptyFolderlessDraft,
      id: "other-draft",
      workspaceId: "workspace-other",
    };

    const updated = __rendererTestHooks.applyPiDefaultsToDraftSessions(
      [untouchedChoice, emptyFolderlessDraft, otherWorkspaceDraft] as any,
      "workspace-folderless",
      configuration,
    );

    expect(updated[0]).toMatchObject({
      modelLabel: "another-provider / chosen-model",
      thinkingLevel: "low",
    });
    expect(updated[1]).toMatchObject({
      modelLabel: "openai-codex / gpt-5.6-sol",
      thinkingLevel: "high",
    });
    expect(updated[2]).not.toHaveProperty("modelLabel");
    expect(updated[2]).not.toHaveProperty("thinkingLevel");
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

  it("allows move/remove for an idle saved session before automatic runtime close", () => {
    const saved = {
      ...baseSession(),
      sessionFile: "/sessions/saved.jsonl",
      runtimeBacked: false,
      resumeBacked: true,
    } as any;
    expect(__rendererTestHooks.canManageWorkspaceMembership(saved)).toBe(true);
    expect(
      __rendererTestHooks.canManageWorkspaceMembership({
        ...saved,
        runtimeBacked: true,
      }),
    ).toBe(true);
    expect(
      __rendererTestHooks.canManageWorkspaceMembership({
        ...saved,
        status: "working",
        baseState: "working",
      }),
    ).toBe(false);
  });

  it("preserves a background runtime update when an awaited resume completes", () => {
    const saved = {
      ...baseSession(),
      id: "saved-before-resume",
      projectId: "/projects/a",
      sessionFile: "/sessions/saved.jsonl",
      runtimeBacked: false,
      resumeBacked: true,
    };
    const backgroundAfterEvent = __rendererTestHooks.reduceRuntimeEvent(
      { ...baseSession(), id: "background-runtime", projectId: "/projects/b" },
      { type: "agent_start", runtimeId: "background-runtime" } as any,
    );
    const resumed = {
      ...baseSession(),
      id: "resumed-runtime",
      projectId: "/projects/a",
      sessionFile: "/sessions/saved.jsonl",
    };

    const completed = __rendererTestHooks.replaceResumedSession(
      [saved, backgroundAfterEvent] as any,
      saved.id,
      resumed as any,
    );

    expect(
      completed.find((session: any) => session.id === "background-runtime"),
    ).toMatchObject({ status: "working", baseState: "working" });
    expect(
      completed.find((session: any) => session.id === "resumed-runtime"),
    ).toBeDefined();
  });

  it("preserves background updates while close or delete completion removes its target", () => {
    const backgroundAfterEvent = __rendererTestHooks.reduceRuntimeEvent(
      { ...baseSession(), id: "background-runtime", projectId: "/projects/b" },
      { type: "agent_start", runtimeId: "background-runtime" } as any,
    );
    const savedRuntime = {
      ...baseSession(),
      id: "saved-runtime",
      projectId: "/projects/a",
      sessionFile: "/sessions/saved.jsonl",
    };
    const savedRow = {
      ...baseSession(),
      id: "saved-row",
      projectId: "/projects/a",
      sessionFile: "/sessions/delete.jsonl",
      runtimeBacked: false,
      resumeBacked: true,
    };

    const afterClose = __rendererTestHooks.closeRuntimeInSessionState(
      [savedRuntime, backgroundAfterEvent] as any,
      savedRuntime.id,
    );
    const afterDelete = __rendererTestHooks.removeSessionById(
      [savedRow, backgroundAfterEvent] as any,
      savedRow.id,
    );

    expect(
      afterClose.find((session: any) => session.id === savedRuntime.id),
    ).toMatchObject({ runtimeBacked: false, resumeBacked: true });
    expect(
      afterClose.find((session: any) => session.id === "background-runtime"),
    ).toMatchObject({ status: "working" });
    expect(afterDelete.map((session: any) => session.id)).toEqual([
      "background-runtime",
    ]);
    expect(afterDelete[0]).toMatchObject({ status: "working" });
  });

  it("filters saved sessions only by workspace ID, never by a folder path", () => {
    const currentSaved = {
      ...baseSession(),
      id: "current-saved",
      workspaceId: "workspace-a",
      projectId: "/projects/a",
      projectPath: "/projects/a",
      sessionFile: "/sessions/current.jsonl",
      runtimeBacked: false,
      resumeBacked: true,
    };
    const otherProjectSaved = {
      ...currentSaved,
      id: "other-project-saved",
      workspaceId: "workspace-b",
      // This deliberately matches the current folder; it must not make the
      // row visible in the current workspace.
      projectId: "/projects/a",
      projectPath: "/projects/a",
      sessionFile: "/sessions/other.jsonl",
    };
    const attachedCurrentProject = {
      ...currentSaved,
      id: "attached-current",
      sessionFile: "/sessions/attached.jsonl",
      runtimeBacked: true,
      resumeBacked: false,
    };
    const sessions = [
      currentSaved,
      otherProjectSaved,
      attachedCurrentProject,
    ] as any;

    expect(
      __rendererTestHooks.savedSessionsForProject(sessions, "workspace-a"),
    ).toEqual([currentSaved]);
    expect(
      __rendererTestHooks
        .removeSavedSessionsForProject(sessions, "workspace-a")
        .map((session: any) => session.id),
    ).toEqual(["other-project-saved", "attached-current"]);
  });

  it("preserves hidden runtimes and typed drafts while refreshing another workspace", () => {
    const hiddenRuntime = {
      ...baseSession(),
      id: "runtime-b",
      workspaceId: "workspace-b",
      projectPath: "/same-folder-as-a",
      runtimeBacked: true,
    };
    const hiddenDraft = {
      ...baseSession(),
      id: "draft-b",
      workspaceId: "workspace-b",
      draftSession: true,
      runtimeBacked: false,
    };
    const staleSavedA = {
      ...baseSession(),
      id: "saved-a-stale",
      workspaceId: "workspace-a",
      runtimeBacked: false,
      resumeBacked: true,
    };
    const freshSavedA = { ...staleSavedA, id: "saved-a-fresh" };

    const result = __rendererTestHooks.replaceWorkspaceSavedRows(
      [hiddenRuntime, hiddenDraft, staleSavedA] as any,
      "workspace-a",
      [freshSavedA] as any,
      {
        "draft-b": { text: "keep this", attachments: [], slashOpen: false },
      },
    );

    expect(result.map((session: any) => session.id)).toEqual([
      "runtime-b",
      "draft-b",
      "saved-a-fresh",
    ]);
  });

  it("uses the session working folder for attachments over the workspace default", () => {
    const workspace = {
      id: "workspace-a",
      name: "Workspace A",
      lastOpenedAt: 1,
      defaultProject: {
        id: "default-folder",
        path: "/folders/default",
        canonicalPath: "/folders/default",
        displayName: "default",
        lastOpenedAt: 1,
      },
    };
    expect(
      __rendererTestHooks.workingDirectoryForSession(
        { ...baseSession(), workingDirectory: "/folders/session-b" } as any,
        workspace,
      ),
    ).toBe("/folders/session-b");
  });

  it("starts create names empty and prefills rename names", () => {
    expect(
      __rendererTestHooks.initialWorkspaceDialogName("create", "Current"),
    ).toBe("");
    expect(
      __rendererTestHooks.initialWorkspaceDialogName("rename", "Current"),
    ).toBe("Current");
  });

  it("updates every in-memory label owned by a renamed workspace", () => {
    const sessions = [
      { ...baseSession(), id: "a", workspaceId: "workspace-a" },
      { ...baseSession(), id: "b", workspaceId: "workspace-b" },
    ] as any;
    const updated = __rendererTestHooks.updateWorkspaceSessionLabels(
      sessions,
      "workspace-a",
      "Renamed workspace",
    );
    expect(updated.find((session: any) => session.id === "a")?.project).toBe(
      "Renamed workspace",
    );
    expect(updated.find((session: any) => session.id === "b")?.project).toBe(
      "Project",
    );
  });

  it("reports active-turn blockers before the last-workspace fallback", () => {
    const busy = {
      ...baseSession(),
      status: "working",
      baseState: "working",
    };
    expect(
      __rendererTestHooks.archiveWorkspaceBlockReason(
        [busy] as any,
        {},
        "workspace-a",
        1,
      ),
    ).toMatch(/finish active sessions/i);
    expect(
      __rendererTestHooks.archiveWorkspaceBlockReason(
        [busy] as any,
        {},
        "workspace-a",
        2,
      ),
    ).toMatch(/finish active sessions/i);
    expect(
      __rendererTestHooks.archiveWorkspaceBlockReason([], {}, "workspace-a", 1),
    ).toMatch(/another workspace/i);
  });

  it("allows idle attached sessions but blocks active work and unsent drafts from archive", () => {
    const idleAttached = {
      ...baseSession(),
      sessionFile: "/sessions/idle.jsonl",
      runtimeBacked: true,
      resumeBacked: false,
    } as any;
    expect(__rendererTestHooks.canManageWorkspaceMembership(idleAttached)).toBe(
      true,
    );
    expect(
      __rendererTestHooks.archiveWorkspaceBlockReason(
        [idleAttached],
        {},
        "workspace-a",
        2,
      ),
    ).toBeUndefined();

    const active = {
      ...idleAttached,
      status: "working",
      baseState: "working",
    };
    expect(__rendererTestHooks.canManageWorkspaceMembership(active)).toBe(
      false,
    );
    expect(
      __rendererTestHooks.archiveWorkspaceBlockReason(
        [active],
        {},
        "workspace-a",
        2,
      ),
    ).toMatch(/finish active sessions/i);

    const draft = {
      ...baseSession(),
      id: "draft-1",
      runtimeBacked: false,
      draftSession: true,
    } as any;
    expect(__rendererTestHooks.canManageWorkspaceMembership(draft)).toBe(false);
    expect(
      __rendererTestHooks.archiveWorkspaceBlockReason(
        [draft],
        {
          "draft-1": {
            text: "unsent work",
            attachments: [],
            slashOpen: false,
          },
        },
        "workspace-a",
        2,
      ),
    ).toMatch(/send or clear/i);
  });

  it("blocks archive for meaningful composer state but ignores an empty draft", () => {
    const idleDraft = {
      ...baseSession(),
      runtimeBacked: false,
      draftSession: true,
    } as any;
    const emptyDrafts = {
      "session-1": { text: "  ", attachments: [], slashOpen: false },
    };
    expect(
      __rendererTestHooks.archiveWorkspaceBlockReason(
        [idleDraft],
        emptyDrafts,
        "workspace-a",
        2,
      ),
    ).toBeUndefined();
    expect(
      __rendererTestHooks.archiveWorkspaceBlockReason(
        [idleDraft],
        {
          "session-1": {
            text: "unsent prompt",
            attachments: [],
            slashOpen: false,
          },
        },
        "workspace-a",
        2,
      ),
    ).toMatch(/send or clear/i);
    expect(
      __rendererTestHooks.archiveWorkspaceBlockReason(
        [idleDraft],
        {
          "session-1": {
            text: "",
            attachments: [{ id: "attachment" }],
            slashOpen: false,
          },
        } as any,
        "workspace-a",
        2,
      ),
    ).toMatch(/attachments/i);
  });

  it("keeps a destructive dialog busy and rejects duplicate transactions", async () => {
    const gate = { current: false };
    const busy: boolean[] = [];
    let release: (() => void) | undefined;
    const transaction = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = __rendererTestHooks.runBusyDialogTransaction(
      gate,
      (value: boolean) => busy.push(value),
      () => transaction,
    );
    const duplicate = await __rendererTestHooks.runBusyDialogTransaction(
      gate,
      (value: boolean) => busy.push(value),
      async () => undefined,
    );
    expect(duplicate).toBe(false);
    expect(busy).toEqual([true]);
    release?.();
    await first;
    expect(busy).toEqual([true, false]);
  });

  it("imports unassigned sessions sequentially and reports partial results", async () => {
    const calls: string[] = [];
    const result = await __rendererTestHooks.settleSequentialSessionImports(
      ["first", "second", "third"],
      async (sessionFile: string) => {
        calls.push(sessionFile);
        if (sessionFile === "second") throw new Error("unavailable");
      },
    );
    expect(calls).toEqual(["first", "second", "third"]);
    expect(result).toEqual({
      added: ["first", "third"],
      failed: ["second"],
    });
  });
});

describe("renderer attention-first inbox", () => {
  function inboxSession(
    id: string,
    updatedAtMs: number,
    patch: Record<string, unknown> = {},
  ) {
    return {
      ...baseSession(),
      id,
      title: id,
      updatedAtMs,
      runtimeBacked: false,
      resumeBacked: true,
      sessionFile: `/tmp/${id}.jsonl`,
      ...patch,
    };
  }

  it("pins all attention rows ahead of five recency-limited idle saved sessions", () => {
    const idleSaved = Array.from({ length: 7 }, (_, index) =>
      inboxSession(`saved-${index}`, index),
    );
    const inbox = __rendererTestHooks.buildRealSessionInbox(
      [
        ...idleSaved,
        inboxSession("working-old", -10, {
          status: "working",
          baseState: "working",
        }),
        inboxSession("needs-input", -20, {
          status: "waiting",
          baseState: "waitingForInput",
          overlays: { ...emptyOverlays, needsUserInput: true },
        }),
        inboxSession("error", -30, {
          status: "error",
          baseState: "error",
        }),
        inboxSession("working-new", 20, {
          status: "working",
          baseState: "working",
        }),
      ] as any,
      "",
    );

    expect(inbox.needsInput.map((session: any) => session.id)).toEqual([
      "needs-input",
    ]);
    expect(inbox.errors.map((session: any) => session.id)).toEqual(["error"]);
    expect(inbox.working.map((session: any) => session.id)).toEqual([
      "working-new",
      "working-old",
    ]);
    expect(inbox.idleSaved.map((session: any) => session.id)).toEqual([
      "saved-6",
      "saved-5",
      "saved-4",
      "saved-3",
      "saved-2",
      "saved-1",
      "saved-0",
    ]);
  });

  it("searches every saved row and keeps intervention queues labeled during work", () => {
    const inbox = __rendererTestHooks.buildRealSessionInbox(
      [
        inboxSession("recent", 2),
        inboxSession("older-match", 1, { title: "Find this saved session" }),
      ] as any,
      "find this",
    );

    expect(inbox.idleSaved.map((session: any) => session.id)).toEqual([
      "older-match",
    ]);
    expect(
      __rendererTestHooks.queueBadgeLabels({
        ...emptyOverlays,
        streaming: true,
        piQueuedSteeringCount: 1,
        piQueuedFollowUpCount: 2,
      }),
    ).toEqual(["Steer 1", "Follow-up 2"]);
  });
});

describe("renderer intervention UX", () => {
  it("identifies only known extension commands as unavailable for queues", () => {
    const commands = [
      { name: "/deploy", description: "Deploy", source: "extension" },
      { name: "/review", description: "Review", source: "prompt template" },
    ] as const;

    expect(
      __rendererTestHooks.findKnownExtensionCommand(
        "/deploy production",
        commands as any,
      ),
    ).toBe("/deploy");
    expect(
      __rendererTestHooks.findKnownExtensionCommand("/review", commands as any),
    ).toBeUndefined();
    expect(
      __rendererTestHooks.findKnownExtensionCommand(
        "ordinary instruction",
        commands as any,
      ),
    ).toBeUndefined();
  });
});

describe("renderer runtime-scoped capabilities", () => {
  it("keeps model and command responses scoped when older runtime requests finish last", async () => {
    let capabilities: any = {};
    let resolveModelsForA: ((models: any[]) => void) | undefined;
    let resolveCommandsForA: ((commands: any[]) => void) | undefined;
    const modelsForA = new Promise<any[]>((resolve) => {
      resolveModelsForA = resolve;
    });
    const commandsForA = new Promise<any[]>((resolve) => {
      resolveCommandsForA = resolve;
    });

    const loadModels = async (runtimeId: string, response: Promise<any[]>) => {
      const models = await response;
      capabilities = __rendererTestHooks.updateRuntimeCapabilities(
        capabilities,
        runtimeId,
        { models },
      );
    };
    const loadCommands = async (
      runtimeId: string,
      response: Promise<any[]>,
    ) => {
      const commands = await response;
      capabilities = __rendererTestHooks.updateRuntimeCapabilities(
        capabilities,
        runtimeId,
        { commands },
      );
    };

    const slowModelsForA = loadModels("runtime-a", modelsForA);
    const slowCommandsForA = loadCommands("runtime-a", commandsForA);
    await loadModels("runtime-b", Promise.resolve([{ id: "model-b" }]));
    await loadCommands("runtime-b", Promise.resolve([{ name: "/command-b" }]));
    resolveModelsForA?.([{ id: "model-a" }]);
    resolveCommandsForA?.([{ name: "/command-a" }]);
    await Promise.all([slowModelsForA, slowCommandsForA]);

    expect(
      __rendererTestHooks.runtimeCapabilitiesFor(capabilities, "runtime-a"),
    ).toMatchObject({
      models: [{ id: "model-a" }],
      commands: [{ name: "/command-a" }],
    });
    expect(
      __rendererTestHooks.runtimeCapabilitiesFor(capabilities, "runtime-b"),
    ).toMatchObject({
      models: [{ id: "model-b" }],
      commands: [{ name: "/command-b" }],
    });
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

    const exactPiQueue = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "queue_update",
      runtimeId: "session-1",
      steering: ["one"],
      followUp: ["two", "three"],
    } as any);
    expect(exactPiQueue.overlays).toMatchObject({
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
      id: "ext-1",
      method: "confirm",
      title: "Confirm",
      message: "Approve?",
    } as any);

    expect(waiting.status).toBe("waiting");
    expect(waiting.baseState).toBe("waitingForInput");
    expect(waiting.overlays.needsUserInput).toBe(true);
    expect(waiting.pendingExtensionUiRequests).toMatchObject([
      {
        id: "ext-1",
        method: "confirm",
        title: "Confirm",
        message: "Approve?",
      },
    ]);
  });

  it("explains unsupported extension UI methods instead of silently ignoring them", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(baseSession(), {
      type: "extension_ui_request",
      runtimeId: "session-1",
      id: "notify-1",
      method: "notify",
      message: "Background notification",
    } as any);

    expect(next.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "diagnostic",
          content: expect.stringContaining(
            "Only select, confirm, input, and editor",
          ),
        }),
      ]),
    );
    expect(next.overlays.needsUserInput).toBe(false);
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

  it("preserves title and transcript across metadata-only model and thinking snapshots", () => {
    const current = {
      ...baseSession(),
      title: "Keep this title",
      projectId: "/projects/original",
      sessionFile: "/sessions/keep.jsonl",
      status: "error",
      baseState: "error",
      overlays: { ...emptyOverlays, retrying: true },
      retryPrompt: { text: "retry this", attachments: [] },
      timeline: [
        {
          id: "user-1",
          kind: "user",
          content: "Keep this title",
          createdAt: "now",
        },
        {
          id: "assistant-1",
          kind: "assistant",
          content: "Existing response",
          createdAt: "now",
        },
      ],
    } as any;
    const afterModel = __rendererTestHooks.mergeSessionUsageFromSnapshot(
      current,
      __rendererTestHooks.sessionFromSnapshot({
        runtimeId: "session-1",
        backendMode: "real",
        state: {
          cwd: "/projects/changed-by-snapshot",
          provider: "provider-two",
          model: "model-two",
        },
        messages: [],
      } as any),
    );
    const afterThinking = __rendererTestHooks.mergeSessionUsageFromSnapshot(
      afterModel,
      __rendererTestHooks.sessionFromSnapshot({
        runtimeId: "session-1",
        backendMode: "real",
        state: {
          cwd: "/projects/changed-by-snapshot",
          provider: "provider-two",
          model: "model-two",
          thinkingLevel: "high",
        },
        messages: [],
      } as any),
    );

    expect(afterThinking).toMatchObject({
      title: "Keep this title",
      projectId: "/projects/original",
      sessionFile: "/sessions/keep.jsonl",
      status: "error",
      baseState: "error",
      retryPrompt: { text: "retry this" },
      modelLabel: "provider-two / model-two",
      thinkingLevel: "high",
    });
    expect(afterThinking.overlays).toEqual(current.overlays);
    expect(afterThinking.timeline).toEqual(current.timeline);
  });

  it("uses Pi's production sessionName as the snapshot title", () => {
    const session = __rendererTestHooks.sessionFromSnapshot({
      runtimeId: "runtime-1",
      backendMode: "real",
      state: { cwd: "/tmp/project", sessionName: "  Named by Pi  " },
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Fallback first prompt",
        },
      ],
    } as any);

    expect(session.title).toBe("Named by Pi");
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

  it("keeps a completed assistant message working until agent_end confirms the turn", () => {
    const next = __rendererTestHooks.reduceRuntimeEvent(
      {
        ...baseSession(),
        status: "sending",
        baseState: "attaching",
        overlays: { ...emptyOverlays, streaming: true },
      } as any,
      {
        type: "message_update",
        runtimeId: "session-1",
        messageId: "assistant-1",
        role: "assistant",
        content: "Done",
        done: true,
      } as any,
    );

    expect(next.status).toBe("working");
    expect(next.baseState).toBe("working");
    expect(next.awaitingAgentEnd).toBe(true);
    expect(next.subtitle).toContain("waiting for Pi completion");
  });

  it("uses compact runtime status to confirm sending, while keeping abort pending", () => {
    const sending = {
      ...baseSession(),
      status: "sending",
      baseState: "attaching",
    } as any;
    const activeStatus = {
      runtimeId: "session-1",
      backendMode: "real",
      state: { cwd: "/tmp/project", isAgentActive: true },
    } as any;

    const confirmed = __rendererTestHooks.reconcileSessionWithRuntimeStatus(
      sending,
      activeStatus,
    );
    expect(confirmed.status).toBe("working");
    expect(__rendererTestHooks.isSessionBusy(confirmed)).toBe(true);

    const aborting = { ...confirmed, status: "aborting" } as any;
    expect(
      __rendererTestHooks.reconcileSessionWithRuntimeStatus(
        aborting,
        activeStatus,
      ).status,
    ).toBe("aborting");
  });

  it("keeps quiet working reconciliation runtime-scoped", () => {
    const working = {
      ...baseSession(),
      status: "working",
      baseState: "working",
    } as any;
    const awaitingAgentEnd = {
      ...working,
      awaitingAgentEnd: true,
    } as any;
    const otherRuntimeStatus = {
      runtimeId: "session-2",
      backendMode: "real",
      state: { isAgentActive: false },
    } as any;

    expect(__rendererTestHooks.shouldReconcileSession(working)).toBe(true);
    expect(__rendererTestHooks.shouldReconcileSession(awaitingAgentEnd)).toBe(
      true,
    );
    expect(
      __rendererTestHooks.reconcileSessionWithRuntimeStatus(
        awaitingAgentEnd,
        otherRuntimeStatus,
      ),
    ).toBe(awaitingAgentEnd);
  });

  it("uses final event usage before requesting a status refresh", () => {
    const event = {
      type: "agent_end",
      runtimeId: "session-1",
      usage: { input: 10, output: 5 },
    } as any;
    expect(__rendererTestHooks.eventHasUsageMetadata(event)).toBe(true);

    const next = __rendererTestHooks.reduceRuntimeEvent(
      { ...baseSession(), status: "working", baseState: "working" } as any,
      event,
    );
    expect(next.usageStats).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("merges status usage only into the requested runtime", () => {
    const session = baseSession() as any;
    const otherStatus = {
      runtimeId: "session-2",
      backendMode: "real",
      state: { isAgentActive: false },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
      },
    } as any;
    expect(
      __rendererTestHooks.mergeSessionUsageFromRuntimeStatus(
        session,
        otherStatus,
      ),
    ).toBe(session);
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
