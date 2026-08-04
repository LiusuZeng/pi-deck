import {
  markWorkflowStepCompleted,
  markWorkflowStepFailed,
  markWorkflowStepQueued,
  markWorkflowStepStarted,
  readyWorkflowSteps,
} from "./workflowEngine.js";
import { renderWorkflowPrompt } from "./workflowPromptRenderer.js";
import type { WorkflowRun } from "../../shared/workflowSchemas.js";
interface WorkflowMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface WorkflowRuntimeEvent {
  type: string;
  runtimeId: string;
  [key: string]: unknown;
}

export interface WorkflowSessionSnapshot {
  runtimeId: string;
  state: {
    sessionId?: string | undefined;
    sessionFile?: string | undefined;
  };
  messages: WorkflowMessage[];
}

export interface WorkflowSchedulerDependencies {
  createSession(workspaceId: string): Promise<WorkflowSessionSnapshot>;
  prompt(runtimeId: string, text: string): Promise<void>;
  getSnapshot(runtimeId: string): Promise<WorkflowSessionSnapshot>;
  closeSession(runtimeId: string): Promise<void>;
  persist(run: WorkflowRun): Promise<WorkflowRun>;
  emit(run: WorkflowRun): void;
  now?: () => number;
}

interface ActiveStep {
  runId: string;
  stepRunId: string;
}

/**
 * Runs one ready agent step at a time. A Pi worker is deliberately treated as
 * a normal chat worker: it is created only when a step is selected and closed
 * after its terminal event, returning the capacity slot before the next step.
 */
