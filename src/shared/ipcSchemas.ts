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
    id: z.string(),
    role: z.string(),
    content: z.string().optional(),
    createdAt: z.number().optional(),
  })
  .passthrough();

export const chatStateSchema = z
  .object({
    runtimeId: z.string().optional(),
    sessionId: z.string().optional(),
    sessionFile: z.string().optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    thinkingLevel: z.string().optional(),
    isAgentActive: z.boolean().optional(),
  })
  .passthrough();

export const chatSnapshotSchema = z
  .object({
    runtimeId: z.string(),
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
  chatEvent: "chat:event",
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];
