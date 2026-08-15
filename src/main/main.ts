import {
  app,
  BrowserWindow,
  dialog,
  shell,
  session,
  nativeImage,
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
  multitaskModeRequestSchema,
  multitaskModeStateSchema,
  multitaskModeUpdateRequestSchema,
  multitaskStateEventSchema,
} from "../shared/ipcSchemas.js";
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
  ChatSnapshot,
  PickAttachmentsResult,
  ProjectRef,
  PickProjectResult,
} from "../shared/types.js";
import { DiagnosticsService } from "./diagnostics/diagnostics.js";
import { registerValidatedIpc } from "./ipc/registerIpc.js";
import {
  discoverPiModels,
  discoverPiRuntimeModels,
  parsePiRuntimeModelDiscovery,
} from "./pi/modelDiscovery.js";
import { SinglePiAdapter } from "./pi/piAdapter.js";
import { WorkerCapacity } from "./pi/workerCapacity.js";
import { selectAvailableRuntime } from "./runtimeSelection.js";
import {
  scanSessionRepository,
  validatePiSession,
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
import { SettingsStore } from "./settings/settingsStore.js";
import { formatCanonicalFileReference } from "./attachments.js";
import { MultitaskManager } from "./multitask/multitaskManager.js";
import { MultitaskStateStore } from "./multitask/multitaskStateStore.js";
import { DelegationBridgeServer, type DelegateRequest } from "./multitask/delegationBridgeServer.js";
import { writeDeckDelegateAcceptanceHarness, writeDeckDelegateExtension, DECK_DELEGATE_CAPABILITY_ENV, DECK_DELEGATE_ENDPOINT_ENV, DECK_DELEGATE_PARENT_RUNTIME_ENV } from "./multitask/deckDelegateExtensionGenerator.js";
import { MultitaskSupervisor, type ChildWorkerCallbacks, type ParentTaskNotification } from "./multitask/multitaskSupervisor.js";
import { PersistedRuntimeResumeGuard } from "./multitask/persistedRuntimeResumeGuard.js";
import { deliverWithAttachmentConsumption } from "./attachmentDelivery.js";
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

let mainWindow: BrowserWindow | undefined;
let settingsStore: SettingsStore | undefined;
let projectStore: ProjectStore | undefined;
const realChatLaunchConfigCache = new RealChatLaunchConfigCache();
let diagnostics: DiagnosticsService | undefined;
let multitaskStateStore: MultitaskStateStore | undefined;
const multitaskManagers = new Map<string, MultitaskManager>();
// Snapshot reads happen often. A persisted session is rehydrated exactly once
// when attached; later reads must not close live private children.
const multitaskRuntimeResumeGuard = new PersistedRuntimeResumeGuard();
let delegationBridge: DelegationBridgeServer | undefined;
let delegationCredentials: { socketPath: string } | undefined;
let multitaskSupervisor: MultitaskSupervisor<string, string, { close(): Promise<void>; provideInput(input: string): Promise<void> }> | undefined;
const delegateCalls = new Map<string, { connectionId: string; toolCallId: string }>();
let nextDelegatedTaskNumber = 1;
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
  projectStore = new ProjectStore(resolvePiDeckHome(process.env), diagnostics);
  multitaskStateStore = new MultitaskStateStore(app.getPath("userData"));
  await multitaskStateStore.loadIfNeeded();
  await projectStore.loadIfNeeded();
  await startDelegationBridge();

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
      listChatSessions(
        store,
        await authorizeRendererChatProject(request?.projectId),
      ),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatResumeSession,
    requestSchema: chatResumeSessionRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async ({ projectId, sessionFile }) =>
      resumeChatSession(
        store,
        diagnosticsService,
        sessionFile,
        await authorizeRendererChatProject(projectId),
      ),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatDeleteSession,
    requestSchema: chatDeleteSessionRequestSchema,
    responseSchema: chatDeleteSessionResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ projectId, sessionFile }) =>
      deleteChatSession(
        store,
        diagnosticsService,
        sessionFile,
        await authorizeRendererChatProject(projectId),
      ),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatDeleteAllSessions,
    requestSchema: chatDeleteAllSessionsRequestSchema,
    responseSchema: chatDeleteAllSessionsResultSchema,
    diagnostics: diagnosticsService,
    handler: async (request) =>
      deleteAllChatSessions(
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
    handler: async ({ runtimeId, projectId }) =>
      listChatModels(
        store,
        diagnosticsService,
        runtimeId,
        await authorizeRendererChatProject(projectId),
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
      await closeAttachedChatRuntime(adapter, activeRuntimeId);
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatCreateSession,
    requestSchema: chatCreateSessionRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async (request) =>
      createChatSessionSnapshot(
        store,
        diagnosticsService,
        await authorizeRendererChatProject(request?.projectId),
      ),
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
    responseSchema: multitaskModeStateSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId }) => multitaskModeState(runtimeId),
  });

  registerValidatedIpc({
    channel: ipcChannels.multitaskUpdateMode,
    requestSchema: multitaskModeUpdateRequestSchema,
    responseSchema: multitaskModeStateSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, mode }) => {
      const manager = await getMultitaskManager(runtimeId);
      manager.setMode(mode);
      multitaskSupervisor?.setMode(runtimeId, mode);
      await persistMultitaskSupervisor(runtimeId);
      emitMultitaskState(runtimeId, manager);
      return multitaskModeStateFromManager(runtimeId, manager);
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

      const projectRoot = request.projectPath
        ? await safeRealpath(request.projectPath)
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
      const projectRoot = request.projectPath
        ? await safeRealpath(request.projectPath)
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
  const cachedSessions =
    mode === "real" ? await projects.getCachedSessionSummaries(project.id) : [];

  return {
    backendMode: mode,
    version: app.getVersion(),
    settings,
    diagnostics: diagnosticsService.getSummary(settings),
    project,
    projects: projectList.projects,
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
    getParentMode: (parentRuntimeId) =>
      multitaskManagers.get(parentRuntimeId)?.mode ?? "sequential",
  });
  const credentials = await bridge.start();
  delegationBridge = bridge;
  delegationCredentials = { socketPath: credentials.socketPath };
  bridge.onDelegate((request) => void handleDelegateRequest(request));
  bridge.onInputResponse((response) => void handleDelegateInput(response));
}

