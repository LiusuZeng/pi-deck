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
  attachmentImportDroppedFilesRequestSchema,
  attachmentImportImageRequestSchema,
  attachmentPickerRequestSchema,
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
type ChatBackendMode = "fake" | "real";

let chatAdapter: SinglePiAdapter | undefined;
let chatAdapterPromise: Promise<SinglePiAdapter> | undefined;
let chatWorkerCapacity: WorkerCapacity | undefined;
let chatRuntimeId: string | undefined;
let chatBackendMode: ChatBackendMode | undefined;
const chatRuntimeIds = new Set<string>();
const chatRuntimeModes = new Map<string, ChatBackendMode>();
const chatWorkerCwds = new Map<string, string>();
const chatRuntimeSessionFiles = new Map<string, string>();
const chatRuntimeProjectIds = new Map<string, string>();
const chatSessionFileLocks = new Map<string, string>();
const chatSessionResumePromises = new Map<string, Promise<ChatSnapshot>>();
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

interface AttachmentSelectionRecord {
  filePath?: string;
  kind: AttachmentDraft["kind"];
  mimeType?: string;
  imageDataBase64?: string;
  size?: number;
}

const attachmentSelections = new Map<string, AttachmentSelectionRecord>();
const maxImportedImageBytes = MAX_IMAGE_BYTES;
const maxPromptImages = 10;
const maxReferencedFileWarningBytes = 100 * 1024 * 1024;

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
  await projectStore.loadIfNeeded();

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
    handler: async (request) => listChatSessions(store, request?.projectId),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatResumeSession,
    requestSchema: chatResumeSessionRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async ({ projectId, sessionFile }) =>
      resumeChatSession(store, diagnosticsService, sessionFile, projectId),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatDeleteSession,
    requestSchema: chatDeleteSessionRequestSchema,
    responseSchema: chatDeleteSessionResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ projectId, sessionFile }) =>
      deleteChatSession(store, sessionFile, projectId),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatDeleteAllSessions,
    requestSchema: chatDeleteAllSessionsRequestSchema,
    responseSchema: chatDeleteAllSessionsResultSchema,
    diagnostics: diagnosticsService,
    handler: async (request) =>
      deleteAllChatSessions(store, request?.projectId),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatListModels,
    requestSchema: chatListModelsRequestSchema,
    responseSchema: chatListModelsResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId }) =>
      listChatModels(store, diagnosticsService, runtimeId),
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
    handler: async ({ runtimeId, text, attachments }) => {
      const adapter = await ensureChatAdapter(store, diagnosticsService);
      const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
      await adapter.prompt(
        activeRuntimeId,
        await buildPromptInputWithImagePolicy(
          store,
          adapter,
          activeRuntimeId,
          text,
          attachments ?? [],
        ),
      );
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatSteer,
    requestSchema: chatInterventionRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, text, attachments }) => {
      const adapter = await ensureChatAdapter(store, diagnosticsService);
      const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
      await adapter.steer(
        activeRuntimeId,
        await buildPromptInputWithImagePolicy(
          store,
          adapter,
          activeRuntimeId,
          text,
          attachments ?? [],
        ),
      );
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatFollowUp,
    requestSchema: chatInterventionRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, text, attachments }) => {
      const adapter = await ensureChatAdapter(store, diagnosticsService);
      const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
      await adapter.followUp(
        activeRuntimeId,
        await buildPromptInputWithImagePolicy(
          store,
          adapter,
          activeRuntimeId,
          text,
          attachments ?? [],
        ),
      );
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
      await adapter.closeSession(activeRuntimeId);
      forgetChatRuntime(activeRuntimeId);
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatCreateSession,
    requestSchema: chatCreateSessionRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async (request) =>
      createChatSessionSnapshot(store, diagnosticsService, request?.projectId),
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
      await ensureProjectStore().selectProject(projectId);
      selectedRealProjectCwd = projectId;
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
        attachments: await Promise.all(
          result.filePaths.map((filePath) =>
            buildAttachmentDraft(filePath, projectRoot),
          ),
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
        attachments: await Promise.all(
          uniquePaths.map((filePath) =>
            buildAttachmentDraft(filePath, projectRoot),
          ),
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
      attachments: request.images.map(importImageAttachmentDraft),
    }),
  });
}

