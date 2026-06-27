import { app, BrowserWindow, shell, session } from "electron";
import path from "node:path";
import { z } from "zod";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  chatAbortRequestSchema,
  chatPromptRequestSchema,
  chatRuntimeEventSchema,
  chatSnapshotSchema,
  diagnosticsSummarySchema,
  ipcChannels,
  noPayloadSchema,
} from "../shared/ipcSchemas.js";
import type { ChatSnapshot } from "../shared/types.js";
import { DiagnosticsService } from "./diagnostics/diagnostics.js";
import { registerValidatedIpc } from "./ipc/registerIpc.js";
import {
  buildContentSecurityPolicy,
  buildSecureWebPreferences,
  isAllowedExternalUrl,
  shouldAllowNavigation,
} from "./security.js";
import { SinglePiAdapter } from "./pi/piAdapter.js";
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
