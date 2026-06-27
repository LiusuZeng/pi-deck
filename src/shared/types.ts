import type { z } from "zod";
import type {
  appSettingsSchema,
  diagnosticsSummarySchema,
  ipcErrorSchema,
} from "./ipcSchemas.js";

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type DiagnosticsSummary = z.infer<typeof diagnosticsSummarySchema>;
export type IpcErrorPayload = z.infer<typeof ipcErrorSchema>;

export interface PiDeckApi {
  app: {
    getVersion(): Promise<string>;
    getDiagnosticsSummary(): Promise<DiagnosticsSummary>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
}
