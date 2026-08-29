import type { z } from "zod";
import type {
  appBootstrapStateSchema,
  appSettingsSchema,
  attachmentAssignOwnerRequestSchema,
  attachmentDraftSchema,
  attachmentImportDroppedFilesRequestSchema,
  attachmentImportImageRequestSchema,
  attachmentReleaseOwnerRequestSchema,
  attachmentReleaseRequestSchema,
  chatCommandSummarySchema,
  chatCreateSessionRequestSchema,
  chatDeleteAllSessionsRequestSchema,
  chatDeleteAllSessionsResultSchema,
  chatDeleteSessionResultSchema,
  chatListCommandsRequestSchema,
  chatListCommandsResultSchema,
  chatListModelsResultSchema,
  chatListSessionsRequestSchema,
  chatListSessionsResultSchema,
  chatInterventionRequestSchema,
  chatMessageSchema,
  chatPromptDestinationSchema,
  chatPromptRequestSchema,
  chatModelSummarySchema,
  chatRuntimeEventSchema,
  chatRuntimeStatusRequestSchema,
  chatRuntimeStatusSchema,
  chatRuntimeUsageSchema,
  chatRespondToExtensionUiRequestSchema,
  chatSessionSummarySchema,
  chatSnapshotRequestSchema,
  chatSnapshotSchema,
  diagnosticsSummarySchema,
  ipcErrorSchema,
  multitaskModeRequestSchema,
  multitaskModeStateSchema,
  multitaskModeUpdateRequestSchema,
  multitaskSettingsRequestSchema,
  multitaskSettingsSchema,
  multitaskSettingsUpdateRequestSchema,
  multitaskStateEventSchema,
  multitaskTaskSummarySchema,
  parallelWorkerModelSchema,
  parallelWorkerSettingsSchema,
  pickAttachmentsResultSchema,
  pickProjectResultSchema,
  projectListResultSchema,
  projectRefSchema,
  themePreferenceSchema,
  workspaceAddSessionRequestSchema,
  workspaceArchiveSessionRequestSchema,
  workspaceCreateRequestSchema,
  workspaceListResultSchema,
  workspaceListSessionsRequestSchema,
  workspaceMoveSessionRequestSchema,
  workspaceRefSchema,
  workspaceRemoveSessionRequestSchema,
  workspaceRestoreSessionRequestSchema,
  workspaceSessionMutationResultSchema,
  workspaceRestoreRequestSchema,
  workspaceUpdateRequestSchema,
  workspaceUsageRequestSchema,
  workspaceUsageResultSchema,
  workspaceUsageTotalsSchema,
} from "./ipcSchemas.js";
import type {
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
  workflowTemplateDefinitionSchema,
  workflowTemplateListResultSchema,
  workflowTemplateSchema,
  workflowUpdateTemplateRequestSchema,
} from "./workflowSchemas.js";
import type {
  canonicalWorkflowEventSchema,
  canonicalWorkflowGetRunRequestSchema,
  canonicalWorkflowHumanAnswerRequestSchema,
  canonicalWorkflowListRunsRequestSchema,
  canonicalWorkflowOccurrenceRequestSchema,
  canonicalWorkflowStartRunRequestSchema,
  workflowGraphEventSchema,
  workflowGraphSnapshotRequestSchema,
  workflowGraphSnapshotSchema,
  workflowCreateRequestSchema,
  workflowDefinitionSchema,
  workflowListRequestSchema,
  workflowScopedDefinitionSchema,
  workflowRunEnvelopeSchema,
  workflowUpdateRequestSchema,
} from "./agentWorkflowSchemas.js";

export type CanonicalWorkflowRun = z.infer<typeof workflowRunEnvelopeSchema>;
export type CanonicalWorkflowStartRunRequest = z.infer<
  typeof canonicalWorkflowStartRunRequestSchema
>;
export type CanonicalWorkflowGetRunRequest = z.infer<
  typeof canonicalWorkflowGetRunRequestSchema
>;
export type CanonicalWorkflowOccurrenceRequest = z.infer<
  typeof canonicalWorkflowOccurrenceRequestSchema