export class WorkflowScheduler {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly activeByRuntime = new Map<string, ActiveStep>();
  private readonly pumping = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly dependencies: WorkflowSchedulerDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
  }

  async schedule(run: WorkflowRun): Promise<WorkflowRun> {
    this.runs.set(run.id, run);
    if (isTerminalRun(run)) return run;
    return this.pump(run.id);
  }

  /** Apply a newly persisted stop/retry/approval mutation from IPC. */
  async update(run: WorkflowRun): Promise<WorkflowRun> {
    this.runs.set(run.id, run);
    if (run.status === "stopped" || run.status === "failed") {
      for (const [runtimeId, active] of this.activeByRuntime) {
        if (active.runId === run.id) {
          this.activeByRuntime.delete(runtimeId);
          await this.closeQuietly(runtimeId);
        }
      }
      return run;
    }
    return this.pump(run.id);
  }

  async handleRuntimeEvent(event: WorkflowRuntimeEvent): Promise<void> {
    const active = this.activeByRuntime.get(event.runtimeId);
    if (active === undefined) {
      if (event.type === "worker_exit") await this.pumpQueuedRuns();
      return;
    }

    if (event.type === "worker_exit") {
      this.activeByRuntime.delete(event.runtimeId);
      const run = this.runs.get(active.runId);
      if (run !== undefined && !isTerminalRun(run)) {
        await this.finishFailed(
          run,
          active.stepRunId,
          "The Pi worker exited before the workflow step completed.",
        );
      }
      await this.pumpQueuedRuns();
      return;
    }
    if (event.type !== "agent_end") return;
    // Pi can emit an intermediate error agent_end before its automatic retry.
    // Keep ownership of the runtime until the authoritative terminal event.
    if (event.willRetry === true) return;
    const run = this.runs.get(active.runId);
    if (run === undefined || isTerminalRun(run)) return;

    this.activeByRuntime.delete(event.runtimeId);
    const status = typeof event.status === "string" ? event.status : undefined;
    if (status === "error" || status === "aborted") {
      await this.finishFailed(
        run,
        active.stepRunId,
        typeof event.error === "string"
          ? event.error
          : `Pi agent ended with status: ${status}.`,
      );
      await this.closeQuietly(event.runtimeId);
      await this.pumpQueuedRuns();
      return;
    }

    try {
      const snapshot = await this.dependencies.getSnapshot(event.runtimeId);
      const finalAssistant = findFinalAssistant(snapshot.messages);
      if (finalAssistant?.error === true) {
        await this.finishFailed(
          run,
          active.stepRunId,
          finalAssistant.errorMessage ?? "Pi returned an assistant error.",
        );
      } else {
        const completed = markWorkflowStepCompleted(
          run,
          active.stepRunId,
          finalAssistant?.content !== undefined
            ? { finalAnswer: finalAssistant.content }
            : {},
          this.now(),
        );
        await this.persistAndEmit(this.runsSet(completed));
        // The final answer is persisted before close can emit worker_exit.
      }
    } catch (error) {
      await this.finishFailed(
        run,
        active.stepRunId,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await this.closeQuietly(event.runtimeId);
      await this.pump(run.id);
      await this.pumpQueuedRuns();
    }
  }

  private async pump(runId: string): Promise<WorkflowRun> {
    const existing = this.runs.get(runId);
    if (existing === undefined)
      throw new Error(`Unknown workflow run: ${runId}`);
    if (this.pumping.has(runId)) return existing;
    this.pumping.add(runId);
    try {
      const run = this.runs.get(runId)!;
      if (isTerminalRun(run) || run.status === "needsAttention") return run;
      if (
        [...this.activeByRuntime.values()].some((item) => item.runId === runId)
      ) {
        return run;
      }
      const step = readyWorkflowSteps(run)[0];
      if (step === undefined) return run;
      const definition = run.templateSnapshot.steps.find(
        (candidate) => candidate.id === step.templateStepId,
      );
      if (definition === undefined) {
        return this.finishFailed(
          run,
          step.id,
          `Unknown workflow step: ${step.templateStepId}`,
        );
      }

      let session: WorkflowSessionSnapshot;
      try {
        session = await this.dependencies.createSession(run.workspaceId);
      } catch (error) {
        // Capacity is intentionally not inferred from an arbitrary error. A
        // failed allocation is safe to leave queued; startup/configuration
        // errors are actionable and must not masquerade as queued work.
        if (isCapacityError(error)) {
          const queued = markWorkflowStepQueued(run, step.id, this.now());
          return this.persistAndEmit(this.runsSet(queued));
        }
        return this.finishFailed(
          run,
          step.id,
          error instanceof Error ? error.message : String(error),
        );
      }

      const renderedPrompt = renderWorkflowPrompt({
        ...(run.templateSnapshot.context !== undefined
          ? { workflowContext: run.templateSnapshot.context }
          : {}),
        step: definition,
        run,
      });
      const started = markWorkflowStepStarted(
        run,
        step.id,
        this.now(),
        session.runtimeId,
      );
      const sessionState = session.state;
      const withMetadata: WorkflowRun = {
        ...started,
        stepRuns: started.stepRuns.map((candidate) =>
          candidate.id === step.id
            ? {
                ...candidate,
                renderedPrompt,
                ...(typeof sessionState.sessionFile === "string"
                  ? { sessionFile: sessionState.sessionFile }
                  : {}),
                ...(typeof sessionState.sessionId === "string"
                  ? { sessionId: sessionState.sessionId }
                  : {}),
              }
            : candidate,
        ),
      };
      this.activeByRuntime.set(session.runtimeId, {
        runId,
        stepRunId: step.id,
      });
      await this.persistAndEmit(this.runsSet(withMetadata));
      try {
        await this.dependencies.prompt(session.runtimeId, renderedPrompt);
      } catch (error) {
        this.activeByRuntime.delete(session.runtimeId);
        await this.finishFailed(
          withMetadata,
          step.id,
          error instanceof Error ? error.message : String(error),
        );
        await this.closeQuietly(session.runtimeId);
      }
      return this.runs.get(runId)!;
    } finally {
      this.pumping.delete(runId);
    }
  }

  private async finishFailed(
    run: WorkflowRun,
    stepRunId: string,
    error: string,
  ): Promise<WorkflowRun> {
    const failed = markWorkflowStepFailed(run, stepRunId, error, this.now());
    return this.persistAndEmit(this.runsSet(failed));
  }

  private runsSet(run: WorkflowRun): WorkflowRun {
    this.runs.set(run.id, run);
    return run;
  }

  private async persistAndEmit(run: WorkflowRun): Promise<WorkflowRun> {
    const persisted = await this.dependencies.persist(run);
    this.runs.set(persisted.id, persisted);
    this.dependencies.emit(persisted);
    return persisted;
  }

  private async closeQuietly(runtimeId: string): Promise<void> {
    try {
      await this.dependencies.closeSession(runtimeId);
    } catch {
      // The workflow result is already persisted. A dead worker is reclaimed
      // by the main runtime event router, so cleanup failure is non-fatal here.
    }
  }

  private async pumpQueuedRuns(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.stepRuns.some((step) => step.status === "queued")) {
        // A capacity release can make queued work runnable. Keep this best
        // effort and let the next explicit schedule retry if allocation still
        // fails.
        const ready = {
          ...run,
          stepRuns: run.stepRuns.map((step) =>
            step.status === "queued"
              ? { ...step, status: "ready" as const, updatedAtMs: this.now() }
              : step,
          ),
        };
        this.runsSet(ready);
        await this.pump(run.id);
      }
    }
  }
}

function isTerminalRun(run: WorkflowRun): boolean {
  return ["completed", "failed", "stopped"].includes(run.status);
}

function isCapacityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "WorkerCapacityError" ||
      (/capacity/i.test(error.message) &&
        /reached|maximum|limit/i.test(error.message)))
  );
}

interface FinalAssistant {
  content?: string;
  error?: boolean;
  errorMessage?: string;
}

function findFinalAssistant(
  messages: WorkflowMessage[],
): FinalAssistant | undefined {
  const message = [...messages]
    .reverse()
    .find((candidate) => candidate.role === "assistant");
  if (message === undefined) return undefined;
  const record = message as Record<string, unknown>;
  const content = contentText(message.content);
  const stopReason =
    typeof record.stopReason === "string" ? record.stopReason : undefined;
  const errorMessage =
    typeof record.errorMessage === "string" ? record.errorMessage : undefined;
  return {
    ...(content !== undefined ? { content } : {}),
    ...(stopReason === "error" || errorMessage !== undefined
      ? { error: true }
      : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const value = (part as Record<string, unknown>).text;
      return typeof value === "string" ? value : "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}
