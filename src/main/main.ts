import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  shell,
  session,
  nativeImage,
  webContents,
  type OpenDialogOptions,
} from "electron";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
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
  chatCreateSessionRequestSchema,
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
  chatSnapshotRequestSchema,
  chatSnapshotSchema,
  diagnosticsSummarySchema,
  ipcChannels,
  noPayloadSchema,
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
  multitaskModeRequestSchema,
  multitaskModeUpdateRequestSchema,
  multitaskSettingsRequestSchema,
  multitaskSettingsSchema,
  multitaskSettingsUpdateRequestSchema,
  multitaskStateEventSchema,
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
  workflowTemplateDefinitionSchema,
  workflowTemplateListResultSchema,
  workflowTemplateSchema,
  workflowUpdateTemplateRequestSchema,
} from "../shared/workflowSchemas.js";
import {
  canonicalWorkflowGetRunRequestSchema,
  canonicalWorkflowHumanAnswerRequestSchema,
  canonicalWorkflowListRunsRequestSchema,
  canonicalWorkflowOccurrenceRequestSchema,
  canonicalWorkflowStartRunRequestSchema,
  workflowCreateRequestSchema,
  workflowDefinitionSchema,
  workflowGraphSnapshotRequestSchema,
  workflowGraphSnapshotSchema,
  workflowGraphSubscriptionRequestSchema,
  workflowListRequestSchema,
  workflowScopedDefinitionSchema,
  workflowRunEnvelopeSchema,
  workflowUpdateRequestSchema,
  type WorkflowRunEnvelope,
} from "../shared/agentWorkflowSchemas.js";
import { deriveWorkflowGraphSnapshot } from "./workflows/workflowGraphSnapshot.js";
import { WorkflowGraphSubscriptions } from "./workflows/workflowGraphSubscriptions.js";
import type {
  AppBootstrapState,
  AppSettings,
  AttachmentDraft,
  ChatCommandSummary,
  ChatDeleteAllSessionsResult,
  ChatDeleteSessionResult,
  ChatListCommandsResult,
  ChatListSessionsResult,
  ChatRespondToExtensionUiRequest,
  ChatRuntimeStatus,
  ChatSessionSummary,
  ChatSnapshot,
  PickAttachmentsResult,
  ProjectRef,
  PickProjectResult,
  WorkspaceListResult,
  WorkspaceRef,
  WorkflowRun,
} from "../shared/types.js";
import { DiagnosticsService } from "./diagnostics/diagnostics.js";
import { registerValidatedIpc } from "./ipc/registerIpc.js";
import {
  discoverPiModels,
  discoverPiRuntimeModels,
  parsePiRuntimeModelDiscovery,
} from "./pi/modelDiscovery.js";
import { SinglePiAdapter } from "./pi/piAdapter.js";
import { WorkerCapacity, WorkerCapacityError } from "./pi/workerCapacity.js";
import { selectAvailableRuntime } from "./runtimeSelection.js";
import {
  readPiSessionSummary,
  scanSessionRepository,
  validatePiSession,
  validatePiSessionFile,
} from "./pi/sessionRepository.js";
import type { PiMessage, PiState, PromptInput } from "./pi/types.js";
import type {
  AppPiSettings,
  EffectivePiConfigResult,
} from "./platform/piEnvironment.js";
import { RealChatLaunchConfigCache } from "./platform/realChatLaunchConfigCache.js";
import {
  buildContentSecurityPolicy,
  buildSecureWebPreferences,
  isAllowedExternalUrl,
  shouldAllowNavigation,
} from "./security.js";
import { ProjectStore, resolvePiDeckHome } from "./projects/projectStore.js";
import {
  WorkspaceStore,
  type WorkspaceRecord,
} from "./workspaces/workspaceStore.js";
import { SettingsStore } from "./settings/settingsStore.js";
import {
  applyThemePreference,
  effectiveWindowBackground,
  updateWindowBackground,
} from "./theme.js";
import { formatCanonicalFileReference } from "./attachments.js";
import { MultitaskStateStore } from "./multitask/multitaskStateStore.js";
import {
  DelegationBridgeServer,
  type DelegateRequest,
} from "./multitask/delegationBridgeServer.js";
import {
  writeDeckDelegateAcceptanceHarness,
  writeDeckDelegateExtension,
  DECK_DELEGATE_CAPABILITY_ENV,
  DECK_DELEGATE_ENDPOINT_ENV,
  DECK_DELEGATE_PARENT_RUNTIME_ENV,
} from "./multitask/deckDelegateExtensionGenerator.js";
import {
  MultitaskSupervisor,
  type ChildWorkerCallbacks,
  type ParentTaskNotification,
} from "./multitask/multitaskSupervisor.js";
import { PersistedRuntimeResumeGuard } from "./multitask/persistedRuntimeResumeGuard.js";
import {
  TaskSessionOrchestrator,
  type PersistedTaskSessionTask,
  type TaskSessionLaunch,
  type TaskSessionWorkerSettings,
} from "./multitask/taskSessionOrchestrator.js";
import { TaskSessionMainStateStore } from "./multitask/taskSessionMainStateStore.js";
import {
  boundedParentContext,
  buildTaskSessionPlannerPrompt,
  fallbackTaskSessionPlan,
  parseTaskSessionPlannerResponse,
  resolveTaskSessionPlannerTimeoutMs,
  TASK_SESSION_PLANNER_MAX_TASKS,
} from "./multitask/taskSessionPlanner.js";
import { deliverWithAttachmentConsumption } from "./attachmentDelivery.js";
import {
  approveWorkflowStep,
  createWorkflowRun,
  retryWorkflowStep,
  retryWorkflowCondition,
  overrideWorkflowCondition,
  stopWorkflowRun,
} from "./workflows/workflowEngine.js";
import {
  rehydrateWorkflowRuns as rehydratePersistedWorkflowRuns,
  rehydrateCanonicalWorkflowRuns,
} from "./workflows/workflowRehydration.js";
import { WorkflowStore } from "./workflows/workflowStore.js";
import { createWorkflowRoleRun } from "./workflows/agentWorkflowRuntime.js";
import {
  initializeWorkflows,
  requireAgentWorkflows,
  type WorkflowInitialization,
} from "./workflows/workflowAvailability.js";
import {
  WorkflowOccurrenceScheduler,
  WorkflowScheduler,
  type WorkflowRuntimeEvent,
} from "./workflows/workflowScheduler.js";
import {
  AttachmentSelectionStore,
  type AttachmentSelectionEntry,
} from "./attachmentSelectionStore.js";
import {
  assertImagePromptPermitted,
  decodeImageBase64,
  inspectImage,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  type SupportedImageMimeType,
} from "./imagePolicy.js";

const isDev = process.env.VITE_DEV_SERVER_URL !== undefined;
const managedRuntimeProjectId = "pi-deck:managed-runtime-context";
const managedRuntimeDirectoryName = "runtime-context";
const managedRuntimeProjectBrand = Symbol("managedRuntimeProject");

type ManagedRuntimeProjectRef = ProjectRef & {
  readonly [managedRuntimeProjectBrand]: true;
};

let mainWindow: BrowserWindow | undefined;
let settingsStore: SettingsStore | undefined;
let projectStore: ProjectStore | undefined;
let workspaceStore: WorkspaceStore | undefined;
let workflowInitialization: WorkflowInitialization<WorkflowStore> | undefined;
const realChatLaunchConfigCache = new RealChatLaunchConfigCache();
let diagnostics: DiagnosticsService | undefined;
let multitaskStateStore: MultitaskStateStore | undefined;
let taskSessionStateStore: TaskSessionMainStateStore | undefined;
// Snapshot reads happen often. A persisted session is rehydrated exactly once
// when attached; later reads must not close live private children.
const multitaskRuntimeResumeGuard = new PersistedRuntimeResumeGuard();
let delegationBridge: DelegationBridgeServer | undefined;
let delegationCredentials: { socketPath: string } | undefined;
let multitaskSupervisor:
  | MultitaskSupervisor<
      string,
      string,
      { close(): Promise<void>; provideInput(input: string): Promise<void> }
    >
  | undefined;
const delegateCalls = new Map<
  string,
  { connectionId: string; toolCallId: string }
>();
let nextDelegatedTaskNumber = 1;
let taskSessionOrchestrator:
  | TaskSessionOrchestrator<string, { close(): Promise<void> }>
  | undefined;
const taskSessionSettings = new Map<string, TaskSessionWorkerSettings>();
const taskSessionSynthesisTails = new Map<string, Promise<void>>();
type TaskSessionPlannerRun = {
  cancelled: boolean;
  cancel(): void;
  closeWorker?: () => Promise<void>;
};
// Planner workers are not task-session workers, so they need their own parent
// ownership registry for close/delete races and allocation timeouts.
const taskSessionPlannerRuns = new Map<string, Set<TaskSessionPlannerRun>>();
type ChatBackendMode = "fake" | "real";

let chatAdapter: SinglePiAdapter | undefined;
let chatAdapterPromise: Promise<SinglePiAdapter> | undefined;
let chatWorkerCapacity: WorkerCapacity | undefined;
let maxRunningWorkers = 1;
let chatRuntimeId: string | undefined;
let chatBackendMode: ChatBackendMode | undefined;
const chatRuntimeIds = new Set<string>();
const chatRuntimeModes = new Map<string, ChatBackendMode>();
const chatWorkerCwds = new Map<string, string>();
const chatRuntimeSessionFiles = new Map<string, string>();
const chatRuntimeProjectIds = new Map<string, string>();
const chatRuntimeWorkspaceIds = new Map<string, string>();
const chatSessionFileLocks = new Map<string, string>();
const chatSessionResumePromises = new Map<string, Promise<ChatSnapshot>>();
// A single-delete transaction may detach Pi before filesystem removal commits.
// Its worker-exit event must not revoke retryable composer selections.
const attachmentPreservingRuntimeClosures = new Set<string>();
const pendingExtensionUiRequests = new Map<
  string,
  Map<
    string,
    {
      method: "select" | "confirm" | "input" | "editor";
      timer?: NodeJS.Timeout;
    }
  >
>();
const extensionUiTimeoutGraceMs = 1_000;
let chatWorkerCreationTail: Promise<void> = Promise.resolve();
let chatEventUnsubscribe: (() => void) | undefined;
let selectedRealProjectCwd: string | undefined;
let isQuittingAfterChatWorkerCleanup = false;
let testProjectPickQueue: string[] | undefined;

let workflowScheduler: WorkflowScheduler | undefined;
let workflowOccurrenceScheduler: WorkflowOccurrenceScheduler | undefined;

const maxImportedImageBytes = MAX_IMAGE_BYTES;
const maxPromptImages = 10;
const maxReferencedFileWarningBytes = 100 * 1024 * 1024;
const maxRetainedAttachmentPayloadBytes = 64 * 1024 * 1024;
const attachmentSelections = new AttachmentSelectionStore({
  // This is the encoded base64 string retained in main, not the decoded image
  // size. Keep it well below Electron's practical process-memory headroom.
  maxSelections: 100,
  maxRetainedBytes: maxRetainedAttachmentPayloadBytes,
  ttlMs: 10 * 60 * 1_000,
});

async function bootstrap(): Promise<void> {
  const userDataOverride = process.env.PI_DECK_USER_DATA_DIR;
  if (userDataOverride !== undefined && userDataOverride.trim().length > 0) {
    app.setPath("userData", path.resolve(userDataOverride));
  }

  await app.whenReady();

  diagnostics = new DiagnosticsService(
    app.getVersion(),
    app.getPath("userData"),
  );
  await diagnostics.initialize();
  settingsStore = new SettingsStore(app.getPath("userData"), diagnostics);
  await settingsStore.loadIfNeeded();
  applyAppTheme(await settingsStore.get());
  nativeTheme.on("updated", () => {
    updateWindowBackground(mainWindow, nativeTheme);
  });
  projectStore = new ProjectStore(resolvePiDeckHome(process.env), diagnostics);
  multitaskStateStore = new MultitaskStateStore(app.getPath("userData"));
  taskSessionStateStore = new TaskSessionMainStateStore(
    app.getPath("userData"),
  );
  await Promise.all([
    multitaskStateStore.loadIfNeeded(),
    taskSessionStateStore.loadIfNeeded(),
  ]);
  await projectStore.loadIfNeeded();
  workspaceStore = new WorkspaceStore(
    resolvePiDeckHome(process.env),
    diagnostics,
  );
  await workspaceStore.loadIfNeeded();
  workflowInitialization = await initializeWorkflows(async () => {
    const store = new WorkflowStore(
      resolvePiDeckHome(process.env),
      diagnostics,
    );
    await store.loadIfNeeded();
    return store;
  });
  if (workflowInitialization.status === "available") {
    workflowScheduler = createWorkflowScheduler(settingsStore, diagnostics);
    workflowOccurrenceScheduler = createWorkflowOccurrenceScheduler(
      settingsStore,
      diagnostics,
    );
  } else {
    diagnostics.recordError(workflowInitialization.diagnostic);
  }
  const hadWorkspaceMetadata =
    (await workspaceStore.list()).workspaces.length > 0;
  await migrateLegacyProjectsToWorkspaces();
  // Keep a stable, folderless bucket for sessions that are not explicitly
  // grouped. On a fresh install it is the initial selection; real-mode users
  // retain their last active named workspace while still seeing the bucket.
  await workspaceStore.ensureDefaultWorkspace({
    activate: !hadWorkspaceMetadata || resolveChatBackendMode() === "fake",
  });
  // Rehydrated canonical occurrences may immediately create Pi sessions. An
  // adapter is safe to initialize here (it creates no worker by itself), while
  // scheduling before it exists would turn resumable queued work into failure.
  await startDelegationBridge();
  await ensureChatAdapter(settingsStore, diagnostics);
  await rehydrateWorkflowRuns();

  configureCsp();
  registerIpcHandlers(settingsStore, diagnostics);
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

function createMainWindow(): void {
  const preloadPath = path.join(__dirname, "../preload/index.js");
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Pi Deck",
    backgroundColor: effectiveWindowBackground(nativeTheme),
    show: process.env.PI_DECK_E2E_HIDE_WINDOWS !== "1",
    webPreferences: buildSecureWebPreferences(preloadPath),
  });

  const appOrigin = isDev
    ? new URL(process.env.VITE_DEV_SERVER_URL as string).origin
    : "file://";

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!shouldAllowNavigation(targetUrl, appOrigin)) {
      event.preventDefault();
      if (isAllowedExternalUrl(targetUrl)) {
        void shell.openExternal(targetUrl);
      }
    }
  });

  registerDevReloadShortcut(mainWindow);

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function applyAppTheme(settings: AppSettings): void {
  applyThemePreference(nativeTheme, settings.theme);
  updateWindowBackground(mainWindow, nativeTheme);
}

function registerDevReloadShortcut(window: BrowserWindow): void {
  if (!isDev) {
    return;
  }

  window.webContents.on("before-input-event", (event, input) => {
    const isReloadKey = input.key.toLowerCase() === "r" || input.key === "F5";
    const hasReloadModifier = input.key === "F5" || input.meta || input.control;
    if (input.type !== "keyDown" || !isReloadKey || !hasReloadModifier) {
      return;
    }

    event.preventDefault();
    if (input.shift) {
      window.webContents.reloadIgnoringCache();
      return;
    }
    window.webContents.reload();
  });
}