>;
export type CanonicalWorkflowHumanAnswerRequest = z.infer<
  typeof canonicalWorkflowHumanAnswerRequestSchema
>;
export type CanonicalWorkflowEvent = z.infer<
  typeof canonicalWorkflowEventSchema
>;
export type WorkflowGraphSnapshot = z.infer<typeof workflowGraphSnapshotSchema>;
export type WorkflowGraphEvent = z.infer<typeof workflowGraphEventSchema>;
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppBootstrapState = z.infer<typeof appBootstrapStateSchema>;
export type DiagnosticsSummary = z.infer<typeof diagnosticsSummarySchema>;
export type IpcErrorPayload = z.infer<typeof ipcErrorSchema>;
export type MultitaskModeRequest = z.infer<typeof multitaskModeRequestSchema>;
export type MultitaskModeUpdateRequest = z.infer<
  typeof multitaskModeUpdateRequestSchema
>;
export type MultitaskModeState = z.infer<typeof multitaskModeStateSchema>;
export type MultitaskSettings = z.infer<typeof multitaskSettingsSchema>;
export type MultitaskSettingsRequest = z.infer<
  typeof multitaskSettingsRequestSchema
>;
export type MultitaskSettingsUpdateRequest = z.infer<
  typeof multitaskSettingsUpdateRequestSchema
>;
export type MultitaskTaskSummary = z.infer<typeof multitaskTaskSummarySchema>;
export type MultitaskStateEvent = z.infer<typeof multitaskStateEventSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatPromptDestination = z.infer<typeof chatPromptDestinationSchema>;
export type ParallelWorkerModel = z.infer<typeof parallelWorkerModelSchema>;
export type ParallelWorkerSettings = z.infer<
  typeof parallelWorkerSettingsSchema
>;
// Input keeps destination optional for callers upgrading from the legacy
// parent-only prompt contract; schema parsing supplies the parent default.
export type ChatPromptRequest = z.input<typeof chatPromptRequestSchema>;
export type ChatInterventionRequest = z.infer<
  typeof chatInterventionRequestSchema
>;
export type ChatCreateSessionRequest = z.infer<
  typeof chatCreateSessionRequestSchema
>;
export type ChatRespondToExtensionUiRequest = z.infer<
  typeof chatRespondToExtensionUiRequestSchema
>;
export type ChatSnapshotRequest = z.infer<typeof chatSnapshotRequestSchema>;
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;
export type ChatRuntimeStatusRequest = z.infer<
  typeof chatRuntimeStatusRequestSchema
>;
export type ChatRuntimeStatus = z.infer<typeof chatRuntimeStatusSchema>;
export type ChatRuntimeUsage = z.infer<typeof chatRuntimeUsageSchema>;
export type ChatSessionSummary = z.infer<typeof chatSessionSummarySchema>;
export type ChatModelSummary = z.infer<typeof chatModelSummarySchema>;
export type ChatListModelsResult = z.infer<typeof chatListModelsResultSchema>;
export type ChatCommandSummary = z.infer<typeof chatCommandSummarySchema>;
export type ChatListCommandsRequest = z.infer<
  typeof chatListCommandsRequestSchema
>;
export type ChatListCommandsResult = z.infer<
  typeof chatListCommandsResultSchema
>;
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
export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;
export type WorkspaceListResult = z.infer<typeof workspaceListResultSchema>;
export type WorkspaceCreateRequest = z.infer<
  typeof workspaceCreateRequestSchema
>;
export type WorkspaceRestoreRequest = z.infer<
  typeof workspaceRestoreRequestSchema
>;
export type WorkspaceUpdateRequest = z.infer<
  typeof workspaceUpdateRequestSchema
>;
export type WorkspaceAddSessionRequest = z.infer<
  typeof workspaceAddSessionRequestSchema
>;
export type WorkspaceArchiveSessionRequest = z.infer<
  typeof workspaceArchiveSessionRequestSchema
>;
export type WorkspaceRestoreSessionRequest = z.infer<
  typeof workspaceRestoreSessionRequestSchema
