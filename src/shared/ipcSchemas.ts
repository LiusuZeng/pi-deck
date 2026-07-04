import { z } from "zod";

const appSettingsShape = {
  piBinaryPath: z.string().min(1).optional(),
  agentDir: z.string().min(1).optional(),
  sessionDir: z.string().min(1).optional(),
  maxRunningSessions: z.number().int().min(1).max(20),
  warmWorkerLimit: z.number().int().min(0).max(20),
  enableLoginShellEnvCapture: z.boolean(),
} satisfies z.ZodRawShape;

export const appSettingsSchema = z
  .object({
    ...appSettingsShape,
    maxRunningSessions: appSettingsShape.maxRunningSessions.default(4),
    warmWorkerLimit: appSettingsShape.warmWorkerLimit.default(1),
    enableLoginShellEnvCapture:
      appSettingsShape.enableLoginShellEnvCapture.default(true),
  })
  .strict();

export const appSettingsPatchSchema = z
  .object(appSettingsShape)
  .partial()
  .strict();

export const diagnosticsSummarySchema = z
  .object({
    appVersion: z.string(),
    userDataPath: z.string(),
    logPath: z.string(),
    settings: appSettingsSchema,
    recentErrors: z.array(z.string()),
  })
  .strict();

export const chatImageAttachmentSchema = z
  .object({
    id: z.string().optional(),
    fileName: z.string().optional(),
    mimeType: z.string(),
    dataBase64: z.string(),
  })
  .strict();

export const chatMessageSchema = z.preprocess(
  (value) => normalizeChatMessage(value),
  z
    .object({
      id: z.string().optional(),
      role: z.string(),
      content: z.string().optional(),
      imageAttachments: z.array(chatImageAttachmentSchema).optional(),
      createdAt: z.number().optional(),
    })
    .passthrough(),
);

function normalizeChatMessage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const content = extractTextContent(record.content);
  const imageAttachments = extractImageAttachments(record.content);
  return {
    ...record,
    ...(content !== undefined ? { content } : {}),
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
  };
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((item): string[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") {
      return [record.text];
    }
    return [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractImageAttachments(value: unknown): Array<{
  id?: string;
  fileName?: string;
  mimeType: string;
  dataBase64: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "image") {
      return [];
    }
    const mimeType =
      typeof record.mimeType === "string" ? record.mimeType : undefined;
    const dataBase64 =
      typeof record.data === "string"
        ? record.data
        : typeof record.dataBase64 === "string"
          ? record.dataBase64
          : undefined;
    if (mimeType === undefined || dataBase64 === undefined) {
      return [];
    }
    return [
      {
        id: typeof record.id === "string" ? record.id : `image-${index}`,
        ...(typeof record.fileName === "string"
          ? { fileName: record.fileName }
          : {}),
        mimeType,
        dataBase64,
      },
    ];
  });
}

export const chatStateSchema = z
  .object({
    runtimeId: z.string().optional(),
    sessionId: z.string().optional(),
    sessionFile: z.string().optional(),
    cwd: z.string().optional(),
    model: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    provider: z.string().optional(),
    thinkingLevel: z.string().optional(),
    isAgentActive: z.boolean().optional(),
  })
  .passthrough();

export const chatSnapshotSchema = z
  .object({
    runtimeId: z.string(),
    backendMode: z.enum(["fake", "real"]),
    state: chatStateSchema,
    messages: z.array(chatMessageSchema),
  })
  .strict();

export const chatSessionSummarySchema = z
  .object({
    id: z.string(),
    sessionFile: z.string(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    title: z.string(),
    updatedAtMs: z.number(),
    createdAtMs: z.number().optional(),
    messageCount: z.number().int().min(0),
    preview: z.string().optional(),
    attachedRuntimeId: z.string().optional(),
  })
  .strict();

export const chatListSessionsResultSchema = z
  .object({
    projectCwd: z.string(),
    sessionDir: z.string().optional(),
    sessions: z.array(chatSessionSummarySchema),
    diagnostics: z.array(z.string()),
  })
  .strict();

export const chatResumeSessionRequestSchema = z
  .object({
    sessionFile: z.string().min(1),
  })
  .strict();

export const chatDeleteSessionRequestSchema = z
  .object({
    sessionFile: z.string().min(1),
  })
  .strict();

export const chatDeleteSessionResultSchema = z
  .object({
    deleted: z.literal(true),
    sessionFile: z.string(),
  })
  .strict();

export const chatDeleteAllSessionsResultSchema = z
  .object({
    deleted: z.literal(true),
    deletedCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
  })
  .strict();

export const chatModelSummarySchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    provider: z.string().optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.string()).optional(),
    contextWindow: z.number().optional(),
  })
  .passthrough();

