import { describe, expect, it } from "vitest";
import {
  apiResponseSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  attachmentDraftSchema,
  attachmentImportDroppedFilesRequestSchema,
  attachmentImportImageRequestSchema,
  attachmentPickerRequestSchema,
  chatDeleteSessionRequestSchema,
  chatMessageSchema,
  chatPromptRequestSchema,
  pickProjectResultSchema,
  projectRefSchema,
} from "./ipcSchemas.js";

describe("IPC schemas", () => {
  it("applies settings defaults and caps running sessions at 20", () => {
    expect(appSettingsSchema.parse({})).toMatchObject({
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: true,
    });
    expect(appSettingsPatchSchema.parse({})).toEqual({});
    expect(() =>
      appSettingsPatchSchema.parse({ maxRunningSessions: 21 }),
    ).toThrow();
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

  it("validates delete session requests", () => {
    expect(
      chatDeleteSessionRequestSchema.parse({
        sessionFile: "/tmp/session.jsonl",
      }),
    ).toEqual({ sessionFile: "/tmp/session.jsonl" });
    expect(() => chatDeleteSessionRequestSchema.parse({})).toThrow();
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
  });

  it("validates dropped regular file path import payloads", () => {
    expect(
      attachmentImportDroppedFilesRequestSchema.parse({
        paths: ["/tmp/a.txt", "/tmp/b.bin"],
        projectPath: "/tmp",
      }),
    ).toEqual({ paths: ["/tmp/a.txt", "/tmp/b.bin"], projectPath: "/tmp" });

    expect(() =>
      attachmentImportDroppedFilesRequestSchema.parse({ paths: [] }),
    ).toThrow();
    expect(() =>
      attachmentImportDroppedFilesRequestSchema.parse({
        paths: ["/tmp/a.txt"],
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
      }),
    ).toMatchObject({ images: [{ fileName: "screenshot.png" }] });

    expect(() =>
      attachmentImportImageRequestSchema.parse({
        images: [{ fileName: "x.png", mimeType: "image/png", path: "/tmp/x" }],
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
      attachmentPickerRequestSchema.parse({ projectPath: "/project" }),
    ).toEqual({
      projectPath: "/project",
    });
    expect(attachmentDraftSchema.parse(attachment)).toEqual(attachment);

    expect(() =>
      attachmentPickerRequestSchema.parse({ recursiveRead: true }),
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
  });
});
