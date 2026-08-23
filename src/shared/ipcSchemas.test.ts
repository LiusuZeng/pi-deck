import { describe, expect, it } from "vitest";
import {
  apiResponseSchema,
  appBootstrapStateSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  attachmentDraftSchema,
  attachmentImportDroppedFilesRequestSchema,
  attachmentImportImageRequestSchema,
  attachmentPickerRequestSchema,
  attachmentReleaseOwnerRequestSchema,
  attachmentReleaseRequestSchema,
  attachmentAssignOwnerRequestSchema,
  chatCreateSessionRequestSchema,
  chatDeleteAllSessionsResultSchema,
  chatDeleteSessionRequestSchema,
  chatInterventionRequestSchema,
  chatMessageSchema,
  chatPromptRequestSchema,
  chatRespondToExtensionUiRequestSchema,
  chatRuntimeStatusRequestSchema,
  chatRuntimeStatusSchema,
  multitaskModeRequestSchema,
  multitaskModeUpdateRequestSchema,
  multitaskSettingsUpdateRequestSchema,
  multitaskStateEventSchema,
  multitaskTaskSummarySchema,
  pickProjectResultSchema,
  projectRefSchema,
  chatSessionSummarySchema,
  workspaceCreateRequestSchema,
  workspaceArchiveSessionRequestSchema,
  workspaceRestoreSessionRequestSchema,
  workspaceListSessionsRequestSchema,
  workspaceListResultSchema,
  workspaceMoveSessionRequestSchema,
  workspaceRestoreRequestSchema,
  workspaceUpdateRequestSchema,
} from "./ipcSchemas.js";