function configureCsp(): void {
  const csp = buildContentSecurityPolicy(isDev);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

function registerIpcHandlers(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): void {
  registerValidatedIpc({
    channel: ipcChannels.appGetVersion,
    requestSchema: noPayloadSchema,
    responseSchema: z.string(),
    diagnostics: diagnosticsService,
    handler: () => app.getVersion(),
  });

  registerValidatedIpc({
    channel: ipcChannels.appGetDiagnosticsSummary,
    requestSchema: noPayloadSchema,
    responseSchema: diagnosticsSummarySchema,
    diagnostics: diagnosticsService,
    handler: async () => diagnosticsService.getSummary(await store.get()),
  });

  registerValidatedIpc({
    channel: ipcChannels.appGetBootstrapState,
    requestSchema: noPayloadSchema,
    responseSchema: appBootstrapStateSchema,
    diagnostics: diagnosticsService,
    handler: async () => getAppBootstrapState(store, diagnosticsService),
  });

  registerValidatedIpc({
    channel: ipcChannels.settingsGet,
    requestSchema: noPayloadSchema,
    responseSchema: appSettingsSchema,
    diagnostics: diagnosticsService,
    handler: async () => store.get(),
  });

  registerValidatedIpc({
    channel: ipcChannels.settingsUpdate,
    requestSchema: appSettingsPatchSchema,
    responseSchema: appSettingsSchema,
    diagnostics: diagnosticsService,
    handler: async (patch) => {
      const updated = await store.update(patch);
      applyAppTheme(updated);
      // App settings are an explicit configuration generation boundary.
      realChatLaunchConfigCache.clear();
      return updated;
    },
  });

  // Demo Slice chat bridge. Fake remains the default; PI_DECK_BACKEND=real
  // enables the narrow real `pi --mode rpc` vertical slice.
  registerValidatedIpc({
    channel: ipcChannels.chatGetSnapshot,
    requestSchema: chatSnapshotRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async (request) =>
      getChatSnapshot(store, diagnosticsService, request?.runtimeId),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatGetRuntimeStatus,
    requestSchema: chatRuntimeStatusRequestSchema,
    responseSchema: chatRuntimeStatusSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId }) => getChatRuntimeStatus(runtimeId),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatListSessions,
    requestSchema: chatListSessionsRequestSchema,
    responseSchema: chatListSessionsResultSchema,
    diagnostics: diagnosticsService,
    handler: async (request) =>
      request?.workspaceId
        ? listWorkspaceChatSessions(store, request.workspaceId)
        : listChatSessions(
            store,
            await authorizeRendererChatProject(request?.projectId),
          ),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatResumeSession,
    requestSchema: chatResumeSessionRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId, projectId, sessionFile }) => {
      const project = workspaceId
        ? await projectForWorkspaceSession(workspaceId, sessionFile)
        : await authorizeRendererChatProject(projectId);
      return resumeChatSession(
        store,
        diagnosticsService,
        sessionFile,
        project,
        workspaceId,
      );
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatDeleteSession,
    requestSchema: chatDeleteSessionRequestSchema,
    responseSchema: chatDeleteSessionResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId, projectId, sessionFile }) => {
      const project = workspaceId
        ? await projectForWorkspaceSession(workspaceId, sessionFile)
        : await authorizeRendererChatProject(projectId);
      return deleteChatSession(
        store,
        diagnosticsService,
        sessionFile,
        project,
        workspaceId,
      );
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatDeleteAllSessions,
    requestSchema: chatDeleteAllSessionsRequestSchema,
    responseSchema: chatDeleteAllSessionsResultSchema,
    diagnostics: diagnosticsService,
    handler: async (request) =>
      request?.workspaceId
        ? deleteAllWorkspaceChatSessions(
            store,
            diagnosticsService,
            request.workspaceId,
          )
        : deleteAllChatSessions(
            store,
            diagnosticsService,
            await authorizeRendererChatProject(request?.projectId),
          ),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatListModels,
    requestSchema: chatListModelsRequestSchema,
    responseSchema: chatListModelsResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, workspaceId, projectId }) =>
      listChatModels(
        store,
        diagnosticsService,
        runtimeId,
        workspaceId
          ? await resolveWorkspaceProject(workspaceId, projectId)
          : await authorizeRendererChatProject(projectId),
      ),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatListCommands,
    requestSchema: chatListCommandsRequestSchema,
    responseSchema: chatListCommandsResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId }) =>
      listChatCommands(store, diagnosticsService, runtimeId),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatSetModel,
    requestSchema: chatSetModelRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, provider, modelId }) =>
      setChatModel(store, diagnosticsService, runtimeId, provider, modelId),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatSetThinking,
    requestSchema: chatSetThinkingRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, level }) =>
      setChatThinking(store, diagnosticsService, runtimeId, level),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatPrompt,
    requestSchema: chatPromptRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({
      runtimeId,
      text,
      attachments,
      attachmentOwnerId,
      destination,
      workerOverrides,
    }) => {
      const adapter = await ensureChatAdapter(store, diagnosticsService);
      const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
      if (destination === "newTaskSession") {
        if ((attachments?.length ?? 0) > 0) {
          throw new Error(
            "Attachments are not supported for private task sessions.",
          );
        }
        const orchestrator = getTaskSessionOrchestrator(activeRuntimeId);
        if (orchestrator.state(activeRuntimeId).mode !== "parallel") {
          throw new Error(
            "New task sessions are available only in Parallel mode.",
          );
        }
        await orchestrator.submit(
          activeRuntimeId,
          text,
          toTaskSessionSettings(workerOverrides),
        );
        return undefined;
      }
      const promptAttachments = attachments ?? [];
      await deliverWithAttachmentConsumption({
        store: attachmentSelections,
        ownerId: attachmentOwnerId,
        selectedPathTokens: promptAttachments.map(
          (attachment) => attachment.selectedPathToken,
        ),
        deliver: async () =>
          queueTaskSessionParentTurn(activeRuntimeId, async () =>
            adapter.prompt(
              activeRuntimeId,
              await buildPromptInputWithImagePolicy(
                store,
                adapter,
                activeRuntimeId,
                text,
                promptAttachments,
                attachmentOwnerId,
              ),
            ),
          ),
      });
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatSteer,
    requestSchema: chatInterventionRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, text, attachments, attachmentOwnerId }) => {
      const adapter = await ensureChatAdapter(store, diagnosticsService);
      const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
      const promptAttachments = attachments ?? [];
      await deliverWithAttachmentConsumption({
        store: attachmentSelections,
        ownerId: attachmentOwnerId,
        selectedPathTokens: promptAttachments.map(
          (attachment) => attachment.selectedPathToken,
        ),
        deliver: async () =>
          adapter.steer(
            activeRuntimeId,
            await buildPromptInputWithImagePolicy(
              store,
              adapter,
              activeRuntimeId,
              text,
              promptAttachments,
              attachmentOwnerId,
            ),
          ),
      });
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatFollowUp,
    requestSchema: chatInterventionRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, text, attachments, attachmentOwnerId }) => {
      const adapter = await ensureChatAdapter(store, diagnosticsService);
      const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
      const promptAttachments = attachments ?? [];
      await deliverWithAttachmentConsumption({
        store: attachmentSelections,
        ownerId: attachmentOwnerId,
        selectedPathTokens: promptAttachments.map(
          (attachment) => attachment.selectedPathToken,
        ),
        deliver: async () =>
          // Follow-ups share the parent turn queue with synthesis. Steer is
          // intentionally not queued: it is an intervention in the live turn.
          queueTaskSessionParentTurn(activeRuntimeId, async () =>
            adapter.followUp(
              activeRuntimeId,
              await buildPromptInputWithImagePolicy(
                store,
                adapter,
                activeRuntimeId,
                text,
                promptAttachments,
                attachmentOwnerId,
              ),
            ),
          ),
      });
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatAbort,
    requestSchema: chatAbortRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId }) => {
      const adapter = await ensureChatAdapter(store, diagnosticsService);
      const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
      await adapter.abort(activeRuntimeId);
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatRespondToExtensionUi,
    requestSchema: chatRespondToExtensionUiRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async (request) => {
      await respondToExtensionUi(store, diagnosticsService, request);
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatCloseSession,
    requestSchema: chatCloseSessionRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId }) => {
      const adapter = await ensureChatAdapter(store, diagnosticsService);
      const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
      const status = await getChatRuntimeStatus(activeRuntimeId);
      if (status.state.isAgentActive) {
        throw new Error("Finish the active turn before closing this session.");
      }
      // Persist the latest session title/preview before an internal idle
      // shutdown. Without this read, a restored row can fall back to the
      // generated JSONL filename instead of the user's first prompt.
      try {
        await getChatSnapshotForRuntime(
          adapter,
          activeRuntimeId,
          chatRuntimeModes.get(activeRuntimeId) ?? resolveChatBackendMode(),
        );
      } catch (error) {
        diagnosticsService.recordError(
          `Could not refresh session metadata before closing runtime ${activeRuntimeId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await closeAttachedChatRuntime(adapter, activeRuntimeId);
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatCreateSession,
    requestSchema: chatCreateSessionRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async (request) => {
      const project = request?.workspaceId
        ? await resolveWorkspaceProject(request.workspaceId, request.projectId)
        : await authorizeRendererChatProject(request?.projectId);
      return createChatSessionSnapshot(
        store,
        diagnosticsService,
        project,
        request?.workspaceId,
        request?.multitaskMode,
      );
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatReset,
    requestSchema: noPayloadSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async () => {
      await closeChatWorker();
      // Reset is an explicit new-session action, unlike application bootstrap.
      return createChatSessionSnapshot(store, diagnosticsService);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.multitaskGetMode,
    requestSchema: multitaskModeRequestSchema,
    responseSchema: multitaskStateEventSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId }) => taskSessionState(runtimeId),
  });

  registerValidatedIpc({
    channel: ipcChannels.multitaskUpdateMode,
    requestSchema: multitaskModeUpdateRequestSchema,
    responseSchema: multitaskStateEventSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, mode }) => {
      const orchestrator = getTaskSessionOrchestrator(runtimeId);
      const legacySupervisor = await getMultitaskSupervisor(runtimeId);
      orchestrator.setMode(runtimeId, mode);
      legacySupervisor.setMode(runtimeId, mode);
      await Promise.all([
        persistTaskSession(runtimeId),
        persistMultitaskSupervisor(runtimeId),
      ]);
      emitTaskSessionState(runtimeId);
      return taskSessionState(runtimeId);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.multitaskGetSettings,
    requestSchema: multitaskSettingsRequestSchema,
    responseSchema: multitaskSettingsSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId }) => {
      getTaskSessionOrchestrator(runtimeId);
      return fromTaskSessionSettings(taskSessionSettings.get(runtimeId));
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.multitaskUpdateSettings,
    requestSchema: multitaskSettingsUpdateRequestSchema,
    responseSchema: multitaskSettingsSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, settings }) => {
      const orchestrator = getTaskSessionOrchestrator(runtimeId);
      const storedSettings = toTaskSessionSettings(settings);
      taskSessionSettings.set(runtimeId, storedSettings);
      orchestrator.updateWorkerSettings(runtimeId, storedSettings);
      const sessionFile = chatRuntimeSessionFiles.get(runtimeId);
      if (sessionFile)
        await taskSessionStateStore?.setSettings(sessionFile, storedSettings);
      emitTaskSessionState(runtimeId);
      await persistTaskSession(runtimeId);
      return fromTaskSessionSettings(storedSettings);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.projectList,
    requestSchema: noPayloadSchema,
    responseSchema: projectListResultSchema,
    diagnostics: diagnosticsService,
    handler: async () => ensureProjectStore().list(),
  });

  registerValidatedIpc({
    channel: ipcChannels.projectGetActive,
    requestSchema: noPayloadSchema,
    responseSchema: projectListResultSchema,
    diagnostics: diagnosticsService,
    handler: async () => ensureProjectStore().list(),
  });

  registerValidatedIpc({
    channel: ipcChannels.projectSelect,
    requestSchema: projectSelectRequestSchema,
    responseSchema: projectListResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ projectId }) => {
      const project = await ensureProjectStore().selectProject(projectId);
      selectedRealProjectCwd = project.canonicalPath;
      return ensureProjectStore().list();
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.projectPickFolder,
    requestSchema: noPayloadSchema,
    responseSchema: pickProjectResultSchema,
    diagnostics: diagnosticsService,
    handler: async (): Promise<PickProjectResult> => {
      const testProjectPath = nextTestProjectPickPath();
      if (testProjectPath !== undefined) {
        return pickProjectByPathForTest(testProjectPath, store);
      }

      const options: OpenDialogOptions = {
        title: "Open Pi Deck Project",
        properties: ["openDirectory"],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);

      if (result.canceled || result.filePaths.length === 0) {
        return { selected: false } as const;
      }

      const selectedPath = result.filePaths[0] as string;
      const canonicalPath = await fs.realpath(selectedPath);
      selectedRealProjectCwd = canonicalPath;
      await store.update({ projectCwd: canonicalPath });
      const project =
        await ensureProjectStore().upsertAndActivateProject(canonicalPath);
      return { selected: true, project };
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceList,
    requestSchema: noPayloadSchema,
    responseSchema: workspaceListResultSchema,
    diagnostics: diagnosticsService,
    handler: projectWorkspaceListResult,
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceGetActive,
    requestSchema: noPayloadSchema,
    responseSchema: workspaceListResultSchema,
    diagnostics: diagnosticsService,
    handler: projectWorkspaceListResult,
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceCreate,
    requestSchema: workspaceCreateRequestSchema,
    responseSchema: workspaceListResultSchema,
    diagnostics: diagnosticsService,
    handler: async (request) => {
      if (request.defaultProjectId !== undefined) {
        await ensureProjectStore().resolveAuthorizedProject(
          request.defaultProjectId,
        );
      }
      await ensureWorkspaceStore().create(request);
      return projectWorkspaceListResult();
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceUpdate,
    requestSchema: workspaceUpdateRequestSchema,
    responseSchema: workspaceListResultSchema,
    diagnostics: diagnosticsService,
    handler: async (request) => {
      if (typeof request.defaultProjectId === "string") {
        await ensureProjectStore().resolveAuthorizedProject(
          request.defaultProjectId,
        );
      }
      await ensureWorkspaceStore().update(request);
      return projectWorkspaceListResult();
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceSelect,
    requestSchema: workspaceSelectRequestSchema,
    responseSchema: workspaceListResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId }) => {
      const workspace = await ensureWorkspaceStore().select(workspaceId);
      if (workspace.defaultProjectId !== undefined) {
        try {
          const project = await ensureProjectStore().selectProject(
            workspace.defaultProjectId,
          );
          selectedRealProjectCwd = project.canonicalPath;
        } catch (error) {
          diagnosticsService.recordError(
            `Selected workspace ${workspace.id}, but its default working folder is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return projectWorkspaceListResult();
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceArchive,
    requestSchema: workspaceArchiveRequestSchema,
    responseSchema: workspaceListResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId }) => {
      if (
        [...chatRuntimeWorkspaceIds.entries()].some(
          ([runtimeId, ownerWorkspaceId]) =>
            ownerWorkspaceId === workspaceId && chatRuntimeIds.has(runtimeId),
        )
      ) {
        throw new Error(
          "Close attached sessions before archiving this workspace.",
        );
      }
      await ensureWorkspaceStore().archive(workspaceId);
      return projectWorkspaceListResult();
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceRestore,
    requestSchema: workspaceRestoreRequestSchema,
    responseSchema: workspaceListResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId }) => {
      await ensureWorkspaceStore().restore(workspaceId);
      // Workspace restoration is also a workflow lifecycle boundary. Runs
      // retained while the workspace was archived may be waiting or queued;
      // schedule them before returning so the renderer does not need a relaunch
      // (or a second workflow action) to resume them.
      await rehydrateWorkflowRuns(workspaceId);
      return projectWorkspaceListResult();
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceAddSession,
    requestSchema: workspaceAddSessionRequestSchema,
    responseSchema: workspaceSessionMutationResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId, sessionFile }) =>
      addSessionToWorkspace(store, workspaceId, sessionFile),
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceMoveSession,
    requestSchema: workspaceMoveSessionRequestSchema,
    responseSchema: workspaceSessionMutationResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ sessionFile, toWorkspaceId }) => {
      await requireOpenWorkspace(toWorkspaceId);
      const canonical =
        (await safeRealpath(sessionFile)) ?? path.resolve(sessionFile);
      if (chatSessionFileLocks.has(canonical)) {
        throw new Error(
          "Close the attached session before moving it to another workspace.",
        );
      }
      const moved = await ensureWorkspaceStore().moveSession(
        canonical,
        toWorkspaceId,
      );
      return { workspaceId: moved.workspaceId, sessionFile: moved.sessionFile };
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceRemoveSession,
    requestSchema: workspaceRemoveSessionRequestSchema,
    responseSchema: workspaceSessionMutationResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId, sessionFile }) => {
      const runtimeId = chatSessionFileLocks.get(
        (await safeRealpath(sessionFile)) ?? path.resolve(sessionFile),
      );
      if (runtimeId !== undefined) {
        throw new Error(
          "Close the attached session before removing it from a workspace.",
        );
      }
      await ensureWorkspaceStore().removeSession(workspaceId, sessionFile);
      return {
        workspaceId,
        sessionFile:
          (await safeRealpath(sessionFile)) ?? path.resolve(sessionFile),
      };
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceArchiveSession,
    requestSchema: workspaceArchiveSessionRequestSchema,
    responseSchema: workspaceSessionMutationResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId, sessionFile }) => {
      const canonical =
        (await safeRealpath(sessionFile)) ?? path.resolve(sessionFile);
      if (chatSessionFileLocks.has(canonical)) {
        throw new Error("Finish the attached session before archiving it.");
      }
      return ensureWorkspaceStore().archiveSession(workspaceId, canonical);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceRestoreSession,
    requestSchema: workspaceRestoreSessionRequestSchema,
    responseSchema: workspaceSessionMutationResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId, sessionFile }) =>
      ensureWorkspaceStore().restoreSession(workspaceId, sessionFile),
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceListSessions,
    requestSchema: workspaceListSessionsRequestSchema,
    responseSchema: chatListSessionsResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId, includeArchived }) =>
      listWorkspaceChatSessions(store, workspaceId, {
        ...(includeArchived !== undefined ? { includeArchived } : {}),
        discoverLegacySessions: false,
      }),
  });

  registerValidatedIpc({
    channel: ipcChannels.workspaceListUnassignedSessions,
    requestSchema: noPayloadSchema,
    responseSchema: chatListSessionsResultSchema,
    diagnostics: diagnosticsService,
    handler: async () => listUnassignedWorkspaceSessions(store),
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowListWorkflows,
    requestSchema: workflowListRequestSchema,
    responseSchema: workflowScopedDefinitionSchema.array(),
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId }) => {
      await requireOpenWorkspace(workspaceId);
      const workflowStore = ensureWorkflowStore();
      return Promise.all(
        (await workflowStore.listWorkflows(workspaceId)).map(
          async (workflow) => ({
            workflow,
            scopeWorkspaceId:
              (await workflowStore.getWorkflowScope(workflow.id)) ?? null,
          }),
        ),
      );
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowCreateWorkflow,
    requestSchema: workflowCreateRequestSchema,
    responseSchema: workflowScopedDefinitionSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId, scopeWorkspaceId, workflow }) => {
      await requireOpenWorkspace(workspaceId);
      if (scopeWorkspaceId !== undefined && scopeWorkspaceId !== null)
        await requireOpenWorkspace(scopeWorkspaceId);
      // Preserve the old IPC behavior for callers that omit this new field.
      const scope =
        scopeWorkspaceId === undefined ? workspaceId : scopeWorkspaceId;
      const saved = await ensureWorkflowStore().createWorkflow(
        workflow,
        scope ?? undefined,
      );
      return { workflow: saved, scopeWorkspaceId: scope ?? null };
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowUpdateWorkflow,
    requestSchema: workflowUpdateRequestSchema,
    responseSchema: workflowScopedDefinitionSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workspaceId, scopeWorkspaceId, workflow }) => {
      await requireOpenWorkspace(workspaceId);
      const workflowStore = ensureWorkflowStore();
      const existingScope = await workflowStore.getWorkflowScope(workflow.id);
      // An archived scope cannot be selected anew, but an existing saved scope
      // remains editable so archiving never strands its workflow document.
      if (
        scopeWorkspaceId !== undefined &&
        scopeWorkspaceId !== null &&
        scopeWorkspaceId !== existingScope
      )
        await requireOpenWorkspace(scopeWorkspaceId);
      const saved = await workflowStore.updateWorkflow(
        workflow,
        workspaceId,
        scopeWorkspaceId,
      );
      return {
        workflow: saved,
        scopeWorkspaceId:
          scopeWorkspaceId === undefined
            ? ((await workflowStore.getWorkflowScope(saved.id)) ?? null)
            : scopeWorkspaceId,
      };
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowGetTemplate,
    requestSchema: workflowGetTemplateRequestSchema,
    responseSchema: workflowTemplateSchema,
    diagnostics: diagnosticsService,
    handler: async ({ templateId }) => {
      const template = await ensureWorkflowStore().getTemplate(templateId);
      if (template.workspaceId !== undefined)
        await requireOpenWorkspace(template.workspaceId);
      return template;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowListTemplates,
    requestSchema: noPayloadSchema,
    responseSchema: workflowTemplateListResultSchema,
    diagnostics: diagnosticsService,
    handler: async () => {
      const workspaceId = (await ensureWorkspaceStore().getActiveWorkspace())
        ?.id;
      if (workspaceId !== undefined) await requireOpenWorkspace(workspaceId);
      return {
        templates: await ensureWorkflowStore().listTemplates(workspaceId),
      };
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowCreateTemplate,
    requestSchema: workflowCreateTemplateRequestSchema,
    responseSchema: workflowTemplateSchema,
    diagnostics: diagnosticsService,
    handler: async (definition) => {
      if (definition.workspaceId !== undefined)
        await requireOpenWorkspace(definition.workspaceId);
      return ensureWorkflowStore().createTemplate(definition);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowUpdateTemplate,
    requestSchema: workflowUpdateTemplateRequestSchema,
    responseSchema: workflowTemplateSchema,
    diagnostics: diagnosticsService,
    handler: async ({ templateId, ...definition }) => {
      if (definition.workspaceId !== undefined)
        await requireOpenWorkspace(definition.workspaceId);
      const current = await ensureWorkflowStore().getTemplate(templateId);
      if (current.workspaceId !== undefined)
        await requireOpenWorkspace(current.workspaceId);
      return ensureWorkflowStore().updateTemplate(templateId, definition);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowArchiveTemplate,
    requestSchema: workflowArchiveTemplateRequestSchema,
    responseSchema: workflowTemplateSchema,
    diagnostics: diagnosticsService,
    handler: async ({ templateId }) => {
      const template = await ensureWorkflowStore().getTemplate(templateId);
      if (template.workspaceId !== undefined)
        await requireOpenWorkspace(template.workspaceId);
      return ensureWorkflowStore().archiveTemplate(templateId);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowDuplicateTemplate,
    requestSchema: workflowDuplicateTemplateRequestSchema,
    responseSchema: workflowTemplateSchema,
    diagnostics: diagnosticsService,
    handler: async ({ templateId }) => {
      const template = await ensureWorkflowStore().getTemplate(templateId);
      if (template.workspaceId !== undefined)
        await requireOpenWorkspace(template.workspaceId);
      return ensureWorkflowStore().duplicateTemplate(templateId);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.canonicalWorkflowListRuns,
    requestSchema: canonicalWorkflowListRunsRequestSchema,
    responseSchema: workflowRunEnvelopeSchema.array(),
    diagnostics: diagnosticsService,
    handler: async (request) => {
      const workspaceId =
        request?.workspaceId ??
        (await ensureWorkspaceStore().getActiveWorkspace())?.id;
      if (!workspaceId)
        throw new Error("No workspace is selected for workflow runs.");
      await requireOpenWorkspace(workspaceId);
      return ensureWorkflowStore().listWorkflowRuns(workspaceId);
    },
  });
  registerValidatedIpc({
    channel: ipcChannels.canonicalWorkflowGetRun,
    requestSchema: canonicalWorkflowGetRunRequestSchema,
    responseSchema: workflowRunEnvelopeSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId }) => {
      const run = await ensureWorkflowStore().getWorkflowRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      return run;
    },
  });
  registerValidatedIpc({
    channel: ipcChannels.workflowGraphGetSnapshot,
    requestSchema: workflowGraphSnapshotRequestSchema,
    responseSchema: workflowGraphSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId }) => {
      const run = await ensureWorkflowStore().getWorkflowRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      return deriveWorkflowGraphSnapshot(run.definition, run);
    },
  });
  registerValidatedIpc({
    channel: ipcChannels.workflowGraphSubscribe,
    requestSchema: workflowGraphSubscriptionRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runId }, event) => {
      const run = await ensureWorkflowStore().getWorkflowRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      const senderId = event.sender.id;
      if (!graphRunSubscriptions.hasSender(senderId))
        event.sender.once("destroyed", () =>
          graphRunSubscriptions.removeSender(senderId),
        );
      graphRunSubscriptions.subscribe(senderId, runId, run.workspaceId);
    },
  });
  registerValidatedIpc({
    channel: ipcChannels.workflowGraphUnsubscribe,
    requestSchema: workflowGraphSubscriptionRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runId }, event) => {
      graphRunSubscriptions.unsubscribe(event.sender.id, runId);
    },
  });
  registerValidatedIpc({
    channel: ipcChannels.canonicalWorkflowStartRun,
    requestSchema: canonicalWorkflowStartRunRequestSchema,
    responseSchema: workflowRunEnvelopeSchema,
    diagnostics: diagnosticsService,
    handler: async ({ workflowId, workspaceId, inputs }) => {
      await requireOpenWorkspace(workspaceId);
      const definition = await ensureWorkflowStore().getWorkflowForWorkspace(
        workflowId,
        workspaceId,
      );
      const run = createWorkflowRoleRun(definition, workspaceId, inputs);
      const persisted = await ensureWorkflowStore().createWorkflowRun(run);
      emitCanonicalWorkflowRunEvent(persisted);
      return ensureWorkflowOccurrenceScheduler().schedule(persisted);
    },
  });
  registerValidatedIpc({
    channel: ipcChannels.canonicalWorkflowStopRun,
    requestSchema: canonicalWorkflowGetRunRequestSchema,
    responseSchema: workflowRunEnvelopeSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId }) => {
      const run = await ensureWorkflowStore().getWorkflowRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      return ensureWorkflowOccurrenceScheduler().stop(runId);
    },
  });
  registerValidatedIpc({
    channel: ipcChannels.canonicalWorkflowRetryOccurrence,
    requestSchema: canonicalWorkflowOccurrenceRequestSchema,
    responseSchema: workflowRunEnvelopeSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId, occurrenceId }) => {
      const run = await ensureWorkflowStore().getWorkflowRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      return ensureWorkflowOccurrenceScheduler().retry(runId, occurrenceId);
    },
  });
  registerValidatedIpc({
    channel: ipcChannels.canonicalWorkflowAnswerHuman,
    requestSchema: canonicalWorkflowHumanAnswerRequestSchema,
    responseSchema: workflowRunEnvelopeSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId, occurrenceId, value }) => {
      const run = await ensureWorkflowStore().getWorkflowRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      return ensureWorkflowOccurrenceScheduler().answerHuman(
        runId,
        occurrenceId,
        value,
      );
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowListRuns,
    requestSchema: workflowListRunsRequestSchema,
    responseSchema: workflowRunListResultSchema,
    diagnostics: diagnosticsService,
    handler: async (request) => {
      const workspaceId =
        request?.workspaceId ??
        (await ensureWorkspaceStore().getActiveWorkspace())?.id;
      if (workspaceId === undefined)
        throw new Error("No workspace is selected for workflow runs.");
      await requireOpenWorkspace(workspaceId);
      return { runs: await ensureWorkflowStore().listRuns(workspaceId) };
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowGetRun,
    requestSchema: workflowGetRunRequestSchema,
    responseSchema: workflowRunSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId }) => {
      const run = await ensureWorkflowStore().getRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      return run;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowStartRun,
    requestSchema: workflowStartRunRequestSchema,
    responseSchema: workflowRunSchema,
    diagnostics: diagnosticsService,
    handler: async ({ templateId, workspaceId, inputs }) => {
      const template = await ensureWorkflowStore().getTemplate(templateId);
      const resolvedWorkspaceId = await resolveWorkflowWorkspaceId(
        workspaceId,
        template.workspaceId,
      );
      await validateWorkflowPaths(
        template,
        inputs,
        await resolveWorkspaceProject(resolvedWorkspaceId),
      );
      const run = createWorkflowRun({
        template,
        workspaceId: resolvedWorkspaceId,
        inputs,
      });
      const persisted = await ensureWorkflowStore().createRun(run);
      emitWorkflowRunEvent(persisted);
      return ensureWorkflowScheduler().schedule(persisted);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowStopRun,
    requestSchema: workflowStopRunRequestSchema,
    responseSchema: workflowRunSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId }) => {
      const run = await ensureWorkflowStore().getRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      const updated = await ensureWorkflowStore().updateRun(
        stopWorkflowRun(run),
      );
      emitWorkflowRunEvent(updated);
      return ensureWorkflowScheduler().update(updated);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowRetryStep,
    requestSchema: workflowRetryStepRequestSchema,
    responseSchema: workflowRunSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId, stepRunId }) => {
      const run = await ensureWorkflowStore().getRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      const updated = await ensureWorkflowStore().updateRun(
        retryWorkflowStep(run, stepRunId),
      );
      emitWorkflowRunEvent(updated);
      return ensureWorkflowScheduler().update(updated);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowRetryCondition,
    requestSchema: workflowRetryConditionRequestSchema,
    responseSchema: workflowRunSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId, transitionRunId }) => {
      const run = await ensureWorkflowStore().getRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      const updated = await ensureWorkflowStore().updateRun(
        retryWorkflowCondition(run, transitionRunId),
      );
      emitWorkflowRunEvent(updated);
      return ensureWorkflowScheduler().update(updated);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowOverrideCondition,
    requestSchema: workflowOverrideConditionRequestSchema,
    responseSchema: workflowRunSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId, transitionRunId, decision, rationale }) => {
      const run = await ensureWorkflowStore().getRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      const updated = await ensureWorkflowStore().updateRun(
        overrideWorkflowCondition(run, transitionRunId, decision, rationale),
      );
      emitWorkflowRunEvent(updated);
      return ensureWorkflowScheduler().update(updated);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.workflowApproveGate,
    requestSchema: workflowApproveGateRequestSchema,
    responseSchema: workflowRunSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runId, stepRunId, action }) => {
      const run = await ensureWorkflowStore().getRun(runId);
      await requireOpenWorkspace(run.workspaceId);
      const updated = await ensureWorkflowStore().updateRun(
        approveWorkflowStep(run, stepRunId, action),
      );
      emitWorkflowRunEvent(updated);
      return ensureWorkflowScheduler().update(updated);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.attachmentsPickFiles,
    requestSchema: attachmentPickerRequestSchema,
    responseSchema: pickAttachmentsResultSchema,
    diagnostics: diagnosticsService,
    handler: async (request): Promise<PickAttachmentsResult> => {
      const options: OpenDialogOptions = {
        title: "Select files for Pi Deck",
        properties: ["openFile", "multiSelections"],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);

      if (result.canceled || result.filePaths.length === 0) {
        return { selected: false } as const;
      }

      const requestedWorkingDirectory =
        request.workingDirectory ?? request.projectPath;
      const projectRoot = requestedWorkingDirectory
        ? await safeRealpath(requestedWorkingDirectory)
        : undefined;

      return {
        selected: true,
        attachments: await buildAttachmentDrafts(
          [...new Set(result.filePaths)],
          projectRoot,
          request.ownerId,
          request.sessionId,
        ),
      };
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.attachmentsImportDroppedFiles,
    requestSchema: attachmentImportDroppedFilesRequestSchema,
    responseSchema: pickAttachmentsResultSchema,
    diagnostics: diagnosticsService,
    handler: async (request): Promise<PickAttachmentsResult> => {
      const requestedWorkingDirectory =
        request.workingDirectory ?? request.projectPath;
      const projectRoot = requestedWorkingDirectory
        ? await safeRealpath(requestedWorkingDirectory)
        : undefined;
      const uniquePaths = [
        ...new Set(request.paths.map((filePath) => path.resolve(filePath))),
      ];
      return {
        selected: true,
        attachments: await buildAttachmentDrafts(
          uniquePaths,
          projectRoot,
          request.ownerId,
          request.sessionId,
        ),
      };
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.attachmentsImportImages,
    requestSchema: attachmentImportImageRequestSchema,
    responseSchema: pickAttachmentsResultSchema,
    diagnostics: diagnosticsService,
    handler: (request): PickAttachmentsResult => ({
      selected: true,
      attachments: importImageAttachmentDrafts(
        request.images,
        request.ownerId,
        request.sessionId,
      ),
    }),
  });

  registerValidatedIpc({
    channel: ipcChannels.attachmentsRelease,
    requestSchema: attachmentReleaseRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: ({ selectedPathTokens, ownerId }) => {
      attachmentSelections.releaseOwned(ownerId, selectedPathTokens);
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.attachmentsReleaseOwner,
    requestSchema: attachmentReleaseOwnerRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: ({ ownerId }) => {
      attachmentSelections.releaseOwner(ownerId);
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.attachmentsAssignOwner,
    requestSchema: attachmentAssignOwnerRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: ({
      selectedPathTokens,
      previousOwnerId,
      previousSessionId,
      ownerId,
      sessionId,
    }) => {
      attachmentSelections.assignOwner(
        selectedPathTokens,
        previousOwnerId,
        previousSessionId,
        ownerId,
        sessionId,
      );
      attachmentPreservingRuntimeClosures.delete(previousSessionId);
      return undefined;
    },
  });
}

function ensureProjectStore(): ProjectStore {
  if (projectStore === undefined) {
    throw new Error("Project store is not initialized");
  }
  return projectStore;
}

function ensureWorkspaceStore(): WorkspaceStore {
  if (workspaceStore === undefined) {
    throw new Error("Workspace store is not initialized");
  }
  return workspaceStore;
}

function ensureWorkflowStore(): WorkflowStore {
  return requireAgentWorkflows(workflowInitialization);
}

function ensureWorkflowOccurrenceScheduler(): WorkflowOccurrenceScheduler {
  requireAgentWorkflows(workflowInitialization);
  if (workflowOccurrenceScheduler === undefined)
    throw new Error("Workflow occurrence scheduler is not initialized");
  return workflowOccurrenceScheduler;
}

function ensureWorkflowScheduler(): WorkflowScheduler {
  requireAgentWorkflows(workflowInitialization);
  if (workflowScheduler === undefined) {
    throw new Error("Workflow scheduler is not initialized");
  }
  return workflowScheduler;
}

async function rehydrateWorkflowRuns(workspaceId?: string): Promise<void> {
  if (workflowInitialization?.status !== "available") {
    return;
  }
  const store = ensureWorkflowStore();
  const scheduler = ensureWorkflowScheduler();
  await rehydratePersistedWorkflowRuns(
    await store.listRuns(),
    {
      resolveWorkspace: (workspaceId) => resolveWorkspaceProject(workspaceId),
      updateRun: (run) => store.updateRun(run),
      schedule: (run) => scheduler.schedule(run),
      emit: (run) => emitWorkflowRunEvent(run),
      recordError: (message) => diagnostics?.recordError(message),
    },
    Date.now(),
    workspaceId,
  );
  await rehydrateCanonicalWorkflowRuns(
    await store.listWorkflowRuns(),
    {
      resolveWorkspace: (id) => resolveWorkspaceProject(id),
      updateRun: (run) => store.updateWorkflowRun(run),
      schedule: (run) => ensureWorkflowOccurrenceScheduler().schedule(run),
      emit: emitCanonicalWorkflowRunEvent,
      recordError: (message) => diagnostics?.recordError(message),
    },
    Date.now(),
    workspaceId,
  );
}

function createWorkflowScheduler(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): WorkflowScheduler {
  return new WorkflowScheduler({
    createSession: async (workspaceId) => {
      const project = await resolveWorkspaceProject(workspaceId);
      const snapshot = await createChatSessionSnapshot(
        store,
        diagnosticsService,
        project,
        workspaceId,
      );
      return {
        runtimeId: snapshot.runtimeId,
        state: snapshot.state,
        messages: snapshot.messages,
      };
    },
    prompt: async (runtimeId, text) => {
      const adapter = chatAdapter;
      if (adapter === undefined || !adapter.hasRuntime(runtimeId)) {
        throw new Error(
          `Workflow chat runtime is no longer attached: ${runtimeId}`,
        );
      }
      await adapter.prompt(runtimeId, { text });
    },
    getSnapshot: async (runtimeId) => {
      const adapter = chatAdapter;
      if (adapter === undefined || !adapter.hasRuntime(runtimeId)) {
        throw new Error(
          `Workflow chat runtime is no longer attached: ${runtimeId}`,
        );
      }
      const snapshot = await getChatSnapshotForRuntime(
        adapter,
        runtimeId,
        chatRuntimeModes.get(runtimeId) ?? resolveChatBackendMode(),
      );
      return {
        runtimeId: snapshot.runtimeId,
        state: snapshot.state,
        messages: snapshot.messages,
      };
    },
    closeSession: async (runtimeId) => {
      const adapter = chatAdapter;
      if (adapter !== undefined && adapter.hasRuntime(runtimeId)) {
        await closeAttachedChatRuntime(adapter, runtimeId);
      }
    },
    configureSession: async (runtimeId, settings) => {
      const adapter = chatAdapter;
      if (adapter === undefined || !adapter.hasRuntime(runtimeId)) {
        throw new Error(
          `Workflow chat runtime is no longer attached: ${runtimeId}`,
        );
      }
      if (settings.model !== undefined) {
        await adapter.request(runtimeId, "set_model", settings.model);
      }
      if (settings.thinkingLevel !== undefined) {
        await adapter.request(runtimeId, "set_thinking_level", {
          level: settings.thinkingLevel,
        });
      }
      const state = await adapter.getRuntimeStatus(runtimeId);
      const modelId = typeof state.model === "string" ? state.model : undefined;
      const provider =
        typeof state.provider === "string" ? state.provider : undefined;
      if (
        settings.model?.modelId !== undefined &&
        modelId !== settings.model.modelId
      ) {
        throw new Error(
          `Pi did not apply workflow model override: ${settings.model.modelId}`,
        );
      }
      if (
        settings.model?.provider !== undefined &&
        provider !== settings.model.provider
      ) {
        throw new Error(
          `Pi did not apply workflow provider override: ${settings.model.provider}`,
        );
      }
      if (
        settings.thinkingLevel !== undefined &&
        state.thinkingLevel !== settings.thinkingLevel
      ) {
        throw new Error(
          `Pi did not apply workflow thinking override: ${settings.thinkingLevel}`,
        );
      }
    },
    getRun: (runId) => ensureWorkflowStore().getRun(runId),
    persist: (run) => ensureWorkflowStore().updateRun(run),
    emit: emitWorkflowRunEvent,
  });
}

function createWorkflowOccurrenceScheduler(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): WorkflowOccurrenceScheduler {
  return new WorkflowOccurrenceScheduler({
    createSession: async (workspaceId) => {
      const project = await resolveWorkspaceProject(workspaceId);
      const snapshot = await createChatSessionSnapshot(
        store,
        diagnosticsService,
        project,
        workspaceId,
      );
      return {
        runtimeId: snapshot.runtimeId,
        state: snapshot.state,
        messages: snapshot.messages,
      };
    },
    prompt: async (runtimeId, text) => {
      const adapter = chatAdapter;
      if (adapter === undefined || !adapter.hasRuntime(runtimeId)) {
        throw new Error(
          `Workflow chat runtime is no longer attached: ${runtimeId}`,
        );
      }
      await adapter.prompt(runtimeId, { text });
    },
    getSnapshot: async (runtimeId) => {
      const adapter = chatAdapter;
      if (adapter === undefined || !adapter.hasRuntime(runtimeId)) {
        throw new Error(
          `Workflow chat runtime is no longer attached: ${runtimeId}`,
        );
      }
      const snapshot = await getChatSnapshotForRuntime(
        adapter,
        runtimeId,
        chatRuntimeModes.get(runtimeId) ?? resolveChatBackendMode(),
      );
      return {
        runtimeId: snapshot.runtimeId,
        state: snapshot.state,
        messages: snapshot.messages,
      };
    },
    closeSession: async (runtimeId) => {
      const adapter = chatAdapter;
      if (adapter !== undefined && adapter.hasRuntime(runtimeId)) {
        await closeAttachedChatRuntime(adapter, runtimeId);
      }
    },
    configureSession: async (runtimeId, settings) => {
      const adapter = chatAdapter;
      if (adapter === undefined || !adapter.hasRuntime(runtimeId)) {
        throw new Error(
          `Workflow chat runtime is no longer attached: ${runtimeId}`,
        );
      }
      if (settings.model !== undefined) {
        await adapter.request(runtimeId, "set_model", settings.model);
      }
      if (settings.thinkingLevel !== undefined) {
        await adapter.request(runtimeId, "set_thinking_level", {
          level: settings.thinkingLevel,
        });
      }
      const state = await adapter.getRuntimeStatus(runtimeId);
      const modelId = typeof state.model === "string" ? state.model : undefined;
      const provider =
        typeof state.provider === "string" ? state.provider : undefined;
      if (
        settings.model?.modelId !== undefined &&
        modelId !== settings.model.modelId
      ) {
        throw new Error(
          `Pi did not apply workflow model override: ${settings.model.modelId}`,
        );
      }
      if (
        settings.model?.provider !== undefined &&
        provider !== settings.model.provider
      ) {
        throw new Error(
          `Pi did not apply workflow provider override: ${settings.model.provider}`,
        );
      }
      if (
        settings.thinkingLevel !== undefined &&
        state.thinkingLevel !== settings.thinkingLevel
      ) {
        throw new Error(
          `Pi did not apply workflow thinking override: ${settings.thinkingLevel}`,
        );
      }
    },
    getRun: (runId) => ensureWorkflowStore().getWorkflowRun(runId),
    persist: (run) => ensureWorkflowStore().updateWorkflowRun(run),
    emit: emitCanonicalWorkflowRunEvent,
  });
}

async function validateWorkflowPaths(
  template: import("../shared/workflowSchemas.js").WorkflowTemplate,
  inputs: Record<string, string>,
  project: ProjectRef,
): Promise<void> {
  const values = [
    ...(template.context?.relevantPaths ?? []),
    ...template.inputs
      .filter((input) => input.type === "path")
      .map((input) => inputs[input.id] ?? input.defaultValue)
      .filter((value): value is string => value !== undefined),
  ];
  for (const value of values) {
    const resolved = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(project.canonicalPath, value);
    const canonical = await safeRealpath(resolved);
    if (
      canonical === undefined ||
      !isPathInside(canonical, project.canonicalPath)
    ) {
      throw new Error(
        `Workflow path is unavailable or outside its authorized workspace project: ${value}`,
      );
    }
  }
}

async function resolveWorkflowWorkspaceId(
  requestedWorkspaceId: string | undefined,
  templateWorkspaceId: string | undefined,
): Promise<string> {
  if (
    requestedWorkspaceId !== undefined &&
    templateWorkspaceId !== undefined &&
    requestedWorkspaceId !== templateWorkspaceId
  ) {
    throw new Error(
      "Workflow template is authorized for a different workspace.",
    );
  }
  const workspaceId =
    templateWorkspaceId ??
    requestedWorkspaceId ??
    (await ensureWorkspaceStore().getActiveWorkspace())?.id;
  if (workspaceId === undefined) {
    throw new Error("No workspace is selected for this workflow run.");
  }
  await requireOpenWorkspace(workspaceId);
  return workspaceId;
}

async function migrateLegacyProjectsToWorkspaces(): Promise<void> {
  const projects = ensureProjectStore();
  const listed = await projects.list();
  if (listed.projects.length === 0) {
    // Project activation happens lazily during local-only bootstrap. Do not
    // seal an empty migration before that compatibility project exists.
    return;
  }
  const refs = (
    await Promise.all(
      listed.projects.map(async (project) =>
        (await projects.getSessionRefs(project.id)).map((ref) => ({
          ...ref,
          projectId: project.id,
        })),
      ),
    )
  ).flat();
  await ensureWorkspaceStore().migrateLegacyProjects({
    ...(listed.activeProjectId
      ? { activeProjectId: listed.activeProjectId }
      : {}),
    projects: listed.projects.map((project) => ({
      id: project.id,
      displayName: project.displayName,
      createdAtMs: project.lastOpenedAt,
      updatedAtMs: project.lastOpenedAt,
      lastOpenedAtMs: project.lastOpenedAt,
    })),
    sessionRefs: refs,
  });
}

async function projectWorkspaceListResult(): Promise<WorkspaceListResult> {
  const [listedWorkspaces, listedProjects] = await Promise.all([
    ensureWorkspaceStore().list(),
    ensureProjectStore().list(),
  ]);
  const projectsById = new Map(
    listedProjects.projects.map((project) => [project.id, project]),
  );
  const toRef = (workspace: WorkspaceRecord): WorkspaceRef => {
    const defaultProject = workspace.defaultProjectId
      ? projectsById.get(workspace.defaultProjectId)
      : undefined;
    return {
      id: workspace.id,
      name: workspace.name,
      ...(workspace.isDefault ? { isDefault: true } : {}),
      ...(workspace.defaultProjectId
        ? { defaultProjectId: workspace.defaultProjectId }
        : {}),
      ...(defaultProject ? { defaultProject } : {}),
      lastOpenedAt: workspace.lastOpenedAtMs,
    };
  };
  return {
    ...(listedWorkspaces.activeWorkspaceId
      ? { activeWorkspaceId: listedWorkspaces.activeWorkspaceId }
      : {}),
    ...(listedWorkspaces.activeWorkspace
      ? { activeWorkspace: toRef(listedWorkspaces.activeWorkspace) }
      : {}),
    workspaces: listedWorkspaces.workspaces.map(toRef),
    ...(listedWorkspaces.archivedWorkspaces?.length
      ? {
          archivedWorkspaces: listedWorkspaces.archivedWorkspaces.map(toRef),
        }
      : {}),
  };
}

async function requireOpenWorkspace(
  workspaceId: string,
): Promise<WorkspaceRecord> {
  const workspace = await ensureWorkspaceStore().getWorkspace(workspaceId);
  if (workspace === undefined) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  if (workspace.archivedAtMs !== undefined) {
    throw new Error(`Workspace is archived: ${workspaceId}`);
  }
  return workspace;
}

async function resolveWorkspaceProject(
  workspaceId: string,
  requestedProjectId?: string,
): Promise<ProjectRef> {
  const workspace = await requireOpenWorkspace(workspaceId);
  const projectId = requestedProjectId ?? workspace.defaultProjectId;
  if (projectId === undefined) {
    return resolveManagedRuntimeProject();
  }
  return ensureProjectStore().resolveAuthorizedProject(projectId);
}

async function resolveWorkspaceRepositoryProject(
  workspaceId: string,
): Promise<ProjectRef> {
  const workspace = await requireOpenWorkspace(workspaceId);
  if (workspace.defaultProjectId !== undefined) {
    const defaultProject = await ensureProjectStore()
      .resolveAuthorizedProject(workspace.defaultProjectId)
      .catch(() => undefined);
    if (defaultProject !== undefined) {
      return defaultProject;
    }
  }
  return resolveManagedRuntimeProject();
}

async function resolveManagedRuntimeProject(): Promise<ManagedRuntimeProjectRef> {
  const piDeckHome = resolvePiDeckHome(process.env);
  await fs.mkdir(piDeckHome, { recursive: true, mode: 0o700 });
  const canonicalHome = await fs.realpath(piDeckHome);
  const runtimeDirectory = path.join(piDeckHome, managedRuntimeDirectoryName);

  try {
    await fs.mkdir(runtimeDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const runtimeStat = await fs.lstat(runtimeDirectory);
  if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
    throw new Error(
      "Pi Deck's managed runtime context is not a safe directory.",
    );
  }
  const canonicalRuntimeDirectory = await fs.realpath(runtimeDirectory);
  if (!isPathInside(canonicalRuntimeDirectory, canonicalHome)) {
    throw new Error(
      "Pi Deck's managed runtime context resolved outside its application data directory.",
    );
  }
  await fs.chmod(canonicalRuntimeDirectory, 0o700);

  return {
    id: managedRuntimeProjectId,
    path: canonicalRuntimeDirectory,
    canonicalPath: canonicalRuntimeDirectory,
    displayName: "Pi Deck managed runtime",
    lastOpenedAt: 0,
    [managedRuntimeProjectBrand]: true,
  };
}

function isManagedRuntimeProject(
  project: ProjectRef | undefined,
): project is ManagedRuntimeProjectRef {
  return (
    project !== undefined &&
    (project as Partial<ManagedRuntimeProjectRef>)[
      managedRuntimeProjectBrand
    ] === true
  );
}

async function addSessionToWorkspace(
  settings: SettingsStore,
  workspaceId: string,
  sessionFile: string,
): Promise<{ workspaceId: string; sessionFile: string }> {
  const project = await resolveWorkspaceRepositoryProject(workspaceId);
  const launch = await resolveRealChatLaunchConfig(settings, project);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    throw new Error("No Pi session directory is configured.");
  }
  const validation = await validatePiSessionFile({ sessionFile, sessionDir });
  if (!validation.ok) {
    throw new Error(
      `Session is not eligible for workspace import: ${validation.reason}.`,
    );
  }
  const stat = await fs.stat(validation.sessionFile);
  const refreshed = await readPiSessionSummary({
    sessionFile: validation.sessionFile,
    sessionDir,
  });
  const result = await ensureWorkspaceStore().upsertSessionRef(
    workspaceId,
    refreshed.summary ?? {
      id: validation.sessionFile,
      sessionFile: validation.sessionFile,
      cwd: validation.cwd,
      title: path.basename(validation.sessionFile, ".jsonl"),
      updatedAtMs: stat.mtimeMs,
      createdAtMs: stat.birthtimeMs,
      messageCount: 0,
    },
  );
  return { workspaceId: result.workspaceId, sessionFile: result.sessionFile };
}

async function listUnassignedWorkspaceSessions(
  settings: SettingsStore,
): Promise<ChatListSessionsResult> {
  const workspace = await ensureWorkspaceStore().getActiveWorkspace();
  if (workspace === undefined) {
    throw new Error("No active workspace is selected.");
  }
  const project = await resolveWorkspaceRepositoryProject(workspace.id);
  const launch = await resolveRealChatLaunchConfig(settings, project);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    return {
      projectCwd: launch.projectCwd,
      workspaceId: workspace.id,
      projectId: launch.projectId,
      sessions: [],
      diagnostics: ["No Pi session directory is configured."],
    };
  }
  const scanned = await scanSessionRepository({
    sessionDir,
    maxDepth: 4,
    maxFiles: 20_000,
    maxTotalBytes: 250 * 1024 * 1024,
    maxWallTimeMs: 15_000,
  });
  const sessionsWithOwners = await Promise.all(
    scanned.sessions.map(async (session) => ({
      session,
      owner: await ensureWorkspaceStore().getSessionOwner(session.sessionFile),
    })),
  );
  return {
    projectCwd: launch.projectCwd,
    workspaceId: workspace.id,
    projectId: launch.projectId,
    sessionDir,
    sessions: sessionsWithOwners.flatMap(({ session, owner }) =>
      owner === undefined ? [session] : [],
    ),
    diagnostics: scanned.diagnostics,
  };
}

/**
 * Convert a renderer-supplied project ID into a main-owned project record.
 *
 * The ID is an opaque key, even though P0 records currently use canonical
 * paths as IDs. Only ProjectStore decides which root it maps to; downstream
 * chat code receives a record and never a renderer string. Fake mode has no
 * project-scoped filesystem work and keeps its synthetic demo project
 * compatibility, so it intentionally discards this optional hint.
 */
async function authorizeRendererChatProject(
  projectId?: string,
): Promise<ProjectRef | undefined> {
  if (projectId === undefined || resolveChatBackendMode() !== "real") {
    return undefined;
  }
  return ensureProjectStore().resolveAuthorizedProject(projectId);
}

/**
 * Build the first renderer payload strictly from local stores. In particular,
 * do not call ensureChatAdapter(), resolveRealChatLaunchConfig(), or
 * listChatSessions() here: each can eventually start Pi or scan its session
 * repository. The renderer asks for a fresh list only after this shell paints.
 */
async function getAppBootstrapState(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): Promise<AppBootstrapState> {
  const settings = await store.get();
  const projects = ensureProjectStore();
  const listedProjects = await projects.list();
  const explicitProject = hasBootstrapProjectOverride(settings);
  const mode = resolveChatBackendMode();
  const needsProjectActivation =
    explicitProject || listedProjects.activeProject === undefined;
  const project =
    !needsProjectActivation && listedProjects.activeProject !== undefined
      ? listedProjects.activeProject
      : mode === "real"
        ? await projects.upsertAndActivateProject(
            await resolveBootstrapProjectCwd(settings),
          )
        : projectRefFromCwd(await resolveBootstrapProjectCwd(settings));
  const projectList =
    mode === "real" && needsProjectActivation
      ? await projects.list()
      : listedProjects;
  const workspaceStateBeforeMigration = await ensureWorkspaceStore().list();
  const shouldKeepDefaultWorkspaceActive =
    workspaceStateBeforeMigration.workspaces.length === 0 ||
    workspaceStateBeforeMigration.activeWorkspace?.isDefault === true;
  if (mode === "real") {
    await migrateLegacyProjectsToWorkspaces();
  }
  await ensureWorkspaceStore().ensureDefaultWorkspace({
    activate: shouldKeepDefaultWorkspaceActive,
  });
  let activeWorkspace = await ensureWorkspaceStore().getActiveWorkspace();
  if (activeWorkspace === undefined) {
    activeWorkspace = await ensureWorkspaceStore().ensureDefaultWorkspace({
      activate: true,
    });
  }
  const workspaceList = await projectWorkspaceListResult();
  const cachedSessions =
    mode === "real"
      ? await ensureWorkspaceStore().getCachedSessionSummaries(
          activeWorkspace.id,
        )
      : [];

  return {
    backendMode: mode,
    version: app.getVersion(),
    settings,
    diagnostics: diagnosticsService.getSummary(settings),
    project,
    projects: projectList.projects,
    workspace:
      workspaceList.activeWorkspace ??
      workspaceList.workspaces.find((item) => item.id === activeWorkspace.id),
    workspaces: workspaceList.workspaces,
    ...(workspaceList.archivedWorkspaces
      ? { archivedWorkspaces: workspaceList.archivedWorkspaces }
      : {}),
    cachedSessions,
  };
}

function hasBootstrapProjectOverride(_settings: AppSettings): boolean {
  // Persisted settings.projectCwd is only a fallback when ProjectStore has no
  // active project. Treating it as explicit would undo a recent-project switch
  // on every restart.
  return (
    selectedRealProjectCwd !== undefined ||
    (process.env.PI_DECK_PROJECT_CWD?.trim().length ?? 0) > 0
  );
}

function projectRefFromCwd(cwd: string): ProjectRef {
  return {
    id: cwd,
    path: cwd,
    canonicalPath: cwd,
    displayName: path.basename(cwd) || cwd,
    lastOpenedAt: Date.now(),
  };
}

async function resolveBootstrapProjectCwd(
  settings: AppSettings,
): Promise<string> {
  const requested =
    selectedRealProjectCwd ??
    process.env.PI_DECK_PROJECT_CWD ??
    settings.projectCwd ??
    process.cwd();
  const resolved = path.resolve(requested);
  return (await safeRealpath(resolved)) ?? resolved;
}

function nextTestProjectPickPath(): string | undefined {
  const singlePath = process.env.PI_DECK_TEST_PICK_PROJECT_CWD;
  if (singlePath !== undefined && singlePath.trim().length > 0) {
    return singlePath;
  }

  const pathQueue = process.env.PI_DECK_TEST_PICK_PROJECT_CWDS;
  if (pathQueue === undefined || pathQueue.trim().length === 0) {
    return undefined;
  }

  if (testProjectPickQueue === undefined) {
    const parsed = JSON.parse(pathQueue) as unknown;
    testProjectPickQueue = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  }

  return testProjectPickQueue.shift();
}

async function pickProjectByPathForTest(
  projectPath: string,
  store: SettingsStore,
): Promise<PickProjectResult> {
  if (projectPath === "__cancel__") {
    return { selected: false } as const;
  }
  const canonicalPath = await fs.realpath(projectPath);
  selectedRealProjectCwd = canonicalPath;
  await store.update({ projectCwd: canonicalPath });
  const project =
    await ensureProjectStore().upsertAndActivateProject(canonicalPath);
  return { selected: true, project };
}

async function ensureChatAdapter(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): Promise<SinglePiAdapter> {
  if (chatAdapter !== undefined) {
    return chatAdapter;
  }
  if (chatAdapterPromise !== undefined) {
    return chatAdapterPromise;
  }

  const initialization = initializeChatAdapter(store, diagnosticsService);
  chatAdapterPromise = initialization;
  try {
    return await initialization;
  } finally {
    if (chatAdapterPromise === initialization) {
      chatAdapterPromise = undefined;
    }
  }
}

async function startDelegationBridge(): Promise<void> {
  const bridge = new DelegationBridgeServer({
    stateDir: path.join(app.getPath("userData"), "delegate-bridge"),
    // The bridge binds parentId from the capability; this is the only place
    // extension mode queries obtain their runtime's live manager state.
    getParentMode: (parentRuntimeId) => {
      try {
        return multitaskSupervisor?.mode(parentRuntimeId) ?? "sequential";
      } catch {
        return "sequential";
      }
    },
  });
  const credentials = await bridge.start();
  delegationBridge = bridge;
  delegationCredentials = { socketPath: credentials.socketPath };
  bridge.onDelegate((request) => void handleDelegateRequest(request));
  bridge.onInputResponse((response) => void handleDelegateInput(response));
}

async function deckDelegateExtensionPath(): Promise<string> {
  const output = path.join(
    app.getPath("userData"),
    "extensions",
    "deck-delegate.ts",
  );
  await writeDeckDelegateExtension(output);
  return output;
}

async function deckDelegateHarnessPath(
  delegateExtensionPath: string,
): Promise<string | undefined> {
  if (process.env.PI_DECK_E2E_DELEGATE_HARNESS !== "1") return undefined;
  const output = path.join(
    app.getPath("userData"),
    "extensions",
    "deck-delegate-acceptance-harness.ts",
  );
  await writeDeckDelegateAcceptanceHarness(output, delegateExtensionPath);
  return output;
}

function delegateEnvironment(
  base: NodeJS.ProcessEnv,
  parentRuntimeId: string,
): NodeJS.ProcessEnv {
  const credentials = delegationCredentials;
  const capability = delegationBridge?.registerParent(parentRuntimeId);
  if (!credentials || !capability)
    throw new Error("Delegation bridge is not available.");
  return {
    ...base,
    [DECK_DELEGATE_ENDPOINT_ENV]: `unix:${credentials.socketPath}`,
    [DECK_DELEGATE_CAPABILITY_ENV]: capability,
    [DECK_DELEGATE_PARENT_RUNTIME_ENV]: parentRuntimeId,
  };
}

async function handleDelegateRequest(request: DelegateRequest): Promise<void> {
  // Authentication capability, not untrusted payload, binds this connection.
  const payload = request.payload;
  const parentId = request.parentId;
  const supervisor = multitaskSupervisor;
  if (!parentId || !supervisor || !delegationBridge) {
    delegationBridge?.sendChildResult({
      connectionId: request.connectionId,
      toolCallId: request.toolCallId,
      outcome: "failed",
      handoff: {
        summary: "Parallel multitasking is not enabled for this parent.",
      },
    });
    return;
  }
  if (!isMultitaskMode(parentId, "parallel") || !chatRuntimeIds.has(parentId)) {
    delegationBridge?.sendChildResult({
      connectionId: request.connectionId,
      toolCallId: request.toolCallId,
      outcome: "failed",
      handoff: {
        summary: "Parallel multitasking is not enabled for this parent.",
      },
    });
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    delegationBridge.sendChildResult({
      connectionId: request.connectionId,
      toolCallId: request.toolCallId,
      outcome: "failed",
      handoff: { summary: "Invalid delegate action." },
    });
    return;
  }
  const inputAction = payload as {
    action?: unknown;
    taskNumber?: unknown;
    input?: unknown;
  };
  if (inputAction.action === "provide_input") {
    if (
      !Number.isSafeInteger(inputAction.taskNumber) ||
      (inputAction.taskNumber as number) < 1 ||
      typeof inputAction.input !== "string" ||
      !inputAction.input.trim()
    ) {
      delegationBridge.sendChildResult({
        connectionId: request.connectionId,
        toolCallId: request.toolCallId,
        outcome: "failed",
        handoff: { summary: "A task number and input are required." },
      });
      return;
    }
    try {
      await supervisor.provideInput(
        parentId,
        inputAction.taskNumber as number,
        inputAction.input,
      );
      delegationBridge.sendChildResult({
        connectionId: request.connectionId,
        toolCallId: request.toolCallId,
        outcome: "completed",
        handoff: {
          summary: `Input delivered to task #${inputAction.taskNumber}.`,
        },
      });
    } catch (error) {
      delegationBridge.sendChildResult({
        connectionId: request.connectionId,
        toolCallId: request.toolCallId,
        outcome: "failed",
        handoff: {
          summary:
            error instanceof Error ? error.message : "Unable to deliver input.",
        },
      });
    }
    return;
  }
  if (typeof (payload as { task?: unknown }).task !== "string") {
    delegationBridge.sendChildResult({
      connectionId: request.connectionId,
      toolCallId: request.toolCallId,
      outcome: "failed",
      handoff: { summary: "Invalid delegate task." },
    });
    return;
  }
  const task = (payload as { task: string; name?: unknown }).task.trim();
  const name =
    typeof (payload as { name?: unknown }).name === "string"
      ? (payload as { name: string }).name.trim()
      : "Delegated task";
  if (!task || task.length > 16_000 || name.length > 256) {
    delegationBridge.sendChildResult({
      connectionId: request.connectionId,
      toolCallId: request.toolCallId,
      outcome: "failed",
      handoff: { summary: "Delegate task exceeds Deck limits." },
    });
    return;
  }
  const number = nextDelegatedTaskNumber++;
  try {
    delegateCalls.set(`${parentId}:${number}`, {
      connectionId: request.connectionId,
      toolCallId: request.toolCallId,
    });
    supervisor.enqueue(parentId, {
      number,
      name: name || "Delegated task",
      brief: { text: task },
    });
  } catch (error) {
    delegateCalls.delete(`${parentId}:${number}`);
    delegationBridge.sendChildResult({
      connectionId: request.connectionId,
      toolCallId: request.toolCallId,
      outcome: "failed",
      handoff: {
        summary:
          error instanceof Error ? error.message : "Unable to queue child.",
      },
    });
  }
}

async function initializeChatAdapter(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): Promise<SinglePiAdapter> {
  const mode = resolveChatBackendMode();
  maxRunningWorkers = (await store.get()).maxRunningSessions;
  const adapter = new SinglePiAdapter();
  const capacity = new WorkerCapacity(() => adapter.workerCount());
  const unsubscribe = adapter.onEvent((event) => {
    const parsed = chatRuntimeEventSchema.safeParse(event);
    if (!parsed.success) {
      diagnosticsService.recordError(
        `Dropping invalid chat event: ${parsed.error.message}`,
      );
      return;
    }
    // Private delegated workers share the adapter only for capacity and RPC;
    // their events/transcript identities never cross into renderer chat state.
    if (chatRuntimeIds.has(parsed.data.runtimeId)) {
      trackExtensionUiRuntimeEvent(parsed.data);
      sendChatEventToRenderer(parsed.data);
    }
    // Workflow handling runs before worker-exit cleanup. agent_end needs the
    // live worker to read its final transcript; worker_exit itself is handled
    // as a terminal workflow failure before the adapter forgets the worker.
    void workflowScheduler?.handleRuntimeEvent(
      parsed.data as WorkflowRuntimeEvent,
    );
    void workflowOccurrenceScheduler?.handleRuntimeEvent(
      parsed.data as WorkflowRuntimeEvent,
    );
    if (parsed.data.type === "worker_exit") {
      // A child exit does not go through closeSession(), so remove it from the
      // adapter as well as the UI/runtime maps or it would consume capacity.
      adapter.forgetExitedWorker(parsed.data.runtimeId);
      const preserveAttachments = attachmentPreservingRuntimeClosures.has(
        parsed.data.runtimeId,
      );
      forgetChatRuntime(parsed.data.runtimeId, { preserveAttachments });
      taskSessionOrchestrator?.scheduleAll();
    }
  });

  // Creating an adapter only installs routing and capacity bookkeeping. A
  // worker is created by an explicit create/resume/send path, never merely by
  // making the app interactive.
  chatBackendMode = mode;
  chatEventUnsubscribe = unsubscribe;
  chatWorkerCapacity = capacity;
  chatAdapter = adapter;
  taskSessionOrchestrator = new TaskSessionOrchestrator({
    plan: (parentId, prompt) =>
      planTaskSession(adapter, store, parentId, prompt),
    resolveWorkerSettings: ({ parentId, parentSettings, promptSettings }) => ({
      ...parentSettings,
      ...taskSessionSettings.get(parentId),
      ...promptSettings,
    }),
    createWorker: (launch) => createTaskSessionWorker(adapter, store, launch),
    hasGlobalCapacity: () => capacityAvailable(),
    isCapacityUnavailable: (error) => error instanceof WorkerCapacityError,
    synthesize: (input) => synthesizeTaskSession(adapter, input),
    onState: (parentId) => {
      emitTaskSessionState(parentId);
      void persistTaskSession(parentId);
    },
  });
  multitaskSupervisor = new MultitaskSupervisor({
    hasCapacity: () => capacityAvailable(),
    createWorker: (launch) =>
      createDelegatedChild(
        adapter,
        store,
        launch.parentId,
        launch.task,
        launch.callbacks,
      ),
    onParentNotification: (notification) =>
      handleMultitaskNotification(notification),
  });
  return adapter;
}

async function createChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  mode: ChatBackendMode,
  capacity: WorkerCapacity,
  project?: ProjectRef,
  workspaceId?: string,
  initialMultitaskMode: "sequential" | "parallel" = "sequential",
): Promise<ChatWorkerSpec> {
  return serializeChatWorkerCreation(async () => {
    const workerSpec =
      mode === "real"
        ? await createRealChatWorker(
            adapter,
            store,
            capacity,
            project,
            workspaceId,
          )
        : await createFakeChatWorker(adapter, store, capacity, workspaceId);
    registerChatWorker(workerSpec, mode, initialMultitaskMode);
    return workerSpec;
  });
}

