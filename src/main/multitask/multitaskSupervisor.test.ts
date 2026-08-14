import { describe, expect, it } from "vitest";
import {
  MultitaskSupervisor,
  type ChildWorkerCallbacks,
  type ParentTaskNotification,
} from "./multitaskSupervisor.js";

type Worker = {
  callbacks: ChildWorkerCallbacks;
  close: () => void;
  provideInput: (input: string) => void;
};

function setup(capacity = 2) {
  const notifications: ParentTaskNotification<string>[] = [];
  const workers = new Map<number, Worker>();
  let live = 0;
  const supervisor = new MultitaskSupervisor<string, string, Worker>({
    hasCapacity: () => live < capacity,
    createWorker: ({ task, callbacks }) => {
      live += 1;
      const worker: Worker = {
        callbacks,
        close: () => {
          live -= 1;
        },
        provideInput: () => undefined,
      };
      workers.set(task.number, worker);
      return worker;
    },
    onParentNotification: (notification) => notifications.push(notification),
    maxBriefLength: 10,
  });
  supervisor.addParent("parent", { mode: "parallel", maxQueuedTasks: 3 });
  return { supervisor, workers, notifications };
}

describe("MultitaskSupervisor", () => {
  it("starts bounded briefs under capacity and exposes no brief or worker handle", async () => {
    const { supervisor, workers, notifications } = setup(1);
    supervisor.enqueue("parent", {
      number: 1,
      name: "one",
      brief: { text: "private" },
    });
    supervisor.enqueue("parent", {
      number: 2,
      name: "two",
      brief: { text: "also" },
    });
    await supervisor.schedule("parent");

    expect(workers.has(1)).toBe(true);
    expect(supervisor.snapshots("parent")).toEqual([
      { number: 1, name: "one", status: "running" },
      { number: 2, name: "two", status: "queued" },
    ]);
    expect(JSON.stringify(notifications)).not.toContain("private");
    expect(() =>
      supervisor.enqueue("parent", {
        number: 3,
        name: "long",
        brief: { text: "01234567890" },
      }),
    ).toThrow(/exceeds/);
  });

  it("captures terminal handoffs, closes workers, and starts the next queued child", async () => {
    const { supervisor, workers, notifications } = setup(1);
    supervisor.enqueue("parent", {
      number: 1,
      name: "one",
      brief: { text: "a" },
    });
    supervisor.enqueue("parent", {
      number: 2,
      name: "two",
      brief: { text: "b" },
    });
    await supervisor.schedule("parent");
    workers.get(1)!.callbacks.completed({ summary: "safe result" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await supervisor.schedule("parent");

    expect(workers.get(1)).toBeDefined(); // Factory test registry is not supervisor state.
    expect(supervisor.snapshots("parent")).toEqual([
      { number: 1, name: "one", status: "completed" },
      { number: 2, name: "two", status: "running" },
    ]);
    expect(notifications).toContainEqual({
      type: "task-handoff",
      parentId: "parent",
      task: { number: 1, name: "one", status: "completed" },
      handoff: { summary: "safe result" },
    });
  });

  it("captures failures as terminal handoffs and closes the failed child", async () => {
    const { supervisor, workers } = setup();
    supervisor.enqueue("parent", {
      number: 1,
      name: "one",
      brief: { text: "a" },
    });
    await supervisor.schedule("parent");
    let closed = false;
    workers.get(1)!.close = () => {
      closed = true;
    };

    workers.get(1)!.callbacks.failed({ summary: "safe failure" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(true);
    expect(supervisor.snapshots("parent")[0]).toEqual({
      number: 1,
      name: "one",
      status: "failed",
    });
  });

  it("routes input by task number entirely through its retained worker", async () => {
    const { supervisor, workers } = setup();
    let input: string | undefined;
    supervisor.enqueue("parent", {
      number: 1,
      name: "one",
      brief: { text: "a" },
    });
    await supervisor.schedule("parent");
    workers.get(1)!.provideInput = (value) => {
      input = value;
    };
    workers.get(1)!.callbacks.inputNeeded();
    expect(supervisor.snapshots("parent")[0]).toEqual({
      number: 1,
      name: "one",
      status: "waiting-input",
    });

    await supervisor.provideInput("parent", 1, "main-only answer");
    expect(input).toBe("main-only answer");
    expect(supervisor.snapshots("parent")[0].status).toBe("running");
  });

  it("resume closes live children and turns live saved tasks into safe interruption handoffs", async () => {
    const { supervisor, workers } = setup();
    supervisor.enqueue("parent", {
      number: 1,
      name: "one",
      brief: { text: "a" },
    });
    await supervisor.schedule("parent");
    let closed = false;
    workers.get(1)!.close = () => {
      closed = true;
    };

    await supervisor.resume("parent");
    expect(closed).toBe(true);
    expect(supervisor.snapshots("parent")).toEqual([
      { number: 1, name: "one", status: "cancelled" },
    ]);
    expect(
      supervisor.exportState("parent").tasks[0].terminalHandoff,
    ).toMatchObject({
      summary: "Child task interrupted during session resume.",
    });
  });
});
