import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiDeckApi } from "../shared/types.js";

const electronMock = vi.hoisted(() => {
  const exposed: { api?: PiDeckApi } = {};
  return {
    exposed,
    contextBridge: {
      exposeInMainWorld: vi.fn((_key: string, api: PiDeckApi) => {
        exposed.api = api;
      }),
    },
    ipcRenderer: {
      invoke: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer,
}));

describe("preload PiDeck API validation", () => {
  let api: PiDeckApi;

  beforeAll(async () => {
    await import("./index.js");
    if (!electronMock.exposed.api) {
      throw new Error("preload API was not exposed");
    }
    api = electronMock.exposed.api;
  });

  beforeEach(() => {
    electronMock.ipcRenderer.invoke.mockReset();
  });

  it("rejects invalid attachment picker requests before invoking IPC", () => {
    expect(() =>
      api.attachments.pickFiles({
        projectPath: "/project",
        arbitraryRead: true,
      } as unknown as { projectPath?: string }),
    ).toThrow();

    expect(electronMock.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it("validates project picker responses from IPC", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      data: {
        selected: true,
        project: {
          id: "/project",
          path: "/project",
          canonicalPath: "/project",
          displayName: "project",
          lastOpenedAt: 1,
          unexpected: "field",
        },
      },
    });

    await expect(api.projects.pickProject()).rejects.toThrow();
  });

  it("accepts valid attachment picker responses from IPC", async () => {
    const payload = {
      selected: true,
      attachments: [
        {
          id: "draft-1",
          selectedPathToken: "opaque-token-1",
          fileName: "mockup.png",
          displayPath: "design/mockup.png",
          mimeType: "image/png",
          kind: "image",
          sendMode: "imageInput",
          outsideProject: false,
          status: "ready",
        },
      ],
    };
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      data: payload,
    });

    await expect(
      api.attachments.pickFiles({ projectPath: "/project" }),
    ).resolves.toEqual(payload);
  });
});
