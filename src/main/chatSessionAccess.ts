import type { ProjectRef } from "../shared/types.js";
import { resolveChatCreationWorkspaceId } from "./chatWorkspaceOwnership.js";
import type { ProjectStore } from "./projects/projectStore.js";
import type {
  WorkspaceRecord,
  WorkspaceStore,
} from "./workspaces/workspaceStore.js";

/** The workspace operations needed to make chat session access decisions. */
export type ChatSessionAccessWorkspacePort = Pick<
  WorkspaceStore,
  "ensureDefaultWorkspace" | "getSessionRefs" | "getWorkspace"
>;

/** The registered-project operations needed to authorize chat access. */
export type ChatSessionAccessProjectPort = Pick<
  ProjectStore,
  "list" | "resolveAuthorizedProject"
>;

/**
 * Main-process policies deliberately injected into the otherwise decision-only
 * chat session access seam. The managed-project policy retains its filesystem
 * safety checks in main, while this module only selects when to use it.
 */
export interface ChatSessionAccessPorts {
  workspace: ChatSessionAccessWorkspacePort;
  project: ChatSessionAccessProjectPort;
  canonicalPath(filePath: string): Promise<string>;
  resolveManagedProject(): Promise<ProjectRef>;
  isRealBackend(): boolean;
}

export async function requireOpenChatWorkspace(
  ports: ChatSessionAccessPorts,
  workspaceId: string,
): Promise<WorkspaceRecord> {
  const workspace = await ports.workspace.getWorkspace(workspaceId);
  if (workspace === undefined) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  if (workspace.archivedAtMs !== undefined) {
    throw new Error(`Workspace is archived: ${workspaceId}`);
  }
  return workspace;
}

/** Authorize an opaque renderer project ID only for the real backend. */
export async function authorizeRendererChatProject(
  ports: ChatSessionAccessPorts,
  projectId?: string,
): Promise<ProjectRef | undefined> {
  if (projectId === undefined || !ports.isRealBackend()) {
    return undefined;
  }
  return ports.project.resolveAuthorizedProject(projectId);
}

export async function resolveWorkspaceProject(
  ports: ChatSessionAccessPorts,
  workspaceId: string,
  requestedProjectId?: string,
): Promise<ProjectRef> {
  const workspace = await requireOpenChatWorkspace(ports, workspaceId);
  const projectId = requestedProjectId ?? workspace.defaultProjectId;
  if (projectId === undefined) {
    return ports.resolveManagedProject();
  }
  return ports.project.resolveAuthorizedProject(projectId);
}

export async function resolveWorkspaceRepositoryProject(
  ports: ChatSessionAccessPorts,
  workspaceId: string,
): Promise<ProjectRef> {
  const workspace = await requireOpenChatWorkspace(ports, workspaceId);
  if (workspace.defaultProjectId !== undefined) {
    const defaultProject = await ports.project
      .resolveAuthorizedProject(workspace.defaultProjectId)
      .catch(() => undefined);
    if (defaultProject !== undefined) {
      return defaultProject;
    }
  }
  return ports.resolveManagedProject();
}

export async function resolveChatCreationContext(
  ports: ChatSessionAccessPorts,
  requestedWorkspaceId: string | undefined,
  requestedProjectId: string | undefined,
): Promise<{ workspaceId: string; project?: ProjectRef }> {
  if (requestedWorkspaceId !== undefined) {
    const workspaceId = resolveChatCreationWorkspaceId(
      requestedWorkspaceId,
      undefined,
    );
    return {
      workspaceId,
      project: await resolveWorkspaceProject(
        ports,
        workspaceId,
        requestedProjectId,
      ),
    };
  }

  // Compatibility callers without a workspace must use the persisted default,
  // not whichever named workspace happens to be active. Do not activate it:
  // fallback ownership must not change migration/relaunch selection state.
  const requestedProject = await authorizeRendererChatProject(
    ports,
    requestedProjectId,
  );
  const defaultWorkspace = await ports.workspace.ensureDefaultWorkspace();
  const workspaceId = resolveChatCreationWorkspaceId(
    undefined,
    defaultWorkspace.id,
  );
  return {
    workspaceId,
    ...(requestedProject !== undefined
      ? { project: requestedProject }
      : ports.isRealBackend()
        ? { project: await resolveWorkspaceProject(ports, workspaceId) }
        : {}),
  };
}

export async function projectForWorkspaceSession(
  ports: ChatSessionAccessPorts,
  workspaceId: string,
  sessionFile: string,
): Promise<ProjectRef> {
  const workspace = await requireOpenChatWorkspace(ports, workspaceId);
  const canonicalSessionFile = await ports.canonicalPath(sessionFile);
  const ref = (await ports.workspace.getSessionRefs(workspace.id)).find(
    (item) => item.sessionFile === canonicalSessionFile,
  );
  if (ref === undefined) {
    throw new Error("Session does not belong to this workspace.");
  }
  const managedProject = await ports.resolveManagedProject();
  // A workspace without a default project is intentionally directory
  // independent. Imported/legacy sessions can retain an old cwd in their Pi
  // header even after their former project record is gone; requiring the user
  // to reopen that folder would make the folderless workspace unusable. Run
  // those sessions in Pi Deck's managed context instead. Directory-backed
  // workspaces continue through the registered-project authorization path
  // below.
  if (workspace.defaultProjectId === undefined) {
    return managedProject;
  }
  const refCwd = ref.cwd ? await ports.canonicalPath(ref.cwd) : undefined;
  if (refCwd === managedProject.canonicalPath) {
    return managedProject;
  }
  const projects = await ports.project.list();
  const project = refCwd
    ? projects.projects.find((candidate) => candidate.canonicalPath === refCwd)
    : projects.projects.find(
        (candidate) => candidate.id === workspace.defaultProjectId,
      );
  if (project === undefined) {
    throw new Error(
      "The session working folder is not registered. Reopen that folder before resuming this session.",
    );
  }
  return ports.project.resolveAuthorizedProject(project.id);
}