async function deckDelegateExtensionPath(): Promise<string> {
  const output = path.join(app.getPath("userData"), "extensions", "deck-delegate.ts");
  await writeDeckDelegateExtension(output);
  return output;
}

async function deckDelegateHarnessPath(delegateExtensionPath: string): Promise<string | undefined> {
  if (process.env.PI_DECK_E2E_DELEGATE_HARNESS !== "1") return undefined;
  const output = path.join(app.getPath("userData"), "extensions", "deck-delegate-acceptance-harness.ts");
  await writeDeckDelegateAcceptanceHarness(output, delegateExtensionPath);
  return output;
}

function delegateEnvironment(base: NodeJS.ProcessEnv, parentRuntimeId: string): NodeJS.ProcessEnv {
  const credentials = delegationCredentials;
  const capability = delegationBridge?.registerParent(parentRuntimeId);
  if (!credentials || !capability) throw new Error("Delegation bridge is not available.");
  return { ...base, [DECK_DELEGATE_ENDPOINT_ENV]: `unix:${credentials.socketPath}`, [DECK_DELEGATE_CAPABILITY_ENV]: capability, [DECK_DELEGATE_PARENT_RUNTIME_ENV]: parentRuntimeId };
}

async function handleDelegateRequest(request: DelegateRequest): Promise<void> {
  // Authentication capability, not untrusted payload, binds this connection.
  const payload = request.payload;
  const parentId = request.parentId;
  const supervisor = multitaskSupervisor;
  if (!parentId || !supervisor || !delegationBridge) {
    delegationBridge?.sendChildResult({ connectionId: request.connectionId, toolCallId: request.toolCallId, outcome: "failed", handoff: { summary: "Parallel multitasking is not enabled for this parent." } });
    return;
  }
  if (multitaskManagers.get(parentId)?.mode !== "parallel" || !chatRuntimeIds.has(parentId)) {
    delegationBridge?.sendChildResult({ connectionId: request.connectionId, toolCallId: request.toolCallId, outcome: "failed", handoff: { summary: "Parallel multitasking is not enabled for this parent." } });
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    delegationBridge.sendChildResult({ connectionId: request.connectionId, toolCallId: request.toolCallId, outcome: "failed", handoff: { summary: "Invalid delegate action." } });
    return;
  }
  const inputAction = payload as { action?: unknown; taskNumber?: unknown; input?: unknown };
  if (inputAction.action === "provide_input") {
    if (!Number.isSafeInteger(inputAction.taskNumber) || (inputAction.taskNumber as number) < 1 || typeof inputAction.input !== "string" || !inputAction.input.trim()) {
      delegationBridge.sendChildResult({ connectionId: request.connectionId, toolCallId: request.toolCallId, outcome: "failed", handoff: { summary: "A task number and input are required." } });
      return;
    }
    try {
      await supervisor.provideInput(parentId, inputAction.taskNumber as number, inputAction.input);
      delegationBridge.sendChildResult({ connectionId: request.connectionId, toolCallId: request.toolCallId, outcome: "completed", handoff: { summary: `Input delivered to task #${inputAction.taskNumber}.` } });
    } catch (error) {
      delegationBridge.sendChildResult({ connectionId: request.connectionId, toolCallId: request.toolCallId, outcome: "failed", handoff: { summary: error instanceof Error ? error.message : "Unable to deliver input." } });
    }
    return;
  }
  if (typeof (payload as { task?: unknown }).task !== "string") {
    delegationBridge.sendChildResult({ connectionId: request.connectionId, toolCallId: request.toolCallId, outcome: "failed", handoff: { summary: "Invalid delegate task." } });
    return;
  }
  const task = (payload as { task: string; name?: unknown }).task.trim();
  const name = typeof (payload as { name?: unknown }).name === "string" ? (payload as { name: string }).name.trim() : "Delegated task";
  if (!task || task.length > 16_000 || name.length > 256) {
    delegationBridge.sendChildResult({ connectionId: request.connectionId, toolCallId: request.toolCallId, outcome: "failed", handoff: { summary: "Delegate task exceeds Deck limits." } });
    return;
  }
  const number = nextDelegatedTaskNumber++;
  try {
    delegateCalls.set(`${parentId}:${number}`, { connectionId: request.connectionId, toolCallId: request.toolCallId });
    supervisor.enqueue(parentId, { number, name: name || "Delegated task", brief: { text: task } });
  } catch (error) {
    delegateCalls.delete(`${parentId}:${number}`);
    delegationBridge.sendChildResult({ connectionId: request.connectionId, toolCallId: request.toolCallId, outcome: "failed", handoff: { summary: error instanceof Error ? error.message : "Unable to queue child." } });
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
    if (parsed.data.type === "worker_exit") {
      // A child exit does not go through closeSession(), so remove it from the
      // adapter as well as the UI/runtime maps or it would consume capacity.
      adapter.forgetExitedWorker(parsed.data.runtimeId);
      const preserveAttachments = attachmentPreservingRuntimeClosures.has(
        parsed.data.runtimeId,
      );
      forgetChatRuntime(parsed.data.runtimeId, { preserveAttachments });
    }
  });

  // Creating an adapter only installs routing and capacity bookkeeping. A
  // worker is created by an explicit create/resume/send path, never merely by
  // making the app interactive.
  chatBackendMode = mode;
  chatEventUnsubscribe = unsubscribe;
  chatWorkerCapacity = capacity;
  chatAdapter = adapter;
  multitaskSupervisor = new MultitaskSupervisor({
    hasCapacity: () => capacityAvailable(),
    createWorker: (launch) => createDelegatedChild(adapter, store, launch.parentId, launch.task, launch.callbacks),
    onParentNotification: (notification) => handleMultitaskNotification(notification),
  });
  return adapter;
}