>;
export type WorkspaceListSessionsRequest = z.infer<
  typeof workspaceListSessionsRequestSchema
>;
export type WorkspaceMoveSessionRequest = z.infer<
  typeof workspaceMoveSessionRequestSchema
>;
export type WorkspaceRemoveSessionRequest = z.infer<
  typeof workspaceRemoveSessionRequestSchema
>;
export type WorkspaceSessionMutationResult = z.infer<
  typeof workspaceSessionMutationResultSchema
>;
export type WorkspaceUsageRequest = z.infer<typeof workspaceUsageRequestSchema>;
export type WorkspaceUsageTotals = z.infer<typeof workspaceUsageTotalsSchema>;
export type WorkspaceUsageResult = z.infer<typeof workspaceUsageResultSchema>;
export type AttachmentDraft = z.infer<typeof attachmentDraftSchema>;
export type AttachmentImportDroppedFilesRequest = z.infer<
  typeof attachmentImportDroppedFilesRequestSchema
>;
export type AttachmentImportImageRequest = z.infer<
  typeof attachmentImportImageRequestSchema
>;
export type AttachmentReleaseRequest = z.infer<
  typeof attachmentReleaseRequestSchema
>;
export type AttachmentReleaseOwnerRequest = z.infer<
  typeof attachmentReleaseOwnerRequestSchema
>;
export type AttachmentAssignOwnerRequest = z.infer<
  typeof attachmentAssignOwnerRequestSchema
>;
export type PickAttachmentsResult = z.infer<typeof pickAttachmentsResultSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowScopedDefinition = z.infer<
  typeof workflowScopedDefinitionSchema
>;
export type WorkflowListRequest = z.infer<typeof workflowListRequestSchema>;
export type WorkflowCreateRequest = z.infer<typeof workflowCreateRequestSchema>;
export type WorkflowUpdateRequest = z.infer<typeof workflowUpdateRequestSchema>;
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type WorkflowTemplateDefinition = z.infer<
  typeof workflowTemplateDefinitionSchema
>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
export type WorkflowTemplateListResult = z.infer<
  typeof workflowTemplateListResultSchema
>;
export type WorkflowRunListResult = z.infer<typeof workflowRunListResultSchema>;
export type WorkflowGetTemplateRequest = z.infer<
  typeof workflowGetTemplateRequestSchema
>;
export type WorkflowCreateTemplateRequest = z.infer<
  typeof workflowCreateTemplateRequestSchema
>;
export type WorkflowUpdateTemplateRequest = z.infer<
  typeof workflowUpdateTemplateRequestSchema
>;
export type WorkflowArchiveTemplateRequest = z.infer<
  typeof workflowArchiveTemplateRequestSchema
>;
export type WorkflowDuplicateTemplateRequest = z.infer<
  typeof workflowDuplicateTemplateRequestSchema
>;
export type WorkflowListRunsRequest = z.infer<
  typeof workflowListRunsRequestSchema
>;
export type WorkflowGetRunRequest = z.infer<typeof workflowGetRunRequestSchema>;
export type WorkflowStartRunRequest = z.infer<
  typeof workflowStartRunRequestSchema
>;
export type WorkflowStopRunRequest = z.infer<
  typeof workflowStopRunRequestSchema
>;
export type WorkflowRetryStepRequest = z.infer<
  typeof workflowRetryStepRequestSchema
>;
export type WorkflowRetryConditionRequest = z.infer<
  typeof workflowRetryConditionRequestSchema
>;
export type WorkflowOverrideConditionRequest = z.infer<
  typeof workflowOverrideConditionRequestSchema
>;
export type WorkflowApproveGateRequest = z.infer<
  typeof workflowApproveGateRequestSchema
>;

