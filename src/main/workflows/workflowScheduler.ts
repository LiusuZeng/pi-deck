import {
  markWorkflowStepCompleted,
  markWorkflowStepFailed,
  markWorkflowStepQueued,
  markWorkflowStepStarted,
  readyWorkflowSteps,
  resolveWorkflowCondition,
  failWorkflowCondition,
} from "./workflowEngine.js";
import { renderWorkflowPrompt } from "./workflowPromptRenderer.js";
import type {
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowTransition,
} from "../../shared/workflowSchemas.js";
import { z } from "zod";
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
  configureSession?(
    runtimeId: string,
    settings: { model?: { provider?: string; modelId?: string }; thinkingLevel?: string },
  ): Promise<void>;
  getRun?(runId: string): Promise<WorkflowRun>;
  persist(run: WorkflowRun): Promise<WorkflowRun>;
  emit(run: WorkflowRun): void;
  now?: () => number;
}

interface ActiveStep {
  runId: string;
  /** Scheduler mutation generation that owns this runtime. */
  version: number;
  kind: "step" | "condition";
  stepRunId?: string;
  transitionRunId?: string;
}

type RuntimeOwnership = { runtimeId: string; active: ActiveStep };

const conditionJudgeSchema = z.object({
  decision: z.enum(["yes", "no", "unsure"]),
  rationale: z.string().min(1).max(4_000),
}).strict();

/**
 * Runs one ready agent step at a time. A Pi worker is deliberately treated as
 * a normal chat worker: it is created only when a step is selected and closed
 * after its terminal event, returning the capacity slot before the next step.
 */
