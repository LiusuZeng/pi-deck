export interface TaskSessionParentRecorderAdapter {
  getRuntimeStatus(
    runtimeId: string,
  ): Promise<{ isAgentActive?: boolean; isStreaming?: boolean }>;
  prompt(runtimeId: string, input: { text: string }): Promise<void>;
}

export interface TaskSessionParentRecorderOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultTaskPromptRecordTimeoutMs = 180_000;
const defaultTaskPromptRecordPollMs = 250;

export function taskSessionPromptRecordCommand(prompt: string): string {
  const encoded = Buffer.from(JSON.stringify({ prompt }), "utf8").toString(
    "base64url",
  );
  return `/deck-task-prompt ${encoded}`;
}

export function resolveTaskSessionPromptRecordTimeoutMs(
  value = process.env.PI_DECK_TASK_PROMPT_RECORD_TIMEOUT_MS,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : defaultTaskPromptRecordTimeoutMs;
}

export async function recordTaskSessionPromptAfterParentIdle(
  adapter: TaskSessionParentRecorderAdapter,
  parentId: string,
  prompt: string,
  options: TaskSessionParentRecorderOptions = {},
): Promise<void> {
  await waitForParentRuntimeIdle(adapter, parentId, options);
  await adapter.prompt(parentId, {
    text: taskSessionPromptRecordCommand(prompt),
  });
}

export async function waitForParentRuntimeIdle(
  adapter: Pick<TaskSessionParentRecorderAdapter, "getRuntimeStatus">,
  parentId: string,
  options: TaskSessionParentRecorderOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? defaultTaskPromptRecordTimeoutMs;
  const pollMs = options.pollMs ?? defaultTaskPromptRecordPollMs;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;

  while (true) {
    const status = await adapter.getRuntimeStatus(parentId);
    if (!isParentRuntimeActive(status)) return;
    if (now() >= deadline) {
      throw new Error(
        "Timed out waiting for parent session to finish active work before recording task-session prompt.",
      );
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

function isParentRuntimeActive(status: {
  isAgentActive?: boolean;
  isStreaming?: boolean;
}): boolean {
  return status.isAgentActive === true || status.isStreaming === true;
}
