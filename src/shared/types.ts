import type { z } from "zod";
import type {
  appSettingsSchema,
  attachmentDraftSchema,
  attachmentImportDroppedFilesRequestSchema,
  attachmentImportImageRequestSchema,
  chatDeleteAllSessionsRequestSchema,
  chatDeleteAllSessionsResultSchema,
  chatDeleteSessionResultSchema,
  chatListModelsResultSchema,
  chatListSessionsRequestSchema,
  chatListSessionsResultSchema,
  chatMessageSchema,
  chatModelSummarySchema,
  chatRuntimeEventSchema,
  chatSessionSummarySchema,
  chatSnapshotRequestSchema,
  chatSnapshotSchema,
  diagnosticsSummarySchema,
  ipcErrorSchema,
  pickAttachmentsResultSchema,
  pickProjectResultSchema,
  projectListResultSchema,
  projectRefSchema,
} from "./ipcSchemas.js";

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type DiagnosticsSummary = z.infer<typeof diagnosticsSummarySchema>;
export type IpcErrorPayload = z.infer<typeof ipcErrorSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatSnapshotRequest = z.infer<typeof chatSnapshotRequestSchema>;
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;
export type ChatSessionSummary = z.infer<typeof chatSessionSummarySchema>;
export type ChatModelSummary = z.infer<typeof chatModelSummarySchema>;
export type ChatListModelsResult = z.infer<typeof chatListModelsResultSchema>;
export type ChatListSessionsRequest = z.infer<
  typeof chatListSessionsRequestSchema
>;
export type ChatDeleteSessionResult = z.infer<
  typeof chatDeleteSessionResultSchema
>;
export type ChatDeleteAllSessionsRequest = z.infer<
  typeof chatDeleteAllSessionsRequestSchema
>;
export type ChatDeleteAllSessionsResult = z.infer<
  typeof chatDeleteAllSessionsResultSchema
>;
export type ChatListSessionsResult = z.infer<
  typeof chatListSessionsResultSchema
>;
export type ChatRuntimeEvent = z.infer<typeof chatRuntimeEventSchema>;
export type ProjectRef = z.infer<typeof projectRefSchema>;
export type ProjectListResult = z.infer<typeof projectListResultSchema>;
export type PickProjectResult = z.infer<typeof pickProjectResultSchema>;
export type AttachmentDraft = z.infer<typeof attachmentDraftSchema>;
export type AttachmentImportDroppedFilesRequest = z.infer<
  typeof attachmentImportDroppedFilesRequestSchema
>;
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
    getSnapshot(request?: ChatSnapshotRequest): Promise<ChatSnapshot>;
    listSessions(
      request?: ChatListSessionsRequest,
    ): Promise<ChatListSessionsResult>;
    resumeSession(request: {
      projectId?: string;
      sessionFile: string;
    }): Promise<ChatSnapshot>;
    deleteSession(request: {
      projectId?: string;
      sessionFile: string;
    }): Promise<ChatDeleteSessionResult>;
    deleteAllSessions(
      request?: ChatDeleteAllSessionsRequest,
    ): Promise<ChatDeleteAllSessionsResult>;
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
    createSession(request?: { projectId?: string }): Promise<ChatSnapshot>;
    reset(): Promise<ChatSnapshot>;
    onEvent(listener: (event: ChatRuntimeEvent) => void): () => void;
  };
  projects: {
    list(): Promise<ProjectListResult>;
    getActive(): Promise<ProjectListResult>;
    select(request: { projectId: string }): Promise<ProjectListResult>;
    pickProject(): Promise<PickProjectResult>;
  };
  attachments: {
    pickFiles(request?: {
      projectPath?: string;
    }): Promise<PickAttachmentsResult>;
    importDroppedFiles(
      files: File[],
      request?: { projectPath?: string },
    ): Promise<PickAttachmentsResult>;
    importImages(
      request: AttachmentImportImageRequest,
    ): Promise<PickAttachmentsResult>;
  };
}
