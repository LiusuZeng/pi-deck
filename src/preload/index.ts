import { contextBridge, ipcRenderer } from "electron";
import { z, type ZodType } from "zod";
import {
  apiResponseSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  attachmentPickerRequestSchema,
  chatAbortRequestSchema,
  chatPromptRequestSchema,
  chatRuntimeEventSchema,
  chatSnapshotSchema,
  diagnosticsSummarySchema,
  ipcChannels,
  pickAttachmentsResultSchema,
  pickProjectResultSchema,
} from "../shared/ipcSchemas.js";
import type {
  AppSettings,
  ChatRuntimeEvent,
  PiDeckApi,
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
    getSnapshot: () =>
      invokeValidated({
        channel: ipcChannels.chatGetSnapshot,
        request: undefined,
        responseSchema: chatSnapshotSchema,
      }),
    prompt: (request: { runtimeId: string; text: string }) =>
      invokeValidated({
        channel: ipcChannels.chatPrompt,
        request: chatPromptRequestSchema.parse(request),
        responseSchema: z.void(),
      }),
    abort: (request: { runtimeId: string }) =>
      invokeValidated({
        channel: ipcChannels.chatAbort,
        request: chatAbortRequestSchema.parse(request),
        responseSchema: z.void(),
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
    pickProject: () =>
      invokeValidated({
        channel: ipcChannels.projectPickFolder,
        request: undefined,
        responseSchema: pickProjectResultSchema,
      }),
  }),
  attachments: Object.freeze({
    pickFiles: (request?: { projectPath?: string }) =>
      invokeValidated({
        channel: ipcChannels.attachmentsPickFiles,
        request: attachmentPickerRequestSchema.parse(request ?? {}),
        responseSchema: pickAttachmentsResultSchema,
      }),
  }),
});

contextBridge.exposeInMainWorld("piDeck", api);