async function createChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  mode: ChatBackendMode,
  capacity: WorkerCapacity,
  project?: ProjectRef,
): Promise<ChatWorkerSpec> {
  return serializeChatWorkerCreation(async () => {
    const workerSpec =
      mode === "real"
        ? await createRealChatWorker(adapter, store, capacity, project)
        : await createFakeChatWorker(adapter, store, capacity);
    registerChatWorker(workerSpec, mode);
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
  return capacity !== undefined && adapter !== undefined && adapter.workerCount() < maxRunningWorkers;
}

function registerChatWorker(
  workerSpec: ChatWorkerSpec,
  mode: ChatBackendMode,
): void {
  const runtimeId = workerSpec.worker.runtimeId;
  chatRuntimeId = runtimeId;
  chatRuntimeIds.add(runtimeId);
  chatRuntimeModes.set(runtimeId, mode);
  chatWorkerCwds.set(runtimeId, workerSpec.cwd);
  if (workerSpec.projectId !== undefined) {
    chatRuntimeProjectIds.set(runtimeId, workerSpec.projectId);
  }
  const manager = new MultitaskManager({ mode: "sequential", maxQueuedTasks: 100 });
  multitaskManagers.set(runtimeId, manager);
  multitaskSupervisor?.addParent(runtimeId, { mode: manager.mode, maxQueuedTasks: 100 });
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
  if (!chatRuntimeIds.has(request.runtimeId) || !adapter.hasRuntime(request.runtimeId)) {
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

function resolveChatBackendMode(): ChatBackendMode {
  return process.env.PI_DECK_BACKEND === "real" ? "real" : "fake";
}

function resolveActiveChatRuntimeId(
  adapter: SinglePiAdapter,
  requestedRuntimeId: string,
): string {
  const selection = selectAvailableRuntime({
    requestedRuntimeId,
    hasRuntime: (runtimeId) => chatRuntimeIds.has(runtimeId) && adapter.hasRuntime(runtimeId),
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
  multitaskManagers.delete(runtimeId);
  multitaskRuntimeResumeGuard.forget(runtimeId);
  delegationBridge?.removeParent(runtimeId);
  for (const [key, call] of delegateCalls) {
    if (key.startsWith(`${runtimeId}:`)) {
      delegationBridge?.sendChildResult({ ...call, outcome: "cancelled", handoff: { summary: "Parent session closed." } });
      delegateCalls.delete(key);
    }
  }
  void multitaskSupervisor?.removeParent(runtimeId);
  if (chatRuntimeId === runtimeId) {
    chatRuntimeId = undefined;
  }
}

interface ChatWorkerSpec {
  worker: ReturnType<SinglePiAdapter["createWorker"]>;
  cwd: string;
  projectId?: string;
}

async function createDelegatedChild(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  parentId: string,
  task: { brief: { text: string } },
  callbacks: ChildWorkerCallbacks,
): Promise<{ close(): Promise<void>; provideInput(input: string): Promise<void> }> {
  const capacity = getChatWorkerCapacity();
  const parentMode = chatRuntimeModes.get(parentId);
  const cwd = chatWorkerCwds.get(parentId);
  const projectId = chatRuntimeProjectIds.get(parentId);
  if (!parentMode || !cwd) throw new Error("Delegating parent is no longer attached.");
  const worker = await capacity.allocate(async () => (await store.get()).maxRunningSessions, () => {
    if (parentMode === "fake") {
      return adapter.createWorker({ command: process.execPath, args: [path.join(__dirname, "pi/fakeRpc/fakeRpcServer.js"), "--stream-delay-ms", "10"], cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    }
    return createRealDelegatedWorker(adapter, store, cwd, projectId);
  });
  let ended = false;
  worker.onEvent((event) => {
    if (ended) return;
    if (event.type === "extension_ui_request") callbacks.inputNeeded();
    if (event.type === "agent_end" || event.type === "worker_exit") {
      ended = true;
      void worker.getMessages().then((messages) => {
        const last = messages.at(-1);
        callbacks.completed({ summary: typeof last?.content === "string" ? last.content.slice(0, 32_768) : "Child completed." });
      }).catch(() => callbacks.failed({ summary: "Child exited without a result." }));
    }
  });
  try {
    await worker.prompt({ text: task.brief.text });
  } catch (error) {
    await adapter.closeSession(worker.runtimeId).catch(() => undefined);
    throw error;
  }
  return { close: () => adapter.closeSession(worker.runtimeId), provideInput: (input) => worker.steer({ text: input }) };
}

async function createRealDelegatedWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  cwd: string,
  projectId: string | undefined,
): Promise<ReturnType<SinglePiAdapter["createWorker"]>> {
  const project = projectId ? await ensureProjectStore().resolveAuthorizedProject(projectId) : undefined;
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

function handleDelegateInput(response: { parentId: string; connectionId: string; toolCallId: string; input: string }): void {
  const entry = [...delegateCalls.entries()].find(([, call]) =>
    call.connectionId === response.connectionId && call.toolCallId === response.toolCallId,
  );
  if (!entry || !entry[0].startsWith(`${response.parentId}:`)) return;
  const number = Number(entry[0].slice(response.parentId.length + 1));
  void multitaskSupervisor?.provideInput(response.parentId, number, response.input).catch(() => undefined);
}

function handleMultitaskNotification(notification: ParentTaskNotification<string>): void {
  const key = `${notification.parentId}:${notification.task.number}`;
  const call = delegateCalls.get(key);
  const bridge = delegationBridge;
  if (notification.type === "task-status") {
    bridge?.sendChildLifecycle({ connectionId: call?.connectionId ?? "", toolCallId: call?.toolCallId ?? "", taskNumber: notification.task.number, status: notification.task.status });
  } else {
    const outcome = notification.task.status === "completed" ? "completed" : notification.task.status === "cancelled" ? "cancelled" : "failed";
    bridge?.sendChildResult({ connectionId: call?.connectionId ?? "", toolCallId: call?.toolCallId ?? "", outcome, handoff: notification.handoff });
    delegateCalls.delete(key);
  }
  const supervisor = multitaskSupervisor;
  if (supervisor) {
    const manager = multitaskManagers.get(notification.parentId);
    if (manager) emitMultitaskStateFromSnapshots(notification.parentId, manager.mode, supervisor.snapshots(notification.parentId));
    void persistMultitaskSupervisor(notification.parentId);
  }
}

async function createFakeChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
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
        args: [fakeRpcPath, "--stream-delay-ms", "120", ...(process.env.PI_DECK_FAKE_DELEGATE_SCENARIO === "1" ? ["--prompt-scenario", "delegate"] : [])],
        cwd,
        env: { ...delegateEnvironment(process.env, runtimeId), ELECTRON_RUN_AS_NODE: "1" },
      });
      return { worker, cwd };
    },
  );
}

async function createRealChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
  project?: ProjectRef,
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
      return { worker, cwd: launch.projectCwd, projectId: launch.projectId };
    },
  );
}

