import { contextBridge, ipcRenderer } from "electron";
import { z, type ZodType } from "zod";
import {
  apiResponseSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  diagnosticsSummarySchema,
  ipcChannels,
} from "../shared/ipcSchemas.js";
import type { AppSettings, PiDeckApi } from "../shared/types.js";

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
});

contextBridge.exposeInMainWorld("piDeck", api);