async function serializeChatWorkerCreation<T>(
  create: () => Promise<T>,
): Promise<T> {
  const previous = chatWorkerCreationTail;
  let release: (() => void) | undefined;
  chatWorkerCreationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await create();
  } finally {
    release?.();
  }
}

function capacityAvailable(): boolean {
  const capacity = chatWorkerCapacity;
  const adapter = chatAdapter;
  // The capacity allocator remains authoritative at spawn time. This cheap
  // preflight only prevents a queued child from competing with active parent UI.
  return (
    capacity !== undefined &&
    adapter !== undefined &&
    adapter.workerCount() < maxRunningWorkers
  );
}

function registerChatWorker(
  workerSpec: ChatWorkerSpec,
  mode: ChatBackendMode,
  initialMultitaskMode: "sequential" | "parallel" = "sequential",
): void {
  const runtimeId = workerSpec.worker.runtimeId;
  chatRuntimeId = runtimeId;
  chatRuntimeIds.add(runtimeId);
  chatRuntimeModes.set(runtimeId, mode);
  chatWorkerCwds.set(runtimeId, workerSpec.cwd);
  if (workerSpec.projectId !== undefined) {
    chatRuntimeProjectIds.set(runtimeId, workerSpec.projectId);
  }
  if (workerSpec.workspaceId !== undefined) {
    chatRuntimeWorkspaceIds.set(runtimeId, workerSpec.workspaceId);
  }
  taskSessionOrchestrator?.addParent(runtimeId, {
    mode: initialMultitaskMode,
    ...(taskSessionSettings.has(runtimeId)
      ? { workerSettings: taskSessionSettings.get(runtimeId)! }
      : {}),
  });
  multitaskSupervisor?.addParent(runtimeId, {
    mode: initialMultitaskMode,
    maxQueuedTasks: 100,
  });
}

