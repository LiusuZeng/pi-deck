/** Scheduling policy for the private child tasks of one parent session. */
export type MultitaskMode = "parallel" | "sequential";

export type ChildTaskStatus =
  | "queued"
  | "running"
  | "waiting-input"
  | "completed"
  | "failed"
  | "cancelled";

export type TerminalChildTaskStatus = Extract<
  ChildTaskStatus,
  "completed" | "failed" | "cancelled"
>;

/**
 * Text that is safe to retain and show to the parent after a child is gone.
 * Deliberately does not contain a child session/runtime identifier or the
 * child's request/input.
 */
export interface ChildTaskHandoff {
  summary?: string;
  details?: string;
}

/** Caller-assigned, stable identity and private launch request for a child. */
export interface NewChildTask<Request> {
  number: number;
  name: string;
  request: Request;
}

/** Safe state for consumers outside the child runtime. */
export interface ChildTaskSnapshot {
  number: number;
  name: string;
  status: ChildTaskStatus;
  terminalHandoff?: ChildTaskHandoff;
}

/** JSON-friendly state which can be saved without child runtime data. */
export interface MultitaskState {
  mode: MultitaskMode;
  tasks: ChildTaskSnapshot[];
}

/** A launch selected by the scheduler. This stays in the main-process domain. */
export interface ChildTaskStart<Request, Input> {
  number: number;
  name: string;
  request: Request;
  input?: Input;
}

export interface MultitaskManagerOptions {
  mode: MultitaskMode;
  /** Maximum number of tasks allowed in the queued state. */
  maxQueuedTasks: number;
}

interface StoredChildTask<Request, Input> extends ChildTaskSnapshot {
  request?: Request;
  input?: Input;
}

/** @internal Main-process-only representation; never expose this as a snapshot. */
export type InternalChildTask<Request, Input> = StoredChildTask<Request, Input>;