export const chatListModelsRequestSchema = z
  .object({
    runtimeId: z.string(),
  })
  .strict();

export const chatListModelsResultSchema = z
  .object({
    models: z.array(chatModelSummarySchema),
  })
  .strict();

export const chatSetModelRequestSchema = z
  .object({
    runtimeId: z.string(),
    provider: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict();

export const chatSetThinkingRequestSchema = z
  .object({
    runtimeId: z.string(),
    level: z.string().min(1),
  })
  .strict();

export const chatPromptAttachmentSchema = z
  .object({
    selectedPathToken: z.string().min(1),
    sendMode: z.enum(["imageInput", "pathReference"]),
  })
  .strict();

export const chatPromptRequestSchema = z
  .object({
    runtimeId: z.string(),
    text: z.string().trim().min(1),
    attachments: z.array(chatPromptAttachmentSchema).optional(),
  })
  .strict();

export const chatAbortRequestSchema = z
  .object({
    runtimeId: z.string(),
  })
  .strict();

export const chatRuntimeEventSchema = z
  .object({
    type: z.string(),
    runtimeId: z.string(),
  })
  .passthrough();

export const projectRefSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    canonicalPath: z.string(),
    displayName: z.string(),
    lastOpenedAt: z.number(),
    invalidReason: z.string().optional(),
  })
  .strict();

export const pickProjectResultSchema = z.discriminatedUnion("selected", [
  z.object({ selected: z.literal(false) }).strict(),
  z.object({ selected: z.literal(true), project: projectRefSchema }).strict(),
]);

export const attachmentPickerRequestSchema = z
  .object({
    projectPath: z.string().optional(),
  })
  .strict();

export const attachmentDraftSchema = z
  .object({
    id: z.string(),
    selectedPathToken: z.string(),
    fileName: z.string(),
    displayPath: z.string(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    kind: z.enum(["image", "textFile", "binaryFile"]),
    sendMode: z.enum(["imageInput", "pathReference"]),
    outsideProject: z.boolean(),
    status: z.enum(["ready", "missing", "unreadable"]),
    warning: z.string().optional(),
    previewDataUrl: z.string().optional(),
  })
  .strict();

export const attachmentImportImageRequestSchema = z
  .object({
    images: z
      .array(
        z
          .object({
            fileName: z.string().min(1),
            mimeType: z.string().min(1),
            size: z.number().int().nonnegative(),
            dataBase64: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const pickAttachmentsResultSchema = z.discriminatedUnion("selected", [
  z.object({ selected: z.literal(false) }).strict(),
  z
    .object({
      selected: z.literal(true),
      attachments: z.array(attachmentDraftSchema),
    })
    .strict(),
]);

export const ipcErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    issues: z.unknown().optional(),
  })
  .strict();

export const apiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    z.object({ ok: z.literal(false), error: ipcErrorSchema }).strict(),
  ]);

export const noPayloadSchema = z.undefined();

export const ipcChannels = {
  appGetVersion: "app:getVersion",
  appGetDiagnosticsSummary: "app:getDiagnosticsSummary",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  chatGetSnapshot: "chat:getSnapshot",
  chatListSessions: "chat:listSessions",
  chatResumeSession: "chat:resumeSession",
  chatDeleteSession: "chat:deleteSession",
  chatDeleteAllSessions: "chat:deleteAllSessions",
  chatPrompt: "chat:prompt",
  chatAbort: "chat:abort",
  chatListModels: "chat:listModels",
  chatSetModel: "chat:setModel",
  chatSetThinking: "chat:setThinking",
  chatCreateSession: "chat:createSession",
  chatReset: "chat:reset",
  chatEvent: "chat:event",
  projectPickFolder: "project:pickFolder",
  attachmentsPickFiles: "attachments:pickFiles",
  attachmentsImportImages: "attachments:importImages",
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];
