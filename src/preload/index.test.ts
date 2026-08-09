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
    webUtils: {
      getPathForFile: vi.fn(
        (file: File & { path?: string }) => file.path ?? "",
      ),
    },
  };
});

vi.mock("electron", () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer,
  webUtils: electronMock.webUtils,
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

  it("exposes canonical agentWorkflow workflow IPC methods with strict workspace scope", async () => {
    const workflow = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "workflow-1",
      revision: 1,
      name: "Workflow",
      inputs: [],
      entryNodeId: "worker-1",
      nodes: [
        {
          id: "worker-1",
          name: "Worker",
          role: "worker" as const,
          config: { instructions: "Do the work" },
        },
      ],
      relationships: [],
    };
    electronMock.ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      data: workflow,
    });

    await api.workflows.createWorkflow({
      workspaceId: "workspace-1",
      workflow,
    });
    await api.workflows.updateWorkflow({
      workspaceId: "workspace-1",
      workflow,
    });
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      data: [workflow],
    });
    await expect(
      api.workflows.listWorkflows({ workspaceId: "workspace-1" }),
    ).resolves.toEqual([workflow]);

    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      "workflows:create",
      { workspaceId: "workspace-1", workflow },
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      "workflows:update",
      { workspaceId: "workspace-1", workflow },
    );
    expect(() =>
      api.workflows.createWorkflow({
        workspaceId: "workspace-1",
        workflow: { ...workflow, extra: true },
      } as never),
    ).toThrow();
  });

  it("exposes strict steer and follow-up IPC methods", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      data: undefined,
    });

    await api.chat.steer({ runtimeId: "runtime-1", text: "Change course" });
    await api.chat.followUp({ runtimeId: "runtime-1", text: "Then test it" });

    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      "chat:steer",
      { runtimeId: "runtime-1", text: "Change course" },
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      "chat:followUp",
      { runtimeId: "runtime-1", text: "Then test it" },
    );
    expect(() =>
      api.chat.steer({
        runtimeId: "runtime-1",
        text: "Nope",
        arbitraryIpc: true,
      } as unknown as { runtimeId: string; text: string }),
    ).toThrow();
  });

  it("exposes the validated local bootstrap API", async () => {
    const project = {
      id: "/project",
      path: "/project",
      canonicalPath: "/project",
      displayName: "project",
      lastOpenedAt: 1,
    };
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      data: {
        backendMode: "fake",
        version: "0.1.0",
        settings: {},
        diagnostics: {
          appVersion: "0.1.0",
          userDataPath: "/tmp/user-data",
          logPath: "/tmp/log",
          settings: {},
          recentErrors: [],
        },
        project,
        projects: [project],
        cachedSessions: [],
      },
    });

    await expect(api.app.getBootstrapState()).resolves.toMatchObject({
      backendMode: "fake",
      project,
    });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      "app:getBootstrapState",
      undefined,
    );
  });

  it("exposes a runtime-scoped compact status API", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      data: {
        runtimeId: "runtime-1",
        backendMode: "real",
        state: { isAgentActive: false },
      },
    });

    await expect(
      api.chat.getRuntimeStatus({ runtimeId: "runtime-1" }),
    ).resolves.toMatchObject({ runtimeId: "runtime-1" });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      "chat:getRuntimeStatus",
      { runtimeId: "runtime-1" },
    );
    expect(() =>
      api.chat.getRuntimeStatus({
        runtimeId: "runtime-1",
        messages: [],
      } as unknown as { runtimeId: string }),
    ).toThrow();
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

  it("exposes strict workspace lifecycle IPC methods", async () => {
    const workspace = {
      id: "workspace-1",
      name: "Release planning",
      lastOpenedAt: 1,
    };
    electronMock.ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      data: {
        activeWorkspaceId: workspace.id,
        activeWorkspace: workspace,
        workspaces: [workspace],
      },
    });

    await api.workspaces.create({ name: "  Release   planning " });
    await api.workspaces.update({
      workspaceId: workspace.id,
      defaultProjectId: null,
    });
    await api.workspaces.select({ workspaceId: workspace.id });

    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      "workspaces:create",
      { name: "Release planning" },
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      "workspaces:update",
      { workspaceId: workspace.id, defaultProjectId: null },
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      3,
      "workspaces:select",
      { workspaceId: workspace.id },
    );
    expect(() =>
      api.workspaces.create({
        name: "Release",
        rootPath: "/not-workspace-identity",
      } as unknown as { name: string }),
    ).toThrow();
  });

  it("exposes strict workspace membership IPC methods", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      data: {
        workspaceId: "workspace-2",
        sessionFile: "/sessions/one.jsonl",
      },
    });

    await api.workspaces.addSession({
      workspaceId: "workspace-1",
      sessionFile: "/sessions/one.jsonl",
    });
    await api.workspaces.moveSession({
      sessionFile: "/sessions/one.jsonl",
      toWorkspaceId: "workspace-2",
    });
    await api.workspaces.removeSession({
      workspaceId: "workspace-2",
      sessionFile: "/sessions/one.jsonl",
    });

    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      "workspaces:addSession",
      {
        workspaceId: "workspace-1",
        sessionFile: "/sessions/one.jsonl",
      },
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      "workspaces:moveSession",
      {
        sessionFile: "/sessions/one.jsonl",
        toWorkspaceId: "workspace-2",
      },
    );
  });

  it("passes dropped file paths through preload-owned Electron webUtils", async () => {
    const payload = {
      selected: true,
      attachments: [
        {
          id: "draft-1",
          selectedPathToken: "opaque-token-1",
          fileName: "notes.txt",
          displayPath: "/project/notes.txt",
          kind: "textFile",
          sendMode: "pathReference",
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
      api.attachments.importDroppedFiles(
        [{ name: "notes.txt", path: "/project/notes.txt" } as unknown as File],
        {
          projectPath: "/project",
          ownerId: "owner-generation-1",
          sessionId: "draft-1",
        },
      ),
    ).resolves.toEqual(payload);

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      "attachments:importDroppedFiles",
      {
        paths: ["/project/notes.txt"],
        projectPath: "/project",
        ownerId: "owner-generation-1",
        sessionId: "draft-1",
      },
    );
  });

  it("exposes owner-scoped attachment release and transfer methods", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      data: undefined,
    });

    await api.attachments.release({
      ownerId: "draft-1",
      selectedPathTokens: ["token-1"],
    });
    await api.attachments.releaseOwner({ ownerId: "draft-1" });
    await api.attachments.assignOwner({
      previousOwnerId: "owner-generation-1",
      previousSessionId: "draft-1",
      ownerId: "owner-generation-2",
      sessionId: "runtime-1",
      selectedPathTokens: ["token-1"],
    });

    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      "attachments:release",
      { ownerId: "draft-1", selectedPathTokens: ["token-1"] },
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      "attachments:releaseOwner",
      { ownerId: "draft-1" },
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      3,
      "attachments:assignOwner",
      {
        previousOwnerId: "owner-generation-1",
        previousSessionId: "draft-1",
        ownerId: "owner-generation-2",
        sessionId: "runtime-1",
        selectedPathTokens: ["token-1"],
      },
    );
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
      api.attachments.pickFiles({
        projectPath: "/project",
        ownerId: "owner-generation-1",
        sessionId: "draft-1",
      }),
    ).resolves.toEqual(payload);
  });
});