function getChatWorkerCapacity(): WorkerCapacity {
  if (chatWorkerCapacity === undefined) {
    throw new Error("Chat worker capacity is not initialized");
  }
  return chatWorkerCapacity;
}

function trackExtensionUiRuntimeEvent(
  event: z.infer<typeof chatRuntimeEventSchema>,
): void {
  if (event.type !== "extension_ui_request") {
    return;
  }
  const method = getExtensionUiDialogMethod(event.method);
  const requestId = typeof event.id === "string" ? event.id : undefined;
  if (method === undefined || requestId === undefined) {
    return;
  }

  const requests = pendingExtensionUiRequests.get(event.runtimeId) ?? new Map();
  const existing = requests.get(requestId);
  if (existing?.timer !== undefined) clearTimeout(existing.timer);
  const timeout =
    typeof event.timeout === "number" && event.timeout >= 0
      ? event.timeout
      : undefined;
  const timer =
    timeout === undefined
      ? undefined
      : setTimeout(() => {
          const pending = pendingExtensionUiRequests.get(event.runtimeId);
          if (pending === undefined || pending.get(requestId)?.timer !== timer)
            return;
          pending.delete(requestId);
          if (pending.size === 0)
            pendingExtensionUiRequests.delete(event.runtimeId);
          sendChatEventToRenderer({
            type: "extension_ui_request_timeout",
            runtimeId: event.runtimeId,
            requestId,
          });
        }, timeout + extensionUiTimeoutGraceMs);
  if (timer !== undefined) timer.unref();
  requests.set(requestId, {
    method,
    ...(timer !== undefined ? { timer } : {}),
  });
  pendingExtensionUiRequests.set(event.runtimeId, requests);
}

