import {
  app,
  BrowserWindow,
  dialog,
  shell,
  session,
  type OpenDialogOptions,
} from "electron";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  attachmentImportDroppedFilesRequestSchema,
  attachmentImportImageRequestSchema,
  attachmentPickerRequestSchema,
  chatAbortRequestSchema,
  chatDeleteAllSessionsResultSchema,
  chatDeleteSessionRequestSchema,
  chatDeleteSessionResultSchema,
  chatListModelsRequestSchema,
  chatListModelsResultSchema,
  chatListSessionsResultSchema,
  chatPromptRequestSchema,
  chatResumeSessionRequestSchema,
  chatSetModelRequestSchema,
  chatSetThinkingRequestSchema,
  chatRuntimeEventSchema,
  chatSnapshotSchema,
  diagnosticsSummarySchema,
  ipcChannels,
  noPayloadSchema,
  pickAttachmentsResultSchema,
  pickProjectResultSchema,
} from "../shared/ipcSchemas.js";
import type {
  AppSettings,
  AttachmentDraft,
  ChatDeleteAllSessionsResult,
  ChatDeleteSessionResult,
  ChatListSessionsResult,
  ChatSnapshot,
  PickAttachmentsResult,
  PickProjectResult,
} from "../shared/types.js";
import { DiagnosticsService } from "./diagnostics/diagnostics.js";
import { registerValidatedIpc } from "./ipc/registerIpc.js";
import { SinglePiAdapter } from "./pi/piAdapter.js";
import { selectAvailableRuntime } from "./runtimeSelection.js";
import { scanSessionRepository } from "./pi/sessionRepository.js";
import type { PromptInput } from "./pi/types.js";
import {
  resolveEffectivePiConfig,
  resolvePiBinary,
  type AppPiSettings,
} from "./platform/piEnvironment.js";
import {
  buildContentSecurityPolicy,
  buildSecureWebPreferences,
  isAllowedExternalUrl,
  shouldAllowNavigation,
} from "./security.js";
import { SettingsStore } from "./settings/settingsStore.js";

const isDev = process.env.VITE_DEV_SERVER_URL !== undefined;

let mainWindow: BrowserWindow | undefined;
let settingsStore: SettingsStore | undefined;
let diagnostics: DiagnosticsService | undefined;
type ChatBackendMode = "fake" | "real";

let chatAdapter: SinglePiAdapter | undefined;
let chatRuntimeId: string | undefined;
let chatBackendMode: ChatBackendMode | undefined;
const chatRuntimeIds = new Set<string>();
const chatRuntimeModes = new Map<string, ChatBackendMode>();
const chatWorkerCwds = new Map<string, string>();
const chatRuntimeSessionFiles = new Map<string, string>();
const chatSessionFileLocks = new Map<string, string>();
let warmChatWorker: ChatWorkerSpec | undefined;
let warmChatWorkerPromise: Promise<ChatWorkerSpec | undefined> | undefined;
let warmChatWorkerSessionFile: string | undefined;
let chatEventUnsubscribe: (() => void) | undefined;
let selectedRealProjectCwd: string | undefined;
let isQuittingAfterChatWorkerCleanup = false;

interface AttachmentSelectionRecord {
  filePath?: string;
  kind: AttachmentDraft["kind"];
  mimeType?: string;
  imageDataBase64?: string;
  size?: number;
}

const attachmentSelections = new Map<string, AttachmentSelectionRecord>();
const maxImportedImageBytes = 20 * 1024 * 1024;

