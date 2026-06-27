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
  AttachmentDraft,
  ChatSnapshot,
  PickAttachmentsResult,
  PickProjectResult,
} from "../shared/types.js";
import { DiagnosticsService } from "./diagnostics/diagnostics.js";
import { registerValidatedIpc } from "./ipc/registerIpc.js";
import { SinglePiAdapter } from "./pi/piAdapter.js";
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
let chatAdapter: SinglePiAdapter | undefined;
let chatRuntimeId: string | undefined;
let isQuittingAfterFakeWorkerCleanup = false;

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

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
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

  // M2/M2.5 temporary fake chat bridge for renderer development.
  // Real project/session worker management lands in M3/M5.
  registerValidatedIpc({
    channel: ipcChannels.chatGetSnapshot,
    requestSchema: noPayloadSchema,
    responseSchema: chatSnapshotSchema,
    diagnostics: diagnosticsService,
    handler: async () => getChatSnapshot(diagnosticsService),
  });

  registerValidatedIpc({
    channel: ipcChannels.chatPrompt,
    requestSchema: chatPromptRequestSchema,
    responseSchema: z.void(),
    diagnostics: diagnosticsService,
    handler: async ({ runtimeId, text }) => {
      const adapter = ensureChatAdapter(diagnosticsService);
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
      const adapter = ensureChatAdapter(diagnosticsService);
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

// M2/M2.5 temporary fake chat bridge for renderer development.
// Real project/session worker management lands in M3/M5.
function ensureChatAdapter(
  diagnosticsService: DiagnosticsService,
): SinglePiAdapter {
  if (chatAdapter !== undefined) {
    return chatAdapter;
  }

  const adapter = new SinglePiAdapter();
  const fakeRpcPath = path.join(__dirname, "pi/fakeRpc/fakeRpcServer.js");
  const worker = adapter.createWorker({
    command: process.execPath,
    args: [fakeRpcPath, "--stream-delay-ms", "120"],
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  chatRuntimeId = worker.runtimeId;
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

async function closeFakeChatWorker(): Promise<void> {
  const adapter = chatAdapter;
  const runtimeId = chatRuntimeId;
  chatAdapter = undefined;
  chatRuntimeId = undefined;

  if (adapter === undefined || runtimeId === undefined) {
    return;
  }

  try {
    await adapter.closeSession(runtimeId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics?.recordError(`Failed to close fake chat worker: ${message}`);
  }
}

async function getChatSnapshot(
  diagnosticsService: DiagnosticsService,
): Promise<ChatSnapshot> {
  const adapter = ensureChatAdapter(diagnosticsService);
  const runtimeId = chatRuntimeId;
  if (runtimeId === undefined) {
    throw new Error("Fake chat runtime failed to initialize");
  }
  const [state, messages] = await Promise.all([
    adapter.getState(runtimeId),
    adapter.getMessages(runtimeId),
  ]);
  return { runtimeId, state, messages };
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
    isQuittingAfterFakeWorkerCleanup ||
    chatAdapter === undefined ||
    chatRuntimeId === undefined
  ) {
    return;
  }

  event.preventDefault();
  isQuittingAfterFakeWorkerCleanup = true;
  void closeFakeChatWorker().finally(() => {
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

bootstrap().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  diagnostics?.recordError(`Fatal startup error: ${message}`);
  console.error(message);
  app.quit();
});
