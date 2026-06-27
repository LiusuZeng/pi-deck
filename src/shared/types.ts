import type { z } from "zod";
import type {
  appSettingsSchema,
  chatMessageSchema,
  chatRuntimeEventSchema,
  chatSnapshotSchema,
  diagnosticsSummarySchema,
  ipcErrorSchema,
} from "./ipcSchemas.js";

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type DiagnosticsSummary = z.infer<typeof diagnosticsSummarySchema>;
export type IpcErrorPayload = z.infer<typeof ipcErrorSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;
export type ChatRuntimeEvent = z.infer<typeof chatRuntimeEventSchema>;

export interface PiDeckApi {
  app: {
    getVersion(): Promise<string>;
    getDiagnosticsSummary(): Promise<DiagnosticsSummary>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  chat: {
    getSnapshot(): Promise<ChatSnapshot>;
    prompt(request: { runtimeId: string; text: string }): Promise<void>;
    abort(request: { runtimeId: string }): Promise<void>;
    onEvent(listener: (event: ChatRuntimeEvent) => void): () => void;
  };
}
