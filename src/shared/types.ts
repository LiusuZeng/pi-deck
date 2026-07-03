import type { z } from "zod";
import type {
  appSettingsSchema,
  attachmentDraftSchema,
  attachmentImportImageRequestSchema,
  chatListModelsResultSchema,
  chatListSessionsResultSchema,
  chatMessageSchema,
  chatModelSummarySchema,
  chatRuntimeEventSchema,
  chatSessionSummarySchema,
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
export type ChatSessionSummary = z.infer<typeof chatSessionSummarySchema>;
export type ChatModelSummary = z.infer<typeof chatModelSummarySchema>;
export type ChatListModelsResult = z.infer<typeof chatListModelsResultSchema>;
export type ChatListSessionsResult = z.infer<
  typeof chatListSessionsResultSchema
>;
export type ChatRuntimeEvent = z.infer<typeof chatRuntimeEventSchema>;
export type ProjectRef = z.infer<typeof projectRefSchema>;
export type PickProjectResult = z.infer<typeof pickProjectResultSchema>;
export type AttachmentDraft = z.infer<typeof attachmentDraftSchema>;
export type AttachmentImportImageRequest = z.infer<
  typeof attachmentImportImageRequestSchema
>;
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
    listSessions(): Promise<ChatListSessionsResult>;
    resumeSession(request: { sessionFile: string }): Promise<ChatSnapshot>;
    listModels(request: { runtimeId: string }): Promise<ChatListModelsResult>;
    setModel(request: {
      runtimeId: string;
      provider: string;
      modelId: string;
    }): Promise<ChatSnapshot>;
    setThinking(request: {
      runtimeId: string;
      level: string;
    }): Promise<ChatSnapshot>;
    prompt(request: {
      runtimeId: string;
      text: string;
      attachments?: Array<{
        selectedPathToken: string;
        sendMode: "imageInput" | "pathReference";
      }>;
    }): Promise<void>;
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
    importImages(
      request: AttachmentImportImageRequest,
    ): Promise<PickAttachmentsResult>;
  };
}