async function bootstrap(): Promise<void> {
  await app.whenReady();

  diagnostics = new DiagnosticsService(
    app.getVersion(),
    app.getPath("userData"),
  );
  await diagnostics.initialize();
  settingsStore = new SettingsStore(app.getPath("userData"), diagnostics);
  await settingsStore.loadIfNeeded();

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
    handler: async (patch) => store.update(patch),
  });

  // Demo Slice chat bridge. Fake remains the default; PI_DECK_BACKEND=real
  // enables the narrow real `pi --mode rpc` vertical slice.
  registerValidatedIpc({
    channel: ipcChannels.chatGetSnapshot,
    requestSchema: noPayloadSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async () => getChatSnapshot(store, diagnosticsService),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatListSessions,
    requestSchema: noPayloadSchema,
    responseSchema: chatListSessionsResultSchema,
    diagnostics: diagnosticsService,
    handler: async () => listChatSessions(store),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatResumeSession,
    requestSchema: chatResumeSessionRequestSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async ({ sessionFile }) =>
      resumeChatSession(store, diagnosticsService, sessionFile),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatDeleteSession,
    requestSchema: chatDeleteSessionRequestSchema,
    responseSchema: chatDeleteSessionResultSchema,
    diagnostics: diagnosticsService,
    handler: async ({ sessionFile }) => deleteChatSession(store, sessionFile),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatDeleteAllSessions,
    requestSchema: noPayloadSchema,
    responseSchema: chatDeleteAllSessionsResultSchema,
    diagnostics: diagnosticsService,
    handler: async () => deleteAllChatSessions(store),
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
      await adapter.prompt(
        resolveActiveChatRuntimeId(adapter, runtimeId),
        await buildPromptInput(text, attachments ?? []),
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
      await adapter.abort(resolveActiveChatRuntimeId(adapter, runtimeId));
      return undefined;
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.chatCreateSession,
    requestSchema: noPayloadSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async () => createChatSessionSnapshot(store, diagnosticsService),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatReset,
    requestSchema: noPayloadSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async () => {
      await closeChatWorker();
      return getChatSnapshot(store, diagnosticsService);
    },
  });

  registerValidatedIpc({
    channel: ipcChannels.projectPickFolder,
    requestSchema: noPayloadSchema,
    responseSchema: pickProjectResultSchema,
    diagnostics: diagnosticsService,
    handler: async (): Promise<PickProjectResult> => {
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
      return {
        selected: true,
        project: {
          id: canonicalPath,
          path: selectedPath,
          canonicalPath,
          displayName: path.basename(canonicalPath) || canonicalPath,
          lastOpenedAt: Date.now(),
        },
      };
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

async function ensureChatAdapter(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): Promise<SinglePiAdapter> {
  if (chatAdapter !== undefined) {
    return chatAdapter;
  }

  const mode = resolveChatBackendMode();
  const adapter = new SinglePiAdapter();
  const unsubscribe = adapter.onEvent((event) => {
    const parsed = chatRuntimeEventSchema.safeParse(event);
    if (!parsed.success) {
      diagnosticsService.recordError(
        `Dropping invalid chat event: ${parsed.error.message}`,
      );
      return;
    }
    sendChatEventToRenderer(parsed.data);
  });

  try {
    await createChatWorker(adapter, store, mode);
  } catch (error) {
    unsubscribe();
    throw error;
  }
  if (mode === "real") {
    void ensureWarmChatWorker(adapter, store);
  }

  chatBackendMode = mode;
  chatEventUnsubscribe = unsubscribe;
  chatAdapter = adapter;
  return adapter;
}

async function createChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  mode: ChatBackendMode,
  options: { preferWarm?: boolean } = {},
): Promise<ChatWorkerSpec> {
  const warmWorker =
    mode === "real" && options.preferWarm === true
      ? await takeWarmChatWorker()
      : undefined;
  const workerSpec =
    warmWorker ??
    (mode === "real"
      ? await createRealChatWorker(adapter, store)
      : createFakeChatWorker(adapter));
  registerChatWorker(workerSpec, mode);
  if (mode === "real") {
    void ensureWarmChatWorker(adapter, store);
  }
  return workerSpec;
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
}

async function ensureWarmChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
): Promise<ChatWorkerSpec | undefined> {
  if (!shouldPrewarmRealWorker()) {
    return undefined;
  }
  if (warmChatWorker !== undefined) {
    return warmChatWorker;
  }
  if (warmChatWorkerPromise !== undefined) {
    return warmChatWorkerPromise;
  }

  warmChatWorkerPromise = (async () => {
    const workerSpec = await createRealChatWorker(adapter, store);
    const state = await adapter.getState(workerSpec.worker.runtimeId);
    if (typeof state.sessionFile === "string") {
      warmChatWorkerSessionFile =
        (await safeRealpath(state.sessionFile)) ??
        path.resolve(state.sessionFile);
    }
    warmChatWorker = workerSpec;
    return workerSpec;
  })()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics?.recordError(`Failed to prewarm real Pi worker: ${message}`);
      warmChatWorker = undefined;
      warmChatWorkerSessionFile = undefined;
      return undefined;
    })
    .finally(() => {
      warmChatWorkerPromise = undefined;
    });

  return warmChatWorkerPromise;
}

