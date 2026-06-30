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

export const chatMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.string(),
    content: z.preprocess(
      (value) => extractTextContent(value),
      z.string().optional(),
    ),
    createdAt: z.number().optional(),
  })
  .passthrough();

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

export const chatPromptRequestSchema = z
  .object({
    runtimeId: z.string(),
    text: z.string().trim().min(1),
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
  chatPrompt: "chat:prompt",
  chatAbort: "chat:abort",
  chatReset: "chat:reset",
  chatEvent: "chat:event",
  projectPickFolder: "project:pickFolder",
  attachmentsPickFiles: "attachments:pickFiles",
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];
