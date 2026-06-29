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
  attachmentPickerRequestSchema,
  chatAbortRequestSchema,
  chatPromptRequestSchema,
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
  ChatSnapshot,
  PickAttachmentsResult,
  PickProjectResult,
} from "../shared/types.js";
import { DiagnosticsService } from "./diagnostics/diagnostics.js";
import { registerValidatedIpc } from "./ipc/registerIpc.js";
import { SinglePiAdapter } from "./pi/piAdapter.js";
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
let chatWorkerCwd: string | undefined;
let isQuittingAfterChatWorkerCleanup = false;

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
    channel: ipcChannels.chatPrompt,
    requestSchema: chatPromptRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, text }) => {
      const adapter = await ensureChatAdapter(store, diagnosticsService);
      await adapter.prompt(runtimeId, { text });
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
      await adapter.abort(runtimeId);
      return undefined;
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
  const workerSpec =
    mode === "real"
      ? await createRealChatWorker(adapter, store)
      : createFakeChatWorker(adapter);

  chatBackendMode = mode;
  chatWorkerCwd = workerSpec.cwd;
  chatRuntimeId = workerSpec.worker.runtimeId;
  adapter.onEvent((event) => {
    const parsed = chatRuntimeEventSchema.safeParse(event);
    if (!parsed.success) {
      diagnosticsService.recordError(
        `Dropping invalid chat event: ${parsed.error.message}`,
      );
      return;
    }
    mainWindow?.webContents.send(ipcChannels.chatEvent, parsed.data);
  });
  chatAdapter = adapter;
  return adapter;
}

function resolveChatBackendMode(): ChatBackendMode {
  return process.env.PI_DECK_BACKEND === "real" ? "real" : "fake";
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
  const settings = await store.get();
  const appSettings = applyRealBackendEnvOverrides(settings);
  const projectCwd = await resolveRealBackendCwd();
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

  const worker = adapter.createWorker({
    command: effective.config.piBinary,
    args: ["--mode", "rpc", ...effective.workerArgs],
    cwd: projectCwd,
    env: effective.config.env,
    requestTimeoutMs: Number(process.env.PI_DECK_REAL_RPC_TIMEOUT_MS ?? 30_000),
    commandProtocol: "type-field",
  });
  return { worker, cwd: projectCwd };
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

async function resolveRealBackendCwd(): Promise<string> {
  const requested = process.env.PI_DECK_PROJECT_CWD ?? process.cwd();
  const resolved = path.resolve(requested);
  return (await safeRealpath(resolved)) ?? resolved;
}

async function closeChatWorker(): Promise<void> {
  const adapter = chatAdapter;
  const runtimeId = chatRuntimeId;
  const mode = chatBackendMode ?? resolveChatBackendMode();
  chatAdapter = undefined;
  chatRuntimeId = undefined;
  chatBackendMode = undefined;
  chatWorkerCwd = undefined;

  if (adapter === undefined || runtimeId === undefined) {
    return;
  }

  try {
    await adapter.closeSession(runtimeId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics?.recordError(`Failed to close ${mode} chat worker: ${message}`);
  }
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
  const [state, messages] = await Promise.all([
    adapter.getState(runtimeId),
    adapter.getMessages(runtimeId),
  ]);
  return {
    runtimeId,
    backendMode: mode,
    state: { ...state, cwd: state.cwd ?? chatWorkerCwd },
    messages,
  };
}

async function safeRealpath(filePath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return undefined;
  }
}

// M4 UI shell only: token-shaped metadata is returned for renderer authority shape.
// Real token registry/path validation for sending is implemented in AttachmentService later.
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

  return {
    id: randomUUID(),
    selectedPathToken: randomUUID(),
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
    chatRuntimeId === undefined
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
