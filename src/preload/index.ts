import { contextBridge, ipcRenderer, webUtils } from "electron";
import { z, type ZodType } from "zod";
import {
  apiResponseSchema,
  appBootstrapStateSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  attachmentAssignOwnerRequestSchema,
  attachmentImportDroppedFilesRequestSchema,
  attachmentImportImageRequestSchema,
  attachmentPickerRequestSchema,
  attachmentReleaseOwnerRequestSchema,
  attachmentReleaseRequestSchema,
  chatAbortRequestSchema,
  chatCloseSessionRequestSchema,
  chatInterventionRequestSchema,
  chatDeleteAllSessionsRequestSchema,
  chatDeleteAllSessionsResultSchema,
  chatDeleteSessionRequestSchema,
  chatDeleteSessionResultSchema,
  chatListCommandsRequestSchema,
  chatListCommandsResultSchema,
  chatListModelsRequestSchema,
  chatListModelsResultSchema,
  chatListSessionsRequestSchema,
  chatListSessionsResultSchema,
  chatPromptRequestSchema,
  chatResumeSessionRequestSchema,
  chatRespondToExtensionUiRequestSchema,
  chatSetModelRequestSchema,
  chatSetThinkingRequestSchema,
  chatRuntimeEventSchema,
  chatRuntimeStatusRequestSchema,
  chatRuntimeStatusSchema,
  chatCreateSessionRequestSchema,
  chatSnapshotRequestSchema,
  chatSnapshotSchema,
  diagnosticsSummarySchema,
  ipcChannels,
  pickAttachmentsResultSchema,
  pickProjectResultSchema,
  projectListResultSchema,
  projectSelectRequestSchema,
  workspaceAddSessionRequestSchema,
  workspaceArchiveRequestSchema,
  workspaceCreateRequestSchema,
  workspaceListResultSchema,
  workspaceMoveSessionRequestSchema,
  workspaceRemoveSessionRequestSchema,
  workspaceSelectRequestSchema,
  workspaceSessionMutationResultSchema,
  workspaceUpdateRequestSchema,
} from "../shared/ipcSchemas.js";
import type {
  AppSettings,
  AttachmentAssignOwnerRequest,
  AttachmentImportImageRequest,
  AttachmentReleaseOwnerRequest,
  AttachmentReleaseRequest,
  ChatInterventionRequest,
  ChatRespondToExtensionUiRequest,
  ChatRuntimeEvent,
  PiDeckApi,
  WorkspaceAddSessionRequest,
  WorkspaceCreateRequest,
  WorkspaceMoveSessionRequest,
  WorkspaceRemoveSessionRequest,
  WorkspaceUpdateRequest,
} from "../shared/types.js";

async function invokeValidated<TRequest, TResponse>(options: {
  channel: string;
  request: TRequest;
  responseSchema: ZodType<TResponse>;
}): Promise<TResponse> {
  const rawResponse: unknown = await ipcRenderer.invoke(
    options.channel,
    options.request,
  );
  const response = apiResponseSchema(options.responseSchema).parse(rawResponse);

  if (!response.ok) {
    const error = new Error(response.error.message);
    error.name = response.error.code;
    throw error;
  }

  return response.data;
}

