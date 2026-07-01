import type { z } from "zod";
import type {
  appSettingsSchema,
  attachmentDraftSchema,
  chatMessageSchema,
  chatRuntimeEventSchema,
  chatSnapshotSchema,
  diagnosticsSummarySchema,
  ipcErrorSchema,
  pickAttachmentsResultSchema,
  pickProjectResultSchema,
  projectRefSchema,
} from "./ipcSchemas.js";

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type DiagnosticsSummary = z.infer<typeof diagnosticsSummarySchema>;
export type IpcErrorPayload = z.infer<typeof ipcErrorSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;
export type ChatRuntimeEvent = z.infer<typeof chatRuntimeEventSchema>;
export type ProjectRef = z.infer<typeof projectRefSchema>;
export type PickProjectResult = z.infer<typeof pickProjectResultSchema>;
export type AttachmentDraft = z.infer<typeof attachmentDraftSchema>;
export type PickAttachmentsResult = z.infer<typeof pickAttachmentsResultSchema>;

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
    createSession(): Promise<ChatSnapshot>;
    reset(): Promise<ChatSnapshot>;
    onEvent(listener: (event: ChatRuntimeEvent) => void): () => void;
  };
  projects: {
    pickProject(): Promise<PickProjectResult>;
  };
  attachments: {
    pickFiles(request?: {
      projectPath?: string;
    }): Promise<PickAttachmentsResult>;
  };
}
