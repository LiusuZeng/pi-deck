import type { ChatRuntimeEvent } from "../shared/types.js";

export interface RuntimeEventBufferScheduler {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export interface RuntimeEventBufferOptions {
  deliver(event: ChatRuntimeEvent): void;
  isRuntimeVisible(runtimeId: string): boolean;
  scheduler?: RuntimeEventBufferScheduler;
  backgroundFlushMs?: number;
  maxPendingEntries?: number;
  maxPendingBytes?: number;
}

export interface RuntimeEventBufferStats {
  pendingEntries: number;
  pendingBytes: number;
}

const DEFAULT_BACKGROUND_FLUSH_MS = 125;
const DEFAULT_MAX_PENDING_ENTRIES = 256;
const DEFAULT_MAX_PENDING_BYTES = 1_000_000;

/**
 * Bounds renderer work from dense Pi streams without changing the observable
 * order of lifecycle, error, or extension-input records.  Only non-terminal
 * message/tool updates with a stable entity id wait for a frame.
 */
export class RuntimeEventBuffer {
  private readonly deliver: (event: ChatRuntimeEvent) => void;
  private readonly isRuntimeVisible: (runtimeId: string) => boolean;
  private readonly scheduler: RuntimeEventBufferScheduler;
  private readonly backgroundFlushMs: number;
  private readonly maxPendingEntries: number;
  private readonly maxPendingBytes: number;
  private readonly pendingByRuntime = new Map<
    string,
    Map<string, PendingEvent>
  >();
  private pendingBytes = 0;
  private animationFrameHandle: number | undefined;
  private backgroundTimerHandle: number | undefined;

  constructor(options: RuntimeEventBufferOptions) {
    this.deliver = options.deliver;
    this.isRuntimeVisible = options.isRuntimeVisible;
    this.scheduler = options.scheduler ?? browserScheduler();
    this.backgroundFlushMs =
      options.backgroundFlushMs ?? DEFAULT_BACKGROUND_FLUSH_MS;
    this.maxPendingEntries =
      options.maxPendingEntries ?? DEFAULT_MAX_PENDING_ENTRIES;
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  }

  handle(event: ChatRuntimeEvent): void {
    const key = coalescingKey(event);
    if (key === undefined) {
      // A final/error/lifecycle event must observe every update that preceded
      // it for this runtime before it changes the session state.
      this.flushRuntime(event.runtimeId);
      this.deliver(event);
      return;
    }

    const runtimePending =
      this.pendingByRuntime.get(event.runtimeId) ?? new Map();
    if (!this.pendingByRuntime.has(event.runtimeId)) {
      this.pendingByRuntime.set(event.runtimeId, runtimePending);
    }
    const previous = runtimePending.get(key);
    const merged = previous
      ? mergeCoalescibleEvent(previous.event, event)
      : event;
    const bytes = estimateEventBytes(merged);
    if (previous) {
      this.pendingBytes -= previous.bytes;
    }
    runtimePending.set(key, { event: merged, bytes });
    this.pendingBytes += bytes;

    // Do not drop append deltas to meet a memory limit: make the queued work
    // visible synchronously instead. The map is therefore bounded between
    // calls even for hidden runtimes or a throttled browser frame.
    if (
      this.getStats().pendingEntries > this.maxPendingEntries ||
      this.pendingBytes > this.maxPendingBytes
    ) {
      this.flushAll();
      return;
    }
    this.schedule();
  }

  flushRuntime(runtimeId: string): void {
    const pending = this.pendingByRuntime.get(runtimeId);
    if (pending === undefined) {
      return;
    }
    this.pendingByRuntime.delete(runtimeId);
    for (const item of pending.values()) {
      this.pendingBytes -= item.bytes;
      this.deliver(item.event);
    }
    this.cancelIdleSchedules();
  }

  flushAll(): void {
    for (const runtimeId of [...this.pendingByRuntime.keys()]) {
      this.flushRuntime(runtimeId);
    }
    this.cancelIdleSchedules();
  }

  getStats(): RuntimeEventBufferStats {
    let pendingEntries = 0;
    for (const pending of this.pendingByRuntime.values()) {
      pendingEntries += pending.size;
    }
    return { pendingEntries, pendingBytes: this.pendingBytes };
  }

  dispose(): void {
    if (this.animationFrameHandle !== undefined) {
      this.scheduler.cancelAnimationFrame(this.animationFrameHandle);
      this.animationFrameHandle = undefined;
    }
    if (this.backgroundTimerHandle !== undefined) {
      this.scheduler.clearTimeout(this.backgroundTimerHandle);
      this.backgroundTimerHandle = undefined;
    }
    this.pendingByRuntime.clear();
    this.pendingBytes = 0;
  }

  private schedule(): void {
    if (this.hasVisiblePending() && this.animationFrameHandle === undefined) {
      this.animationFrameHandle = this.scheduler.requestAnimationFrame(() => {
        this.animationFrameHandle = undefined;
        this.flushWhere((runtimeId) => this.isRuntimeVisible(runtimeId));
        this.schedule();
      });
    }
    if (this.hasHiddenPending() && this.backgroundTimerHandle === undefined) {
      this.backgroundTimerHandle = this.scheduler.setTimeout(() => {
        this.backgroundTimerHandle = undefined;
        this.flushWhere((runtimeId) => !this.isRuntimeVisible(runtimeId));
        this.schedule();
      }, this.backgroundFlushMs);
    }
  }

  private flushWhere(predicate: (runtimeId: string) => boolean): void {
    for (const runtimeId of [...this.pendingByRuntime.keys()]) {
      if (predicate(runtimeId)) {
        this.flushRuntime(runtimeId);
      }
    }
  }