describe("IPC schemas", () => {
  it("applies settings defaults and caps running sessions at 20", () => {
    expect(appSettingsSchema.parse({})).toMatchObject({
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: true,
      theme: "system",
    });
    expect(appSettingsPatchSchema.parse({})).toEqual({});
    expect(() =>
      appSettingsPatchSchema.parse({ maxRunningSessions: 21 }),
    ).toThrow();
    expect(appSettingsPatchSchema.parse({ theme: "dark" })).toEqual({
      theme: "dark",
    });
    expect(() => appSettingsPatchSchema.parse({ theme: "midnight" })).toThrow();
  });

  it("rejects unknown settings keys", () => {
    expect(() =>
      appSettingsPatchSchema.parse({ arbitraryNodeApi: true }),
    ).toThrow();
  });

  it("validates structured IPC error responses", () => {
    expect(
      apiResponseSchema(appSettingsSchema).parse({
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "IPC payload validation failed",
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("validates a compact local-only bootstrap DTO", () => {
    const project = {
      id: "/project/app",
      path: "/project/app",
      canonicalPath: "/project/app",
      displayName: "app",
      lastOpenedAt: 1_234,
    };
    const bootstrap = {
      backendMode: "real" as const,
      version: "0.1.0",
      settings: {},
      diagnostics: {
        appVersion: "0.1.0",
        userDataPath: "/tmp/user-data",
        logPath: "/tmp/log",
        settings: {},
        recentErrors: [],
      },
      project,
      projects: [project],
      cachedSessions: [],
    };
    expect(appBootstrapStateSchema.parse(bootstrap)).toMatchObject({
      backendMode: "real",
      project,
    });
    expect(() =>
      appBootstrapStateSchema.parse({
        ...bootstrap,
        runtimeId: "must-not-be-here",
      }),
    ).toThrow();
    expect(() =>
      appBootstrapStateSchema.parse({
        ...bootstrap,
        cachedSessions: [
          {
            id: "saved-1",
            sessionFile: "/sessions/saved-1.jsonl",
            title: "Saved",
            updatedAtMs: 1,
            messageCount: 1,
            attachedRuntimeId: "must-not-be-in-bootstrap",
          },
        ],
      }),
    ).toThrow();
  });

  it("validates project picker metadata and rejects unknown fields", () => {
    const project = {
      id: "/project/app",
      path: "/project/app",
      canonicalPath: "/private/project/app",
      displayName: "app",
      lastOpenedAt: 1_234,
    };

    expect(projectRefSchema.parse(project)).toEqual(project);
    expect(
      pickProjectResultSchema.parse({ selected: true, project }),
    ).toMatchObject({ selected: true, project });
    expect(pickProjectResultSchema.parse({ selected: false })).toEqual({
      selected: false,
    });

    expect(() =>
      projectRefSchema.parse({ ...project, arbitraryFileRead: true }),
    ).toThrow();
    expect(() =>
      pickProjectResultSchema.parse({
        selected: true,
        project: { ...project, id: 42 },
      }),
    ).toThrow();
  });

  it("validates path-independent workspace contracts", () => {
    expect(
      workspaceCreateRequestSchema.parse({ name: "  Release   planning  " }),
    ).toEqual({ name: "Release planning" });
    expect(
      workspaceUpdateRequestSchema.parse({
        workspaceId: "workspace-1",
        defaultProjectId: null,
      }),
    ).toEqual({ workspaceId: "workspace-1", defaultProjectId: null });
    expect(() =>
      workspaceUpdateRequestSchema.parse({ workspaceId: "workspace-1" }),
    ).toThrow();
    expect(() =>
      workspaceMoveSessionRequestSchema.parse({
        sessionFile: "/sessions/one.jsonl",
        toWorkspaceId: "workspace-2",
        copy: true,
      }),
    ).toThrow();

    const workspace = {
      id: "workspace-1",
      name: "Release planning",
      lastOpenedAt: 123,
    };
    expect(
      workspaceListResultSchema.parse({
        activeWorkspaceId: workspace.id,
        activeWorkspace: workspace,
        workspaces: [workspace],
      }),
    ).toMatchObject({ activeWorkspace: workspace });
    expect(() =>
      workspaceListResultSchema.parse({
        workspaces: [{ ...workspace, rootPath: "/must-not-be-identity" }],
      }),
    ).toThrow();

    expect(
      workspaceListResultSchema.parse({
        workspaces: [workspace],
        archivedWorkspaces: [{ ...workspace, id: "workspace-archived" }],
      }).archivedWorkspaces,
    ).toHaveLength(1);
    expect(
      workspaceArchiveSessionRequestSchema.parse({
        workspaceId: workspace.id,
        sessionFile: "/sessions/one.jsonl",
      }),
    ).toEqual({
      workspaceId: workspace.id,
      sessionFile: "/sessions/one.jsonl",
    });
    expect(
      workspaceRestoreSessionRequestSchema.parse({
        workspaceId: workspace.id,
        sessionFile: "/sessions/one.jsonl",
      }),
    ).toEqual({
      workspaceId: workspace.id,
      sessionFile: "/sessions/one.jsonl",
    });
    expect(
      workspaceListSessionsRequestSchema.parse({
        workspaceId: workspace.id,
        includeArchived: true,
      }),
    ).toEqual({ workspaceId: workspace.id, includeArchived: true });
    expect(
      chatSessionSummarySchema.parse({
        id: "saved-1",
        sessionFile: "/sessions/saved-1.jsonl",
        title: "Saved",
        updatedAtMs: 1,
        messageCount: 1,
        archivedAtMs: 2,
      }).archivedAtMs,
    ).toBe(2);
  });

  it("rejects malformed workspace and session archive lifecycle payloads", () => {
    const sessionRequest = {
      workspaceId: "workspace-1",
      sessionFile: "/sessions/one.jsonl",
    };
    for (const schema of [
      workspaceArchiveSessionRequestSchema,
      workspaceRestoreSessionRequestSchema,
    ]) {
      expect(() =>
        schema.parse({ ...sessionRequest, workspaceId: "" }),
      ).toThrow();
      expect(() =>
        schema.parse({ ...sessionRequest, sessionFile: "" }),
      ).toThrow();
      expect(() =>
        schema.parse({ ...sessionRequest, deleteFile: true }),
      ).toThrow();
    }

    expect(() =>
      workspaceRestoreRequestSchema.parse({ workspaceId: "" }),
    ).toThrow();
    expect(() =>
      workspaceRestoreRequestSchema.parse({
        workspaceId: "workspace-1",
        restoreFiles: true,
      }),
    ).toThrow();
    expect(() =>
      workspaceListSessionsRequestSchema.parse({
        workspaceId: "workspace-1",
        includeArchived: "yes",
      }),
    ).toThrow();
    expect(() =>
      workspaceListSessionsRequestSchema.parse({
        workspaceId: "workspace-1",
        includeArchived: true,
        sessionDir: "/outside",
      }),
    ).toThrow();
    expect(() =>
      chatSessionSummarySchema.parse({
        id: "saved-1",
        sessionFile: "/sessions/saved-1.jsonl",
        title: "Saved",
        updatedAtMs: 1,
        messageCount: 1,
        archivedAtMs: "yesterday",
      }),
    ).toThrow();
  });

  it("normalizes non-text message content arrays to avoid resume validation failures", () => {
    expect(
      chatMessageSchema.parse({
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "thinking", thinking: "hidden" }],
      }),
    ).toMatchObject({ content: "" });
  });

  it("normalizes persisted user image content for resumed previews", () => {
    expect(
      chatMessageSchema.parse({
        id: "msg-1",
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image",
            id: "image-1",
            fileName: "screenshot.png",
            mimeType: "image/png",
            data: "abc123",
          },
        ],
      }),
    ).toMatchObject({
      content: "What is this?",
      imageAttachments: [
        {
          id: "image-1",
          fileName: "screenshot.png",
          mimeType: "image/png",
          dataBase64: "abc123",
        },
      ],
    });
  });

  it("validates compact, runtime-scoped status DTOs without messages", () => {
    expect(
      chatRuntimeStatusRequestSchema.parse({ runtimeId: "runtime-1" }),
    ).toEqual({ runtimeId: "runtime-1" });
    expect(() =>
      chatRuntimeStatusRequestSchema.parse({
        runtimeId: "runtime-1",
        messages: [],
      }),
    ).toThrow();
    expect(
      chatRuntimeStatusSchema.parse({
        runtimeId: "runtime-1",
        backendMode: "real",
        state: { cwd: "/project", isAgentActive: true },
      }),
    ).toMatchObject({ runtimeId: "runtime-1" });
    expect(() =>
      chatRuntimeStatusSchema.parse({
        runtimeId: "runtime-1",
        backendMode: "real",
        state: { isAgentActive: false },
        messages: [],
      }),
    ).toThrow();
    expect(() =>
      chatRuntimeStatusSchema.parse({
        runtimeId: "runtime-1",
        backendMode: "real",
        state: {
          isAgentActive: false,
          model: { id: "model-1", unboundedModelPayload: "nope" },
        },
      }),
    ).toThrow();
  });

  it("limits multitask contracts to parent-scoped settings and safe task rows", () => {
    expect(
      multitaskModeRequestSchema.parse({ runtimeId: "runtime-7" }),
    ).toEqual({ runtimeId: "runtime-7" });
    expect(
      multitaskModeUpdateRequestSchema.parse({
        runtimeId: "runtime-7",
        mode: "parallel",
      }),
    ).toEqual({ runtimeId: "runtime-7", mode: "parallel" });
    expect(
      multitaskSettingsUpdateRequestSchema.parse({
        runtimeId: "runtime-7",
        settings: {
          model: { provider: "anthropic", modelId: "claude" },
          thinkingLevel: "high",
        },
      }),
    ).toMatchObject({ runtimeId: "runtime-7" });
    expect(
      multitaskStateEventSchema.parse({
        runtimeId: "runtime-7",
        mode: "sequential",
        settings: {},
        activeCount: 1,
        activeLimit: 10,
        tasks: [
          {
            taskNumber: 8,
            generatedName: "Task 8",
            brief: "Investigate the issue",
            lifecycle: "waiting-parent",
            attempt: 2,
            elapsedMs: 500,
            startedAtMs: 1_700_000_000_000,
            progress: "Waiting for plan context",
          },
        ],
      }),
    ).toMatchObject({ runtimeId: "runtime-7", activeLimit: 10 });

    expect(() =>
      multitaskTaskSummarySchema.parse({
        taskNumber: 8,
        generatedName: "Task 8",
        brief: "Private work",
        lifecycle: "completed",
        attempt: 1,
        elapsedMs: 500,
        startedAtMs: 1_700_000_000_000,
      }),
    ).toThrow();
    expect(() => multitaskModeRequestSchema.parse({ runtimeId: "" })).toThrow();
    expect(() =>
      multitaskModeUpdateRequestSchema.parse({
        runtimeId: "runtime-7",
        mode: "parallel",
        childRuntimeId: "not-renderer-safe",
      }),
    ).toThrow();
    expect(() =>
      multitaskTaskSummarySchema.parse({
        taskNumber: 8,
        generatedName: "Task 8",
        brief: "Private work",
        lifecycle: "running",
        attempt: 1,
        elapsedMs: 0,
        sessionFile: "/private/session.jsonl",
      }),
    ).toThrow();
    expect(() =>
      multitaskStateEventSchema.parse({
        runtimeId: "runtime-7",
        mode: "parallel",
        settings: {},
        activeCount: 0,
        activeLimit: 10,
        tasks: [
          {
            taskNumber: 8,
            generatedName: "Task 8",
            brief: "Private work",
            lifecycle: "queued",
            attempt: 1,
            elapsedMs: 0,
            prompt: "private child prompt",
          },
        ],
      }),
    ).toThrow();
  });

  it("validates delete session requests", () => {
    expect(
      chatDeleteSessionRequestSchema.parse({
        sessionFile: "/tmp/session.jsonl",
      }),
    ).toEqual({ sessionFile: "/tmp/session.jsonl" });
    expect(() => chatDeleteSessionRequestSchema.parse({})).toThrow();
  });

  it("requires exact deleted files for bulk deletion owner cleanup", () => {
    expect(
      chatDeleteAllSessionsResultSchema.parse({
        deleted: true,
        deletedCount: 1,
        skippedCount: 1,
        deletedSessionFiles: ["/tmp/deleted.jsonl"],
      }),
    ).toMatchObject({ deletedSessionFiles: ["/tmp/deleted.jsonl"] });
    expect(() =>
      chatDeleteAllSessionsResultSchema.parse({
        deleted: true,
        deletedCount: 1,
        skippedCount: 0,
      }),
    ).toThrow();
  });

  it("accepts an initial multitask mode only when creating a session", () => {
    expect(
      chatCreateSessionRequestSchema.parse({
        workspaceId: "workspace-1",
        multitaskMode: "parallel",
      }),
    ).toEqual({ workspaceId: "workspace-1", multitaskMode: "parallel" });
    expect(() =>
      chatCreateSessionRequestSchema.parse({
        multitaskMode: "invalid",
      }),
    ).toThrow();
    expect(() =>
      chatCreateSessionRequestSchema.parse({
        multitaskMode: "parallel",
        childRuntimeId: "must-not-cross-boundary",
      }),
    ).toThrow();
  });

  it("validates strict steer and follow-up intervention payloads", () => {
    expect(
      chatInterventionRequestSchema.parse({
        runtimeId: "runtime-1",
        text: "Change direction",
      }),
    ).toEqual({ runtimeId: "runtime-1", text: "Change direction" });
    expect(() =>
      chatInterventionRequestSchema.parse({
        runtimeId: "runtime-1",
        text: "Queue this",
        streamingBehavior: "steer",
      }),
    ).toThrow();
  });

  it("validates strict, request-scoped extension UI response payloads", () => {
    expect(
      chatRespondToExtensionUiRequestSchema.parse({
        runtimeId: "runtime-1",
        requestId: "uuid-1",
        response: { confirmed: true },
      }),
    ).toMatchObject({ runtimeId: "runtime-1", requestId: "uuid-1" });
    expect(() =>
      chatRespondToExtensionUiRequestSchema.parse({
        runtimeId: "runtime-1",
        requestId: "uuid-1",
        response: { confirmed: true, value: "wrong" },
      }),
    ).toThrow();
    expect(() =>
      chatRespondToExtensionUiRequestSchema.parse({
        runtimeId: "runtime-1",
        requestId: "uuid-1",
        response: { value: "x" },
        arbitraryFileWrite: true,
      }),
    ).toThrow();
  });

  it("defaults legacy prompts to the parent and validates task-worker overrides", () => {
    expect(
      chatPromptRequestSchema.parse({
        runtimeId: "runtime-1",
        text: "Summarize these",
        destination: "newTaskSession",
        workerOverrides: {
          model: { provider: "anthropic", modelId: "claude" },
          thinkingLevel: "high",
        },
      }),
    ).toMatchObject({ destination: "newTaskSession" });
    expect(
      chatPromptRequestSchema.parse({ runtimeId: "runtime-1", text: "Legacy" }),
    ).toMatchObject({ destination: "parent" });
    expect(() =>
      chatPromptRequestSchema.parse({
        runtimeId: "runtime-1",
        text: "Bad worker",
        workerOverrides: {
          model: { provider: "x", modelId: "y", runtimeId: "private" },
        },
      }),
    ).toThrow();
  });

  it("validates prompt attachment tokens without file paths", () => {
    expect(
      chatPromptRequestSchema.parse({
        runtimeId: "runtime-1",
        text: "Summarize these",
        attachments: [
          { selectedPathToken: "token-1", sendMode: "pathReference" },
          { selectedPathToken: "token-2", sendMode: "imageInput" },
        ],
        attachmentOwnerId: "owner-generation-1",
      }),
    ).toMatchObject({ runtimeId: "runtime-1" });

    expect(() =>
      chatPromptRequestSchema.parse({
        runtimeId: "runtime-1",
        text: "Summarize this",
        attachments: [
          { selectedPathToken: "token-1", filePath: "/etc/passwd" },
        ],
      }),
    ).toThrow();
    expect(() =>
      chatPromptRequestSchema.parse({
        runtimeId: "runtime-1",
        text: "Do not duplicate this image",
        attachments: [
          { selectedPathToken: "token-1", sendMode: "imageInput" },
          { selectedPathToken: "token-1", sendMode: "imageInput" },
        ],
      }),
    ).toThrow();
  });

  it("validates dropped regular file path import payloads", () => {
    expect(
      attachmentImportDroppedFilesRequestSchema.parse({
        paths: ["/tmp/a.txt", "/tmp/b.bin"],
        projectPath: "/tmp",
        ownerId: "owner-generation-1",
        sessionId: "draft-1",
      }),
    ).toEqual({
      paths: ["/tmp/a.txt", "/tmp/b.bin"],
      projectPath: "/tmp",
      ownerId: "owner-generation-1",
      sessionId: "draft-1",
    });

    expect(() =>
      attachmentImportDroppedFilesRequestSchema.parse({
        paths: [],
        ownerId: "owner-generation-1",
        sessionId: "draft-1",
      }),
    ).toThrow();
    expect(() =>
      attachmentImportDroppedFilesRequestSchema.parse({
        paths: ["/tmp/a.txt"],
        ownerId: "owner-generation-1",
        sessionId: "draft-1",
        recursiveRead: true,
      }),
    ).toThrow();
  });

  it("validates dropped image import payloads", () => {
    expect(
      attachmentImportImageRequestSchema.parse({
        images: [
          {
            fileName: "screenshot.png",
            mimeType: "image/png",
            size: 123,
            dataBase64: "abc123",
          },
        ],
        ownerId: "owner-generation-1",
        sessionId: "draft-1",
      }),
    ).toMatchObject({ images: [{ fileName: "screenshot.png" }] });

    expect(() =>
      attachmentImportImageRequestSchema.parse({
        images: [{ fileName: "x.png", mimeType: "image/png", path: "/tmp/x" }],
        ownerId: "owner-generation-1",
        sessionId: "draft-1",
      }),
    ).toThrow();
  });

  it("validates attachment picker request and token-shaped draft metadata", () => {
    const attachment = {
      id: "draft-1",
      selectedPathToken: "opaque-token-1",
      fileName: "App.tsx",
      displayPath: "src/App.tsx",
      kind: "textFile",
      sendMode: "pathReference",
      outsideProject: false,
      status: "ready",
    };

    expect(
      attachmentPickerRequestSchema.parse({
        projectPath: "/project",
        ownerId: "owner-generation-1",
        sessionId: "draft-1",
      }),
    ).toEqual({
      projectPath: "/project",
      ownerId: "owner-generation-1",
      sessionId: "draft-1",
    });
    expect(attachmentDraftSchema.parse(attachment)).toEqual(attachment);

    expect(() =>
      attachmentPickerRequestSchema.parse({
        ownerId: "owner-generation-1",
        sessionId: "draft-1",
        recursiveRead: true,
      }),
    ).toThrow();
    expect(() =>
      attachmentDraftSchema.parse({
        ...attachment,
        selectedPathToken: undefined,
      }),
    ).toThrow();
    expect(() =>
      attachmentDraftSchema.parse({ ...attachment, sendMode: undefined }),
    ).toThrow();
    expect(() =>
      attachmentDraftSchema.parse({ ...attachment, status: undefined }),
    ).toThrow();
    expect(() =>
      attachmentDraftSchema.parse({ ...attachment, kind: "directory" }),
    ).toThrow();
    expect(() =>
      attachmentDraftSchema.parse({
        ...attachment,
        sendMode: "inlineContents",
      }),
    ).toThrow();

    expect(
      attachmentReleaseRequestSchema.parse({
        ownerId: "runtime-1",
        selectedPathTokens: ["token-1"],
      }),
    ).toMatchObject({ ownerId: "runtime-1" });
    expect(
      attachmentAssignOwnerRequestSchema.parse({
        previousOwnerId: "owner-generation-1",
        previousSessionId: "draft-1",
        ownerId: "owner-generation-2",
        sessionId: "runtime-1",
        selectedPathTokens: ["token-1"],
      }),
    ).toMatchObject({
      previousOwnerId: "owner-generation-1",
      previousSessionId: "draft-1",
      ownerId: "owner-generation-2",
      sessionId: "runtime-1",
    });
    expect(
      attachmentReleaseOwnerRequestSchema.parse({ ownerId: "runtime-1" }),
    ).toEqual({ ownerId: "runtime-1" });
    expect(() =>
      attachmentReleaseRequestSchema.parse({ selectedPathTokens: ["token-1"] }),
    ).toThrow();
    expect(() =>
      attachmentAssignOwnerRequestSchema.parse({
        ownerId: "runtime-1",
        selectedPathTokens: ["token-1"],
      }),
    ).toThrow();
  });
});
