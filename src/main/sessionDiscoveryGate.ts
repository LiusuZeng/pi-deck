import fs from "node:fs/promises";
import path from "node:path";

export type SessionAttachmentLease = {
  generation: number;
  release: () => void;
};

export type SessionAttachmentQueueEntry = {
  entered: Promise<SessionAttachmentLease>;
};

/**
 * FIFO transaction boundary shared by session attachment and repository
 * discovery. Queueing is synchronous, so callers can publish deterministic
 * evidence that they are waiting without leaving a gap for a later entrant.
 */
export class SessionAttachmentGate {
  private tail: Promise<void> = Promise.resolve();

  enqueue(generation: number): SessionAttachmentQueueEntry {
    const previous = this.tail;
    let releaseTurn!: () => void;
    let released = false;
    this.tail = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    return {
      entered: previous.then(() => ({
        generation,
        release: () => {
          if (released) return;
          released = true;
          releaseTurn();
        },
      })),
    };
  }

  async enter(generation: number): Promise<SessionAttachmentLease> {
    return this.enqueue(generation).entered;
  }
}

export type SessionDiscoveryKind = "project" | "workspace" | "unassigned";

/** Selects publishable candidates without mutating or otherwise claiming them. */
export async function filterBlockedSessionCandidates<
  T extends { sessionFile: string },
>(
  candidates: readonly T[],
  blocks: (sessionFile: string) => Promise<boolean>,
): Promise<{ attachable: T[]; blocked: T[] }> {
  const attachable: T[] = [];
  const blocked: T[] = [];
  for (const candidate of candidates) {
    ((await blocks(candidate.sessionFile)) ? blocked : attachable).push(
      candidate,
    );
  }
  return { attachable, blocked };
}

type SessionDiscoveryEnvironment = Readonly<
  Partial<
    Record<"PI_DECK_E2E_TEST" | "PI_DECK_TEST_DISCOVERY_GATE_DIR", string>
  >
>;

/**
 * Runs a complete scan/filter/admission/persistence transaction under the
 * attachment gate. `assertActive` is intentionally supplied to the operation:
 * potentially long scans must recheck it immediately before every admission
 * or cache write, rather than catching cancellation and persisting stale work.
 */
export class SessionDiscoveryGate {
  constructor(
    private readonly attachmentGate: SessionAttachmentGate,
    private readonly environment: SessionDiscoveryEnvironment = process.env,
    private readonly onMarkerWritten?: (
      kind: SessionDiscoveryKind,
      phase: "queued" | "entered",
    ) => void,
  ) {}

  async run<T>(options: {
    kind?: SessionDiscoveryKind;
    generation: number;
    assertActive: () => void;
    operation: (assertActive: () => void) => Promise<T>;
  }): Promise<T> {
    const queued = this.attachmentGate.enqueue(options.generation);
    let markerError: unknown;
    try {
      await this.writeMarker(options.kind, "queued");
    } catch (error) {
      // The queue entry already exists. Acquire and release it below even when
      // test instrumentation fails, otherwise one bad marker deadlocks the app.
      markerError = error;
    }

    const lease = await queued.entered;
    try {
      if (markerError !== undefined) throw markerError;
      await this.writeMarker(options.kind, "entered");
      options.assertActive();
      const result = await options.operation(options.assertActive);
      options.assertActive();
      return result;
    } finally {
      lease.release();
    }
  }

  private async writeMarker(
    kind: SessionDiscoveryKind | undefined,
    phase: "queued" | "entered",
  ): Promise<void> {
    const directory =
      this.environment.PI_DECK_E2E_TEST === "1"
        ? this.environment.PI_DECK_TEST_DISCOVERY_GATE_DIR
        : undefined;
    if (kind === undefined || directory === undefined || directory === "") {
      return;
    }
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${kind}-${phase}`), `${phase}\n`);
    this.onMarkerWritten?.(kind, phase);
  }
}
