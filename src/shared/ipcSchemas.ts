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
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];