async function takeWarmChatWorker(): Promise<ChatWorkerSpec | undefined> {
  const workerSpec = warmChatWorker ?? (await warmChatWorkerPromise);
  if (workerSpec === undefined) {
    return undefined;
  }
  warmChatWorker = undefined;
  warmChatWorkerPromise = undefined;
  warmChatWorkerSessionFile = undefined;
  return workerSpec;
}

function shouldPrewarmRealWorker(): boolean {
  return process.env.PI_DECK_DISABLE_PREWARM_REAL_WORKER !== "1";
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
    activeRuntimeId: chatRuntimeId,
    runtimeIds: chatRuntimeIds,
    hasRuntime: (runtimeId) => adapter.hasRuntime(runtimeId),
  });

  if (selection.reason === "requested" && selection.runtimeId !== undefined) {
    return selection.runtimeId;
  }

  forgetChatRuntime(requestedRuntimeId);

  if (selection.runtimeId !== undefined) {
    chatRuntimeId = selection.runtimeId;
    diagnostics?.recordError(
      `Renderer requested stale chat runtime ${requestedRuntimeId}; using ${selection.reason} runtime ${selection.runtimeId}.`,
    );
    return selection.runtimeId;
  }

  throw new Error("Chat runtime is not initialized");
}

function forgetChatRuntime(runtimeId: string): void {
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
  if (chatRuntimeId === runtimeId) {
    chatRuntimeId = undefined;
  }
}

interface ChatWorkerSpec {
  worker: ReturnType<SinglePiAdapter["createWorker"]>;
  cwd: string;
}