const api: PiDeckApi = Object.freeze({
  app: Object.freeze({
    getVersion: () =>
      invokeValidated({
        channel: ipcChannels.appGetVersion,
        request: undefined,
        responseSchema: z.string(),
      }),
    getDiagnosticsSummary: () =>
      invokeValidated({
        channel: ipcChannels.appGetDiagnosticsSummary,
        request: undefined,
        responseSchema: diagnosticsSummarySchema,
      }),
    getBootstrapState: () =>
      invokeValidated({
        channel: ipcChannels.appGetBootstrapState,
        request: undefined,
        responseSchema: appBootstrapStateSchema,
      }),
  }),
  settings: Object.freeze({
    get: () =>
      invokeValidated({
        channel: ipcChannels.settingsGet,
        request: undefined,
        responseSchema: appSettingsSchema,
      }),
    update: (patch: Partial<AppSettings>) =>
      invokeValidated({
        channel: ipcChannels.settingsUpdate,
        request: appSettingsPatchSchema.parse(patch),
        responseSchema: appSettingsSchema,
      }),
  }),
  chat: Object.freeze({
    getSnapshot: (request?: { runtimeId?: string }) =>
      invokeValidated({
        channel: ipcChannels.chatGetSnapshot,
        request: chatSnapshotRequestSchema.parse(request),
        responseSchema: chatSnapshotSchema,
      }),
    getRuntimeStatus: (request: { runtimeId: string }) =>
      invokeValidated({
        channel: ipcChannels.chatGetRuntimeStatus,
        request: chatRuntimeStatusRequestSchema.parse(request),
        responseSchema: chatRuntimeStatusSchema,
      }),
    listSessions: (request?: { workspaceId?: string; projectId?: string }) =>
      invokeValidated({
        channel: ipcChannels.chatListSessions,
        request: chatListSessionsRequestSchema.parse(request),
        responseSchema: chatListSessionsResultSchema,
      }),
    resumeSession: (request: {
      workspaceId?: string;
      projectId?: string;
      sessionFile: string;
    }) =>
      invokeValidated({
        channel: ipcChannels.chatResumeSession,
        request: chatResumeSessionRequestSchema.parse(request),
        responseSchema: chatSnapshotSchema,
      }),
    deleteSession: (request: {
      workspaceId?: string;
      projectId?: string;
      sessionFile: string;
    }) =>
      invokeValidated({
        channel: ipcChannels.chatDeleteSession,
        request: chatDeleteSessionRequestSchema.parse(request),
        responseSchema: chatDeleteSessionResultSchema,
      }),
    deleteAllSessions: (request?: {
      workspaceId?: string;
      projectId?: string;
    }) =>
      invokeValidated({
        channel: ipcChannels.chatDeleteAllSessions,
        request: chatDeleteAllSessionsRequestSchema.parse(request),
        responseSchema: chatDeleteAllSessionsResultSchema,
      }),
    listModels: (request: {
      runtimeId?: string;
      workspaceId?: string;
      projectId?: string;
    }) =>
      invokeValidated({
        channel: ipcChannels.chatListModels,
        request: chatListModelsRequestSchema.parse(request),
        responseSchema: chatListModelsResultSchema,
      }),
    listCommands: (request: { runtimeId: string }) =>
      invokeValidated({
        channel: ipcChannels.chatListCommands,
        request: chatListCommandsRequestSchema.parse(request),
        responseSchema: chatListCommandsResultSchema,
      }),
    setModel: (request: {
      runtimeId: string;
      provider: string;
      modelId: string;
    }) =>
      invokeValidated({
        channel: ipcChannels.chatSetModel,
        request: chatSetModelRequestSchema.parse(request),
        responseSchema: chatSnapshotSchema,
      }),
    setThinking: (request: { runtimeId: string; level: string }) =>
      invokeValidated({
        channel: ipcChannels.chatSetThinking,
        request: chatSetThinkingRequestSchema.parse(request),
        responseSchema: chatSnapshotSchema,
      }),
    prompt: (request: ChatInterventionRequest) =>
      invokeValidated({
        channel: ipcChannels.chatPrompt,
        request: chatPromptRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    steer: (request: ChatInterventionRequest) =>
      invokeValidated({
        channel: ipcChannels.chatSteer,
        request: chatInterventionRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    followUp: (request: ChatInterventionRequest) =>
      invokeValidated({
        channel: ipcChannels.chatFollowUp,
        request: chatInterventionRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    abort: (request: { runtimeId: string }) =>
      invokeValidated({
        channel: ipcChannels.chatAbort,
        request: chatAbortRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    respondToExtensionUi: (request: ChatRespondToExtensionUiRequest) =>
      invokeValidated({
        channel: ipcChannels.chatRespondToExtensionUi,
        request: chatRespondToExtensionUiRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    closeSession: (request: { runtimeId: string }) =>
      invokeValidated({
        channel: ipcChannels.chatCloseSession,
        request: chatCloseSessionRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    createSession: (request?: { workspaceId?: string; projectId?: string }) =>
      invokeValidated({
        channel: ipcChannels.chatCreateSession,
        request: chatCreateSessionRequestSchema.parse(request),
        responseSchema: chatSnapshotSchema,
      }),
    reset: () =>
      invokeValidated({
        channel: ipcChannels.chatReset,
        request: undefined,
        responseSchema: chatSnapshotSchema,
      }),
    onEvent: (listener: (event: ChatRuntimeEvent) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const parsed = chatRuntimeEventSchema.safeParse(payload);
        if (!parsed.success) {
          console.warn("Dropping invalid chat IPC event", parsed.error);
          return;
        }
        listener(parsed.data);
      };
      ipcRenderer.on(ipcChannels.chatEvent, wrapped);
      return () => {
        ipcRenderer.off(ipcChannels.chatEvent, wrapped);
      };
    },
  }),
  projects: Object.freeze({
    list: () =>
      invokeValidated({
        channel: ipcChannels.projectList,
        request: undefined,
        responseSchema: projectListResultSchema,
      }),
    getActive: () =>
      invokeValidated({
        channel: ipcChannels.projectGetActive,
        request: undefined,
        responseSchema: projectListResultSchema,
      }),
    select: (request: { projectId: string }) =>
      invokeValidated({
        channel: ipcChannels.projectSelect,
        request: projectSelectRequestSchema.parse(request),
        responseSchema: projectListResultSchema,
      }),
    pickProject: () =>
      invokeValidated({
        channel: ipcChannels.projectPickFolder,
        request: undefined,
        responseSchema: pickProjectResultSchema,
      }),
  }),
  workspaces: Object.freeze({
    list: () =>
      invokeValidated({
        channel: ipcChannels.workspaceList,
        request: undefined,
        responseSchema: workspaceListResultSchema,
      }),
    getActive: () =>
      invokeValidated({
        channel: ipcChannels.workspaceGetActive,
        request: undefined,
        responseSchema: workspaceListResultSchema,
      }),
    create: (request: WorkspaceCreateRequest) =>
      invokeValidated({
        channel: ipcChannels.workspaceCreate,
        request: workspaceCreateRequestSchema.parse(request),
        responseSchema: workspaceListResultSchema,
      }),
    update: (request: WorkspaceUpdateRequest) =>
      invokeValidated({
        channel: ipcChannels.workspaceUpdate,
        request: workspaceUpdateRequestSchema.parse(request),
        responseSchema: workspaceListResultSchema,
      }),
    select: (request: { workspaceId: string }) =>
      invokeValidated({
        channel: ipcChannels.workspaceSelect,
        request: workspaceSelectRequestSchema.parse(request),
        responseSchema: workspaceListResultSchema,
      }),
    archive: (request: { workspaceId: string }) =>
      invokeValidated({
        channel: ipcChannels.workspaceArchive,
        request: workspaceArchiveRequestSchema.parse(request),
        responseSchema: workspaceListResultSchema,
      }),
    addSession: (request: WorkspaceAddSessionRequest) =>
      invokeValidated({
        channel: ipcChannels.workspaceAddSession,
        request: workspaceAddSessionRequestSchema.parse(request),
        responseSchema: workspaceSessionMutationResultSchema,
      }),
    moveSession: (request: WorkspaceMoveSessionRequest) =>
      invokeValidated({
        channel: ipcChannels.workspaceMoveSession,
        request: workspaceMoveSessionRequestSchema.parse(request),
        responseSchema: workspaceSessionMutationResultSchema,
      }),
    removeSession: (request: WorkspaceRemoveSessionRequest) =>
      invokeValidated({
        channel: ipcChannels.workspaceRemoveSession,
        request: workspaceRemoveSessionRequestSchema.parse(request),
        responseSchema: workspaceSessionMutationResultSchema,
      }),
    listUnassignedSessions: () =>
      invokeValidated({
        channel: ipcChannels.workspaceListUnassignedSessions,
        request: undefined,
        responseSchema: chatListSessionsResultSchema,
      }),
  }),
  attachments: Object.freeze({
    pickFiles: (request: {
      projectPath?: string;
      workingDirectory?: string;
      ownerId: string;
      sessionId: string;
    }) =>
      invokeValidated({
        channel: ipcChannels.attachmentsPickFiles,
        request: attachmentPickerRequestSchema.parse(request),
        responseSchema: pickAttachmentsResultSchema,
      }),
    importDroppedFiles: (
      files: File[],
      request: {
        projectPath?: string;
        workingDirectory?: string;
        ownerId: string;
        sessionId: string;
      },
    ) => {
      const paths = files
        .map((file) => webUtils.getPathForFile(file))
        .filter((filePath) => filePath.length > 0);
      return invokeValidated({
        channel: ipcChannels.attachmentsImportDroppedFiles,
        request: attachmentImportDroppedFilesRequestSchema.parse({
          ...request,
          paths,
        }),
        responseSchema: pickAttachmentsResultSchema,
      });
    },
    importImages: (request: AttachmentImportImageRequest) =>
      invokeValidated({
        channel: ipcChannels.attachmentsImportImages,
        request: attachmentImportImageRequestSchema.parse(request),
        responseSchema: pickAttachmentsResultSchema,
      }),
    release: (request: AttachmentReleaseRequest) =>
      invokeValidated({
        channel: ipcChannels.attachmentsRelease,
        request: attachmentReleaseRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    releaseOwner: (request: AttachmentReleaseOwnerRequest) =>
      invokeValidated({
        channel: ipcChannels.attachmentsReleaseOwner,
        request: attachmentReleaseOwnerRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    assignOwner: (request: AttachmentAssignOwnerRequest) =>
      invokeValidated({
        channel: ipcChannels.attachmentsAssignOwner,
        request: attachmentAssignOwnerRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
  }),
});

contextBridge.exposeInMainWorld("piDeck", api);
