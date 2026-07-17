export class WorkerCapacityError extends Error {
  constructor(readonly maxRunningSessions: number) {
    super(
      `Maximum running session capacity (${maxRunningSessions}) reached. Close a session and try again.`,
    );
    this.name = "WorkerCapacityError";
  }
}

/**
 * Serializes worker allocation and reserves a slot while a worker is being
 * created. The worker count callback must include every live worker, including
 * workers held warm for a future session.
 */
export class WorkerCapacity {
  private reservations = 0;
  private allocationTail: Promise<void> = Promise.resolve();

  constructor(private readonly workerCount: () => number) {}

  async allocate<T>(
    getMaxRunningSessions: () => Promise<number>,
    create: () => Promise<T> | T,
  ): Promise<T> {
    const releaseAllocation = await this.enterAllocation();
    let reserved = false;
    try {
      // Read this inside the allocation critical section so a settings update
      // affects the very next creation attempt rather than a cached value.
      const maxRunningSessions = await getMaxRunningSessions();
      if (this.workerCount() + this.reservations >= maxRunningSessions) {
        throw new WorkerCapacityError(maxRunningSessions);
      }
      this.reservations += 1;
      reserved = true;
      return await create();
    } finally {
      if (reserved) {
        this.reservations -= 1;
      }
      releaseAllocation();
    }
  }

  private async enterAllocation(): Promise<() => void> {
    const previous = this.allocationTail;
    let release: (() => void) | undefined;
    this.allocationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return (): void => release?.();
  }
}