async function respondToExtensionUi(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  request: ChatRespondToExtensionUiRequest,
): Promise<void> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  if (
    !chatRuntimeIds.has(request.runtimeId) ||
    !adapter.hasRuntime(request.runtimeId)
  ) {
    throw new Error(
      `Extension UI runtime is no longer attached: ${request.runtimeId}`,
    );
  }
  const pending = pendingExtensionUiRequests
    .get(request.runtimeId)
    ?.get(request.requestId);
  if (pending === undefined) {
    throw new Error(
      `Extension UI request ${request.requestId} is no longer pending for this runtime. It may have timed out or already been answered.`,
    );
  }
  if (!isValidExtensionUiResponse(pending.method, request.response)) {
    throw new Error(
      `Invalid response for Pi extension UI ${pending.method} request.`,
    );
  }

  try {
    await adapter.respondToExtensionUi(request.runtimeId, {
      id: request.requestId,
      ...request.response,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnosticsService.recordError(
      `Failed to write extension UI response ${request.requestId} for ${request.runtimeId}: ${message}`,
    );
    sendChatEventToRenderer({
      type: "extension_ui_response_failed",
      runtimeId: request.runtimeId,
      requestId: request.requestId,
      message: `Could not deliver extension UI response: ${message}`,
    });
    throw error;
  }

  if (pending.timer !== undefined) clearTimeout(pending.timer);
  const requests = pendingExtensionUiRequests.get(request.runtimeId);
  requests?.delete(request.requestId);
  if (requests?.size === 0)
    pendingExtensionUiRequests.delete(request.runtimeId);
  sendChatEventToRenderer({
    type: "extension_ui_response_sent",
    runtimeId: request.runtimeId,
    requestId: request.requestId,
  });
}

function getExtensionUiDialogMethod(
  value: unknown,
): "select" | "confirm" | "input" | "editor" | undefined {
  return value === "select" ||
    value === "confirm" ||
    value === "input" ||
    value === "editor"
    ? value
    : undefined;
}

function isValidExtensionUiResponse(
  method: "select" | "confirm" | "input" | "editor",
  response: ChatRespondToExtensionUiRequest["response"],
): boolean {
  if ("cancelled" in response) return true;
  return method === "confirm" ? "confirmed" in response : "value" in response;
}

function clearPendingExtensionUiRequests(runtimeId: string): void {
  const requests = pendingExtensionUiRequests.get(runtimeId);
  if (requests === undefined) return;
  for (const pending of requests.values()) {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
  }
  pendingExtensionUiRequests.delete(runtimeId);
}

function sendChatEventToRenderer(
  event: z.infer<typeof chatRuntimeEventSchema>,
): void {
  const window = mainWindow;
  if (
    window === undefined ||
    window.isDestroyed() ||
    window.webContents.isDestroyed()
  ) {
    return;
  }
  window.webContents.send(ipcChannels.chatEvent, event);
}

function emitWorkflowRunEvent(run: WorkflowRun): void {
  const event = workflowEventSchema.parse({
    type: "workflow_run_updated",
    runId: run.id,
    status: run.status,
  });
  const window = mainWindow;
  if (
    window === undefined ||
    window.isDestroyed() ||
    window.webContents.isDestroyed()
  ) {
    return;
  }
  window.webContents.send(ipcChannels.workflowEvent, event);
}

function resolveChatBackendMode(): ChatBackendMode {
  return process.env.PI_DECK_BACKEND === "real" ? "real" : "fake";
}

function resolveActiveChatRuntimeId(
  adapter: SinglePiAdapter,
  requestedRuntimeId: string,
): string {
  const selection = selectAvailableRuntime({
    requestedRuntimeId,
    hasRuntime: (runtimeId) =>
      chatRuntimeIds.has(runtimeId) && adapter.hasRuntime(runtimeId),
  });

  if (selection.reason === "requested" && selection.runtimeId !== undefined) {
    return selection.runtimeId;
  }

  // Do not redirect a stale renderer request to another active session. An
  // abort, close, or prompt against the wrong conversation is worse than a
  // recoverable error in the originating session.
  forgetChatRuntime(requestedRuntimeId);
  diagnostics?.recordError(
    `Renderer requested stale chat runtime ${requestedRuntimeId}; action rejected.`,
  );
  throw new Error(
    `Chat runtime is no longer attached: ${requestedRuntimeId}. Reopen the saved session or create a new session.`,
  );
}

async function closeAttachedChatRuntime(
  adapter: SinglePiAdapter,
  runtimeId: string,
  options: { preserveAttachments?: boolean } = {},
): Promise<void> {
  if (options.preserveAttachments === true) {
    attachmentPreservingRuntimeClosures.add(runtimeId);
  }
  try {
    delegationBridge?.removeParent(runtimeId);
    cancelTaskSessionPlanners(runtimeId);
    await taskSessionOrchestrator?.removeParent(runtimeId);
    await multitaskSupervisor?.removeParent(runtimeId);
    if (adapter.hasRuntime(runtimeId)) {
      await adapter.closeSession(runtimeId);
    }
  } finally {
    // Map cleanup must not depend on a cooperative child process. A delete
    // transaction may keep attachment authority until file removal commits.
    forgetChatRuntime(runtimeId, options);
  }
}

function forgetChatRuntime(
  runtimeId: string,
  options: { preserveAttachments?: boolean } = {},
): void {
  const preserveAttachments =
    options.preserveAttachments === true ||
    attachmentPreservingRuntimeClosures.has(runtimeId);
  if (!preserveAttachments) {
    attachmentSelections.releaseSession(runtimeId);
  }
  clearPendingExtensionUiRequests(runtimeId);
  chatRuntimeIds.delete(runtimeId);
  chatRuntimeModes.delete(runtimeId);
  chatWorkerCwds.delete(runtimeId);
  const sessionFile = chatRuntimeSessionFiles.get(runtimeId);
  if (
    sessionFile !== undefined &&
    chatSessionFileLocks.get(sessionFile) === runtimeId
  ) {
    chatSessionFileLocks.delete(sessionFile);
  }
  chatRuntimeSessionFiles.delete(runtimeId);
  chatRuntimeProjectIds.delete(runtimeId);
  chatRuntimeWorkspaceIds.delete(runtimeId);
  multitaskRuntimeResumeGuard.forget(runtimeId);
  delegationBridge?.removeParent(runtimeId);
  for (const [key, call] of delegateCalls) {
    if (key.startsWith(`${runtimeId}:`)) {
      delegationBridge?.sendChildResult({
        ...call,
        outcome: "cancelled",
        handoff: { summary: "Parent session closed." },
      });
      delegateCalls.delete(key);
    }
  }
  cancelTaskSessionPlanners(runtimeId);
  void taskSessionOrchestrator?.removeParent(runtimeId);
  taskSessionSettings.delete(runtimeId);
  taskSessionSynthesisTails.delete(runtimeId);
  void multitaskSupervisor?.removeParent(runtimeId);
  if (chatRuntimeId === runtimeId) {
    chatRuntimeId = undefined;
  }
}

interface ChatWorkerSpec {
  worker: ReturnType<SinglePiAdapter["createWorker"]>;
  cwd: string;
  projectId?: string;
  workspaceId?: string;
}

function toTaskSessionSettings(
  settings:
    | {
        model?: { provider: string; modelId: string } | undefined;
        thinkingLevel?: string | undefined;
      }
    | undefined,
): TaskSessionWorkerSettings {
  if (!settings) return {};
  return {
    ...(settings.model
      ? { model: `${settings.model.provider}:${settings.model.modelId}` }
      : {}),
    ...(settings.thinkingLevel
      ? { thinkingLevel: settings.thinkingLevel }
      : {}),
  };
}

function getTaskSessionOrchestrator(
  runtimeId: string,
): NonNullable<typeof taskSessionOrchestrator> {
  const orchestrator = taskSessionOrchestrator;
  const adapter = chatAdapter;
  if (
    !orchestrator ||
    !adapter ||
    !chatRuntimeIds.has(runtimeId) ||
    !adapter.hasRuntime(runtimeId)
  ) {
    throw new Error(`Chat runtime is no longer attached: ${runtimeId}`);
  }
  orchestrator.state(runtimeId);
  return orchestrator;
}

async function planTaskSession(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  parentId: string,
  prompt: string,
): Promise<{
  contextSummary: string;
  tasks: { generatedName: string; brief: string }[];
}> {
  // Deliberately isolated: deterministic routing tests never create or consult
  // a planner worker.
  const fixturePath = process.env.PI_DECK_TEST_TASK_ROUTING_FIXTURE;
  if (fixturePath) {
    const fixture: unknown = JSON.parse(await fs.readFile(fixturePath, "utf8"));
    const tasks = (fixture as { tasks?: unknown }).tasks;
    if (
      Array.isArray(tasks) &&
      tasks.length > 0 &&
      tasks.length <= TASK_SESSION_PLANNER_MAX_TASKS
    ) {
      const plan = {
        contextSummary: "Test fixture task-session context.",
        tasks: tasks.map((task, index) => {
          const name = (task as { name?: unknown }).name;
          const cleanName =
            typeof name === "string"
              ? name
                  .replace(/[\r\n]+/g, " ")
                  .trim()
                  .slice(0, 96)
              : `Task ${index + 1}`;
          return {
            generatedName: cleanName || `Task ${index + 1}`,
            brief:
              `Complete ${cleanName || `task ${index + 1}`} for the requested work.`.slice(
                0,
                512,
              ),
          };
        }),
      };
      ensureTaskSessionStillParallel(parentId);
      return plan;
    }
    throw new Error(
      `Task-session fixture must contain one to ${TASK_SESSION_PLANNER_MAX_TASKS} tasks.`,
    );
  }

  const parentContext = boundedParentContext(
    await adapter.getMessages(parentId),
  );
  try {
    const response = await runTaskSessionPlanner(
      adapter,
      store,
      parentId,
      buildTaskSessionPlannerPrompt({ originalPrompt: prompt, parentContext }),
    );
    const plan = parseTaskSessionPlannerResponse(response);
    ensureTaskSessionStillParallel(parentId);
    return plan;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "New task sessions are available only in Parallel mode."
    ) {
      throw error;
    }
    if (
      error instanceof Error &&
      error.message === "Planner inherited model/thinking setup failed."
    ) {
      diagnostics?.recordError(
        "Task-session planner could not inherit the parent model/thinking configuration.",
      );
    }
    // Planning must never turn a new-task submission into parent execution.
    const plan = fallbackTaskSessionPlan(prompt, parentContext);
    ensureTaskSessionStillParallel(parentId);
    return plan;
  }
}

function ensureTaskSessionStillParallel(parentId: string): void {
  if (
    getTaskSessionOrchestrator(parentId).state(parentId).mode !== "parallel"
  ) {
    throw new Error("New task sessions are available only in Parallel mode.");
  }
}

function cancelTaskSessionPlanners(parentId: string): void {
  for (const run of taskSessionPlannerRuns.get(parentId) ?? []) run.cancel();
}