export interface PiDeckApi {
  app: {
    getVersion(): Promise<string>;
    getDiagnosticsSummary(): Promise<DiagnosticsSummary>;
    getBootstrapState(): Promise<AppBootstrapState>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  chat: {
    getSnapshot(request?: ChatSnapshotRequest): Promise<ChatSnapshot>;
    getRuntimeStatus(
      request: ChatRuntimeStatusRequest,
    ): Promise<ChatRuntimeStatus>;
    listSessions(
      request?: ChatListSessionsRequest,
    ): Promise<ChatListSessionsResult>;
    resumeSession(request: {
      workspaceId?: string;
      projectId?: string;
      sessionFile: string;
    }): Promise<ChatSnapshot>;
    deleteSession(request: {
      workspaceId?: string;
      projectId?: string;
      sessionFile: string;
    }): Promise<ChatDeleteSessionResult>;
    deleteAllSessions(
      request?: ChatDeleteAllSessionsRequest,
    ): Promise<ChatDeleteAllSessionsResult>;
    listModels(request: {
      runtimeId?: string;
      workspaceId?: string;
      projectId?: string;
    }): Promise<ChatListModelsResult>;
    listCommands(
      request: ChatListCommandsRequest,
    ): Promise<ChatListCommandsResult>;
    setModel(request: {
      runtimeId: string;
      provider: string;
      modelId: string;
    }): Promise<ChatSnapshot>;
    setThinking(request: {
      runtimeId: string;
      level: string;
    }): Promise<ChatSnapshot>;
    prompt(request: ChatPromptRequest): Promise<void>;
    steer(request: ChatInterventionRequest): Promise<void>;
    followUp(request: ChatInterventionRequest): Promise<void>;
    abort(request: { runtimeId: string }): Promise<void>;
    respondToExtensionUi(
      request: ChatRespondToExtensionUiRequest,
    ): Promise<void>;
    closeSession(request: { runtimeId: string }): Promise<void>;
    createSession(request?: ChatCreateSessionRequest): Promise<ChatSnapshot>;
    reset(): Promise<ChatSnapshot>;
    onEvent(listener: (event: ChatRuntimeEvent) => void): () => void;
  };
  projects: {
    list(): Promise<ProjectListResult>;
    getActive(): Promise<ProjectListResult>;
    select(request: { projectId: string }): Promise<ProjectListResult>;
    pickProject(): Promise<PickProjectResult>;
  };
  workspaces: {
    list(): Promise<WorkspaceListResult>;
    getActive(): Promise<WorkspaceListResult>;
    create(request: WorkspaceCreateRequest): Promise<WorkspaceListResult>;
    update(request: WorkspaceUpdateRequest): Promise<WorkspaceListResult>;
    select(request: { workspaceId: string }): Promise<WorkspaceListResult>;
    archive(request: { workspaceId: string }): Promise<WorkspaceListResult>;
    restore(request: { workspaceId: string }): Promise<WorkspaceListResult>;
    addSession(
      request: WorkspaceAddSessionRequest,
    ): Promise<WorkspaceSessionMutationResult>;
    moveSession(
      request: WorkspaceMoveSessionRequest,
    ): Promise<WorkspaceSessionMutationResult>;
    removeSession(
      request: WorkspaceRemoveSessionRequest,
    ): Promise<WorkspaceSessionMutationResult>;
    archiveSession(
      request: WorkspaceArchiveSessionRequest,
    ): Promise<WorkspaceSessionMutationResult>;
    restoreSession(
      request: WorkspaceRestoreSessionRequest,
    ): Promise<WorkspaceSessionMutationResult>;
    listSessions(
      request: WorkspaceListSessionsRequest,
    ): Promise<ChatListSessionsResult>;
    getUsage(request: WorkspaceUsageRequest): Promise<WorkspaceUsageResult>;
    listUnassignedSessions(): Promise<ChatListSessionsResult>;
  };
  workflows: {
    listWorkflows(
      request: WorkflowListRequest,
    ): Promise<WorkflowScopedDefinition[]>;
    canonicalListRuns(
      request?: z.infer<typeof canonicalWorkflowListRunsRequestSchema>,
    ): Promise<CanonicalWorkflowRun[]>;
    canonicalGetRun(
      request: CanonicalWorkflowGetRunRequest,
    ): Promise<CanonicalWorkflowRun>;
    graphGetSnapshot(request: {
      runId: string;
    }): Promise<WorkflowGraphSnapshot>;
    graphSubscribe(request: { runId: string }): Promise<void>;
    graphUnsubscribe(request: { runId: string }): Promise<void>;
    onGraphEvent(listener: (event: WorkflowGraphEvent) => void): () => void;
    canonicalStartRun(
      request: CanonicalWorkflowStartRunRequest,
    ): Promise<CanonicalWorkflowRun>;
    canonicalStopRun(
      request: CanonicalWorkflowGetRunRequest,
    ): Promise<CanonicalWorkflowRun>;
    canonicalRetryOccurrence(
      request: CanonicalWorkflowOccurrenceRequest,
    ): Promise<CanonicalWorkflowRun>;
    canonicalAnswerHuman(
      request: CanonicalWorkflowHumanAnswerRequest,
    ): Promise<CanonicalWorkflowRun>;
    onCanonicalEvent(
      listener: (event: CanonicalWorkflowEvent) => void,
    ): () => void;
    createWorkflow(
      request: WorkflowCreateRequest,
    ): Promise<WorkflowScopedDefinition>;
    updateWorkflow(
      request: WorkflowUpdateRequest,
    ): Promise<WorkflowScopedDefinition>;
    getTemplate(request: WorkflowGetTemplateRequest): Promise<WorkflowTemplate>;
    listTemplates(): Promise<WorkflowTemplateListResult>;
    createTemplate(
      request: WorkflowCreateTemplateRequest,
    ): Promise<WorkflowTemplate>;
    updateTemplate(
      request: WorkflowUpdateTemplateRequest,
    ): Promise<WorkflowTemplate>;
    archiveTemplate(
      request: WorkflowArchiveTemplateRequest,
    ): Promise<WorkflowTemplate>;
    duplicateTemplate(
      request: WorkflowDuplicateTemplateRequest,
    ): Promise<WorkflowTemplate>;
    listRuns(request?: WorkflowListRunsRequest): Promise<WorkflowRunListResult>;
    getRun(request: WorkflowGetRunRequest): Promise<WorkflowRun>;
    startRun(request: WorkflowStartRunRequest): Promise<WorkflowRun>;
    stopRun(request: WorkflowStopRunRequest): Promise<WorkflowRun>;
    retryStep(request: WorkflowRetryStepRequest): Promise<WorkflowRun>;
    retryCondition(
      request: WorkflowRetryConditionRequest,
    ): Promise<WorkflowRun>;
    overrideCondition(
      request: WorkflowOverrideConditionRequest,
    ): Promise<WorkflowRun>;
    approveGate(request: WorkflowApproveGateRequest): Promise<WorkflowRun>;
    onEvent(listener: (event: WorkflowEvent) => void): () => void;
  };
  multitask: {
    getMode(request: MultitaskModeRequest): Promise<MultitaskStateEvent>;
    updateMode(
      request: MultitaskModeUpdateRequest,
    ): Promise<MultitaskStateEvent>;
    getSettings(request: MultitaskSettingsRequest): Promise<MultitaskSettings>;
    updateSettings(
      request: MultitaskSettingsUpdateRequest,
    ): Promise<MultitaskSettings>;
    onState(listener: (event: MultitaskStateEvent) => void): () => void;
  };
  attachments: {
    pickFiles(request: {
      projectPath?: string;
      workingDirectory?: string;
      ownerId: string;
      sessionId: string;
    }): Promise<PickAttachmentsResult>;
    importDroppedFiles(
      files: File[],
      request: {
        projectPath?: string;
        workingDirectory?: string;
        ownerId: string;
        sessionId: string;
      },
    ): Promise<PickAttachmentsResult>;
    importImages(
      request: AttachmentImportImageRequest,
    ): Promise<PickAttachmentsResult>;
    release(request: AttachmentReleaseRequest): Promise<void>;
    releaseOwner(request: AttachmentReleaseOwnerRequest): Promise<void>;
    assignOwner(request: AttachmentAssignOwnerRequest): Promise<void>;
  };
}
