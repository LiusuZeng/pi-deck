import { describe, expect, it } from "vitest";
import {
  apiResponseSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
} from "./ipcSchemas.js";

describe("IPC schemas", () => {
  it("applies settings defaults and caps running sessions at 20", () => {
    expect(appSettingsSchema.parse({})).toMatchObject({
      maxRunningSessions: 4,
      warmWorkerLimit: 1,
      enableLoginShellEnvCapture: true,
    });
    expect(appSettingsPatchSchema.parse({})).toEqual({});
    expect(() =>
      appSettingsPatchSchema.parse({ maxRunningSessions: 21 }),
    ).toThrow();
  });

  it("rejects unknown settings keys", () => {
    expect(() =>
      appSettingsPatchSchema.parse({ arbitraryNodeApi: true }),
    ).toThrow();
  });

  it("validates structured IPC error responses", () => {
    expect(
      apiResponseSchema(appSettingsSchema).parse({
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "IPC payload validation failed",
        },
      }),
    ).toMatchObject({ ok: false });
  });
});