async function realParentWorkerArgs(workerArgs: readonly string[]): Promise<string[]> {
  const delegateExtension = await deckDelegateExtensionPath();
  const harnessExtension = await deckDelegateHarnessPath(delegateExtension);
  return ["--mode", "rpc", ...workerArgs, "--extension", delegateExtension, ...(harnessExtension ? ["--extension", harnessExtension] : [])];
}

async function createRealResumeWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
  sessionFile: string,
  project?: ProjectRef,
): Promise<ChatWorkerSpec> {
  const launch = await resolveRealChatLaunchConfig(store, project);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    throw new Error("No Pi session directory is configured.");
  }
  const validation = await validatePiSession({
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
  await Promise.all(runtimeIds.map(async (runtimeId) => {
    delegationBridge?.removeParent(runtimeId);
    await multitaskSupervisor?.removeParent(runtimeId);
  }));
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
  chatSessionFileLocks.clear();
  chatSessionResumePromises.clear();
  multitaskManagers.clear();
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
  const validation = await validatePiSession({
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

async function removePersistedPiSessionFile(
  projectId: string,
  sessionFile: string,
  diagnosticsService: DiagnosticsService,
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
    await multitaskStateStore?.delete(sessionFile);
  } catch (error) {
    diagnosticsService.recordError(
      `Failed to remove multitask state for deleted Pi session ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A detached saved-row composer uses the canonical session file as its
  // owner. Revoke it only after removal is confirmed; failed validation and
  // per-file bulk failures leave that owner intact for retry.
  attachmentSelections.releaseSession(sessionFile);
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
): Promise<ChatSnapshot> {
  if (resolveChatBackendMode() !== "real") {
    throw new Error("Session resume is only available in real Pi mode.");
  }

  const launch = await resolveRealChatLaunchConfig(store, project);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    throw new Error("No Pi session directory is configured.");
  }
  const validation = await validatePiSession({
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
): Promise<ChatSnapshot> {
  const workerSpec = await serializeChatWorkerCreation(() =>
    createRealResumeWorker(
      adapter,
      store,
      capacity,
      canonicalSessionFile,
      project,
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
): Promise<ChatSnapshot> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const mode = chatBackendMode ?? resolveChatBackendMode();
  const workerSpec = await createChatWorker(
    adapter,
    store,
    mode,
    getChatWorkerCapacity(),
    project,
  );
  const runtimeId = workerSpec.worker.runtimeId;
  try {
    return await getChatSnapshotForRuntime(adapter, runtimeId, mode, {
      skipMessages: true,
    });
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
    if (projectId !== undefined && (hasTranscript || title !== undefined)) {
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

async function getMultitaskManager(
  runtimeId: string,
): Promise<MultitaskManager> {
  const adapter = chatAdapter;
  if (adapter === undefined || !chatRuntimeIds.has(runtimeId) || !adapter.hasRuntime(runtimeId)) {
    throw new Error(`Chat runtime is no longer attached: ${runtimeId}`);
  }
  const existing = multitaskManagers.get(runtimeId);
  if (existing !== undefined) return existing;
  const sessionFile = chatRuntimeSessionFiles.get(runtimeId);
  const saved = sessionFile ? multitaskStateStore?.get(sessionFile) : undefined;
  const manager = saved
    ? MultitaskManager.rehydrate(saved, { maxQueuedTasks: 100 })
    : new MultitaskManager({ mode: "sequential", maxQueuedTasks: 100 });
  multitaskManagers.set(runtimeId, manager);
  return manager;
}

async function reconcileMultitaskRuntime(
  runtimeId: string,
  sessionFile: unknown,
): Promise<void> {
  if (typeof sessionFile !== "string") return;
  const canonical =
    (await safeRealpath(sessionFile)) ?? path.resolve(sessionFile);
  chatRuntimeSessionFiles.set(runtimeId, canonical);
  const saved = multitaskStateStore?.get(canonical);
  if (!multitaskManagers.has(runtimeId)) {
    multitaskManagers.set(runtimeId, saved
      ? MultitaskManager.rehydrate(saved, { maxQueuedTasks: 100 })
      : new MultitaskManager({ mode: "sequential", maxQueuedTasks: 100 }));
  }
  if (multitaskSupervisor) {
    try { multitaskSupervisor.addParent(runtimeId, { mode: multitaskManagers.get(runtimeId)!.mode, maxQueuedTasks: 100 }); } catch { /* already registered */ }
  }
  if (saved) {
    multitaskManagers.get(runtimeId)?.setMode(saved.mode);
  }
  // Resume is destructive to retained private children. It is valid only for
  // the first attachment of persisted state, never for ordinary snapshots.
  if (multitaskSupervisor && multitaskRuntimeResumeGuard.claim(runtimeId, saved !== undefined)) {
    await multitaskSupervisor.resume(runtimeId, saved);
  }
}

async function persistMultitaskManager(
  runtimeId: string,
  manager: MultitaskManager,
): Promise<void> {
  const sessionFile = chatRuntimeSessionFiles.get(runtimeId);
  if (sessionFile !== undefined)
    await multitaskStateStore?.set(sessionFile, manager.exportState());
}

function multitaskModeState(
  runtimeId: string,
): Promise<{ runtimeId: string; mode: "parallel" | "sequential" }> {
  return getMultitaskManager(runtimeId).then((manager) =>
    multitaskModeStateFromManager(runtimeId, manager),
  );
}

function multitaskModeStateFromManager(
  runtimeId: string,
  manager: MultitaskManager,
): { runtimeId: string; mode: "parallel" | "sequential" } {
  return { runtimeId, mode: manager.mode };
}

function emitMultitaskState(
  runtimeId: string,
  manager: MultitaskManager,
): void {
  const tasks = manager.snapshots().map((task) => ({
    taskNumber: task.number,
    generatedName: task.name,
    status: task.status === "cancelled" ? "failed" : task.status,
  }));
  const payload = {
    ...multitaskModeStateFromManager(runtimeId, manager),
    tasks,
  };
  const parsed = multitaskStateEventSchema.parse(payload);
  const window = mainWindow;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send(ipcChannels.multitaskState, parsed);
}

function emitMultitaskStateFromSnapshots(
  runtimeId: string,
  mode: "parallel" | "sequential",
  snapshots: Array<{ number: number; name: string; status: string }>,
): void {
  const parsed = multitaskStateEventSchema.parse({
    runtimeId,
    mode,
    tasks: snapshots.map((task) => ({ taskNumber: task.number, generatedName: task.name, status: task.status === "cancelled" ? "failed" : task.status })),
  });
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(ipcChannels.multitaskState, parsed);
}

async function persistMultitaskSupervisor(runtimeId: string): Promise<void> {
  const sessionFile = chatRuntimeSessionFiles.get(runtimeId);
  if (sessionFile && multitaskSupervisor) await multitaskStateStore?.set(sessionFile, multitaskSupervisor.exportState(runtimeId));
}