async function runTaskSessionPlanner(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  parentId: string,
  plannerPrompt: string,
): Promise<string> {
  const capacity = getChatWorkerCapacity();
  const parentMode = chatRuntimeModes.get(parentId);
  const cwd = chatWorkerCwds.get(parentId);
  const projectId = chatRuntimeProjectIds.get(parentId);
  if (!parentMode || !cwd)
    throw new Error("Task-session parent is no longer attached.");

  const runs = taskSessionPlannerRuns.get(parentId) ?? new Set();
  taskSessionPlannerRuns.set(parentId, runs);
  const run: TaskSessionPlannerRun = {
    cancelled: false,
    cancel: () => {
      run.cancelled = true;
      void run.closeWorker?.().catch(() => undefined);
    },
  };
  runs.add(run);
  const timeoutMs = resolveTaskSessionPlannerTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      run.cancel();
      reject(new Error(`Task-session planner timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  const operation = (async (): Promise<string> => {
    let worker: ReturnType<SinglePiAdapter["createWorker"]> | undefined;
    try {
      // The deadline starts before allocation and remains in force through
      // inherited configuration, prompt delivery, and terminal-event waiting.
      worker = await capacity.allocate(
        async () => (await store.get()).maxRunningSessions,
        () =>
          parentMode === "fake"
            ? adapter.createWorker({
                command: process.execPath,
                args: [
                  path.join(__dirname, "pi/fakeRpc/fakeRpcServer.js"),
                  "--stream-delay-ms",
                  "10",
                ],
                cwd,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
              })
            : createRealDelegatedWorker(adapter, store, cwd, projectId),
      );
      const plannerWorker = worker;
      run.closeWorker = () => adapter.closeSession(plannerWorker.runtimeId);
      if (run.cancelled) throw new Error("Task-session planner was cancelled.");
      const parentState = await adapter.getRuntimeStatus(parentId);
      try {
        if (
          typeof parentState.provider === "string" &&
          typeof parentState.model === "string"
        ) {
          await plannerWorker.request("set_model", {
            provider: parentState.provider,
            modelId: parentState.model,
          });
        }
        if (typeof parentState.thinkingLevel === "string") {
          await plannerWorker.request("set_thinking_level", {
            level: parentState.thinkingLevel,
          });
        }
      } catch (error) {
        // This label is safe for diagnostics and distinguishes inherited setup
        // from an invalid planner response or an ordinary prompt failure.
        throw new Error("Planner inherited model/thinking setup failed.", {
          cause: error,
        });
      }
      if (run.cancelled) throw new Error("Task-session planner was cancelled.");
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        let unsubscribe: () => void = () => undefined;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          fn();
        };
        unsubscribe = plannerWorker.onEvent((event) => {
          if (event.type === "agent_end") {
            void plannerWorker.getMessages().then(
              (messages) => {
                const last = messages.at(-1);
                finish(() =>
                  resolve(
                    typeof last?.content === "string" ? last.content : "",
                  ),
                );
              },
              (error) => finish(() => reject(error)),
            );
          } else if (event.type === "worker_exit") {
            finish(() =>
              reject(
                new Error("Planner worker exited before returning a plan."),
              ),
            );
          }
        });
        void plannerWorker
          .prompt({ text: plannerPrompt })
          .catch((error) => finish(() => reject(error)));
      });
    } finally {
      await run.closeWorker?.().catch(() => undefined);
    }
  })();
  // Keep a timed-out allocation registered until it resolves, so a late worker
  // is immediately closed rather than escaping parent cleanup.
  void operation
    .finally(() => {
      runs.delete(run);
      if (runs.size === 0) taskSessionPlannerRuns.delete(parentId);
    })
    .catch(() => undefined);
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createTaskSessionWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  launch: TaskSessionLaunch<string>,
): Promise<{ close(): Promise<void> }> {
  const capacity = getChatWorkerCapacity();
  const parentMode = chatRuntimeModes.get(launch.parentId);
  const cwd = chatWorkerCwds.get(launch.parentId);
  const projectId = chatRuntimeProjectIds.get(launch.parentId);
  if (!parentMode || !cwd)
    throw new Error("Task-session parent is no longer attached.");
  const worker = await capacity.allocate(
    async () => (await store.get()).maxRunningSessions,
    () =>
      parentMode === "fake"
        ? adapter.createWorker({
            command: process.execPath,
            args: [
              path.join(__dirname, "pi/fakeRpc/fakeRpcServer.js"),
              "--stream-delay-ms",
              "10",
            ],
            cwd,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          })
        : createRealDelegatedWorker(adapter, store, cwd, projectId),
  );
  let ended = false;
  worker.onEvent((event) => {
    if (ended) return;
    if (event.type === "extension_ui_request")
      launch.callbacks.waitingForParent();
    if (event.type === "agent_end" || event.type === "worker_exit") {
      ended = true;
      void worker
        .getMessages()
        .then((messages) => {
          const last = messages.at(-1);
          launch.callbacks.completed({
            summary:
              typeof last?.content === "string"
                ? conciseTaskHandoff(last.content)
                : "Task completed.",
          });
        })
        .catch((error) => launch.callbacks.failed(error));
    }
  });
  try {
    const parentState = await adapter.getRuntimeStatus(launch.parentId);
    const [provider, modelId] =
      launch.request.workerSettings.model?.split(":", 2) ?? [];
    const selectedProvider =
      provider ??
      (typeof parentState.provider === "string"
        ? parentState.provider
        : undefined);
    const selectedModelId =
      modelId ??
      (typeof parentState.model === "string" ? parentState.model : undefined);
    if (selectedProvider && selectedModelId)
      await worker.request("set_model", {
        provider: selectedProvider,
        modelId: selectedModelId,
      });
    const thinkingLevel =
      launch.request.workerSettings.thinkingLevel ??
      (typeof parentState.thinkingLevel === "string"
        ? parentState.thinkingLevel
        : undefined);
    if (thinkingLevel)
      await worker.request("set_thinking_level", { level: thinkingLevel });
    await worker.prompt({
      text: `Parent context:\n${launch.request.contextSummary}\n\nOriginal request:\n${launch.request.originalPrompt}\n\nAssigned task:\n${launch.request.brief}`,
    });
  } catch (error) {
    await adapter.closeSession(worker.runtimeId).catch(() => undefined);
    throw error;
  }
  return { close: () => adapter.closeSession(worker.runtimeId) };
}

function queueTaskSessionParentTurn(
  parentId: string,
  turn: () => Promise<void>,
): Promise<void> {
  const previous = taskSessionSynthesisTails.get(parentId) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(turn);
  taskSessionSynthesisTails.set(parentId, queued);
  void queued
    .finally(() => {
      if (taskSessionSynthesisTails.get(parentId) === queued) {
        taskSessionSynthesisTails.delete(parentId);
      }
    })
    .catch(() => undefined);
  return queued;
}

function conciseTaskHandoff(value: string) {
  const singleLine = value
    .replace(/\u0000/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.slice(0, 1_024) || "Task completed.";
}

async function synthesizeTaskSession(
  adapter: SinglePiAdapter,
  input: {
    parentId: string;
    originalPrompt: string;
    contextSummary: string;
    tasks: readonly PersistedTaskSessionTask[];
  },
): Promise<void> {
  if (
    !chatRuntimeIds.has(input.parentId) ||
    !adapter.hasRuntime(input.parentId)
  )
    return;
  const report = input.tasks
    .map(
      (task) =>
        `#${task.taskNumber} ${task.generatedName}: ${task.handoffSummary ?? task.lifecycle}`,
    )
    .join("\n");
  const synthesis = async (): Promise<void> => {
    if (!adapter.hasRuntime(input.parentId)) return;
    const text = `Task-session synthesis for: ${input.originalPrompt}\n\n${report}`;
    // Always follow up. The parent turn queue puts this behind an active or
    // queued normal turn; steer remains the sole immediate intervention path.
    await adapter.followUp(input.parentId, { text });
  };
  await queueTaskSessionParentTurn(input.parentId, synthesis);
}

async function createDelegatedChild(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  parentId: string,
  task: { brief: { text: string } },
  callbacks: ChildWorkerCallbacks,
): Promise<{
  close(): Promise<void>;
  provideInput(input: string): Promise<void>;
}> {
  const capacity = getChatWorkerCapacity();
  const parentMode = chatRuntimeModes.get(parentId);
  const cwd = chatWorkerCwds.get(parentId);
  const projectId = chatRuntimeProjectIds.get(parentId);
  if (!parentMode || !cwd)
    throw new Error("Delegating parent is no longer attached.");
  const worker = await capacity.allocate(
    async () => (await store.get()).maxRunningSessions,
    () => {
      if (parentMode === "fake") {
        return adapter.createWorker({
          command: process.execPath,
          args: [
            path.join(__dirname, "pi/fakeRpc/fakeRpcServer.js"),
            "--stream-delay-ms",
            "10",
          ],
          cwd,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
      }
      return createRealDelegatedWorker(adapter, store, cwd, projectId);
    },
  );
  let ended = false;
  worker.onEvent((event) => {
    if (ended) return;
    if (event.type === "extension_ui_request") callbacks.inputNeeded();
    if (event.type === "agent_end" || event.type === "worker_exit") {
      ended = true;
      void worker
        .getMessages()
        .then((messages) => {
          const last = messages.at(-1);
          callbacks.completed({
            summary:
              typeof last?.content === "string"
                ? last.content.slice(0, 32_768)
                : "Child completed.",
          });
        })
        .catch(() =>
          callbacks.failed({ summary: "Child exited without a result." }),
        );
    }
  });
  try {
    await worker.prompt({ text: task.brief.text });
  } catch (error) {
    await adapter.closeSession(worker.runtimeId).catch(() => undefined);
    throw error;
  }
  return {
    close: () => adapter.closeSession(worker.runtimeId),
    provideInput: (input) => worker.steer({ text: input }),
  };
}

async function createRealDelegatedWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  cwd: string,
  projectId: string | undefined,
): Promise<ReturnType<SinglePiAdapter["createWorker"]>> {
  const project =
    projectId === managedRuntimeProjectId
      ? await resolveManagedRuntimeProject()
      : projectId
        ? await ensureProjectStore().resolveAuthorizedProject(projectId)
        : undefined;
  const launch = await resolveRealChatLaunchConfig(store, project);
  return adapter.createWorker({
    command: launch.effective.config.piBinary,
    args: ["--mode", "rpc", ...launch.effective.workerArgs],
    cwd: launch.projectCwd,
    env: launch.effective.config.env,
    requestTimeoutMs: Number(process.env.PI_DECK_REAL_RPC_TIMEOUT_MS ?? 30_000),
    commandProtocol: "type-field",
  });
}

function handleDelegateInput(response: {
  parentId: string;
  connectionId: string;
  toolCallId: string;
  input: string;
}): void {
  const entry = [...delegateCalls.entries()].find(
    ([, call]) =>
      call.connectionId === response.connectionId &&
      call.toolCallId === response.toolCallId,
  );
  if (!entry || !entry[0].startsWith(`${response.parentId}:`)) return;
  const number = Number(entry[0].slice(response.parentId.length + 1));
  void multitaskSupervisor
    ?.provideInput(response.parentId, number, response.input)
    .catch(() => undefined);
}

function handleMultitaskNotification(
  notification: ParentTaskNotification<string>,
): void {
  const key = `${notification.parentId}:${notification.task.number}`;
  const call = delegateCalls.get(key);
  const bridge = delegationBridge;
  if (notification.type === "task-status") {
    bridge?.sendChildLifecycle({
      connectionId: call?.connectionId ?? "",
      toolCallId: call?.toolCallId ?? "",
      taskNumber: notification.task.number,
      status: notification.task.status,
    });
  } else {
    const outcome =
      notification.task.status === "completed"
        ? "completed"
        : notification.task.status === "cancelled"
          ? "cancelled"
          : "failed";
    bridge?.sendChildResult({
      connectionId: call?.connectionId ?? "",
      toolCallId: call?.toolCallId ?? "",
      outcome,
      handoff: notification.handoff,
    });
    delegateCalls.delete(key);
  }
  const supervisor = multitaskSupervisor;
  if (supervisor) {
    try {
      supervisor.state(notification.parentId);
      emitTaskSessionState(notification.parentId);
    } catch {
      // The parent may have been removed while a child notification was queued.
    }
    void persistMultitaskSupervisor(notification.parentId);
  }
}

async function createFakeChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
  workspaceId?: string,
): Promise<ChatWorkerSpec> {
  const fakeRpcPath = path.join(__dirname, "pi/fakeRpc/fakeRpcServer.js");
  const cwd = process.cwd();
  const runtimeId = randomUUID();
  return capacity.allocate(
    async () => (await store.get()).maxRunningSessions,
    () => {
      const worker = adapter.createWorker({
        runtimeId,
        command: process.execPath,
        args: [
          fakeRpcPath,
          "--stream-delay-ms",
          "120",
          ...(process.env.PI_DECK_FAKE_DELEGATE_SCENARIO === "1"
            ? ["--prompt-scenario", "delegate"]
            : []),
        ],
        cwd,
        env: {
          ...delegateEnvironment(process.env, runtimeId),
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
      return { worker, cwd, ...(workspaceId ? { workspaceId } : {}) };
    },
  );
}

async function createRealChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
  project?: ProjectRef,
  workspaceId?: string,
): Promise<ChatWorkerSpec> {
  const launch = await resolveRealChatLaunchConfig(store, project);
  const runtimeId = randomUUID();
  return capacity.allocate(
    async () => (await store.get()).maxRunningSessions,
    async () => {
      const worker = adapter.createWorker({
        runtimeId,
        command: launch.effective.config.piBinary,
        args: await realParentWorkerArgs(launch.effective.workerArgs),
        cwd: launch.projectCwd,
        env: delegateEnvironment(launch.effective.config.env, runtimeId),
        requestTimeoutMs: Number(
          process.env.PI_DECK_REAL_RPC_TIMEOUT_MS ?? 30_000,
        ),
        commandProtocol: "type-field",
      });
      return {
        worker,
        cwd: launch.projectCwd,
        projectId: launch.projectId,
        ...(workspaceId ? { workspaceId } : {}),
      };
    },
  );
}

async function realParentWorkerArgs(
  workerArgs: readonly string[],
): Promise<string[]> {
  const delegateExtension = await deckDelegateExtensionPath();
  const harnessExtension = await deckDelegateHarnessPath(delegateExtension);
  return [
    "--mode",
    "rpc",
    ...workerArgs,
    "--extension",
    delegateExtension,
    ...(harnessExtension ? ["--extension", harnessExtension] : []),
  ];
}

async function createRealResumeWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
  sessionFile: string,
  project?: ProjectRef,
  workspaceId?: string,
): Promise<ChatWorkerSpec> {
  const launch = await resolveRealChatLaunchConfig(store, project);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    throw new Error("No Pi session directory is configured.");
  }
  const validation = isManagedRuntimeProject(project)
    ? await validatePiSessionFile({ sessionFile, sessionDir })
    : await validatePiSession({
        sessionFile,
        sessionDir,
        projectCwd: launch.projectCwd,
      });
  if (!validation.ok) {
    throw new Error(
      `Session is not eligible for resume: ${validation.reason}.`,
    );
  }
  const canonicalSessionFile = validation.sessionFile;
  const runtimeId = randomUUID();
  return capacity.allocate(
    async () => (await store.get()).maxRunningSessions,
    async () => {
      const worker = adapter.createWorker({
        runtimeId,
        command: launch.effective.config.piBinary,
        args: [
          ...(await realParentWorkerArgs(launch.effective.workerArgs)),
          "--session",
          canonicalSessionFile,
        ],
        cwd: launch.projectCwd,
        env: delegateEnvironment(launch.effective.config.env, runtimeId),
        requestTimeoutMs: Number(
          process.env.PI_DECK_REAL_RPC_TIMEOUT_MS ?? 30_000,
        ),
        commandProtocol: "type-field",
      });
      return {
        worker,
        cwd: launch.projectCwd,
        projectId: launch.projectId,
        ...(workspaceId ? { workspaceId } : {}),
      };
    },
  );
}

async function resolveRealChatLaunchConfig(
  store: SettingsStore,
  requestedProject?: ProjectRef,
): Promise<{
  appSettings: AppPiSettings;
  projectId: string;
  projectCwd: string;
  effective: EffectivePiConfigResult;
}> {
  const settings = await store.get();
  const appSettings = applyRealBackendEnvOverrides(settings);
  const project = await resolveRealChatProject(settings, requestedProject);
  const effective = await realChatLaunchConfigCache.resolve({
    appSettings,
    env: process.env,
    projectCwd: project.canonicalPath,
  });
  return {
    appSettings,
    projectId: project.id,
    projectCwd: project.canonicalPath,
    effective,
  };
}

function applyRealBackendEnvOverrides(settings: AppSettings): AppPiSettings {
  const appPiSettings: AppPiSettings = {};
  if (settings.piBinaryPath !== undefined) {
    appPiSettings.piBinaryPath = settings.piBinaryPath;
  }
  if (settings.agentDir !== undefined) {
    appPiSettings.agentDir = settings.agentDir;
  }
  if (settings.sessionDir !== undefined) {
    appPiSettings.sessionDir = settings.sessionDir;
  }
  if (settings.images !== undefined) {
    appPiSettings.images = {
      ...(settings.images.blockImages !== undefined
        ? { blockImages: settings.images.blockImages }
        : {}),
      ...(settings.images.autoResize !== undefined
        ? { autoResize: settings.images.autoResize }
        : {}),
    };
  }

  const piBinaryOverride = process.env.PI_DECK_PI_BINARY;
  if (piBinaryOverride !== undefined && piBinaryOverride.trim().length > 0) {
    appPiSettings.piBinaryPath = piBinaryOverride;
  }
  return appPiSettings;
}

async function resolveRealChatProject(
  settings: AppSettings,
  requestedProject?: ProjectRef,
): Promise<ProjectRef> {
  const projects = ensureProjectStore();
  if (requestedProject !== undefined) {
    if (isManagedRuntimeProject(requestedProject)) {
      // Managed contexts are constructed and revalidated in main. They are
      // intentionally absent from ProjectStore and cannot be named by a
      // renderer-supplied projectId.
      return resolveManagedRuntimeProject();
    }
    // Revalidate immediately before configuration/model discovery or spawn.
    // The object originated at the IPC boundary, but the project can still be
    // removed or moved while an earlier request is waiting on async work.
    return projects.resolveAuthorizedProject(requestedProject.id);
  }

  const activeProject = await projects.getActiveProject();
  const hasExplicitBootstrapOverride =
    selectedRealProjectCwd !== undefined ||
    (process.env.PI_DECK_PROJECT_CWD?.trim().length ?? 0) > 0;
  if (!hasExplicitBootstrapOverride && activeProject !== undefined) {
    return projects.resolveAuthorizedProject(activeProject.id);
  }

  const requested =
    selectedRealProjectCwd ??
    process.env.PI_DECK_PROJECT_CWD ??
    settings.projectCwd ??
    process.cwd();
  const resolved = path.resolve(requested);
  const canonical = (await safeRealpath(resolved)) ?? resolved;
  // Bootstrap/settings/environment are main-process configuration, not a
  // renderer grant. Register once, then still validate the canonical root
  // before any model scan or worker creation.
  const project = await projects.upsertAndActivateProject(canonical);
  return projects.resolveAuthorizedProject(project.id);
}

async function closeChatWorker(): Promise<void> {
  const adapter = chatAdapter;
  const runtimeIds = [...chatRuntimeIds];
  // Reset/quit has no parent left to mediate child work: retire bridge calls
  // and await private child shutdown before releasing parent bookkeeping.
  await Promise.all(
    runtimeIds.map(async (runtimeId) => {
      delegationBridge?.removeParent(runtimeId);
      cancelTaskSessionPlanners(runtimeId);
      await taskSessionOrchestrator?.removeParent(runtimeId);
      await multitaskSupervisor?.removeParent(runtimeId);
    }),
  );
  delegateCalls.clear();
  chatEventUnsubscribe?.();
  chatEventUnsubscribe = undefined;
  chatAdapter = undefined;
  chatWorkerCapacity = undefined;
  chatRuntimeId = undefined;
  chatBackendMode = undefined;
  chatRuntimeIds.clear();
  chatRuntimeModes.clear();
  chatWorkerCwds.clear();
  chatRuntimeSessionFiles.clear();
  chatRuntimeProjectIds.clear();
  chatRuntimeWorkspaceIds.clear();
  chatSessionFileLocks.clear();
  chatSessionResumePromises.clear();
  attachmentPreservingRuntimeClosures.clear();
  for (const runtimeId of runtimeIds) {
    attachmentSelections.releaseSession(runtimeId);
  }
  // chat:reset and application shutdown discard every renderer draft as well
  // as attached runtimes; no selection payload may survive that boundary.
  attachmentSelections.clear();
  for (const runtimeId of [...pendingExtensionUiRequests.keys()]) {
    clearPendingExtensionUiRequests(runtimeId);
  }

  if (adapter === undefined || runtimeIds.length === 0) {
    return;
  }

  await Promise.all(
    runtimeIds.map(async (runtimeId) => {
      try {
        await adapter.closeSession(runtimeId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics?.recordError(
          `Failed to close chat worker ${runtimeId}: ${message}`,
        );
      }
    }),
  );
}

async function listChatModels(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  runtimeId?: string,
  project?: ProjectRef,
): Promise<z.infer<typeof chatListModelsResultSchema>> {
  if (runtimeId === undefined) {
    if (resolveChatBackendMode() === "fake") {
      const activeModel = {
        id: "fake-model",
        name: "Fake model",
        provider: "fake",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
      };
      return {
        models: [activeModel],
        activeModel,
        thinkingLevel: "medium",
        thinkingLevels: [
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ],
      };
    }
    const launch = await resolveRealChatLaunchConfig(store, project);
    try {
      const discovery = await discoverPiRuntimeModels({
        command: launch.effective.config.piBinary,
        args: launch.effective.workerArgs,
        cwd: launch.projectCwd,
        env: launch.effective.config.env,
        requestTimeoutMs: Number(
          process.env.PI_DECK_REAL_RPC_TIMEOUT_MS ?? 30_000,
        ),
      });
      return chatListModelsResultSchema.parse(discovery);
    } catch (error) {
      diagnosticsService.recordError(
        `Pi runtime model discovery failed; falling back to --list-models: ${error instanceof Error ? error.message : String(error)}`,
      );
      const models = await discoverPiModels({
        command: launch.effective.config.piBinary,
        args: launch.effective.workerArgs,
        cwd: launch.projectCwd,
        env: launch.effective.config.env,
      });
      return chatListModelsResultSchema.parse({
        models,
        thinkingLevels: [],
      });
    }
  }

  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
  const [state, modelsResponse, thinkingLevelsResponse] = await Promise.all([
    adapter.request(activeRuntimeId, "get_state"),
    adapter.request(activeRuntimeId, "get_available_models"),
    adapter.request(activeRuntimeId, "get_available_thinking_levels"),
  ]);
  return chatListModelsResultSchema.parse(
    parsePiRuntimeModelDiscovery(state, modelsResponse, thinkingLevelsResponse),
  );
}

async function listChatCommands(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  runtimeId: string,
): Promise<ChatListCommandsResult> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
  const response = await adapter.request(activeRuntimeId, "get_commands");
  return { commands: normalizeChatCommands(response) };
}

function normalizeChatCommands(response: unknown): ChatCommandSummary[] {
  const rawCommands =
    response &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    Array.isArray((response as { commands?: unknown }).commands)
      ? (response as { commands: unknown[] }).commands
      : Array.isArray(response)
        ? response
        : [];

  return rawCommands.flatMap((item): ChatCommandSummary[] => {
    if (typeof item === "string") {
      return [{ name: item, source: "extension", insertText: item }];
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const rawName = firstString(record.name, record.command, record.id);
    if (rawName === undefined || isTuiOnlyCommand(rawName)) {
      return [];
    }
    const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
    const description = firstString(
      record.description,
      record.summary,
      record.title,
    );
    const source = normalizeCommandSource(
      firstString(record.source, record.type, record.kind),
    );
    const insertText = firstString(record.insertText, record.text, name);
    return [
      {
        name,
        ...(description !== undefined ? { description } : {}),
        source,
        ...(insertText !== undefined ? { insertText } : {}),
      },
    ];
  });
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeCommandSource(
  source: string | undefined,
): ChatCommandSummary["source"] {
  const value = source?.toLowerCase().replace(/[\s_-]+/g, " ");
  if (value?.includes("skill")) {
    return "skill";
  }
  if (value?.includes("prompt") || value?.includes("template")) {
    return "prompt template";
  }
  return "extension";
}

function isTuiOnlyCommand(name: string): boolean {
  return ["/settings", "/hotkeys", "/help"].includes(name.trim());
}

async function setChatModel(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  runtimeId: string,
  provider: string,
  modelId: string,
): Promise<ChatSnapshot> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
  await adapter.request(activeRuntimeId, "set_model", { provider, modelId });
  return getChatSnapshotForRuntime(
    adapter,
    activeRuntimeId,
    chatRuntimeModes.get(activeRuntimeId) ?? resolveChatBackendMode(),
    { skipMessages: true },
  );
}

async function setChatThinking(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  runtimeId: string,
  level: string,
): Promise<ChatSnapshot> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
  await adapter.request(activeRuntimeId, "set_thinking_level", { level });
  return getChatSnapshotForRuntime(
    adapter,
    activeRuntimeId,
    chatRuntimeModes.get(activeRuntimeId) ?? resolveChatBackendMode(),
    { skipMessages: true },
  );
}

async function listChatSessions(
  store: SettingsStore,
  project?: ProjectRef,
): Promise<ChatListSessionsResult> {
  const mode = resolveChatBackendMode();
  if (mode !== "real") {
    return {
      projectCwd: process.cwd(),
      ...(project ? { projectId: project.id } : {}),
      sessions: [],
      diagnostics: [
        "Session repository scanning is only enabled in real Pi mode.",
      ],
    };
  }

  const launch = await resolveRealChatLaunchConfig(store, project);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    return {
      projectCwd: launch.projectCwd,
      projectId: launch.projectId,
      sessions: [],
      diagnostics: ["No Pi session directory is configured."],
    };
  }

  const scanResults = [
    await scanSessionRepository({
      sessionDir,
      projectCwd: launch.projectCwd,
      maxDepth: 4,
      maxFiles: 20_000,
      maxTotalBytes: 250 * 1024 * 1024,
      maxWallTimeMs: 15_000,
    }),
  ];
  const candidateDir = launch.effective.projectSessionDirCandidate;
  if (
    candidateDir !== undefined &&
    candidateDir !== sessionDir &&
    process.env.PI_DECK_SCAN_PROJECT_SESSION_DIR_CANDIDATE === "1"
  ) {
    scanResults.push(
      await scanSessionRepository({
        sessionDir: candidateDir,
        projectCwd: launch.projectCwd,
        maxDepth: 3,
        maxFiles: 5_000,
        maxTotalBytes: 100 * 1024 * 1024,
        maxWallTimeMs: 5_000,
      }),
    );
  }

  const sessionsByFile = new Map(
    scanResults.flatMap((result) =>
      result.sessions.map((session) => [session.sessionFile, session] as const),
    ),
  );
  const diagnostics = scanResults.flatMap((result) => result.diagnostics);
  await mergeProjectSessionRefs(
    launch.projectId,
    launch.projectCwd,
    sessionsByFile,
    diagnostics,
  );
  const sessions = [...sessionsByFile.values()].sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs,
  );
  if (candidateDir !== undefined && candidateDir !== sessionDir) {
    diagnostics.push(
      process.env.PI_DECK_SCAN_PROJECT_SESSION_DIR_CANDIDATE === "1"
        ? `Scanned opted-in project sessionDir candidate: ${candidateDir}`
        : `Project sessionDir candidate not scanned without opt-in: ${candidateDir}`,
    );
  }

  return {
    projectCwd: launch.projectCwd,
    projectId: launch.projectId,
    sessionDir,
    sessions: sessions.map((session) => {
      const attachedRuntimeId = chatSessionFileLocks.get(session.sessionFile);
      return attachedRuntimeId ? { ...session, attachedRuntimeId } : session;
    }),
    diagnostics,
  };
}

