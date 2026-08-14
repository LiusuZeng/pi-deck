import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DelegationBridgeServer } from "./delegationBridgeServer.js";
import { MultitaskSupervisor, type ChildWorkerCallbacks } from "./multitaskSupervisor.js";

const directories: string[] = [];
const servers: DelegationBridgeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function nextLine(socket: net.Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function bridge() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdb-"));
  directories.push(directory);
  const server = new DelegationBridgeServer({ stateDir: directory });
  servers.push(server);
  return { server, credentials: await server.start() };
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("DelegationBridgeServer", () => {
  it("authenticates a capability connection and routes host replies by connection and tool call", async () => {
    const { server, credentials } = await bridge();
    const requests: Array<{
      connectionId: string;
      toolCallId: string;
      payload: unknown;
    }> = [];
    let received!: () => void;
    const receivedRequest = new Promise<void>((resolve) => {
      received = resolve;
    });
    server.onDelegate((request) => {
      requests.push(request);
      received();
    });
    const socket = await connect(credentials.socketPath);

    const authenticated = nextLine(socket);
    socket.write(
      `${JSON.stringify({ version: 1, type: "authenticate", token: credentials.token })}\n`,
    );
    expect(await authenticated).toEqual({ version: 1, type: "authenticated" });

    socket.write(
      `${JSON.stringify({ version: 1, type: "delegate", toolCallId: "call-1", payload: { task: "opaque" } })}\n`,
    );
    await receivedRequest;
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const lifecycle = nextLine(socket);
    expect(server.sendChildLifecycle({ ...request, taskNumber: 7, status: "running" })).toBe(
      true,
    );
    expect(await lifecycle).toEqual({
      version: 1,
      type: "child-lifecycle",
      toolCallId: "call-1",
      taskNumber: 7,
      status: "running",
    });
    const result = nextLine(socket);
    expect(
      server.sendChildResult({
        ...request,
        outcome: "completed",
        handoff: { summary: "done" },
      }),
    ).toBe(true);
    expect(await result).toEqual({
      version: 1,
      type: "child-result",
      toolCallId: "call-1",
      outcome: "completed",
      handoff: { summary: "done" },
    });
    expect(
      server.sendChildInputNeeded({ ...request, message: "too late" }),
    ).toBe(false);
    socket.destroy();
  });

  it("bridges waiting input through a stable task number to a retained fake child", async () => {
    const { server, credentials } = await bridge();
    const parentId = "parent";
    const token = server.registerParent(parentId);
    let callbacks!: ChildWorkerCallbacks;
    let receivedInput: string | undefined;
    const supervisor = new MultitaskSupervisor<string, string, {
      close(): void;
      provideInput(input: string): void;
    }>({
      hasCapacity: () => true,
      createWorker: ({ callbacks: workerCallbacks }) => {
        callbacks = workerCallbacks;
        return { close: () => undefined, provideInput: (input) => { receivedInput = input; } };
      },
      onParentNotification: (notification) => {
        const call = calls.get(notification.task.number);
        if (!call) return;
        if (notification.type === "task-status" && notification.task.status === "waiting-input") {
          server.sendChildLifecycle({ ...call, taskNumber: notification.task.number, status: notification.task.status });
        } else if (notification.type === "task-handoff") {
          server.sendChildResult({ ...call, outcome: "completed", handoff: notification.handoff });
        }
      },
    });
    supervisor.addParent(parentId, { mode: "parallel", maxQueuedTasks: 2 });
    const calls = new Map<number, { connectionId: string; toolCallId: string }>();
    let delegated!: () => void;
    const delegatedRequest = new Promise<void>((resolve) => { delegated = resolve; });
    server.onDelegate((request) => {
      const payload = request.payload as { action?: string; taskNumber?: number; input?: string };
      if (payload.action === "provide_input") {
        void supervisor.provideInput(parentId, payload.taskNumber!, payload.input!).then(() =>
          server.sendChildResult({ ...request, outcome: "completed", handoff: { summary: "input delivered" } }),
        );
      } else {
        calls.set(42, request);
        supervisor.enqueue(parentId, { number: 42, name: "fake", brief: { text: "private" } });
        delegated();
      }
    });
    const childCall = await connect(credentials.socketPath);
    const auth = nextLine(childCall);
    childCall.write(`${JSON.stringify({ version: 1, type: "authenticate", token })}\n`);
    await auth;
    const waiting = nextLine(childCall);
    childCall.write(`${JSON.stringify({ version: 1, type: "delegate", toolCallId: "child-call", payload: { task: "private" } })}\n`);
    await delegatedRequest;
    await supervisor.schedule(parentId);
    callbacks.inputNeeded();
    expect(await waiting).toMatchObject({ type: "child-lifecycle", taskNumber: 42, status: "waiting-input" });

    const answerCall = await connect(credentials.socketPath);
    const answerAuth = nextLine(answerCall);
    answerCall.write(`${JSON.stringify({ version: 1, type: "authenticate", token })}\n`);
    await answerAuth;
    const inputDelivered = nextLine(answerCall);
    answerCall.write(`${JSON.stringify({ version: 1, type: "delegate", toolCallId: "answer-call", payload: { action: "provide_input", taskNumber: 42, input: "user answer" } })}\n`);
    expect(await inputDelivered).toMatchObject({ type: "child-result", outcome: "completed" });
    expect(receivedInput).toBe("user answer");
    const completed = nextLine(childCall);
    callbacks.completed({ summary: "done" });
    expect(await completed).toMatchObject({ type: "child-result", outcome: "completed", handoff: { summary: "done" } });
    childCall.destroy();
    answerCall.destroy();
  });

  it("rejects unauthenticated, malformed, and oversized frames", async () => {
    const { credentials } = await bridge();
    const unauthenticated = await connect(credentials.socketPath);
    const closed = new Promise<void>((resolve) =>
      unauthenticated.once("close", () => resolve()),
    );
    unauthenticated.write(
      '{"version":1,"type":"delegate","toolCallId":"x","payload":null}\n',
    );
    await closed;

    const { server, credentials: limited } = await bridge();
    // This separate socket is validly authenticated before it violates its frame limit.
    const socket = await connect(limited.socketPath);
    socket.write(
      `${JSON.stringify({ version: 1, type: "authenticate", token: limited.token })}\n`,
    );
    await nextLine(socket);
    const rejected = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.write(`${"x".repeat(70_000)}\n`);
    await rejected;
    expect(
      server.sendChildLifecycle({
        connectionId: "missing",
        toolCallId: "x",
        status: "queued",
      }),
    ).toBe(false);
  });

  it("removes its Unix socket on stop", async () => {
    const { server, credentials } = await bridge();
    await expect(fs.stat(credentials.socketPath)).resolves.toBeDefined();
    await server.stop();
    await expect(fs.stat(credentials.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
