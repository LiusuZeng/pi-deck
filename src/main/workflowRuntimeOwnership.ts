export type WorkflowRuntimeOwnerKind = "legacy" | "occurrence";

export type WorkflowRuntimeOwnerPhase =
  | "allocating"
  | "running"
  | "terminal"
  | "closing";

export interface WorkflowRuntimeOwnershipMetadata {
  scheduler: WorkflowRuntimeOwnerKind;
  runId: string;
  itemId: string;
  itemKind: "step" | "condition" | "occurrence";
  workspaceId: string;
  sessionFile?: string;
}

export interface WorkflowRuntimeOwnershipEntry extends WorkflowRuntimeOwnershipMetadata {
  runtimeId: string;
  phase: WorkflowRuntimeOwnerPhase;
}

export interface WorkflowRuntimeOwnershipClaim {
  readonly runtimeId: string;
  readonly metadata: WorkflowRuntimeOwnershipMetadata;
  markPhase(phase: WorkflowRuntimeOwnerPhase): void;
  updateSessionFile(sessionFile: string): void;
  release(): void;
}

/**
 * Main-process source of truth for workflow-owned Pi chat runtimes.
 *
 * Workflow schedulers use ordinary chat workers, but public renderer actions
 * must not be allowed to close/delete/reset those workers until the scheduler
 * has persisted terminal state and performed its internal close. Claims are
 * identity based: a stale claim can never release a newer owner for the same
 * runtime, and release is idempotent for scheduler cleanup paths.
 */
export class WorkflowRuntimeOwnershipRegistry {
  private readonly entries = new Map<
    string,
    WorkflowRuntimeOwnershipEntry & { token: symbol }
  >();

  claim(
    runtimeId: string,
    metadata: WorkflowRuntimeOwnershipMetadata,
    phase: WorkflowRuntimeOwnerPhase = "running",
  ): WorkflowRuntimeOwnershipClaim {
    if (this.entries.has(runtimeId)) {
      throw new Error(`Workflow runtime is already owned: ${runtimeId}`);
    }
    const token = Symbol(runtimeId);
    const claimMetadata: WorkflowRuntimeOwnershipMetadata = { ...metadata };
    this.entries.set(runtimeId, { runtimeId, ...claimMetadata, phase, token });
    let released = false;
    return {
      runtimeId,
      metadata: claimMetadata,
      markPhase: (nextPhase) => {
        if (released) return;
        const current = this.entries.get(runtimeId);
        if (current?.token === token) current.phase = nextPhase;
      },
      updateSessionFile: (sessionFile) => {
        if (released) return;
        const current = this.entries.get(runtimeId);
        if (current?.token === token) {
          current.sessionFile = sessionFile;
          claimMetadata.sessionFile = sessionFile;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(runtimeId);
        if (current?.token === token) this.entries.delete(runtimeId);
      },
    };
  }

  get(runtimeId: string): WorkflowRuntimeOwnershipEntry | undefined {
    const entry = this.entries.get(runtimeId);
    if (entry === undefined) return undefined;
    const { token: _token, ...publicEntry } = entry;
    return publicEntry;
  }

  isOwned(runtimeId: string): boolean {
    return this.entries.has(runtimeId);
  }

  hasOwnedRuntimes(): boolean {
    return this.entries.size > 0;
  }

  ownedRuntimeIds(): string[] {
    return [...this.entries.keys()];
  }

  findBySessionFile(sessionFile: string): WorkflowRuntimeOwnershipEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.sessionFile === sessionFile)
      .map(({ token: _token, ...entry }) => entry);
  }

  isSessionFileOwned(sessionFile: string): boolean {
    return this.findBySessionFile(sessionFile).length > 0;
  }

  findByWorkspace(workspaceId: string): WorkflowRuntimeOwnershipEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.workspaceId === workspaceId)
      .map(({ token: _token, ...entry }) => entry);
  }

  isWorkspaceOwned(workspaceId: string): boolean {
    return this.findByWorkspace(workspaceId).length > 0;
  }

  clear(): void {
    this.entries.clear();
  }
}
