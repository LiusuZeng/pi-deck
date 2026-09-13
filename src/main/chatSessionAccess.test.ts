import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProjectRef } from "../shared/types.js";
import {
  authorizeRendererChatProject,
  projectForWorkspaceSession,
  resolveChatCreationContext,
  resolveWorkspaceProject,
  resolveWorkspaceRepositoryProject,
  type ChatSessionAccessPorts,
} from "./chatSessionAccess.js";
import type {
  WorkspaceRecord,
  WorkspaceSessionRef,
} from "./workspaces/workspaceStore.js";

const project = (id: string, canonicalPath = id): ProjectRef => ({
  id,
  path: canonicalPath,
  canonicalPath,
  displayName: id,
  lastOpenedAt: 0,
});

const workspace = (
  id: string,
  defaultProjectId?: string,
  archivedAtMs?: number,
): WorkspaceRecord => ({
  id,
  name: id,
  ...(defaultProjectId !== undefined ? { defaultProjectId } : {}),
  ...(archivedAtMs !== undefined ? { archivedAtMs } : {}),
  createdAtMs: 0,
  updatedAtMs: 0,
  lastOpenedAtMs: 0,
});

const sessionRef = (
  workspaceId: string,
  sessionFile: string,
  cwd?: string,
): WorkspaceSessionRef => ({
  workspaceId,
  sessionFile,
  ...(cwd !== undefined ? { cwd } : {}),
  addedAtMs: 0,
  lastSeenAtMs: 0,
});

function createPorts({
  workspaces,
  defaultWorkspace,
  refs = [],
  projects = [],
  realBackend = true,
  canonicalPaths = {},
}: {
  workspaces: WorkspaceRecord[];
  defaultWorkspace: WorkspaceRecord;
  refs?: WorkspaceSessionRef[];
  projects?: ProjectRef[];
  realBackend?: boolean;
  canonicalPaths?: Record<string, string>;
}): {
  ports: ChatSessionAccessPorts;
  authorizedProjectIds: string[];
  defaultWorkspaceOptions: Array<{ activate?: boolean } | undefined>;
} {
  const authorizedProjectIds: string[] = [];
  const defaultWorkspaceOptions: Array<{ activate?: boolean } | undefined> = [];
  const ports = {
    workspace: {
      getWorkspace: async (id: string) =>
        workspaces.find((candidate) => candidate.id === id),
      ensureDefaultWorkspace: async (options?: { activate?: boolean }) => {
        defaultWorkspaceOptions.push(options);
        return defaultWorkspace;
      },
      getSessionRefs: async (workspaceId: string) =>
        refs.filter((ref) => ref.workspaceId === workspaceId),
    },
    project: {
      list: async () => ({ projects }),
      resolveAuthorizedProject: async (id: string) => {
        authorizedProjectIds.push(id);
        const resolved = projects.find((candidate) => candidate.id === id);
        if (resolved === undefined) throw new Error(`Unknown project: ${id}`);
        return resolved;
      },
    },
    canonicalPath: async (filePath: string) =>
      canonicalPaths[filePath] ?? filePath,
    resolveManagedProject: async () => project("managed", "/managed"),
    isRealBackend: () => realBackend,
  } satisfies ChatSessionAccessPorts;
  return { ports, authorizedProjectIds, defaultWorkspaceOptions };
}