export class WorkflowScheduler {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly activeByRuntime = new Map<string, ActiveStep>();
  private readonly pumping = new Set<string>();
  private readonly mutationVersions = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly dependencies: WorkflowSchedulerDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
  }

  async schedule(run: WorkflowRun): Promise<WorkflowRun> {
    this.runs.set(run.id, run);
    this.mutationVersions.set(run.id, (this.mutationVersions.get(run.id) ?? 0) + 1);
    if (isTerminalRun(run)) return run;
    return this.pump(run.id);
  }

  /** Apply a newly persisted stop/retry/approval mutation from IPC. */
  async update(run: WorkflowRun): Promise<WorkflowRun> {
    this.runs.set(run.id, run);
    this.mutationVersions.set(run.id, (this.mutationVersions.get(run.id) ?? 0) + 1);
    // Any externally persisted mutation supersedes the runtime that was
    // started from the previous generation. This also prevents a retry or
    // approval update from leaving an old worker able to report completion.
    for (const [runtimeId, active] of this.activeByRuntime) {
      if (active.runId === run.id) {
        this.activeByRuntime.delete(runtimeId);
        await this.closeQuietly(runtimeId);
      }
    }
    if (run.status === "stopped" || run.status === "failed") return run;
    return this.pump(run.id);
  }

  async handleRuntimeEvent(event: WorkflowRuntimeEvent): Promise<void> {
    const active = this.activeByRuntime.get(event.runtimeId);
    if (active === undefined) {
      if (event.type === "worker_exit") await this.pumpQueuedRuns();
      return;
    }

    // Pi can emit an intermediate error agent_end before its automatic retry.
    // Keep ownership of the runtime until the authoritative terminal event.
    if (event.type === "agent_end" && event.willRetry === true) return;
    const ownership: RuntimeOwnership = { runtimeId: event.runtimeId, active };
    const run = await this.getOwnedRun(ownership);
    if (run === undefined) return;

    if (event.type === "worker_exit") {
      try {
        if (active.kind === "step" && active.stepRunId !== undefined) {
          await this.finishFailed(
            run,
            active.stepRunId,
            "The Pi worker exited before the workflow step completed.",
            ownership,
          );
        } else if (active.transitionRunId !== undefined) {
          await this.finishConditionFailed(
            run,
            active.transitionRunId,
            "The Pi worker exited before the condition judge completed.",
            ownership,
          );
        }
      } finally {
        const released = await this.releaseOwnership(ownership);
        if (released) await this.closeQuietly(event.runtimeId);
      }
      await this.pumpQueuedRuns();
      return;
    }
    if (event.type !== "agent_end") return;

    const status = typeof event.status === "string" ? event.status : undefined;
    if (status === "error" || status === "aborted") {
      try {
        const current = await this.getOwnedRun(ownership);
        if (current === undefined) return;
        if (active.kind === "step" && active.stepRunId !== undefined) {
          await this.finishFailed(
            current,
            active.stepRunId,
            typeof event.error === "string"
              ? event.error
              : `Pi agent ended with status: ${status}.`,
            ownership,
          );
        } else if (active.transitionRunId !== undefined) {
          await this.finishConditionFailed(
            current,
            active.transitionRunId,
            typeof event.error === "string"
              ? event.error
              : `Condition judge ended with status: ${status}.`,
            ownership,
          );
        }
      } finally {
        const released = await this.releaseOwnership(ownership);
        if (released) await this.closeQuietly(event.runtimeId);
      }
      await this.pumpQueuedRuns();
      return;
    }

    try {
      const snapshot = await this.dependencies.getSnapshot(event.runtimeId);
      // A stop/retry/update may have removed ownership while the snapshot was
      // being read. Never apply an old completion to that newer mutation.
      const current = await this.getOwnedRun(ownership);
      if (current === undefined) return;
      const finalAssistant = findFinalAssistant(snapshot.messages);
      if (active.kind === "condition" && active.transitionRunId !== undefined) {
        if (finalAssistant?.error === true || finalAssistant?.content === undefined) {
          await this.finishConditionFailed(
            current,
            active.transitionRunId,
            finalAssistant?.errorMessage ?? "Condition judge returned no JSON result.",
            ownership,
          );
        } else {
          const parsed = parseConditionDecision(finalAssistant.content);
          if (parsed === undefined) {
            await this.finishConditionFailed(
              current,
              active.transitionRunId,
              "Condition judge returned malformed output; expected strict yes/no/unsure JSON.",
              ownership,
            );
          } else {
            const resolved = resolveWorkflowCondition(
              current,
              active.transitionRunId,
              parsed.decision,
              parsed.rationale,
              this.now(),
            );
            await this.persistAndEmit(this.runsSet(resolved), ownership);
          }
        }
      } else if (active.stepRunId !== undefined) {
        if (finalAssistant?.error === true) {
          await this.finishFailed(
            current,
            active.stepRunId,
            finalAssistant.errorMessage ?? "Pi returned an assistant error.",
            ownership,
          );
        } else {
          const transcript = renderWorkflowTranscript(snapshot.messages);
          const completed = markWorkflowStepCompleted(
            current,
            active.stepRunId,
            {
              ...(finalAssistant?.content !== undefined
                ? { finalAnswer: finalAssistant.content }
                : {}),
              ...(transcript !== undefined ? { transcript } : {}),
            },
            this.now(),
          );
          await this.persistAndEmit(this.runsSet(completed), ownership);
          // The final answer is persisted before close can emit worker_exit.
        }
      }
    } catch (error) {
      const current = await this.getOwnedRun(ownership);
      if (current !== undefined) {
        if (active.kind === "condition" && active.transitionRunId !== undefined) {
          await this.finishConditionFailed(
            current,
            active.transitionRunId,
            error instanceof Error ? error.message : String(error),
            ownership,
          );
        } else if (active.stepRunId !== undefined) {
          await this.finishFailed(
            current,
            active.stepRunId,
            error instanceof Error ? error.message : String(error),
            ownership,
          );
        }
      }
    } finally {
      const released = await this.releaseOwnership(ownership);
      if (released) {
        await this.closeQuietly(event.runtimeId);
        await this.pump(run.id);
        await this.pumpQueuedRuns();
      }
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
      const conditionEntry = step === undefined
        ? run.transitionRuns.find((candidate) => candidate.status === "evaluating")
        : undefined;
      if (step === undefined && conditionEntry === undefined) return run;
      const definition = step === undefined
        ? undefined
        : run.templateSnapshot.steps.find(
            (candidate) => candidate.id === step.templateStepId,
          );
      if (step !== undefined && definition === undefined) {
        return this.finishFailed(
          run,
          step.id,
          `Unknown workflow step: ${step.templateStepId}`,
        );
      }
      const version = this.mutationVersions.get(runId) ?? 0;

      let session: WorkflowSessionSnapshot;
      try {
        session = await this.dependencies.createSession(run.workspaceId);
      } catch (error) {
        // Capacity is intentionally not inferred from an arbitrary error. A
        // failed allocation is safe to leave queued; startup/configuration
        // errors are actionable and must not masquerade as queued work.
        if (isCapacityError(error) && step !== undefined) {
          const queued = markWorkflowStepQueued(run, step.id, this.now());
          return this.persistAndEmit(this.runsSet(queued));
        }
        if (step !== undefined) {
          return this.finishFailed(
            run,
            step.id,
            error instanceof Error ? error.message : String(error),
          );
        }
        return this.finishConditionFailed(
          run,
          conditionEntry!.id,
          error instanceof Error ? error.message : String(error),
        );
      }

      // Stopping a run can race worker allocation. Re-read persisted state and
      // check the mutation generation before recording any runtime metadata.
      const latest = this.dependencies.getRun
        ? await this.dependencies.getRun(runId)
        : this.runs.get(runId);
      if (latest === undefined || latest.status === "stopped" || version !== (this.mutationVersions.get(runId) ?? 0)) {
        await this.closeQuietly(session.runtimeId);
        if (latest !== undefined) this.runsSet(latest);
        return latest ?? run;
      }

      const sessionState = session.state;
      if (step !== undefined && definition !== undefined) {
        let renderedPrompt: string;
        try {
          renderedPrompt = renderWorkflowPrompt({
            ...(run.templateSnapshot.context !== undefined
              ? { workflowContext: run.templateSnapshot.context }
              : {}),
            step: definition,
            run: latest,
          });
        } catch (error) {
          await this.closeQuietly(session.runtimeId);
          return this.finishFailed(
            latest,
            step.id,
            error instanceof Error ? error.message : String(error),
          );
        }
        const started = markWorkflowStepStarted(
          latest,
          step.id,
          this.now(),
          session.runtimeId,
        );
        const withMetadata: WorkflowRun = {
          ...started,
          stepRuns: started.stepRuns.map((candidate) =>
            candidate.id === step.id
              ? {
                  ...candidate,
                  renderedPrompt,
                  ...(typeof sessionState.sessionFile === "string" ? { sessionFile: sessionState.sessionFile } : {}),
                  ...(typeof sessionState.sessionId === "string" ? { sessionId: sessionState.sessionId } : {}),
                }
              : candidate,
          ),
        };
        const active: ActiveStep = {
          runId,
          version,
          kind: "step",
          stepRunId: step.id,
        };
        this.activeByRuntime.set(session.runtimeId, active);
        await this.persistAndEmit(this.runsSet(withMetadata), { runtimeId: session.runtimeId, active });
        try {
          const owned = await this.getOwnedRun({ runtimeId: session.runtimeId, active });
          if (owned === undefined) return this.runs.get(runId)!;
          await this.applyStepSettings(session.runtimeId, owned, definition);
          await this.dependencies.prompt(session.runtimeId, renderedPrompt);
        } catch (error) {
          const ownership = { runtimeId: session.runtimeId, active };
          const owned = await this.getOwnedRun(ownership);
          if (owned !== undefined) {
            await this.finishFailed(owned, step.id, error instanceof Error ? error.message : String(error), ownership);
          }
          if (await this.releaseOwnership(ownership)) await this.closeQuietly(session.runtimeId);
        }
      } else {
        const transition = run.templateSnapshot.transitions.find(
          (candidate): candidate is Extract<WorkflowTransition, { kind: "condition" }> =>
            candidate.id === run.transitionRuns.find((item) => item.id === conditionEntry!.id)?.templateTransitionId && candidate.kind === "condition",
        );
        if (transition === undefined) {
          await this.closeQuietly(session.runtimeId);
          return this.finishConditionFailed(latest, conditionEntry!.id, "Unknown condition transition.");
        }
        const source = latest.stepRuns.find((candidate) => candidate.templateStepId === transition.fromStepId);
        const prompt = renderConditionJudgePrompt(transition, source?.finalAnswer);
        const active: ActiveStep = {
          runId,
          version,
          kind: "condition",
          transitionRunId: conditionEntry!.id,
        };
        this.activeByRuntime.set(session.runtimeId, active);
        try {
          const owned = await this.getOwnedRun({ runtimeId: session.runtimeId, active });
          if (owned === undefined) return this.runs.get(runId)!;
          await this.dependencies.prompt(session.runtimeId, prompt);
        } catch (error) {
          const ownership = { runtimeId: session.runtimeId, active };
          const owned = await this.getOwnedRun(ownership);
          if (owned !== undefined) {
            await this.finishConditionFailed(owned, conditionEntry!.id, error instanceof Error ? error.message : String(error), ownership);
          }
          if (await this.releaseOwnership(ownership)) await this.closeQuietly(session.runtimeId);
        }
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
    ownership?: RuntimeOwnership,
  ): Promise<WorkflowRun> {
    const failed = markWorkflowStepFailed(run, stepRunId, error, this.now());
    return this.persistAndEmit(this.runsSet(failed), ownership);
  }

  private async finishConditionFailed(
    run: WorkflowRun,
    transitionRunId: string,
    error: string,
    ownership?: RuntimeOwnership,
  ): Promise<WorkflowRun> {
    const failed = failWorkflowCondition(run, transitionRunId, error, this.now());
    return this.persistAndEmit(this.runsSet(failed), ownership);
  }

  private async applyStepSettings(
    runtimeId: string,
    run: WorkflowRun,
    definition: WorkflowStepDefinition,
  ): Promise<void> {
    const model = definition.modelOverride ?? run.templateSnapshot.defaultModel;
    const thinkingLevel = definition.thinkingOverride ?? run.templateSnapshot.defaultThinkingLevel;
    if (model === undefined && thinkingLevel === undefined) return;
    if (this.dependencies.configureSession === undefined) {
      throw new Error("Workflow step settings cannot be applied by this Pi runtime.");
    }
    await this.dependencies.configureSession(runtimeId, {
      ...(model !== undefined
        ? {
            model: {
              ...(model.provider !== undefined ? { provider: model.provider } : {}),
              ...(model.modelId !== undefined ? { modelId: model.modelId } : {}),
            },
          }
        : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    });
  }

  private runsSet(run: WorkflowRun): WorkflowRun {
    this.runs.set(run.id, run);
    return run;
  }

  private async persistAndEmit(
    run: WorkflowRun,
    ownership?: RuntimeOwnership,
  ): Promise<WorkflowRun> {
    if (ownership !== undefined && (await this.getOwnedRun(ownership)) === undefined) {
      return this.runs.get(run.id) ?? run;
    }
    const persisted = await this.dependencies.persist(run);
    // The persist call may have yielded to a stop/retry/update. Do not publish
    // or retain a terminal result that no longer owns the runtime mutation.
    if (ownership !== undefined && !this.isCurrentOwner(ownership)) {
      return this.runs.get(run.id) ?? persisted;
    }
    this.runs.set(persisted.id, persisted);
    this.dependencies.emit(persisted);
    return persisted;
  }

  private isCurrentOwner(ownership: RuntimeOwnership): boolean {
    return (
      this.activeByRuntime.get(ownership.runtimeId) === ownership.active &&
      (this.mutationVersions.get(ownership.active.runId) ?? 0) === ownership.active.version
    );
  }

  private async getOwnedRun(ownership: RuntimeOwnership): Promise<WorkflowRun | undefined> {
    if (!this.isCurrentOwner(ownership)) return undefined;
    const current = this.dependencies.getRun
      ? await this.dependencies.getRun(ownership.active.runId)
      : this.runs.get(ownership.active.runId);
    if (!this.isCurrentOwner(ownership) || current === undefined || isTerminalRun(current)) {
      return undefined;
    }
    this.runsSet(current);
    return current;
  }

  private async releaseOwnership(ownership: RuntimeOwnership): Promise<boolean> {
    if (!this.isCurrentOwner(ownership)) return false;
    this.activeByRuntime.delete(ownership.runtimeId);
    return true;
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

function renderConditionJudgePrompt(
  transition: Extract<WorkflowTransition, { kind: "condition" }>,
  sourceAnswer: string | undefined,
): string {
  return [
    "You are a workflow condition judge.",
    "Answer the question using only the completed agent result below.",
    'Return exactly one JSON object with exactly these keys: {"decision":"yes"|"no"|"unsure","rationale":"brief explanation"}.',
    "Do not include markdown, code fences, or any other text.",
    `Question: ${transition.question}`,
    `Completed agent result: ${sourceAnswer ?? "(no result)"}`,
  ].join("\n");
}

function parseConditionDecision(content: string): { decision: "yes" | "no" | "unsure"; rationale: string } | undefined {
  try {
    const parsed = conditionJudgeSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
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

/** Maximum persisted size for a step handoff transcript. */
export const WORKFLOW_TRANSCRIPT_MAX_CHARS = 32_000;
const WORKFLOW_TRANSCRIPT_MAX_MESSAGES = 200;

/**
 * Convert the Pi snapshot into a compact, human-readable handoff. Tool calls
 * and other non-text blocks are intentionally omitted because they cannot be
 * rendered reliably across Pi runtimes. An absent result remains absent so a
 * transcript prompt is blocked rather than claiming unsupported data.
 */
export function renderWorkflowTranscript(
  messages: WorkflowMessage[],
): string | undefined {
  const entries = messages.flatMap((message) => {
    const content = contentText(message.content);
    if (content === undefined || content.trim().length === 0) return [];
    const role = message.role.trim() || "unknown";
    return [`${role}: ${content}`];
  });
  if (entries.length === 0) return undefined;

  const omittedMessages = entries.length > WORKFLOW_TRANSCRIPT_MAX_MESSAGES;
  let transcript = entries.slice(-WORKFLOW_TRANSCRIPT_MAX_MESSAGES).join("\n");
  if (omittedMessages) transcript = `[Earlier messages omitted]\n${transcript}`;
  if (transcript.length <= WORKFLOW_TRANSCRIPT_MAX_CHARS) return transcript;

  const marker = "[Earlier transcript omitted]\n";
  return `${marker}${transcript.slice(-(WORKFLOW_TRANSCRIPT_MAX_CHARS - marker.length))}`;
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