async function listWorkspaceChatSessions(
  settings: SettingsStore,
  workspaceId: string,
  options: {
    discoverLegacySessions?: boolean;
    includeArchived?: boolean;
  } = {},
): Promise<ChatListSessionsResult> {
  const storedWorkspace =
    await ensureWorkspaceStore().getWorkspace(workspaceId);
  if (storedWorkspace === undefined) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  if (
    storedWorkspace.archivedAtMs !== undefined &&
    options.includeArchived !== true
  ) {
    throw new Error(`Workspace is archived: ${workspaceId}`);
  }
  const workspace = storedWorkspace;
  const sessionListOptions =
    options.includeArchived === undefined
      ? {}
      : { includeArchived: options.includeArchived };
  let refs = await ensureWorkspaceStore().getCachedSessionSummaries(
    workspace.id,
    sessionListOptions,
  );
  const diagnostics: string[] = [];
  // Compatibility migration: existing directory-backed projects historically
  // discovered sessions by cwd instead of persisting explicit membership. Keep
  // migrated workspaces in sync with newly discovered files, but never reclaim
  // a session that the user explicitly moved to another workspace.
  if (
    workspace.archivedAtMs === undefined &&
    workspace.legacyProjectId !== undefined &&
    options.discoverLegacySessions !== false
  ) {
    try {
      const project = await ensureProjectStore().resolveAuthorizedProject(
        workspace.legacyProjectId,
      );
      const legacy = await listChatSessions(settings, project);
      diagnostics.push(...legacy.diagnostics);
      if (legacy.sessions.length > 0) {
        // The store applies discovery atomically: refresh current membership,
        // claim only unassigned files, preserve legacy-removal exclusions, and
        // never transfer a ref already owned by another workspace.
        await ensureWorkspaceStore().upsertSessionRefs(
          workspace.id,
          legacy.sessions,
        );
        refs = await ensureWorkspaceStore().getCachedSessionSummaries(
          workspace.id,
          sessionListOptions,
        );
      }
    } catch (error) {
      diagnostics.push(
        `Legacy working-folder session discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  refs = await refreshWorkspaceSessionSummaries(
    settings,
    workspace,
    refs,
    options.includeArchived === true,
    diagnostics,
  );
  const sessions: ChatListSessionsResult["sessions"] = [];
  for (const ref of refs) {
    const canonical = await safeRealpath(ref.sessionFile);
    if (canonical === undefined) {
      await ensureWorkspaceStore().markSessionMissing(
        workspace.id,
        ref.sessionFile,
      );
      diagnostics.push(
        `Workspace session ref is missing or unreadable and was hidden: ${ref.sessionFile}`,
      );
      continue;
    }
    const attachedRuntimeId = chatSessionFileLocks.get(canonical);
    sessions.push({
      ...ref,
      id: canonical,
      sessionFile: canonical,
      ...(attachedRuntimeId ? { attachedRuntimeId } : {}),
    });
  }
  const defaultProject = workspace.defaultProjectId
    ? await ensureProjectStore()
        .resolveAuthorizedProject(workspace.defaultProjectId)
        .catch(() => undefined)
    : undefined;
  return {
    projectCwd:
      defaultProject?.canonicalPath ?? sessions[0]?.cwd ?? process.cwd(),
    workspaceId: workspace.id,
    ...(defaultProject ? { projectId: defaultProject.id } : {}),
    sessions: sessions.sort(
      (left, right) => right.updatedAtMs - left.updatedAtMs,
    ),
    diagnostics,
  };
}

/**
 * Refresh metadata for explicit workspace members without scanning every Pi
 * session. The cache is populated when a runtime is first created, so a
 * process exit or crash can leave a filename-like title behind even though
 * the JSONL already contains the user's first prompt.
 */
async function refreshWorkspaceSessionSummaries(
  settings: SettingsStore,
  workspace: WorkspaceRecord,
  refs: ChatSessionSummary[],
  includeArchived: boolean,
  diagnostics: string[],
): Promise<ChatSessionSummary[]> {
  if (refs.length === 0 || resolveChatBackendMode() !== "real") {
    return refs;
  }

  let sessionDir: string | undefined;
  try {
    const project =
      workspace.archivedAtMs === undefined
        ? await resolveWorkspaceRepositoryProject(workspace.id)
        : workspace.defaultProjectId === undefined
          ? await resolveManagedRuntimeProject()
          : await ensureProjectStore()
              .resolveAuthorizedProject(workspace.defaultProjectId)
              .catch(() => resolveManagedRuntimeProject());
    const launch = await resolveRealChatLaunchConfig(settings, project);
    sessionDir = launch.effective.config.sessionDir;
  } catch (error) {
    diagnostics.push(
      `Workspace session metadata refresh unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return refs;
  }
  if (sessionDir === undefined) {
    return refs;
  }

  const refreshed: ChatSessionSummary[] = [];
  const refreshBatchSize = 8;
  for (let index = 0; index < refs.length; index += refreshBatchSize) {
    const batch = refs.slice(index, index + refreshBatchSize);
    const results = await Promise.all(
      batch.map((ref) =>
        readPiSessionSummary({ sessionFile: ref.sessionFile, sessionDir }),
      ),
    );
    for (const result of results) {
      diagnostics.push(...result.diagnostics);
      if (result.summary !== undefined) {
        refreshed.push(result.summary);
      }
    }
  }
  if (refreshed.length === 0) {
    return refs;
  }

  try {
    await ensureWorkspaceStore().upsertSessionRefs(workspace.id, refreshed, {
      ...(workspace.archivedAtMs !== undefined ? { allowArchived: true } : {}),
    });
    return ensureWorkspaceStore().getCachedSessionSummaries(workspace.id, {
      includeArchived,
    });
  } catch (error) {
    diagnostics.push(
      `Workspace session metadata refresh could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    );
    return refs;
  }
}

async function projectForWorkspaceSession(
  workspaceId: string,
  sessionFile: string,
): Promise<ProjectRef> {
  const workspace = await requireOpenWorkspace(workspaceId);
  const canonical =
    (await safeRealpath(sessionFile)) ?? path.resolve(sessionFile);
  const ref = (await ensureWorkspaceStore().getSessionRefs(workspace.id)).find(
    (item) => item.sessionFile === canonical,
  );
  if (ref === undefined) {
    throw new Error("Session does not belong to this workspace.");
  }
  const managedProject = await resolveManagedRuntimeProject();
  // A workspace without a default project is intentionally directory
  // independent. Imported/legacy sessions can retain an old cwd in their Pi
  // header even after their former project record is gone; requiring the user
  // to reopen that folder would make the folderless workspace unusable. Run
  // those sessions in Pi Deck's managed context instead. Directory-backed
  // workspaces continue through the registered-project authorization path
  // below.
  if (workspace.defaultProjectId === undefined) {
    return managedProject;
  }
  const refCwd = ref.cwd
    ? ((await safeRealpath(ref.cwd)) ?? path.resolve(ref.cwd))
    : undefined;
  if (refCwd === managedProject.canonicalPath) {
    return managedProject;
  }
  const projects = await ensureProjectStore().list();
  const project = ref.cwd
    ? projects.projects.find((candidate) => candidate.canonicalPath === ref.cwd)
    : workspace.defaultProjectId
      ? projects.projects.find(
          (candidate) => candidate.id === workspace.defaultProjectId,
        )
      : undefined;
  if (project === undefined) {
    throw new Error(
      "The session working folder is not registered. Reopen that folder before resuming this session.",
    );
  }
  return ensureProjectStore().resolveAuthorizedProject(project.id);
}

async function mergeProjectSessionRefs(
  projectId: string,
  projectCwd: string,
  sessionsByFile: Map<string, ChatListSessionsResult["sessions"][number]>,
  diagnostics: string[],
): Promise<void> {
  const store = projectStore;
  if (store === undefined) {
    return;
  }

  const refs = await store.getSessionRefs(projectId);
  const missingSessionFiles: string[] = [];
  for (const ref of refs) {
    if (sessionsByFile.has(ref.sessionFile)) {
      continue;
    }
    const canonical = await safeRealpath(ref.sessionFile);
    if (canonical === undefined) {
      missingSessionFiles.push(ref.sessionFile);
      diagnostics.push(
        `Project session ref is missing or unreadable and was hidden: ${ref.sessionFile}`,
      );
      continue;
    }
    sessionsByFile.set(canonical, {
      id: canonical,
      sessionFile: canonical,
      ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
      ...(ref.cwd ? { cwd: ref.cwd } : { cwd: projectCwd }),
      title: ref.title ?? path.basename(canonical, ".jsonl"),
      updatedAtMs: ref.lastKnownUpdatedAtMs ?? ref.lastSeenAtMs,
      ...(ref.createdAtMs ? { createdAtMs: ref.createdAtMs } : {}),
      messageCount: ref.messageCount ?? 0,
      ...(ref.preview ? { preview: ref.preview } : {}),
    });
  }

  await store.upsertSessionRefs(projectId, [...sessionsByFile.values()], {
    missingSessionFiles,
  });
}

async function deleteChatSession(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  sessionFile: string,
  project?: ProjectRef,
  workspaceId?: string,
): Promise<ChatDeleteSessionResult> {
  const mode = resolveChatBackendMode();
  if (mode !== "real") {
    throw new Error(
      "Deleting saved sessions is only available in real Pi mode.",
    );
  }

  const launch = await resolveRealChatLaunchConfig(store, project);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    throw new Error("No Pi session directory is configured.");
  }
  const validation = isManagedRuntimeProject(project)
    ? await validatePiSessionFile({ sessionFile, sessionDir })
    : await validatePiSession({
        sessionFile,
        sessionDir,
        projectCwd: launch.projectCwd,
      });
  if (!validation.ok) {
    throw new Error(
      `Session is not eligible for deletion: ${validation.reason}.`,
    );
  }
  const canonicalSessionFile = validation.sessionFile;

  const lockedRuntimeId = chatSessionFileLocks.get(canonicalSessionFile);
  if (lockedRuntimeId !== undefined) {
    // Closing must precede removal so Pi cannot keep writing the session while
    // it is moved. Keep the composer's generation alive until file removal is
    // confirmed; a failed removal can then be resumed without dead chips.
    await closeRuntimeForDeletedSession(lockedRuntimeId, true);
  }

  await removePersistedPiSessionFile(
    launch.projectId,
    canonicalSessionFile,
    diagnosticsService,
    workspaceId,
  );
  if (lockedRuntimeId !== undefined) {
    attachmentPreservingRuntimeClosures.delete(lockedRuntimeId);
    attachmentSelections.releaseSession(lockedRuntimeId);
  }
  return { deleted: true, sessionFile: canonicalSessionFile };
}

async function closeRuntimeForDeletedSession(
  runtimeId: string,
  preserveAttachments = false,
): Promise<void> {
  const adapter = chatAdapter;
  if (adapter === undefined) {
    forgetChatRuntime(runtimeId, { preserveAttachments });
    return;
  }
  await closeAttachedChatRuntime(adapter, runtimeId, { preserveAttachments });
}

async function deleteAllChatSessions(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  project?: ProjectRef,
): Promise<ChatDeleteAllSessionsResult> {
  const listed = await listChatSessions(store, project);
  if (listed.sessions.length === 0) {
    return {
      deleted: true,
      deletedCount: 0,
      skippedCount: 0,
      deletedSessionFiles: [],
    };
  }
  const launch = await resolveRealChatLaunchConfig(store, project);
  const sessionDir = launch.effective.config.sessionDir;
  const deletedSessionFiles: string[] = [];
  let deletedCount = 0;
  let skippedCount = 0;

  for (const session of listed.sessions) {
    try {
      if (sessionDir === undefined) {
        skippedCount += 1;
        continue;
      }
      const validation = await validatePiSession({
        sessionFile: session.sessionFile,
        sessionDir,
        projectCwd: launch.projectCwd,
      });
      if (!validation.ok) {
        skippedCount += 1;
        continue;
      }
      const canonicalSessionFile = validation.sessionFile;
      const lockedRuntimeId = chatSessionFileLocks.get(canonicalSessionFile);
      if (
        lockedRuntimeId !== undefined &&
        chatRuntimeIds.has(lockedRuntimeId)
      ) {
        skippedCount += 1;
        continue;
      }
      await removePersistedPiSessionFile(
        launch.projectId,
        canonicalSessionFile,
        diagnosticsService,
      );
      deletedSessionFiles.push(canonicalSessionFile);
      deletedCount += 1;
    } catch (error) {
      // A single unexpected validation/I/O failure must not hide the prefix
      // already removed. Return its exact completed subset so the renderer
      // releases only those owners and retains every skipped draft.
      skippedCount += 1;
      diagnosticsService.recordError(
        `Failed to delete saved Pi session ${session.sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { deleted: true, deletedCount, skippedCount, deletedSessionFiles };
}

async function deleteAllWorkspaceChatSessions(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  workspaceId: string,
): Promise<ChatDeleteAllSessionsResult> {
  // Destructive operations must use explicit membership only. A refresh may
  // discover legacy sessions, but delete-all must never adopt new files as a
  // side effect immediately before deleting them.
  const listed = await listWorkspaceChatSessions(store, workspaceId, {
    discoverLegacySessions: false,
  });
  const deletedSessionFiles: string[] = [];
  let skippedCount = 0;
  for (const session of listed.sessions) {
    const lockedRuntimeId = chatSessionFileLocks.get(session.sessionFile);
    if (lockedRuntimeId !== undefined && chatRuntimeIds.has(lockedRuntimeId)) {
      skippedCount += 1;
      continue;
    }
    try {
      const project = await projectForWorkspaceSession(
        workspaceId,
        session.sessionFile,
      );
      const result = await deleteChatSession(
        store,
        diagnosticsService,
        session.sessionFile,
        project,
        workspaceId,
      );
      deletedSessionFiles.push(result.sessionFile);
    } catch (error) {
      skippedCount += 1;
      diagnosticsService.recordError(
        `Failed to delete workspace session ${session.sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    deleted: true,
    deletedCount: deletedSessionFiles.length,
    skippedCount,
    deletedSessionFiles,
  };
}

async function removePersistedPiSessionFile(
  projectId: string,
  sessionFile: string,
  diagnosticsService: DiagnosticsService,
  workspaceId?: string,
): Promise<void> {
  try {
    await trashOrRemoveFile(sessionFile);
  } catch (error) {
    // Some platform trash APIs can report an error after moving the file. Do
    // not make the renderer retain a dead row/owner in that case, but never
    // infer removal from a permission or other unreadable-path failure.
    if (!(await isSessionFileMissing(sessionFile))) {
      throw error;
    }
    diagnosticsService.recordError(
      `Pi session file ${sessionFile} was removed despite a trash error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  chatSessionFileLocks.delete(sessionFile);
  try {
    await Promise.all([
      multitaskStateStore?.delete(sessionFile),
      taskSessionStateStore?.delete(sessionFile),
    ]);
  } catch (error) {
    diagnosticsService.recordError(
      `Failed to remove multitask state for deleted Pi session ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A detached saved-row composer uses the canonical session file as its
  // owner. Revoke it only after removal is confirmed; failed validation and
  // per-file bulk failures leave that owner intact for retry.
  attachmentSelections.releaseSession(sessionFile);
  if (projectId !== managedRuntimeProjectId) {
    try {
      await projectStore?.removeSessionRef(projectId, sessionFile);
    } catch (error) {
      // Disk deletion is already final. The next list scan removes a stale cache
      // ref, so record this persistence failure without falsely reporting that
      // the session is still available to the renderer.
      diagnosticsService.recordError(
        `Failed to remove deleted Pi session cache ref ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (workspaceId !== undefined) {
    try {
      await workspaceStore?.removeSession(workspaceId, sessionFile);
    } catch (error) {
      diagnosticsService.recordError(
        `Failed to remove deleted workspace session ref ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function isSessionFileMissing(sessionFile: string): Promise<boolean> {
  try {
    await fs.lstat(sessionFile);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function trashOrRemoveFile(filePath: string): Promise<void> {
  const forcedFailurePath = process.env.PI_DECK_TEST_FAIL_SESSION_DELETE_PATH;
  if (
    forcedFailurePath !== undefined &&
    path.resolve(forcedFailurePath) === path.resolve(filePath)
  ) {
    throw new Error("Forced session deletion failure for lifecycle testing.");
  }
  try {
    await shell.trashItem(filePath);
  } catch {
    await fs.rm(filePath, { force: true });
  }
}

async function resumeChatSession(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  sessionFile: string,
  project?: ProjectRef,
  workspaceId?: string,
): Promise<ChatSnapshot> {
  if (resolveChatBackendMode() !== "real") {
    throw new Error("Session resume is only available in real Pi mode.");
  }

  const launch = await resolveRealChatLaunchConfig(store, project);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    throw new Error("No Pi session directory is configured.");
  }
  const validation = isManagedRuntimeProject(project)
    ? await validatePiSessionFile({ sessionFile, sessionDir })
    : await validatePiSession({
        sessionFile,
        sessionDir,
        projectCwd: launch.projectCwd,
      });
  if (!validation.ok) {
    throw new Error(
      `Session is not eligible for resume: ${validation.reason}.`,
    );
  }
  const canonicalSessionFile = validation.sessionFile;

  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const existingRuntimeId = chatSessionFileLocks.get(canonicalSessionFile);
  const mode = chatBackendMode ?? "real";
  if (existingRuntimeId !== undefined) {
    chatRuntimeId = existingRuntimeId;
    return getChatSnapshotForRuntime(adapter, existingRuntimeId, mode);
  }

  const pendingResume = chatSessionResumePromises.get(canonicalSessionFile);
  if (pendingResume !== undefined) {
    return pendingResume;
  }

  const resumePromise = attachRealResumeWorker(
    adapter,
    store,
    getChatWorkerCapacity(),
    canonicalSessionFile,
    project,
    workspaceId,
  ).finally(() => {
    chatSessionResumePromises.delete(canonicalSessionFile);
  });
  chatSessionResumePromises.set(canonicalSessionFile, resumePromise);
  return resumePromise;
}

async function attachRealResumeWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
  canonicalSessionFile: string,
  project?: ProjectRef,
  workspaceId?: string,
): Promise<ChatSnapshot> {
  const workerSpec = await serializeChatWorkerCreation(() =>
    createRealResumeWorker(
      adapter,
      store,
      capacity,
      canonicalSessionFile,
      project,
      workspaceId,
    ),
  );
  const runtimeId = workerSpec.worker.runtimeId;
  chatRuntimeId = runtimeId;
  chatRuntimeIds.add(runtimeId);
  chatRuntimeModes.set(runtimeId, "real");
  chatWorkerCwds.set(runtimeId, workerSpec.cwd);
  if (workerSpec.projectId !== undefined) {
    chatRuntimeProjectIds.set(runtimeId, workerSpec.projectId);
  }
  if (workerSpec.workspaceId !== undefined) {
    chatRuntimeWorkspaceIds.set(runtimeId, workerSpec.workspaceId);
  }
  chatRuntimeSessionFiles.set(runtimeId, canonicalSessionFile);
  chatSessionFileLocks.set(canonicalSessionFile, runtimeId);

  try {
    const snapshot = await getChatSnapshotForRuntime(
      adapter,
      runtimeId,
      "real",
    );
    const returnedSessionFile = snapshot.state.sessionFile;
    if (typeof returnedSessionFile !== "string") {
      throw new Error(
        "This Pi version did not report the resumed session file. Update Pi and try again, or resume this session from the Pi CLI.",
      );
    }
    const returnedCanonical =
      (await safeRealpath(returnedSessionFile)) ??
      path.resolve(returnedSessionFile);
    if (returnedCanonical !== canonicalSessionFile) {
      throw new Error(
        `Pi resume opened a different session. Requested ${canonicalSessionFile}, got ${returnedCanonical}.`,
      );
    }
    chatRuntimeSessionFiles.set(runtimeId, canonicalSessionFile);
    chatSessionFileLocks.set(canonicalSessionFile, runtimeId);
    return snapshot;
  } catch (error) {
    await closeRuntimeForDeletedSession(runtimeId);
    throw error;
  }
}

async function createChatSessionSnapshot(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  project?: ProjectRef,
  workspaceId?: string,
  initialMultitaskMode: "sequential" | "parallel" = "sequential",
): Promise<ChatSnapshot> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const mode = chatBackendMode ?? resolveChatBackendMode();
  const workerSpec = await createChatWorker(
    adapter,
    store,
    mode,
    getChatWorkerCapacity(),
    project,
    workspaceId,
    initialMultitaskMode,
  );
  const runtimeId = workerSpec.worker.runtimeId;
  try {
    const snapshot = await getChatSnapshotForRuntime(adapter, runtimeId, mode, {
      skipMessages: true,
    });
    await persistMultitaskSupervisor(runtimeId);
    return snapshot;
  } catch (error) {
    try {
      await closeAttachedChatRuntime(adapter, runtimeId);
    } catch (cleanupError) {
      diagnosticsService.recordError(
        `Failed to clean up newly created chat worker ${runtimeId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

async function getChatSnapshot(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
  requestedRuntimeId?: string,
): Promise<ChatSnapshot> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const mode = chatBackendMode ?? resolveChatBackendMode();
  const runtimeId = requestedRuntimeId ?? chatRuntimeId;
  if (runtimeId === undefined) {
    throw new Error(`${mode} chat runtime failed to initialize`);
  }
  if (!chatRuntimeIds.has(runtimeId) || !adapter.hasRuntime(runtimeId)) {
    forgetChatRuntime(runtimeId);
    throw new Error(`Chat runtime is no longer attached: ${runtimeId}`);
  }
  return getChatSnapshotForRuntime(adapter, runtimeId, mode);
}

async function getChatRuntimeStatus(
  requestedRuntimeId: string,
): Promise<ChatRuntimeStatus> {
  // A status read must not initialize a replacement worker for a stale runtime.
  const adapter = chatAdapter;
  if (adapter === undefined) {
    throw new Error(
      `Chat runtime is no longer attached: ${requestedRuntimeId}`,
    );
  }
  const runtimeId = resolveActiveChatRuntimeId(adapter, requestedRuntimeId);
  const mode = chatRuntimeModes.get(runtimeId) ?? resolveChatBackendMode();
  // Do not replace this with getChatSnapshot: status reconciliation must never
  // transfer get_messages/history across RPC or Electron IPC.
  const state = await adapter.getRuntimeStatus(runtimeId);
  const usage = runtimeUsageFromState(state);
  return {
    runtimeId,
    backendMode: mode,
    state: compactRuntimeStatusState(state, runtimeId),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function compactRuntimeStatusState(
  state: PiState,
  runtimeId: string,
): ChatRuntimeStatus["state"] {
  const record = state as Record<string, unknown>;
  const isAgentActive = Boolean(
    state.isAgentActive ??
    (typeof record.isStreaming === "boolean" ? record.isStreaming : false),
  );
  const model = compactRuntimeStatusModel(state.model);
  return {
    ...(typeof state.sessionId === "string"
      ? { sessionId: state.sessionId }
      : {}),
    ...(typeof state.sessionFile === "string"
      ? { sessionFile: state.sessionFile }
      : {}),
    ...(typeof state.cwd === "string"
      ? { cwd: state.cwd ?? chatWorkerCwds.get(runtimeId) }
      : chatWorkerCwds.get(runtimeId) !== undefined
        ? { cwd: chatWorkerCwds.get(runtimeId) }
        : {}),
    ...(model !== undefined ? { model } : {}),
    ...(typeof state.provider === "string" ? { provider: state.provider } : {}),
    ...(typeof state.thinkingLevel === "string"
      ? { thinkingLevel: state.thinkingLevel }
      : {}),
    isAgentActive,
  };
}

function compactRuntimeStatusModel(
  model: unknown,
): ChatRuntimeStatus["state"]["model"] | undefined {
  if (typeof model === "string") {
    return model;
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return undefined;
  }
  const record = model as Record<string, unknown>;
  const compact = {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.provider === "string"
      ? { provider: record.provider }
      : {}),
    ...(typeof record.contextWindow === "number" &&
    Number.isFinite(record.contextWindow) &&
    record.contextWindow >= 0
      ? { contextWindow: record.contextWindow }
      : {}),
  };
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function runtimeUsageFromState(
  state: PiState,
): ChatRuntimeStatus["usage"] | undefined {
  const usage = (state as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
    return undefined;
  };
  const inputTokens = number("inputTokens", "input");
  const outputTokens = number("outputTokens", "output");
  const cacheReadTokens = number("cacheReadTokens", "cacheRead") ?? 0;
  const cacheWriteTokens = number("cacheWriteTokens", "cacheWrite") ?? 0;
  const nestedCost = record.cost;
  const nestedCostTotal =
    nestedCost && typeof nestedCost === "object" && !Array.isArray(nestedCost)
      ? (nestedCost as Record<string, unknown>).total
      : undefined;
  const totalCostUsd =
    number("totalCostUsd", "cost") ??
    (typeof nestedCostTotal === "number" &&
    Number.isFinite(nestedCostTotal) &&
    nestedCostTotal >= 0
      ? nestedCostTotal
      : undefined);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return undefined;
  }
  const safeInputTokens = inputTokens ?? 0;
  const safeOutputTokens = outputTokens ?? 0;
  return {
    inputTokens: safeInputTokens,
    outputTokens: safeOutputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens:
      number("totalTokens", "total") ??
      safeInputTokens + safeOutputTokens + cacheReadTokens + cacheWriteTokens,
    ...(number("contextUsedTokens", "contextUsed") !== undefined
      ? { contextUsedTokens: number("contextUsedTokens", "contextUsed") }
      : {}),
    ...(number("contextWindowTokens", "contextWindow") !== undefined
      ? { contextWindowTokens: number("contextWindowTokens", "contextWindow") }
      : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

async function getChatSnapshotForRuntime(
  adapter: SinglePiAdapter,
  runtimeId: string,
  fallbackMode: ChatBackendMode,
  options: { skipMessages?: boolean } = {},
): Promise<ChatSnapshot> {
  const mode = chatRuntimeModes.get(runtimeId) ?? fallbackMode;
  const projectId = chatRuntimeProjectIds.get(runtimeId);
  const workspaceId = chatRuntimeWorkspaceIds.get(runtimeId);
  const state = await adapter.getState(runtimeId);
  const messages = options.skipMessages
    ? []
    : await adapter.getMessages(runtimeId);
  if (typeof state.sessionFile === "string") {
    const canonicalSessionFile =
      (await safeRealpath(state.sessionFile)) ??
      path.resolve(state.sessionFile);
    chatRuntimeSessionFiles.set(runtimeId, canonicalSessionFile);
    chatSessionFileLocks.set(canonicalSessionFile, runtimeId);
    // Model/thinking updates intentionally omit get_messages. Merge their
    // state-only data only when Pi supplies a real sessionName; never turn an
    // empty metadata read into a filename title or a zero-message transcript.
    const title =
      titleFromSessionName(state) ??
      (options.skipMessages ? undefined : titleFromMessages(messages));
    const hasTranscript = !options.skipMessages && messages.length > 0;
    if (workspaceId !== undefined) {
      const preview = hasTranscript ? previewFromMessages(messages) : undefined;
      await workspaceStore?.upsertSessionRefFromSnapshot({
        workspaceId,
        sessionFile: canonicalSessionFile,
        ...(typeof state.sessionId === "string"
          ? { sessionId: state.sessionId }
          : {}),
        ...(typeof state.cwd === "string" ? { cwd: state.cwd } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(hasTranscript
          ? { updatedAtMs: Date.now(), messageCount: messages.length }
          : {}),
        ...(preview !== undefined ? { preview } : {}),
      });
    }
    if (
      projectId !== undefined &&
      projectId !== managedRuntimeProjectId &&
      (hasTranscript || title !== undefined)
    ) {
      const preview = hasTranscript ? previewFromMessages(messages) : undefined;
      await projectStore?.upsertSessionRefFromSnapshot({
        projectId,
        sessionFile: canonicalSessionFile,
        ...(typeof state.sessionId === "string"
          ? { sessionId: state.sessionId }
          : {}),
        ...(typeof state.cwd === "string" ? { cwd: state.cwd } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(hasTranscript
          ? { updatedAtMs: Date.now(), messageCount: messages.length }
          : {}),
        ...(preview !== undefined ? { preview } : {}),
      });
    }
  }

  await reconcileMultitaskRuntime(runtimeId, state.sessionFile);
  return {
    runtimeId,
    backendMode: mode,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    state: { ...state, cwd: state.cwd ?? chatWorkerCwds.get(runtimeId) },
    messages,
  };
}

function titleFromSessionName(state: PiState): string | undefined {
  if (typeof state.sessionName !== "string") {
    return undefined;
  }
  const normalized = state.sessionName.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, 64) : undefined;
}

function titleFromMessages(messages: PiMessage[]): string | undefined {
  const firstUser = messages.find((message) => message.role === "user");
  const content =
    typeof firstUser?.content === "string" ? firstUser.content : undefined;
  if (content === undefined || content.trim().length === 0) {
    return undefined;
  }
  return content.trim().replace(/\s+/g, " ").slice(0, 64);
}

function previewFromMessages(messages: PiMessage[]): string | undefined {
  const lastMessage = [...messages]
    .reverse()
    .find((message) => typeof message.content === "string");
  const content =
    typeof lastMessage?.content === "string" ? lastMessage.content : undefined;
  if (content === undefined || content.trim().length === 0) {
    return undefined;
  }
  return content.trim().replace(/\s+/g, " ").slice(0, 160);
}

async function safeRealpath(filePath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return undefined;
  }
}

async function resolvePromptImageSettings(
  store: SettingsStore,
  runtimeId: string,
): Promise<{ blockImages: boolean; autoResize: boolean }> {
  if (chatRuntimeModes.get(runtimeId) !== "real") {
    // Fake mode has no Pi settings files, but retains Pi's safe defaults.
    return { blockImages: false, autoResize: true };
  }
  const projectId = chatRuntimeProjectIds.get(runtimeId);
  const project =
    projectId === undefined
      ? undefined
      : projectId === managedRuntimeProjectId
        ? await resolveManagedRuntimeProject()
        : await ensureProjectStore().resolveAuthorizedProject(projectId);
  const launch = await resolveRealChatLaunchConfig(store, project);
  return launch.effective.config.imageSettings;
}

async function activeModelForRuntime(
  adapter: SinglePiAdapter,
  runtimeId: string,
): Promise<unknown> {
  const [state, response] = await Promise.all([
    adapter.getState(runtimeId),
    adapter.request(runtimeId, "get_available_models"),
  ]);
  const models =
    response &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    Array.isArray((response as { models?: unknown }).models)
      ? (response as { models: unknown[] }).models
      : [];
  const activeModel = models.find((candidate) =>
    modelMatchesState(candidate, state),
  );
  return activeModel ?? null;
}

function modelMatchesState(model: unknown, state: PiState): boolean {
  if (!model || typeof model !== "object" || Array.isArray(model)) return false;
  const candidate = model as { id?: unknown; provider?: unknown };
  const stateModel =
    typeof state.model === "string"
      ? state.model
      : state.model &&
          typeof state.model === "object" &&
          !Array.isArray(state.model)
        ? (state.model as { id?: unknown }).id
        : undefined;
  const stateProvider =
    typeof state.provider === "string"
      ? state.provider
      : state.model &&
          typeof state.model === "object" &&
          !Array.isArray(state.model)
        ? (state.model as { provider?: unknown }).provider
        : undefined;
  if (typeof candidate.id !== "string" || typeof stateModel !== "string") {
    return false;
  }
  return (
    candidate.id === stateModel ||
    (typeof candidate.provider === "string" &&
      typeof stateProvider === "string" &&
      `${candidate.provider}/${candidate.id}` === stateModel)
  );
}

async function buildPromptInputWithImagePolicy(
  store: SettingsStore,
  adapter: SinglePiAdapter,
  runtimeId: string,
  text: string,
  attachments: NonNullable<
    z.infer<typeof chatPromptRequestSchema>["attachments"]
  >,
  attachmentOwnerId: string | undefined,
): Promise<PromptInput> {
  const imageAttachments = attachments.filter(
    (attachment) => attachment.sendMode === "imageInput",
  );
  if (imageAttachments.length > maxPromptImages) {
    throw new Error(`A prompt may contain at most ${maxPromptImages} images.`);
  }

  const imageSettings =
    imageAttachments.length > 0
      ? await resolvePromptImageSettings(store, runtimeId)
      : undefined;
  if (imageSettings !== undefined) {
    assertImagePromptPermitted(imageSettings, undefined);
    assertImagePromptPermitted(
      imageSettings,
      await activeModelForRuntime(adapter, runtimeId),
    );
  }
  return buildPromptInput(
    text,
    attachments,
    imageSettings?.autoResize ?? false,
    chatWorkerCwds.get(runtimeId),
    runtimeId,
    attachmentOwnerId,
  );
}

async function buildPromptInput(
  text: string,
  attachments: NonNullable<
    z.infer<typeof chatPromptRequestSchema>["attachments"]
  >,
  autoResize: boolean,
  projectRoot: string | undefined,
  sessionId: string,
  ownerId: string | undefined,
): Promise<PromptInput> {
  const imageInputs: NonNullable<PromptInput["images"]> = [];
  const pathReferences: string[] = [];

  for (const attachment of attachments) {
    if (ownerId === undefined) {
      throw new Error(
        "Attachment owner generation is missing; reselect the attachment and retry.",
      );
    }
    const selection = attachmentSelections.getOwned(
      attachment.selectedPathToken,
      ownerId,
      sessionId,
    );
    if (selection === undefined) {
      throw new Error(
        "Attachment is no longer available in this session; reselect it and retry.",
      );
    }

    if (attachment.sendMode === "imageInput") {
      if (selection.kind !== "image") {
        throw new Error("Selected attachment is not an image.");
      }
      const data = selection.imageDataBase64
        ? decodeImageBase64(selection.imageDataBase64)
        : selection.filePath
          ? await readImageAttachment(selection.filePath)
          : undefined;
      if (data === undefined) {
        throw new Error(
          "Image attachment is no longer available; reselect it and retry.",
        );
      }
      // Re-inspect at send time: a local path may have changed since selection,
      // and renderer MIME values are never authoritative.
      imageInputs.push(prepareImageForPrompt(data, autoResize));
    } else {
      if (selection.filePath === undefined) {
        throw new Error(
          "Referenced attachment is no longer available; reselect it and retry.",
        );
      }
      await assertAttachmentReadable(selection.filePath);
      pathReferences.push(
        formatCanonicalFileReference(selection.filePath, projectRoot),
      );
    }
  }

  const referencedPaths = pathReferences
    .map((filePath) => `- ${filePath}`)
    .join("\n");
  const promptText = referencedPaths
    ? `${text}\n\nReferenced file paths:\n${referencedPaths}`
    : text;

  return {
    text: promptText,
    ...(imageInputs.length > 0 ? { images: imageInputs } : {}),
  };
}

async function readImageAttachment(
  filePath: string,
): Promise<Buffer | undefined> {
  await assertAttachmentReadable(filePath);
  const stat = await fs.stat(filePath);
  if (stat.size > maxImportedImageBytes) {
    throw new Error("Image is too large to send; choose an image under 20 MB.");
  }
  return fs.readFile(filePath);
}

function prepareImageForPrompt(
  data: Buffer,
  autoResize: boolean,
): { mimeType: SupportedImageMimeType; dataBase64: string } {
  const inspected = inspectImage(data);
  if (
    !autoResize ||
    (inspected.width <= MAX_IMAGE_DIMENSION &&
      inspected.height <= MAX_IMAGE_DIMENSION)
  ) {
    return {
      mimeType: inspected.mimeType,
      dataBase64: data.toString("base64"),
    };
  }

  // Electron's decoder is used only after our byte/dimension preflight. PNG
  // output is deliberate: it is supported by all image-input providers and
  // avoids preserving an animated GIF's ambiguous frame semantics.
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) {
    throw new Error("Image could not be decoded for resizing.");
  }
  const scale = Math.min(
    MAX_IMAGE_DIMENSION / inspected.width,
    MAX_IMAGE_DIMENSION / inspected.height,
  );
  const resized = image.resize({
    width: Math.max(1, Math.round(inspected.width * scale)),
    height: Math.max(1, Math.round(inspected.height * scale)),
  });
  const output = resized.toPNG();
  inspectImage(output);
  return { mimeType: "image/png", dataBase64: output.toString("base64") };
}

function importImageAttachmentDrafts(
  images: z.infer<typeof attachmentImportImageRequestSchema>["images"],
  ownerId: string,
  sessionId: string,
): AttachmentDraft[] {
  // Check count and the bytes of strings main would retain before decoding any
  // image. A full quota must not be able to trigger another 200 MB decode
  // burst merely to discover that it cannot be kept.
  const selections: AttachmentSelectionEntry[] = images.map((image) => ({
    token: randomUUID(),
    record: {
      ownerId,
      sessionId,
      kind: "image",
      imageDataBase64: image.dataBase64,
    },
  }));
  attachmentSelections.assertCanAddMany(selections);

  const drafts: AttachmentDraft[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]!;
    const selection = selections[index]!;
    // Decode and inspect every image before retaining any base64 string. The
    // store's batch admission is atomic, so a malformed later item cannot
    // leave earlier items from the same renderer request resident in main.
    const data = decodeImageBase64(image.dataBase64);
    const inspected = inspectImage(data);
    selection.record.mimeType = inspected.mimeType;
    selection.record.size = data.length;
    drafts.push({
      id: randomUUID(),
      selectedPathToken: selection.token,
      fileName: image.fileName,
      displayPath: image.fileName,
      mimeType: inspected.mimeType,
      size: data.length,
      kind: "image",
      sendMode: "imageInput",
      outsideProject: false,
      status: "ready",
      previewDataUrl: `data:${inspected.mimeType};base64,${image.dataBase64}`,
    });
  }

  attachmentSelections.addMany(selections);
  return drafts;
}

async function inspectImageFile(
  filePath: string,
): Promise<ReturnType<typeof inspectImage> | undefined> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const header = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return inspectImage(header.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function assertAttachmentReadable(filePath: string): Promise<void> {
  const status = await getFileStatus(filePath);
  if (status !== "ready") {
    throw new Error(`Attachment is ${status}: ${filePath}`);
  }
}

interface PreparedAttachmentDraft {
  draft: AttachmentDraft;
  selection?: AttachmentSelectionEntry;
}

/**
 * Stage every file before adding any authority record, so a quota failure in a
 * multi-select cannot leave unreachable tokens from earlier files behind.
 */
async function buildAttachmentDrafts(
  filePaths: readonly string[],
  projectRoot: string | undefined,
  ownerId: string,
  sessionId: string,
): Promise<AttachmentDraft[]> {
  const prepared = await Promise.all(
    filePaths.map((filePath) =>
      prepareAttachmentDraft(filePath, projectRoot, ownerId, sessionId),
    ),
  );
  attachmentSelections.addMany(
    prepared.flatMap((item) => (item.selection ? [item.selection] : [])),
  );
  return prepared.map((item) => item.draft);
}

async function prepareAttachmentDraft(
  filePath: string,
  projectRoot: string | undefined,
  ownerId: string,
  sessionId: string,
): Promise<PreparedAttachmentDraft> {
  const canonicalPath = await safeRealpath(filePath);
  const status = canonicalPath ? await getFileStatus(canonicalPath) : "missing";
  const extension = path.extname(filePath).toLowerCase();
  // A filename is only a hint. Read a bounded header so a renamed image is
  // accepted and a disguised image is never sent under its claimed MIME type.
  const sniffedImage =
    canonicalPath && status === "ready"
      ? await inspectImageFile(canonicalPath)
      : undefined;
  const kind: AttachmentDraft["kind"] = sniffedImage
    ? "image"
    : isLikelyTextPath(extension)
      ? "textFile"
      : "binaryFile";
  const outsideProject = Boolean(
    projectRoot && canonicalPath && !isPathInside(canonicalPath, projectRoot),
  );
  const stat = canonicalPath ? await statIfReadable(canonicalPath) : undefined;
  const warning = attachmentWarning({ outsideProject, kind, stat });

  const selectedPathToken = randomUUID();
  return {
    draft: {
      id: randomUUID(),
      selectedPathToken,
      fileName: path.basename(filePath),
      displayPath: filePath,
      ...(sniffedImage ? { mimeType: sniffedImage.mimeType } : {}),
      ...(stat ? { size: stat.size } : {}),
      kind,
      sendMode: kind === "image" ? "imageInput" : "pathReference",
      outsideProject,
      status,
      ...(warning ? { warning } : {}),
    },
    ...(canonicalPath && status === "ready"
      ? {
          selection: {
            token: selectedPathToken,
            record: {
              ownerId,
              sessionId,
              filePath: canonicalPath,
              kind,
              ...(sniffedImage ? { mimeType: sniffedImage.mimeType } : {}),
            },
          },
        }
      : {}),
  };
}

function attachmentWarning(options: {
  outsideProject: boolean;
  kind: AttachmentDraft["kind"];
  stat?: { size: number } | undefined;
}): string | undefined {
  if (
    options.kind === "image" &&
    options.stat !== undefined &&
    options.stat.size > maxImportedImageBytes
  ) {
    return "Image is over 20 MB and will be blocked before send.";
  }
  if (
    options.kind !== "image" &&
    options.stat?.size !== undefined &&
    options.stat.size > maxReferencedFileWarningBytes
  ) {
    return "Large files are referenced by path only; Pi may choose not to inspect them.";
  }
  if (options.outsideProject) {
    return "Outside selected project; the model may see an absolute local path.";
  }
  if (options.kind === "binaryFile") {
    return "Binary/unknown files are referenced by path only.";
  }
  return undefined;
}

async function getFileStatus(
  filePath: string,
): Promise<"ready" | "missing" | "unreadable"> {
  try {
    await fs.access(filePath, fsConstants.R_OK);
    return "ready";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : "unreadable";
  }
}

async function statIfReadable(
  filePath: string,
): Promise<{ size: number } | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

function isImagePath(extension: string): boolean {
  return (
    getImageMimeType(extension) !== undefined ||
    new Set([".avif", ".bmp", ".heic", ".tif", ".tiff"]).has(extension)
  );
}

function getImageMimeType(extension: string): string | undefined {
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return undefined;
  }
}

function isLikelyTextPath(extension: string): boolean {
  return new Set([
    ".c",
    ".cpp",
    ".css",
    ".go",
    ".h",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".py",
    ".rs",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
  ]).has(extension);
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

app.on("before-quit", (event) => {
  if (
    isQuittingAfterChatWorkerCleanup ||
    chatAdapter === undefined ||
    chatRuntimeIds.size === 0
  ) {
    return;
  }

  event.preventDefault();
  isQuittingAfterChatWorkerCleanup = true;
  void closeChatWorker().finally(() => {
    app.quit();
  });
});

app.on("window-all-closed", () => {
  // Pi Deck owns local agent subprocesses. Closing the last window should end
  // the app and trigger before-quit cleanup on macOS too, rather than leaving
  // real/fake Pi workers running in the background.
  app.quit();
});

bootstrap().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  diagnostics?.recordError(`Fatal startup error: ${message}`);
  console.error(message);
  app.quit();
});

// Subscriptions belong to a specific renderer webContents and retain the
// workspace authorized at registration. They are never a global run-ID list.
const graphRunSubscriptions = new WorkflowGraphSubscriptions();
function emitCanonicalWorkflowRunEvent(run: WorkflowRunEnvelope): void {
  mainWindow?.webContents.send(ipcChannels.canonicalWorkflowEvent, {
    type: "workflow_occurrence_run_updated",
    run,
  });
  // Full run envelopes remain a compatibility event; graph events are sent to
  // every authorized subscriber, including auxiliary windows.
  graphRunSubscriptions.publish(
    run,
    deriveWorkflowGraphSnapshot(run.definition, run),
    (senderId) => webContents.fromId(senderId),
  );
}

async function getMultitaskSupervisor(
  runtimeId: string,
): Promise<NonNullable<typeof multitaskSupervisor>> {
  const adapter = chatAdapter;
  const supervisor = multitaskSupervisor;
  if (
    adapter === undefined ||
    supervisor === undefined ||
    !chatRuntimeIds.has(runtimeId) ||
    !adapter.hasRuntime(runtimeId)
  ) {
    throw new Error(`Chat runtime is no longer attached: ${runtimeId}`);
  }
  // state() also verifies that this is an attached parent, rather than a child.
  supervisor.state(runtimeId);
  return supervisor;
}

function isMultitaskMode(
  runtimeId: string,
  mode: "parallel" | "sequential",
): boolean {
  try {
    return multitaskSupervisor?.mode(runtimeId) === mode;
  } catch {
    return false;
  }
}

async function reconcileMultitaskRuntime(
  runtimeId: string,
  sessionFile: unknown,
): Promise<void> {
  if (typeof sessionFile !== "string") return;
  const canonical =
    (await safeRealpath(sessionFile)) ?? path.resolve(sessionFile);
  chatRuntimeSessionFiles.set(runtimeId, canonical);
  const saved = taskSessionStateStore?.get(canonical);
  const savedSettings = taskSessionStateStore?.getSettings(canonical);
  if (savedSettings) taskSessionSettings.set(runtimeId, savedSettings);
  const orchestrator = taskSessionOrchestrator;
  if (orchestrator) {
    try {
      orchestrator.addParent(runtimeId, {
        mode: saved?.mode ?? "sequential",
        ...(taskSessionSettings.has(runtimeId)
          ? { workerSettings: taskSessionSettings.get(runtimeId)! }
          : {}),
      });
    } catch {
      /* registered at worker creation */
    }
    // Recovery only marks retained private work interrupted; it never starts it.
    if (
      multitaskRuntimeResumeGuard.claim(runtimeId, saved !== undefined) &&
      saved
    ) {
      orchestrator.restore(runtimeId, saved);
    }
  }
  // The authenticated bridge remains independent transport coverage.
  const legacySaved = multitaskStateStore?.get(canonical);
  const supervisor = multitaskSupervisor;
  if (supervisor) {
    try {
      supervisor.addParent(runtimeId, {
        mode: legacySaved?.mode ?? "sequential",
        maxQueuedTasks: 100,
      });
    } catch {
      /* registered */
    }
    if (
      legacySaved &&
      multitaskRuntimeResumeGuard.claim(`${runtimeId}:legacy`, true)
    ) {
      await supervisor.resume(runtimeId, legacySaved);
    }
  }
}

function taskSessionState(
  runtimeId: string,
): z.infer<typeof multitaskStateEventSchema> {
  const state = getTaskSessionOrchestrator(runtimeId).state(runtimeId);
  const usedTaskNumbers = new Set(state.tasks.map((task) => task.taskNumber));
  let legacyTasks: Array<
    z.infer<typeof multitaskStateEventSchema>["tasks"][number]
  > = [];
  try {
    legacyTasks = (multitaskSupervisor?.state(runtimeId).tasks ?? []).map(
      (task) => {
        let taskNumber = task.number;
        while (usedTaskNumbers.has(taskNumber)) taskNumber += 1_000_000;
        usedTaskNumbers.add(taskNumber);
        const lifecycle =
          task.status === "waiting-input"
            ? "waiting-parent"
            : task.status === "cancelled"
              ? "interrupted"
              : task.status;
        return {
          taskNumber,
          generatedName: task.name,
          brief: task.name,
          lifecycle,
          attempt: 1,
          elapsedMs: 0,
        };
      },
    );
  } catch {
    // The compatibility bridge may already be detached from this parent.
  }
  const legacyActiveCount = legacyTasks.filter((task) =>
    ["starting", "running", "retrying", "waiting-parent"].includes(
      task.lifecycle,
    ),
  ).length;
  return multitaskStateEventSchema.parse({
    runtimeId,
    mode: state.mode,
    settings: fromTaskSessionSettings(taskSessionSettings.get(runtimeId)),
    activeCount: state.activeCount + legacyActiveCount,
    activeLimit: state.activeLimit,
    tasks: [...state.tasks, ...legacyTasks],
  });
}

function fromTaskSessionSettings(
  settings: TaskSessionWorkerSettings | undefined,
): { model?: { provider: string; modelId: string }; thinkingLevel?: string } {
  const [provider, modelId] = settings?.model?.split(":", 2) ?? [];
  return {
    ...(provider && modelId ? { model: { provider, modelId } } : {}),
    ...(settings?.thinkingLevel
      ? { thinkingLevel: settings.thinkingLevel }
      : {}),
  };
}

function emitTaskSessionState(runtimeId: string): void {
  let state: z.infer<typeof multitaskStateEventSchema>;
  try {
    state = taskSessionState(runtimeId);
  } catch {
    return;
  }
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  )
    mainWindow.webContents.send(ipcChannels.multitaskState, state);
}

async function persistTaskSession(runtimeId: string): Promise<void> {
  const sessionFile = chatRuntimeSessionFiles.get(runtimeId);
  const orchestrator = taskSessionOrchestrator;
  if (sessionFile && orchestrator)
    await taskSessionStateStore?.set(
      sessionFile,
      orchestrator.exportState(runtimeId),
    );
}

async function persistMultitaskSupervisor(runtimeId: string): Promise<void> {
  const sessionFile = chatRuntimeSessionFiles.get(runtimeId);
  if (sessionFile && multitaskSupervisor)
    await multitaskStateStore?.set(
      sessionFile,
      multitaskSupervisor.exportState(runtimeId),
    );
}