  private hasVisiblePending(): boolean {
    return [...this.pendingByRuntime.keys()].some((runtimeId) =>
      this.isRuntimeVisible(runtimeId),
    );
  }

  private hasHiddenPending(): boolean {
    return [...this.pendingByRuntime.keys()].some(
      (runtimeId) => !this.isRuntimeVisible(runtimeId),
    );
  }

  private cancelIdleSchedules(): void {
    if (this.pendingByRuntime.size > 0) {
      return;
    }
    if (this.animationFrameHandle !== undefined) {
      this.scheduler.cancelAnimationFrame(this.animationFrameHandle);
      this.animationFrameHandle = undefined;
    }
    if (this.backgroundTimerHandle !== undefined) {
      this.scheduler.clearTimeout(this.backgroundTimerHandle);
      this.backgroundTimerHandle = undefined;
    }
  }
}

interface PendingEvent {
  event: ChatRuntimeEvent;
  bytes: number;
}

function coalescingKey(event: ChatRuntimeEvent): string | undefined {
  if (event.type === "message_update" && !isTerminalMessageUpdate(event)) {
    const messageId = getMessageId(event);
    return messageId === undefined ? undefined : `message:${messageId}`;
  }
  if (event.type === "tool_execution_update" && !isTerminalToolUpdate(event)) {
    const toolCallId = getString(event, "toolCallId") ?? getString(event, "id");
    return toolCallId === undefined ? undefined : `tool:${toolCallId}`;
  }
  return undefined;
}

function isTerminalMessageUpdate(event: ChatRuntimeEvent): boolean {
  const assistantEventType = getString(
    getRecord(event, "assistantMessageEvent"),
    "type",
  );
  return (
    getBoolean(event, "done") === true ||
    getBoolean(event, "isError") === true ||
    getString(event, "error") !== undefined ||
    assistantEventType === "done" ||
    assistantEventType === "error"
  );
}

function isTerminalToolUpdate(event: ChatRuntimeEvent): boolean {
  const status = getString(event, "status");
  return (
    getBoolean(event, "done") === true ||
    getBoolean(event, "isError") === true ||
    getString(event, "error") !== undefined ||
    status === "completed" ||
    status === "success" ||
    status === "error" ||
    status === "failed"
  );
}

function mergeCoalescibleEvent(
  previous: ChatRuntimeEvent,
  next: ChatRuntimeEvent,
): ChatRuntimeEvent {
  if (next.type !== "message_update" || previous.type !== "message_update") {
    // Tool execution updates are replacement snapshots in the current Pi RPC
    // contract and reducer, so the newest card projection is sufficient.
    return next;
  }

  const previousDelta = getAppendDelta(previous);
  const nextDelta = getAppendDelta(next);
  if (nextDelta === undefined) {
    return next;
  }
  if (previousDelta !== undefined) {
    return withDirectDelta(next, previousDelta + nextDelta);
  }

  const previousContent = getReplacementContent(previous);
  return previousContent === undefined
    ? next
    : withReplacementContent(next, previousContent + nextDelta);
}

function getMessageId(event: ChatRuntimeEvent): string | undefined {
  return (
    getString(event, "messageId") ??
    getString(getRecord(event, "message"), "id") ??
    getString(getRecord(event, "message"), "responseId") ??
    getString(getRecord(event, "assistantMessageEvent"), "responseId") ??
    getString(
      getRecord(getRecord(event, "assistantMessageEvent"), "partial"),
      "responseId",
    )
  );
}

function getAppendDelta(event: ChatRuntimeEvent): string | undefined {
  const direct = getString(event, "delta");
  if (direct !== undefined) {
    return direct;
  }
  const assistantEvent = getRecord(event, "assistantMessageEvent");
  return getString(assistantEvent, "type") === "text_delta"
    ? getString(assistantEvent, "delta")
    : undefined;
}

function getReplacementContent(event: ChatRuntimeEvent): string | undefined {
  return (
    getString(event, "content") ??
    extractTextContent(getRecord(event, "message")?.content) ??
    extractTextContent(getRecord(event, "assistantMessageEvent")?.content) ??
    extractTextContent(getRecord(event, "assistantMessageEvent")?.partial)
  );
}

function withDirectDelta(
  event: ChatRuntimeEvent,
  delta: string,
): ChatRuntimeEvent {
  const assistantMessageEvent = getRecord(event, "assistantMessageEvent");
  return {
    ...event,
    delta,
    ...(assistantMessageEvent === undefined
      ? {}
      : {
          assistantMessageEvent: { ...assistantMessageEvent, delta: undefined },
        }),
  };
}

function withReplacementContent(
  event: ChatRuntimeEvent,
  content: string,
): ChatRuntimeEvent {
  const assistantMessageEvent = getRecord(event, "assistantMessageEvent");
  return {
    ...event,
    content,
    delta: undefined,
    ...(assistantMessageEvent === undefined
      ? {}
      : {
          assistantMessageEvent: { ...assistantMessageEvent, delta: undefined },
        }),
  };
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value.flatMap((item): string[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const value = (item as Record<string, unknown>).text;
    return typeof value === "string" ? [value] : [];
  });
  return text.length > 0 ? text.join("\n") : undefined;
}

function getRecord(
  event: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = event?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getString(
  event: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = event?.[key];
  return typeof value === "string" ? value : undefined;
}

function getBoolean(
  event: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = event?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function estimateEventBytes(event: ChatRuntimeEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}

function browserScheduler(): RuntimeEventBufferScheduler {
  return {
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle),
  };
}