test("chat creation preserves explicit workspace authorization and implicit default selection", async () => {
  const defaultWorkspace = workspace("default", "default-project");
  const requestedProject = project("requested-project", "/requested");
  const defaultProject = project("default-project", "/default");
  const fixture = createPorts({
    workspaces: [workspace("named", "default-project"), defaultWorkspace],
    defaultWorkspace,
    projects: [requestedProject, defaultProject],
  });

  await assert.doesNotReject(() =>
    resolveChatCreationContext(fixture.ports, "named", "requested-project"),
  );
  assert.deepEqual(
    await resolveChatCreationContext(
      fixture.ports,
      undefined,
      "requested-project",
    ),
    { workspaceId: "default", project: requestedProject },
  );
  assert.deepEqual(fixture.defaultWorkspaceOptions, [undefined]);
  assert.deepEqual(fixture.authorizedProjectIds, [
    "requested-project",
    "requested-project",
  ]);

  await assert.rejects(
    resolveChatCreationContext(fixture.ports, "missing", "requested-project"),
    /unknown workspace/i,
  );
  const archivedFixture = createPorts({
    workspaces: [workspace("archived", undefined, 1), defaultWorkspace],
    defaultWorkspace,
    projects: [requestedProject],
  });
  await assert.rejects(
    resolveChatCreationContext(
      archivedFixture.ports,
      "archived",
      "requested-project",
    ),
    /archived/i,
  );
});

test("chat creation retains real/fake project authorization and managed fallback", async () => {
  const defaultWorkspace = workspace("default");
  const realFixture = createPorts({
    workspaces: [defaultWorkspace],
    defaultWorkspace,
  });
  assert.deepEqual(
    await resolveChatCreationContext(realFixture.ports, undefined, undefined),
    { workspaceId: "default", project: project("managed", "/managed") },
  );
  assert.deepEqual(
    await resolveWorkspaceProject(realFixture.ports, "default"),
    project("managed", "/managed"),
  );
  const unavailableDefault = workspace("unavailable", "unavailable-project");
  const repositoryFixture = createPorts({
    workspaces: [unavailableDefault],
    defaultWorkspace: unavailableDefault,
  });
  assert.deepEqual(
    await resolveWorkspaceRepositoryProject(
      repositoryFixture.ports,
      "unavailable",
    ),
    project("managed", "/managed"),
  );
  assert.deepEqual(repositoryFixture.authorizedProjectIds, [
    "unavailable-project",
  ]);

  const fakeFixture = createPorts({
    workspaces: [defaultWorkspace],
    defaultWorkspace,
    realBackend: false,
  });
  assert.deepEqual(
    await resolveChatCreationContext(fakeFixture.ports, undefined, "ignored"),
    { workspaceId: "default" },
  );
  assert.equal(
    await authorizeRendererChatProject(fakeFixture.ports, "ignored"),
    undefined,
  );
  assert.deepEqual(fakeFixture.authorizedProjectIds, []);
});

test("workspace session access uses canonical membership and reauthorizes its registered project", async () => {
  const named = workspace("named", "default-project");
  const defaultWorkspace = workspace("default");
  const registered = project("registered-project", "/projects/registered");
  const fixture = createPorts({
    workspaces: [named, defaultWorkspace],
    defaultWorkspace,
    refs: [sessionRef("named", "/sessions/owned", "/links/project")],
    projects: [registered],
    canonicalPaths: {
      "/sessions/alias": "/sessions/owned",
      "/links/project": "/projects/registered",
    },
  });

  assert.deepEqual(
    await projectForWorkspaceSession(fixture.ports, "named", "/sessions/alias"),
    registered,
  );
  assert.deepEqual(fixture.authorizedProjectIds, ["registered-project"]);
  await assert.rejects(
    projectForWorkspaceSession(fixture.ports, "default", "/sessions/alias"),
    /does not belong/i,
  );
});

test("folderless workspace sessions use managed context despite stale cwd", async () => {
  const folderless = workspace("folderless");
  const fixture = createPorts({
    workspaces: [folderless],
    defaultWorkspace: folderless,
    refs: [sessionRef("folderless", "/sessions/owned", "/old/project")],
  });

  assert.deepEqual(
    await projectForWorkspaceSession(
      fixture.ports,
      "folderless",
      "/sessions/owned",
    ),
    project("managed", "/managed"),
  );
  assert.deepEqual(fixture.authorizedProjectIds, []);
});