function ensureProjectStore(): ProjectStore {
  if (projectStore === undefined) {
    throw new Error("Project store is not initialized");
  }
  return projectStore;
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

async function initializeChatAdapter(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): Promise<SinglePiAdapter> {
  const mode = resolveChatBackendMode();
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
    trackExtensionUiRuntimeEvent(parsed.data);
    sendChatEventToRenderer(parsed.data);
    if (parsed.data.type === "worker_exit") {
      // A child exit does not go through closeSession(), so remove it from the
      // adapter as well as the UI/runtime maps or it would consume capacity.
      adapter.forgetExitedWorker(parsed.data.runtimeId);
      forgetChatRuntime(parsed.data.runtimeId);
    }
  });

  // Creating an adapter only installs routing and capacity bookkeeping. A
  // worker is created by an explicit create/resume/send path, never merely by
  // making the app interactive.
  chatBackendMode = mode;
  chatEventUnsubscribe = unsubscribe;
  chatWorkerCapacity = capacity;
  chatAdapter = adapter;
  return adapter;
}

async function createChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  mode: ChatBackendMode,
  capacity: WorkerCapacity,
  projectId?: string,
): Promise<ChatWorkerSpec> {
  return serializeChatWorkerCreation(async () => {
    const workerSpec =
      mode === "real"
        ? await createRealChatWorker(adapter, store, capacity, projectId)
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
  if (!adapter.hasRuntime(request.runtimeId)) {
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
    hasRuntime: (runtimeId) => adapter.hasRuntime(runtimeId),
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

function forgetChatRuntime(runtimeId: string): void {
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
  if (chatRuntimeId === runtimeId) {
    chatRuntimeId = undefined;
  }
}

interface ChatWorkerSpec {
  worker: ReturnType<SinglePiAdapter["createWorker"]>;
  cwd: string;
  projectId?: string;
}

async function createFakeChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
): Promise<ChatWorkerSpec> {
  const fakeRpcPath = path.join(__dirname, "pi/fakeRpc/fakeRpcServer.js");
  const cwd = process.cwd();
  return capacity.allocate(
    async () => (await store.get()).maxRunningSessions,
    () => {
      const worker = adapter.createWorker({
        command: process.execPath,
        args: [fakeRpcPath, "--stream-delay-ms", "120"],
        cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      return { worker, cwd };
    },
  );
}

async function createRealChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
  projectId?: string,
): Promise<ChatWorkerSpec> {
  const launch = await resolveRealChatLaunchConfig(store, projectId);
  return capacity.allocate(
    async () => (await store.get()).maxRunningSessions,
    () => {
      const worker = adapter.createWorker({
        command: launch.effective.config.piBinary,
        args: ["--mode", "rpc", ...launch.effective.workerArgs],
        cwd: launch.projectCwd,
        env: launch.effective.config.env,
        requestTimeoutMs: Number(
          process.env.PI_DECK_REAL_RPC_TIMEOUT_MS ?? 30_000,
        ),
        commandProtocol: "type-field",
      });
      return { worker, cwd: launch.projectCwd, projectId: launch.projectCwd };
    },
  );
}

async function createRealResumeWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  capacity: WorkerCapacity,
  sessionFile: string,
  projectId?: string,
): Promise<ChatWorkerSpec> {
  const launch = await resolveRealChatLaunchConfig(store, projectId);
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
  return capacity.allocate(
    async () => (await store.get()).maxRunningSessions,
    () => {
      const worker = adapter.createWorker({
        command: launch.effective.config.piBinary,
        args: [
          "--mode",
          "rpc",
          ...launch.effective.workerArgs,
          "--session",
          canonicalSessionFile,
        ],
        cwd: launch.projectCwd,
        env: launch.effective.config.env,
        requestTimeoutMs: Number(
          process.env.PI_DECK_REAL_RPC_TIMEOUT_MS ?? 30_000,
        ),
        commandProtocol: "type-field",
      });
      return {
        worker,
        cwd: launch.projectCwd,
        projectId: launch.projectCwd,
      };
    },
  );
}

async function resolveRealChatLaunchConfig(
  store: SettingsStore,
  projectId?: string,
): Promise<{
  appSettings: AppPiSettings;
  projectCwd: string;
  effective: EffectivePiConfigResult;
}> {
  const settings = await store.get();
  const appSettings = applyRealBackendEnvOverrides(settings);
  const projectCwd = await resolveRealBackendCwd(settings, projectId);
  const effective = await realChatLaunchConfigCache.resolve({
    appSettings,
    env: process.env,
    projectCwd,
  });
  return { appSettings, projectCwd, effective };
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

async function resolveRealBackendCwd(
  settings: AppSettings,
  projectId?: string,
): Promise<string> {
  const activeProject = await projectStore?.getActiveProject();
  const requested =
    projectId ??
    selectedRealProjectCwd ??
    process.env.PI_DECK_PROJECT_CWD ??
    activeProject?.rootPath ??
    settings.projectCwd ??
    process.cwd();
  const resolved = path.resolve(requested);
  const canonical = (await safeRealpath(resolved)) ?? resolved;
  // Only initial startup establishes a navigator project. Operations for an
  // explicit project must not retarget it: their workers can continue in the
  // background after the user navigates elsewhere.
  if (projectId === undefined && projectStore !== undefined) {
    await projectStore.upsertAndActivateProject(canonical);
  }
  return canonical;
}

async function closeChatWorker(): Promise<void> {
  const adapter = chatAdapter;
  const runtimeIds = [...chatRuntimeIds];
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
  runtimeId: string,
): Promise<z.infer<typeof chatListModelsResultSchema>> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const activeRuntimeId = resolveActiveChatRuntimeId(adapter, runtimeId);
  const response = await adapter.request(
    activeRuntimeId,
    "get_available_models",
  );
  if (
    response &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    Array.isArray((response as { models?: unknown }).models)
  ) {
    return chatListModelsResultSchema.parse(response);
  }
  return { models: [] };
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
  projectId?: string,
): Promise<ChatListSessionsResult> {
  const mode = resolveChatBackendMode();
  if (mode !== "real") {
    return {
      projectCwd: process.cwd(),
      ...(projectId ? { projectId } : {}),
      sessions: [],
      diagnostics: [
        "Session repository scanning is only enabled in real Pi mode.",
      ],
    };
  }

  const launch = await resolveRealChatLaunchConfig(store, projectId);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    return {
      projectCwd: launch.projectCwd,
      projectId: launch.projectCwd,
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
  await mergeProjectSessionRefs(launch.projectCwd, sessionsByFile, diagnostics);
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
    projectId: launch.projectCwd,
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
      ...(ref.cwd ? { cwd: ref.cwd } : { cwd: projectId }),
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
  sessionFile: string,
  projectId?: string,
): Promise<ChatDeleteSessionResult> {
  const mode = resolveChatBackendMode();
  if (mode !== "real") {
    throw new Error(
      "Deleting saved sessions is only available in real Pi mode.",
    );
  }

  const launch = await resolveRealChatLaunchConfig(store, projectId);
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
    await closeRuntimeForDeletedSession(lockedRuntimeId);
  }

  await trashOrRemoveFile(canonicalSessionFile);
  chatSessionFileLocks.delete(canonicalSessionFile);
  await projectStore?.removeSessionRef(launch.projectCwd, canonicalSessionFile);
  return { deleted: true, sessionFile: canonicalSessionFile };
}

async function closeRuntimeForDeletedSession(runtimeId: string): Promise<void> {
  const adapter = chatAdapter;
  try {
    if (adapter !== undefined && adapter.hasRuntime(runtimeId)) {
      await adapter.closeSession(runtimeId);
    }
  } finally {
    forgetChatRuntime(runtimeId);
  }
}

async function deleteAllChatSessions(
  store: SettingsStore,
  projectId?: string,
): Promise<ChatDeleteAllSessionsResult> {
  const listed = await listChatSessions(store, projectId);
  if (listed.sessions.length === 0) {
    return { deleted: true, deletedCount: 0, skippedCount: 0 };
  }
  const launch = await resolveRealChatLaunchConfig(store, projectId);
  const sessionDir = launch.effective.config.sessionDir;
  let deletedCount = 0;
  let skippedCount = 0;

  for (const session of listed.sessions) {
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
    if (lockedRuntimeId !== undefined && chatRuntimeIds.has(lockedRuntimeId)) {
      skippedCount += 1;
      continue;
    }
    await trashOrRemoveFile(canonicalSessionFile);
    chatSessionFileLocks.delete(canonicalSessionFile);
    await projectStore?.removeSessionRef(
      launch.projectCwd,
      canonicalSessionFile,
    );
    deletedCount += 1;
  }

  return { deleted: true, deletedCount, skippedCount };
}

async function trashOrRemoveFile(filePath: string): Promise<void> {
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
  projectId?: string,
): Promise<ChatSnapshot> {
  if (resolveChatBackendMode() !== "real") {
    throw new Error("Session resume is only available in real Pi mode.");
  }

  const launch = await resolveRealChatLaunchConfig(store, projectId);
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
    projectId,
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
  projectId?: string,
): Promise<ChatSnapshot> {
  const workerSpec = await serializeChatWorkerCreation(() =>
    createRealResumeWorker(
      adapter,
      store,
      capacity,
      canonicalSessionFile,
      projectId,
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
  projectId?: string,
): Promise<ChatSnapshot> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const mode = chatBackendMode ?? resolveChatBackendMode();
  const workerSpec = await createChatWorker(
    adapter,
    store,
    mode,
    getChatWorkerCapacity(),
    projectId,
  );
  return getChatSnapshotForRuntime(adapter, workerSpec.worker.runtimeId, mode, {
    skipMessages: true,
  });
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
  if (!adapter.hasRuntime(runtimeId)) {
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
    const projectId = chatRuntimeProjectIds.get(runtimeId) ?? state.cwd;
    if (projectId !== undefined) {
      const preview = previewFromMessages(messages);
      await projectStore?.upsertSessionRefFromSnapshot({
        projectId,
        sessionFile: canonicalSessionFile,
        ...(typeof state.sessionId === "string"
          ? { sessionId: state.sessionId }
          : {}),
        ...(typeof state.cwd === "string" ? { cwd: state.cwd } : {}),
        title:
          titleFromMessages(messages) ??
          path.basename(canonicalSessionFile, ".jsonl"),
        updatedAtMs: Date.now(),
        messageCount: messages.length,
        ...(preview !== undefined ? { preview } : {}),
      });
    }
  }

  return {
    runtimeId,
    backendMode: mode,
    state: { ...state, cwd: state.cwd ?? chatWorkerCwds.get(runtimeId) },
    messages,
  };
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
  const launch = await resolveRealChatLaunchConfig(
    store,
    chatRuntimeProjectIds.get(runtimeId),
  );
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
    chatRuntimeProjectIds.get(runtimeId) ?? chatWorkerCwds.get(runtimeId),
  );
}

async function buildPromptInput(
  text: string,
  attachments: NonNullable<
    z.infer<typeof chatPromptRequestSchema>["attachments"]
  >,
  autoResize: boolean,
  projectRoot: string | undefined,
): Promise<PromptInput> {
  const imageInputs: NonNullable<PromptInput["images"]> = [];
  const pathReferences: string[] = [];

  for (const attachment of attachments) {
    const selection = attachmentSelections.get(attachment.selectedPathToken);
    if (selection === undefined) {
      throw new Error(
        "Attachment is no longer available; reselect it and retry.",
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

function importImageAttachmentDraft(
  image: z.infer<typeof attachmentImportImageRequestSchema>["images"][number],
): AttachmentDraft {
  const data = decodeImageBase64(image.dataBase64);
  const inspected = inspectImage(data);

  const selectedPathToken = randomUUID();
  attachmentSelections.set(selectedPathToken, {
    kind: "image",
    mimeType: inspected.mimeType,
    imageDataBase64: image.dataBase64,
    size: data.length,
  });

  return {
    id: randomUUID(),
    selectedPathToken,
    fileName: image.fileName,
    displayPath: image.fileName,
    mimeType: inspected.mimeType,
    size: data.length,
    kind: "image",
    sendMode: "imageInput",
    outsideProject: false,
    status: "ready",
    previewDataUrl: `data:${inspected.mimeType};base64,${image.dataBase64}`,
  };
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

async function buildAttachmentDraft(
  filePath: string,
  projectRoot: string | undefined,
): Promise<AttachmentDraft> {
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
  if (canonicalPath && status === "ready") {
    attachmentSelections.set(selectedPathToken, {
      filePath: canonicalPath,
      kind,
      ...(sniffedImage ? { mimeType: sniffedImage.mimeType } : {}),
    });
  }

  return {
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