function createFakeChatWorker(adapter: SinglePiAdapter): ChatWorkerSpec {
  const fakeRpcPath = path.join(__dirname, "pi/fakeRpc/fakeRpcServer.js");
  const cwd = process.cwd();
  const worker = adapter.createWorker({
    command: process.execPath,
    args: [fakeRpcPath, "--stream-delay-ms", "120"],
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  return { worker, cwd };
}

async function createRealChatWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
): Promise<ChatWorkerSpec> {
  const launch = await resolveRealChatLaunchConfig(store);
  const worker = adapter.createWorker({
    command: launch.effective.config.piBinary,
    args: ["--mode", "rpc", ...launch.effective.workerArgs],
    cwd: launch.projectCwd,
    env: launch.effective.config.env,
    requestTimeoutMs: Number(process.env.PI_DECK_REAL_RPC_TIMEOUT_MS ?? 30_000),
    commandProtocol: "type-field",
  });
  return { worker, cwd: launch.projectCwd };
}

async function createRealResumeWorker(
  adapter: SinglePiAdapter,
  store: SettingsStore,
  sessionFile: string,
): Promise<ChatWorkerSpec> {
  const launch = await resolveRealChatLaunchConfig(store);
  const canonicalSessionFile =
    (await safeRealpath(sessionFile)) ?? path.resolve(sessionFile);
  const sessionCwd = await readSessionFileCwd(canonicalSessionFile);
  const cwd = sessionCwd ?? launch.projectCwd;
  const worker = adapter.createWorker({
    command: launch.effective.config.piBinary,
    args: [
      "--mode",
      "rpc",
      ...launch.effective.workerArgs,
      "--session",
      canonicalSessionFile,
    ],
    cwd,
    env: launch.effective.config.env,
    requestTimeoutMs: Number(process.env.PI_DECK_REAL_RPC_TIMEOUT_MS ?? 30_000),
    commandProtocol: "type-field",
  });
  return { worker, cwd };
}

async function resolveRealChatLaunchConfig(store: SettingsStore): Promise<{
  appSettings: AppPiSettings;
  projectCwd: string;
  effective: Awaited<ReturnType<typeof resolveEffectivePiConfig>>;
}> {
  const settings = await store.get();
  const appSettings = applyRealBackendEnvOverrides(settings);
  const projectCwd = await resolveRealBackendCwd(settings);
  const binaryResolution = await resolvePiBinary({
    appSettings,
    env: process.env,
  });

  if (!binaryResolution.ok || binaryResolution.piBinary === undefined) {
    const details = binaryResolution.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("; ");
    throw new Error(
      `Real Pi backend requested but no usable pi binary was found. ${details}`,
    );
  }

  const effective = await resolveEffectivePiConfig({
    piBinary: binaryResolution.piBinary,
    appSettings,
    env: process.env,
    cwd: projectCwd,
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

  const piBinaryOverride = process.env.PI_DECK_PI_BINARY;
  if (piBinaryOverride !== undefined && piBinaryOverride.trim().length > 0) {
    appPiSettings.piBinaryPath = piBinaryOverride;
  }
  return appPiSettings;
}

async function resolveRealBackendCwd(settings: AppSettings): Promise<string> {
  const requested =
    selectedRealProjectCwd ??
    process.env.PI_DECK_PROJECT_CWD ??
    settings.projectCwd ??
    process.cwd();
  const resolved = path.resolve(requested);
  return (await safeRealpath(resolved)) ?? resolved;
}

async function closeChatWorker(): Promise<void> {
  const adapter = chatAdapter;
  const pendingWarmWorker = warmChatWorkerPromise
    ? await warmChatWorkerPromise
    : undefined;
  const runtimeIds = [
    ...new Set([
      ...chatRuntimeIds,
      ...(warmChatWorker ? [warmChatWorker.worker.runtimeId] : []),
      ...(pendingWarmWorker ? [pendingWarmWorker.worker.runtimeId] : []),
    ]),
  ];
  chatEventUnsubscribe?.();
  chatEventUnsubscribe = undefined;
  chatAdapter = undefined;
  chatRuntimeId = undefined;
  chatBackendMode = undefined;
  chatRuntimeIds.clear();
  chatRuntimeModes.clear();
  chatWorkerCwds.clear();
  chatRuntimeSessionFiles.clear();
  chatSessionFileLocks.clear();
  warmChatWorker = undefined;
  warmChatWorkerPromise = undefined;
  warmChatWorkerSessionFile = undefined;

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
  const response = await adapter.request(
    resolveActiveChatRuntimeId(adapter, runtimeId),
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
): Promise<ChatListSessionsResult> {
  const mode = resolveChatBackendMode();
  if (mode !== "real") {
    return {
      projectCwd: process.cwd(),
      sessions: [],
      diagnostics: [
        "Session repository scanning is only enabled in real Pi mode.",
      ],
    };
  }

  const launch = await resolveRealChatLaunchConfig(store);
  const sessionDir = launch.effective.config.sessionDir;
  if (sessionDir === undefined) {
    return {
      projectCwd: launch.projectCwd,
      sessions: [],
      diagnostics: ["No Pi session directory is configured."],
    };
  }

  const scanResults = [
    await scanSessionRepository({
      sessionDir,
      projectCwd: launch.projectCwd,
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
      }),
    );
  }

  const sessionsByFile = new Map(
    scanResults.flatMap((result) =>
      result.sessions.map((session) => [session.sessionFile, session] as const),
    ),
  );
  const sessions = [...sessionsByFile.values()].sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs,
  );
  const diagnostics = scanResults.flatMap((result) => result.diagnostics);
  if (candidateDir !== undefined && candidateDir !== sessionDir) {
    diagnostics.push(
      process.env.PI_DECK_SCAN_PROJECT_SESSION_DIR_CANDIDATE === "1"
        ? `Scanned opted-in project sessionDir candidate: ${candidateDir}`
        : `Project sessionDir candidate not scanned without opt-in: ${candidateDir}`,
    );
  }

  return {
    projectCwd: launch.projectCwd,
    sessionDir,
    sessions: sessions
      .filter((session) => session.sessionFile !== warmChatWorkerSessionFile)
      .map((session) => {
        const attachedRuntimeId = chatSessionFileLocks.get(session.sessionFile);
        return attachedRuntimeId ? { ...session, attachedRuntimeId } : session;
      }),
    diagnostics,
  };
}

async function deleteChatSession(
  store: SettingsStore,
  sessionFile: string,
): Promise<ChatDeleteSessionResult> {
  const mode = resolveChatBackendMode();
  if (mode !== "real") {
    throw new Error(
      "Deleting saved sessions is only available in real Pi mode.",
    );
  }

  const canonicalSessionFile = await safeRealpath(sessionFile);
  if (canonicalSessionFile === undefined) {
    throw new Error(`Session file is missing or unreadable: ${sessionFile}`);
  }

  const launch = await resolveRealChatLaunchConfig(store);
  const sessionCwd = await readSessionFileCwd(canonicalSessionFile);
  if (sessionCwd !== undefined && sessionCwd !== launch.projectCwd) {
    throw new Error(
      `Session belongs to a different project. Session cwd: ${sessionCwd}; current project: ${launch.projectCwd}.`,
    );
  }

  const lockedRuntimeId = chatSessionFileLocks.get(canonicalSessionFile);
  if (lockedRuntimeId !== undefined) {
    await closeRuntimeForDeletedSession(lockedRuntimeId);
  }

  await trashOrRemoveFile(canonicalSessionFile);
  chatSessionFileLocks.delete(canonicalSessionFile);
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
): Promise<ChatDeleteAllSessionsResult> {
  const listed = await listChatSessions(store);
  let deletedCount = 0;
  let skippedCount = 0;

  for (const session of listed.sessions) {
    const canonicalSessionFile = await safeRealpath(session.sessionFile);
    if (canonicalSessionFile === undefined) {
      skippedCount += 1;
      continue;
    }
    const lockedRuntimeId = chatSessionFileLocks.get(canonicalSessionFile);
    if (
      canonicalSessionFile === warmChatWorkerSessionFile ||
      (lockedRuntimeId !== undefined && chatRuntimeIds.has(lockedRuntimeId))
    ) {
      skippedCount += 1;
      continue;
    }
    await trashOrRemoveFile(canonicalSessionFile);
    chatSessionFileLocks.delete(canonicalSessionFile);
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
): Promise<ChatSnapshot> {
  if (resolveChatBackendMode() !== "real") {
    throw new Error("Session resume is only available in real Pi mode.");
  }

  const canonicalSessionFile = await safeRealpath(sessionFile);
  if (canonicalSessionFile === undefined) {
    throw new Error(`Session file is missing or unreadable: ${sessionFile}`);
  }
  const launch = await resolveRealChatLaunchConfig(store);
  const sessionCwd = await readSessionFileCwd(canonicalSessionFile);
  if (sessionCwd !== undefined && sessionCwd !== launch.projectCwd) {
    throw new Error(
      `Session belongs to a different project. Session cwd: ${sessionCwd}; current project: ${launch.projectCwd}.`,
    );
  }

  const existingRuntimeId = chatSessionFileLocks.get(canonicalSessionFile);
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const mode = chatBackendMode ?? "real";
  if (existingRuntimeId !== undefined) {
    chatRuntimeId = existingRuntimeId;
    return getChatSnapshotForRuntime(adapter, existingRuntimeId, mode);
  }

  const workerSpec = await createRealResumeWorker(
    adapter,
    store,
    canonicalSessionFile,
  );
  const runtimeId = workerSpec.worker.runtimeId;
  chatRuntimeId = runtimeId;
  chatRuntimeIds.add(runtimeId);
  chatRuntimeModes.set(runtimeId, "real");
  chatWorkerCwds.set(runtimeId, workerSpec.cwd);

  const snapshot = await getChatSnapshotForRuntime(adapter, runtimeId, "real");
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
}

async function createChatSessionSnapshot(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): Promise<ChatSnapshot> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const mode = chatBackendMode ?? resolveChatBackendMode();
  const workerSpec = await createChatWorker(adapter, store, mode, {
    preferWarm: true,
  });
  return getChatSnapshotForRuntime(adapter, workerSpec.worker.runtimeId, mode, {
    skipMessages: true,
  });
}

async function getChatSnapshot(
  store: SettingsStore,
  diagnosticsService: DiagnosticsService,
): Promise<ChatSnapshot> {
  const adapter = await ensureChatAdapter(store, diagnosticsService);
  const runtimeId = chatRuntimeId;
  const mode = chatBackendMode ?? resolveChatBackendMode();
  if (runtimeId === undefined) {
    throw new Error(`${mode} chat runtime failed to initialize`);
  }
  return getChatSnapshotForRuntime(adapter, runtimeId, mode);
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
  }

  return {
    runtimeId,
    backendMode: mode,
    state: { ...state, cwd: state.cwd ?? chatWorkerCwds.get(runtimeId) },
    messages,
  };
}

async function readSessionFileCwd(
  sessionFile: string,
): Promise<string | undefined> {
  try {
    const handle = await fs.open(sessionFile, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .split(/\r?\n/, 1)[0];
      if (!firstLine) {
        return undefined;
      }
      const parsed = JSON.parse(firstLine) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      const cwd = (parsed as Record<string, unknown>).cwd;
      return typeof cwd === "string"
        ? ((await safeRealpath(cwd)) ?? path.resolve(cwd))
        : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function safeRealpath(filePath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return undefined;
  }
}

async function buildPromptInput(
  text: string,
  attachments: NonNullable<
    z.infer<typeof chatPromptRequestSchema>["attachments"]
  >,
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
      if (selection.kind !== "image" || selection.mimeType === undefined) {
        throw new Error("Selected attachment is not a supported image.");
      }
      const dataBase64 =
        selection.imageDataBase64 ??
        (selection.filePath
          ? await readImageAttachmentBase64(selection.filePath)
          : undefined);
      if (dataBase64 === undefined) {
        throw new Error(
          "Image attachment is no longer available; reselect it and retry.",
        );
      }
      imageInputs.push({
        mimeType: selection.mimeType,
        dataBase64,
      });
    } else {
      if (selection.filePath === undefined) {
        throw new Error(
          "Referenced attachment is no longer available; reselect it and retry.",
        );
      }
      await assertAttachmentReadable(selection.filePath);
      pathReferences.push(selection.filePath);
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

async function readImageAttachmentBase64(
  filePath: string,
): Promise<string | undefined> {
  await assertAttachmentReadable(filePath);
  const data = await fs.readFile(filePath);
  return data.toString("base64");
}

function importImageAttachmentDraft(
  image: z.infer<typeof attachmentImportImageRequestSchema>["images"][number],
): AttachmentDraft {
  if (!isSupportedImageMimeType(image.mimeType)) {
    throw new Error(`Unsupported image type: ${image.mimeType}`);
  }
  if (image.size > maxImportedImageBytes) {
    throw new Error(
      "Image is too large to import; choose an image under 20 MB.",
    );
  }

  const selectedPathToken = randomUUID();
  attachmentSelections.set(selectedPathToken, {
    kind: "image",
    mimeType: image.mimeType,
    imageDataBase64: image.dataBase64,
    size: image.size,
  });

  return {
    id: randomUUID(),
    selectedPathToken,
    fileName: image.fileName,
    displayPath: image.fileName,
    mimeType: image.mimeType,
    size: image.size,
    kind: "image",
    sendMode: "imageInput",
    outsideProject: false,
    status: "ready",
    previewDataUrl: `data:${image.mimeType};base64,${image.dataBase64}`,
  };
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
  const imageMimeType = getImageMimeType(extension);
  const kind: AttachmentDraft["kind"] = imageMimeType
    ? "image"
    : isLikelyTextPath(extension)
      ? "textFile"
      : "binaryFile";
  const outsideProject = Boolean(
    projectRoot && canonicalPath && !isPathInside(canonicalPath, projectRoot),
  );
  const stat = canonicalPath ? await statIfReadable(canonicalPath) : undefined;
  const warning = outsideProject
    ? "Outside selected project; the model may see an absolute local path."
    : kind === "binaryFile"
      ? "Binary/unknown files are referenced by path only."
      : undefined;

  const selectedPathToken = randomUUID();
  if (canonicalPath && status === "ready") {
    attachmentSelections.set(selectedPathToken, {
      filePath: canonicalPath,
      kind,
      ...(imageMimeType ? { mimeType: imageMimeType } : {}),
    });
  }

  return {
    id: randomUUID(),
    selectedPathToken,
    fileName: path.basename(filePath),
    displayPath: filePath,
    ...(imageMimeType ? { mimeType: imageMimeType } : {}),
    ...(stat ? { size: stat.size } : {}),
    kind,
    sendMode: kind === "image" ? "imageInput" : "pathReference",
    outsideProject,
    status,
    ...(warning ? { warning } : {}),
  };
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

function isSupportedImageMimeType(mimeType: string): boolean {
  return new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(
    mimeType,
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
