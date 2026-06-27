import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  ipcChannels,
} from "../../shared/ipcSchemas.js";
import { registerValidatedIpc } from "./registerIpc.js";

const electronMock = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, payload: unknown) => Promise<unknown>
  >();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: unknown, payload: unknown) => Promise<unknown>,
        ) => {
          handlers.set(channel, handler);
        },
      ),
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
}));

describe("registerValidatedIpc", () => {
  it("returns structured validation errors for invalid IPC payloads without invoking the handler", async () => {
    const errors: string[] = [];
    const handler = vi.fn(() => ({
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: true,
    }));

    registerValidatedIpc({
      channel: ipcChannels.settingsUpdate,
      requestSchema: appSettingsPatchSchema,
      responseSchema: appSettingsSchema,
      diagnostics: { recordError: (message) => errors.push(message) },
      handler,
    });

    const ipcHandler = electronMock.handlers.get(ipcChannels.settingsUpdate);
    expect(ipcHandler).toBeDefined();

    await expect(
      ipcHandler?.({}, { maxRunningSessions: 99 }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "IPC payload validation failed",
      },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("IPC settings:update rejected");
  });

  it("validates handler responses before returning success", async () => {
    registerValidatedIpc({
      channel: ipcChannels.appGetVersion,
      requestSchema: z.undefined(),
      responseSchema: z.string(),
      diagnostics: { recordError: () => undefined },
      handler: () => "0.1.0",
    });

    const ipcHandler = electronMock.handlers.get(ipcChannels.appGetVersion);
    await expect(ipcHandler?.({}, undefined)).resolves.toEqual({
      ok: true,
      data: "0.1.0",
    });
  });
});
