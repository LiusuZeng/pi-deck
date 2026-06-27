import { ipcMain } from "electron";
import type { ZodType } from "zod";
import { ZodError } from "zod";
import { apiResponseSchema, type IpcChannel } from "../../shared/ipcSchemas.js";
import type { IpcErrorPayload } from "../../shared/types.js";
import type { DiagnosticsRecorder } from "../diagnostics/diagnostics.js";

export function registerValidatedIpc<TRequest, TResponse>(options: {
  channel: IpcChannel;
  requestSchema: ZodType<TRequest>;
  responseSchema: ZodType<TResponse>;
  diagnostics: DiagnosticsRecorder;
  handler: (request: TRequest) => Promise<TResponse> | TResponse;
}): void {
  ipcMain.handle(options.channel, async (_event, rawRequest: unknown) => {
    try {
      const request = options.requestSchema.parse(rawRequest);
      const result = await options.handler(request);
      const data = options.responseSchema.parse(result);
      return apiResponseSchema(options.responseSchema).parse({
        ok: true,
        data,
      });
    } catch (error) {
      const payload = toIpcErrorPayload(error);
      options.diagnostics.recordError(
        `IPC ${options.channel} rejected: ${payload.message}`,
      );
      return apiResponseSchema(options.responseSchema).parse({
        ok: false,
        error: payload,
      });
    }
  });
}

function toIpcErrorPayload(error: unknown): IpcErrorPayload {
  if (error instanceof ZodError) {
    return {
      code: "VALIDATION_ERROR",
      message: "IPC payload validation failed",
      issues: error.issues,
    };
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: String(error),
  };
}
