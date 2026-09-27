export interface TimedExtensionUiRequest {
  id: string;
  timeout?: number | undefined;
}

export interface ClaimedExtensionUiRequest<TRequest> {
  runtimeId: string;
  request: TRequest;
  expiresAtMs?: number | undefined;
}

interface PendingRecord<TRequest> extends ClaimedExtensionUiRequest<TRequest> {
  timer?: ReturnType<typeof setTimeout>;
}

/** Main-owned authorization queue for extension dialogs. */
export class ExtensionUiRequestRegistry<
  TRequest extends TimedExtensionUiRequest,
> {
  private readonly requests = new Map<
    string,
    Map<string, PendingRecord<TRequest>>
  >();
  private readonly inFlightRequests = new Map<
    string,
    Map<string, ClaimedExtensionUiRequest<TRequest>>
  >();

  constructor(
    private readonly options: {
      timeoutGraceMs: number;
      onTimeout(runtimeId: string, requestId: string): void;
      now?: () => number;
      setTimer?: typeof setTimeout;
      clearTimer?: typeof clearTimeout;
    },
  ) {}

  register(runtimeId: string, request: TRequest): void {
    // Reusing an id starts a new authorization lifecycle. An older async
    // response must not be able to restore or complete over this request.
    this.deleteInFlight(runtimeId, request.id);
    const requests = this.requests.get(runtimeId) ?? new Map();
    const existing = requests.get(request.id);
    if (existing?.timer !== undefined) this.clearTimer(existing.timer);
    const expiresAtMs =
      request.timeout === undefined
        ? undefined
        : this.now() + request.timeout + this.options.timeoutGraceMs;
    const record: PendingRecord<TRequest> = {
      runtimeId,
      request,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    };
    requests.set(request.id, record);
    this.requests.set(runtimeId, requests);
    this.schedule(record);
  }

  peek(runtimeId: string, requestId: string): TRequest | undefined {
    return this.requests.get(runtimeId)?.get(requestId)?.request;
  }

  claim(
    runtimeId: string,
    requestId: string,
  ): ClaimedExtensionUiRequest<TRequest> | undefined {
    const requests = this.requests.get(runtimeId);
    const record = requests?.get(requestId);
    if (requests === undefined || record === undefined) return undefined;
    requests.delete(requestId);
    if (requests.size === 0) this.requests.delete(runtimeId);
    if (record.timer !== undefined) this.clearTimer(record.timer);
    const claimed: ClaimedExtensionUiRequest<TRequest> = {
      runtimeId,
      request: record.request,
      ...(record.expiresAtMs === undefined
        ? {}
        : { expiresAtMs: record.expiresAtMs }),
    };
    const inFlight = this.inFlightRequests.get(runtimeId) ?? new Map();
    inFlight.set(requestId, claimed);
    this.inFlightRequests.set(runtimeId, inFlight);
    return claimed;
  }

  restore(
    claimed: ClaimedExtensionUiRequest<TRequest>,
  ): "restored" | "expired" | "superseded" {
    if (!this.deleteInFlight(claimed.runtimeId, claimed.request.id, claimed)) {
      return "superseded";
    }
    if (
      claimed.expiresAtMs !== undefined &&
      claimed.expiresAtMs <= this.now()
    ) {
      this.options.onTimeout(claimed.runtimeId, claimed.request.id);
      return "expired";
    }
    const requests = this.requests.get(claimed.runtimeId) ?? new Map();
    const record: PendingRecord<TRequest> = { ...claimed };
    requests.set(claimed.request.id, record);
    this.requests.set(claimed.runtimeId, requests);
    this.schedule(record);
    return "restored";
  }

  complete(claimed: ClaimedExtensionUiRequest<TRequest>): boolean {
    return this.deleteInFlight(
      claimed.runtimeId,
      claimed.request.id,
      claimed,
    );
  }

  snapshot(runtimeId: string): TRequest[] {
    return [...(this.requests.get(runtimeId)?.values() ?? [])].map(
      ({ request }) => ({ ...request }),
    );
  }

  get pendingCount(): number {
    return [...this.requests.values()].reduce(
      (count, requests) => count + requests.size,
      0,
    );
  }

  has(runtimeId: string): boolean {
    return (
      (this.requests.get(runtimeId)?.size ?? 0) > 0 ||
      (this.inFlightRequests.get(runtimeId)?.size ?? 0) > 0
    );
  }

  get pendingCount(): number {
    let count = 0;
    for (const requests of this.requests.values()) count += requests.size;
    for (const requests of this.inFlightRequests.values()) {
      count += requests.size;
    }
    return count;
  }

  keys(): IterableIterator<string> {
    return new Set([
      ...this.requests.keys(),
      ...this.inFlightRequests.keys(),
    ]).values();
  }

  clearRuntime(runtimeId: string): void {
    const requests = this.requests.get(runtimeId);
    if (requests !== undefined) {
      for (const record of requests.values()) {
        if (record.timer !== undefined) this.clearTimer(record.timer);
      }
      this.requests.delete(runtimeId);
    }
    this.inFlightRequests.delete(runtimeId);
  }

  private deleteInFlight(
    runtimeId: string,
    requestId: string,
    expected?: ClaimedExtensionUiRequest<TRequest>,
  ): boolean {
    const requests = this.inFlightRequests.get(runtimeId);
    if (requests === undefined) return false;
    if (expected !== undefined && requests.get(requestId) !== expected) {
      return false;
    }
    const deleted = requests.delete(requestId);
    if (requests.size === 0) this.inFlightRequests.delete(runtimeId);
    return deleted;
  }

  private schedule(record: PendingRecord<TRequest>): void {
    if (record.expiresAtMs === undefined) return;
    const timer = this.setTimer(
      () => {
        const requests = this.requests.get(record.runtimeId);
        if (requests?.get(record.request.id) !== record) return;
        requests.delete(record.request.id);
        if (requests.size === 0) this.requests.delete(record.runtimeId);
        this.options.onTimeout(record.runtimeId, record.request.id);
      },
      Math.max(0, record.expiresAtMs - this.now()),
    );
    record.timer = timer;
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as ReturnType<typeof setTimeout>).unref();
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private setTimer(
    handler: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    return (this.options.setTimer ?? setTimeout)(handler, delayMs);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    (this.options.clearTimer ?? clearTimeout)(timer);
  }
}
