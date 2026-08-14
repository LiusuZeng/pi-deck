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
  workspaceArchiveSessionRequestSchema,
  workspaceArchiveRequestSchema,
  workspaceCreateRequestSchema,
  workspaceListResultSchema,
  workspaceListSessionsRequestSchema,
  workspaceMoveSessionRequestSchema,
  workspaceRemoveSessionRequestSchema,
  workspaceRestoreSessionRequestSchema,
  workspaceRestoreRequestSchema,
  workspaceSelectRequestSchema,
  workspaceSessionMutationResultSchema,
  workspaceUpdateRequestSchema,
} from "../shared/ipcSchemas.js";
import {
  workflowApproveGateRequestSchema,
  workflowArchiveTemplateRequestSchema,
  workflowCreateTemplateRequestSchema,
  workflowDuplicateTemplateRequestSchema,
  workflowEventSchema,
  workflowGetRunRequestSchema,
  workflowGetTemplateRequestSchema,
  workflowListRunsRequestSchema,
  workflowRetryStepRequestSchema,
  workflowRetryConditionRequestSchema,
  workflowOverrideConditionRequestSchema,
  workflowRunListResultSchema,
  workflowRunSchema,
  workflowStartRunRequestSchema,
  workflowStopRunRequestSchema,
  workflowTemplateListResultSchema,
  workflowTemplateSchema,
  workflowUpdateTemplateRequestSchema,
} from "../shared/workflowSchemas.js";
import {
  canonicalWorkflowEventSchema,
  canonicalWorkflowGetRunRequestSchema,
  canonicalWorkflowHumanAnswerRequestSchema,
  canonicalWorkflowListRunsRequestSchema,
  canonicalWorkflowOccurrenceRequestSchema,
  canonicalWorkflowStartRunRequestSchema,
  workflowGraphEventSchema,
  workflowGraphSnapshotRequestSchema,
  workflowGraphSnapshotSchema,
  workflowGraphSubscriptionRequestSchema,
  workflowCreateRequestSchema,
  workflowListRequestSchema,
  workflowScopedDefinitionSchema,
  workflowRunEnvelopeSchema,
  workflowUpdateRequestSchema,
} from "../shared/agentWorkflowSchemas.js";
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
  WorkspaceArchiveSessionRequest,
  WorkspaceCreateRequest,
  WorkspaceListSessionsRequest,
  WorkspaceMoveSessionRequest,
  WorkspaceRemoveSessionRequest,
  WorkspaceRestoreSessionRequest,
  WorkspaceUpdateRequest,
  WorkflowApproveGateRequest,
  WorkflowRetryConditionRequest,
  WorkflowOverrideConditionRequest,
  WorkflowCreateRequest,
  WorkflowCreateTemplateRequest,
  WorkflowListRequest,
  WorkflowUpdateRequest,
  WorkflowStartRunRequest,
  WorkflowUpdateTemplateRequest,
  WorkflowEvent,
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
    restore: (request: { workspaceId: string }) =>
      invokeValidated({
        channel: ipcChannels.workspaceRestore,
        request: workspaceRestoreRequestSchema.parse(request),
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
    archiveSession: (request: WorkspaceArchiveSessionRequest) =>
      invokeValidated({
        channel: ipcChannels.workspaceArchiveSession,
        request: workspaceArchiveSessionRequestSchema.parse(request),
        responseSchema: workspaceSessionMutationResultSchema,
      }),
    restoreSession: (request: WorkspaceRestoreSessionRequest) =>
      invokeValidated({
        channel: ipcChannels.workspaceRestoreSession,
        request: workspaceRestoreSessionRequestSchema.parse(request),
        responseSchema: workspaceSessionMutationResultSchema,
      }),
    listSessions: (request: WorkspaceListSessionsRequest) =>
      invokeValidated({
        channel: ipcChannels.workspaceListSessions,
        request: workspaceListSessionsRequestSchema.parse(request),
        responseSchema: chatListSessionsResultSchema,
      }),
    listUnassignedSessions: () =>
      invokeValidated({
        channel: ipcChannels.workspaceListUnassignedSessions,
        request: undefined,
        responseSchema: chatListSessionsResultSchema,
      }),
  }),
  workflows: Object.freeze({
    listWorkflows: (request: WorkflowListRequest) =>
      invokeValidated({
        channel: ipcChannels.workflowListWorkflows,
        request: workflowListRequestSchema.parse(request),
        responseSchema: workflowScopedDefinitionSchema.array(),
      }),
    createWorkflow: (request: WorkflowCreateRequest) =>
      invokeValidated({
        channel: ipcChannels.workflowCreateWorkflow,
        request: workflowCreateRequestSchema.parse(request),
        responseSchema: workflowScopedDefinitionSchema,
      }),
    updateWorkflow: (request: WorkflowUpdateRequest) =>
      invokeValidated({
        channel: ipcChannels.workflowUpdateWorkflow,
        request: workflowUpdateRequestSchema.parse(request),
        responseSchema: workflowScopedDefinitionSchema,
      }),
    canonicalListRuns: (request?: { workspaceId?: string }) =>
      invokeValidated({
        channel: ipcChannels.canonicalWorkflowListRuns,
        request: canonicalWorkflowListRunsRequestSchema.parse(request),
        responseSchema: workflowRunEnvelopeSchema.array(),
      }),
    canonicalGetRun: (request: { runId: string }) =>
      invokeValidated({
        channel: ipcChannels.canonicalWorkflowGetRun,
        request: canonicalWorkflowGetRunRequestSchema.parse(request),
        responseSchema: workflowRunEnvelopeSchema,
      }),
    graphGetSnapshot: (request: { runId: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowGraphGetSnapshot,
        request: workflowGraphSnapshotRequestSchema.parse(request),
        responseSchema: workflowGraphSnapshotSchema,
      }),
    graphSubscribe: (request: { runId: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowGraphSubscribe,
        request: workflowGraphSubscriptionRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    graphUnsubscribe: (request: { runId: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowGraphUnsubscribe,
        request: workflowGraphSubscriptionRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    onGraphEvent: (
      listener: (
        event: import("../shared/agentWorkflowSchemas.js").WorkflowGraphEvent,
      ) => void,
    ) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const parsed = workflowGraphEventSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(ipcChannels.workflowGraphEvent, wrapped);
      return () => ipcRenderer.off(ipcChannels.workflowGraphEvent, wrapped);
    },
    canonicalStartRun: (request: {
      workflowId: string;
      workspaceId: string;
      inputs?: Record<string, string>;
    }) =>
      invokeValidated({
        channel: ipcChannels.canonicalWorkflowStartRun,
        request: canonicalWorkflowStartRunRequestSchema.parse(request),
        responseSchema: workflowRunEnvelopeSchema,
      }),
    canonicalStopRun: (request: { runId: string }) =>
      invokeValidated({
        channel: ipcChannels.canonicalWorkflowStopRun,
        request: canonicalWorkflowGetRunRequestSchema.parse(request),
        responseSchema: workflowRunEnvelopeSchema,
      }),
    canonicalRetryOccurrence: (request: {
      runId: string;
      occurrenceId: string;
    }) =>
      invokeValidated({
        channel: ipcChannels.canonicalWorkflowRetryOccurrence,
        request: canonicalWorkflowOccurrenceRequestSchema.parse(request),
        responseSchema: workflowRunEnvelopeSchema,
      }),
    canonicalAnswerHuman: (request: {
      runId: string;
      occurrenceId: string;
      value: string | boolean;
    }) =>
      invokeValidated({
        channel: ipcChannels.canonicalWorkflowAnswerHuman,
        request: canonicalWorkflowHumanAnswerRequestSchema.parse(request),
        responseSchema: workflowRunEnvelopeSchema,
      }),
    onCanonicalEvent: (
      listener: (
        event: import("../shared/agentWorkflowSchemas.js").CanonicalWorkflowEvent,
      ) => void,
    ) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const parsed = canonicalWorkflowEventSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(ipcChannels.canonicalWorkflowEvent, wrapped);
      return () => ipcRenderer.off(ipcChannels.canonicalWorkflowEvent, wrapped);
    },
    getTemplate: (request: { templateId: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowGetTemplate,
        request: workflowGetTemplateRequestSchema.parse(request),
        responseSchema: workflowTemplateSchema,
      }),
    listTemplates: () =>
      invokeValidated({
        channel: ipcChannels.workflowListTemplates,
        request: undefined,
        responseSchema: workflowTemplateListResultSchema,
      }),
    createTemplate: (request: WorkflowCreateTemplateRequest) =>
      invokeValidated({
        channel: ipcChannels.workflowCreateTemplate,
        request: workflowCreateTemplateRequestSchema.parse(request),
        responseSchema: workflowTemplateSchema,
      }),
    updateTemplate: (request: WorkflowUpdateTemplateRequest) =>
      invokeValidated({
        channel: ipcChannels.workflowUpdateTemplate,
        request: workflowUpdateTemplateRequestSchema.parse(request),
        responseSchema: workflowTemplateSchema,
      }),
    archiveTemplate: (request: { templateId: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowArchiveTemplate,
        request: workflowArchiveTemplateRequestSchema.parse(request),
        responseSchema: workflowTemplateSchema,
      }),
    duplicateTemplate: (request: { templateId: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowDuplicateTemplate,
        request: workflowDuplicateTemplateRequestSchema.parse(request),
        responseSchema: workflowTemplateSchema,
      }),
    listRuns: (request?: { workspaceId?: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowListRuns,
        request: workflowListRunsRequestSchema.parse(request),
        responseSchema: workflowRunListResultSchema,
      }),
    getRun: (request: { runId: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowGetRun,
        request: workflowGetRunRequestSchema.parse(request),
        responseSchema: workflowRunSchema,
      }),
    startRun: (request: WorkflowStartRunRequest) =>
      invokeValidated({
        channel: ipcChannels.workflowStartRun,
        request: workflowStartRunRequestSchema.parse(request),
        responseSchema: workflowRunSchema,
      }),
    stopRun: (request: { runId: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowStopRun,
        request: workflowStopRunRequestSchema.parse(request),
        responseSchema: workflowRunSchema,
      }),
    retryStep: (request: { runId: string; stepRunId: string }) =>
      invokeValidated({
        channel: ipcChannels.workflowRetryStep,
        request: workflowRetryStepRequestSchema.parse(request),
        responseSchema: workflowRunSchema,
      }),
    retryCondition: (request: WorkflowRetryConditionRequest) =>
      invokeValidated({
        channel: ipcChannels.workflowRetryCondition,
        request: workflowRetryConditionRequestSchema.parse(request),
        responseSchema: workflowRunSchema,
      }),
    overrideCondition: (request: WorkflowOverrideConditionRequest) =>
      invokeValidated({
        channel: ipcChannels.workflowOverrideCondition,
        request: workflowOverrideConditionRequestSchema.parse(request),
        responseSchema: workflowRunSchema,
      }),
    approveGate: (request: WorkflowApproveGateRequest) =>
      invokeValidated({
        channel: ipcChannels.workflowApproveGate,
        request: workflowApproveGateRequestSchema.parse(request),
        responseSchema: workflowRunSchema,
      }),
    onEvent: (listener: (event: WorkflowEvent) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const parsed = workflowEventSchema.safeParse(payload);
        if (!parsed.success) {
          console.warn("Dropping invalid workflow IPC event", parsed.error);
          return;
        }
        listener(parsed.data);
      };
      ipcRenderer.on(ipcChannels.workflowEvent, wrapped);
      return () => ipcRenderer.off(ipcChannels.workflowEvent, wrapped);
    },
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
