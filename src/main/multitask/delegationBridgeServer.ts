import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  authenticateMessageSchema,
  childInputNeededMessageSchema,
  childLifecycleMessageSchema,
  childResultMessageSchema,
  clientMessageSchema,
  DELEGATION_BRIDGE_PROTOCOL_VERSION,
  type ChildLifecycleStatus,
  type ChildResultWireMessage,
  type DelegateWireMessage,
  type ChildInputResponseWireMessage,
} from "./delegationBridgeProtocol.js";

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 5_000;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export interface DelegationBridgeServerOptions {
  /** Private application state/temp directory in which the Unix socket is made. */
  stateDir: string;
  maxFrameBytes?: number;
  authenticationTimeoutMs?: number;
  onDelegate?: (request: DelegateRequest) => void;
  onConnectionClosed?: (connectionId: string) => void;
  onProtocolError?: (error: DelegationBridgeProtocolError) => void;
}

export interface DelegationBridgeCredentials {
  socketPath: string;
  /** Give this capability only to the parent extension when it is launched. */
  token: string;
  protocolVersion: typeof DELEGATION_BRIDGE_PROTOCOL_VERSION;
}

/** Identity is intentionally scoped to this bridge, not a Pi child/session identity. */
export interface DelegateRequest {
  /** Authoritatively bound by the per-parent capability at authentication. */
  parentId: string;
  connectionId: string;
  toolCallId: string;
  /** Opaque JSON supplied by the extension; the bridge never parses prompts. */
  payload: unknown;
}

export interface ChildLifecycleMessage {
  connectionId: string;
  toolCallId: string;
  status: ChildLifecycleStatus;
}

export interface ChildResultMessage {
  connectionId: string;
  toolCallId: string;
  outcome: ChildResultWireMessage["outcome"];
  handoff?: ChildResultWireMessage["handoff"];
}

export interface ChildInputResponse {
  parentId: string;
  connectionId: string;
  toolCallId: string;
  input: string;
}

export interface ChildInputNeededMessage {
  connectionId: string;
  toolCallId: string;
  message: string;
}

export interface DelegationBridgeProtocolError {
  connectionId?: string;
  code:
    | "authentication-failed"
    | "invalid-frame"
    | "frame-too-large"
    | "duplicate-tool-call";
}

interface Connection {
  id: string;
  socket: net.Socket;
  authenticated: boolean;
  buffer: Buffer;
  requestedToolCalls: Set<string>;
  parentId?: string;
  authenticationTimer: NodeJS.Timeout;
}

/**
 * Local, capability-authenticated bridge for a parent extension.  It contains
 * no child runtime/session state; host code maps delegate requests to work.
 */
export class DelegationBridgeServer {
  private readonly options: Required<
    Pick<
      DelegationBridgeServerOptions,
      "maxFrameBytes" | "authenticationTimeoutMs"
    >
  > &
    DelegationBridgeServerOptions;
  private readonly delegates = new Set<(request: DelegateRequest) => void>();
  private readonly connections = new Map<string, Connection>();
  private server: net.Server | undefined;
  private socketPath: string | undefined;
  private token: string | undefined;
  private readonly parentCapabilities = new Map<string, string>();
  private readonly inputs = new Set<(response: ChildInputResponse) => void>();

  public constructor(options: DelegationBridgeServerOptions) {
    if (!options.stateDir) throw new Error("stateDir is required");
    this.options = {
      ...options,
      maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      authenticationTimeoutMs:
        options.authenticationTimeoutMs ?? DEFAULT_AUTHENTICATION_TIMEOUT_MS,
    };
    if (
      !Number.isSafeInteger(this.options.maxFrameBytes) ||
      this.options.maxFrameBytes < 1
    ) {
      throw new Error("maxFrameBytes must be a positive integer");
    }
  }

  public async start(): Promise<DelegationBridgeCredentials> {
    if (this.server) throw new Error("Delegation bridge is already started");
    await fs.mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    // Keep the random Unix-socket leaf short for macOS's 104-byte path limit.
    const name = `.pdb-v${DELEGATION_BRIDGE_PROTOCOL_VERSION}-${randomBytes(6).toString("hex")}.sock`;
    const socketPath = path.join(this.options.stateDir, name);
    if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new Error(`Unix socket path is too long: ${socketPath}`);
    }
    // The random name makes collision infeasible; remove only this exact stale path.
    await fs.rm(socketPath, { force: true });

    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    this.socketPath = socketPath;
    this.token = randomBytes(32).toString("hex");
    // Kept only for direct host/test clients. Production parent extensions
    // receive a distinct capability from registerParent().
    this.parentCapabilities.set(this.token, "__bridge_default__");
    server.on("error", () => undefined); // listen errors are surfaced by start().
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });
      await fs.chmod(socketPath, 0o600);
    } catch (error) {
      this.server = undefined;
      this.socketPath = undefined;
      this.token = undefined;
      await fs.rm(socketPath, { force: true });
      throw error;
    }
    return {
      socketPath,
      token: this.token,
      protocolVersion: DELEGATION_BRIDGE_PROTOCOL_VERSION,
    };
  }

  /** Issue a unique capability binding an extension connection to one parent. */
  public registerParent(parentId: string): string {
    const token = randomBytes(32).toString("hex");
    this.parentCapabilities.set(token, parentId);
    return token;
  }

  /** Revoke a parent capability and its live connections. */
  public removeParent(parentId: string): void {
    for (const [token, bound] of this.parentCapabilities) {
      if (bound === parentId) this.parentCapabilities.delete(token);
    }
    for (const connection of this.connections.values()) {
      if (connection.parentId === parentId) connection.socket.destroy();
    }
  }

  public onInputResponse(listener: (response: ChildInputResponse) => void): () => void {
    this.inputs.add(listener);
    return () => this.inputs.delete(listener);
  }

  /** Subscribe to opaque delegate invocations from authenticated connections. */
  public onDelegate(listener: (request: DelegateRequest) => void): () => void {
    this.delegates.add(listener);
    return () => this.delegates.delete(listener);
  }

  /** Send safe child progress to the connection that originated this tool call. */
  public sendChildLifecycle(message: ChildLifecycleMessage): boolean {
    const { connectionId, toolCallId, status } = message;
    const parsed = childLifecycleMessageSchema.safeParse({
      version: DELEGATION_BRIDGE_PROTOCOL_VERSION,
      type: "child-lifecycle",
      toolCallId,
      status,
    });
    return parsed.success && this.send(connectionId, toolCallId, parsed.data);
  }

  /** Send the safe terminal handoff and retire the tool call mapping. */
  public sendChildResult(message: ChildResultMessage): boolean {
    const { connectionId, toolCallId, outcome, handoff } = message;
    const parsed = childResultMessageSchema.safeParse({
      version: DELEGATION_BRIDGE_PROTOCOL_VERSION,
      type: "child-result",
      toolCallId,
      outcome,
      ...(handoff === undefined ? {} : { handoff }),
    });
    if (!parsed.success || !this.send(connectionId, toolCallId, parsed.data))
      return false;
    this.connections.get(connectionId)?.requestedToolCalls.delete(toolCallId);
    return true;
  }

  /** Ask the parent extension for input without revealing child runtime data. */
  public sendChildInputNeeded(message: ChildInputNeededMessage): boolean {
    const { connectionId, toolCallId, message: inputMessage } = message;
    const parsed = childInputNeededMessageSchema.safeParse({
      version: DELEGATION_BRIDGE_PROTOCOL_VERSION,
      type: "child-input-needed",
      toolCallId,
      message: inputMessage,
    });
    return parsed.success && this.send(connectionId, toolCallId, parsed.data);
  }

  /** Stops accepting connections, closes clients, and removes the owned socket. */
  public async stop(): Promise<void> {
    for (const connection of this.connections.values())
      connection.socket.destroy();
    this.connections.clear();
    const server = this.server;
    const socketPath = this.socketPath;
    this.server = undefined;
    this.socketPath = undefined;
    this.token = undefined;
    this.parentCapabilities.clear();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (socketPath) await fs.rm(socketPath, { force: true });
  }

  private accept(socket: net.Socket): void {
    const connection: Connection = {
      id: randomUUID(),
      socket,
      authenticated: false,
      buffer: Buffer.alloc(0),
      requestedToolCalls: new Set(),
      authenticationTimer: setTimeout(
        () => this.reject(undefined, socket, "authentication-failed"),
        this.options.authenticationTimeoutMs,
      ),
    };
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.receive(connection, chunk));
    socket.on("error", () => undefined);
    socket.once("close", () => this.closeConnection(connection));
  }

  private receive(connection: Connection, chunk: Buffer): void {
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    while (true) {
      if (
        connection.buffer.length > this.options.maxFrameBytes &&
        connection.buffer.indexOf(0x0a) === -1
      ) {
        this.reject(connection.id, connection.socket, "frame-too-large");
        return;
      }
      const newline = connection.buffer.indexOf(0x0a);
      if (newline === -1) return;
      const frame = connection.buffer.subarray(0, newline);
      connection.buffer = connection.buffer.subarray(newline + 1);
      if (frame.length === 0 || frame.length > this.options.maxFrameBytes) {
        this.reject(
          connection.id,
          connection.socket,
          frame.length > this.options.maxFrameBytes
            ? "frame-too-large"
            : "invalid-frame",
        );
        return;
      }
      // Reject malformed UTF-8 and CR-delimited input: frames are exactly UTF-8 JSON + LF.
      const text = frame.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(frame) || frame.includes(0x0d)) {
        this.reject(connection.id, connection.socket, "invalid-frame");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        this.reject(connection.id, connection.socket, "invalid-frame");
        return;
      }
      const parsed = clientMessageSchema.safeParse(value);
      if (!parsed.success) {
        this.reject(connection.id, connection.socket, "invalid-frame");
        return;
      }
      this.handle(connection, parsed.data);
      if (connection.socket.destroyed) return;
    }
  }

  private handle(
    connection: Connection,
    message:
      | DelegateWireMessage
      | ChildInputResponseWireMessage
      | ReturnType<typeof authenticateMessageSchema.parse>,
  ): void {
    if (!connection.authenticated) {
      const parentId = message.type === "authenticate"
        ? this.parentCapabilities.get(message.token)
        : undefined;
      if (!parentId) {
        this.reject(connection.id, connection.socket, "authentication-failed");
        return;
      }
      connection.authenticated = true;
      connection.parentId = parentId;
      clearTimeout(connection.authenticationTimer);
      this.connections.set(connection.id, connection);
      this.write(connection.socket, {
        version: DELEGATION_BRIDGE_PROTOCOL_VERSION,
        type: "authenticated",
      });
      return;
    }
    if (message.type === "child-input-response") {
      if (!connection.requestedToolCalls.has(message.toolCallId) || !connection.parentId) {
        this.reject(connection.id, connection.socket, "invalid-frame");
        return;
      }
      for (const listener of this.inputs) listener({ parentId: connection.parentId, connectionId: connection.id, toolCallId: message.toolCallId, input: message.input });
      return;
    }
    if (message.type !== "delegate") {
      this.reject(connection.id, connection.socket, "invalid-frame");
      return;
    }
    if (connection.requestedToolCalls.has(message.toolCallId)) {
      this.reject(connection.id, connection.socket, "duplicate-tool-call");
      return;
    }
    connection.requestedToolCalls.add(message.toolCallId);
    const request: DelegateRequest = {
      parentId: connection.parentId!,
      connectionId: connection.id,
      toolCallId: message.toolCallId,
      payload: message.payload,
    };
    this.options.onDelegate?.(request);
    for (const listener of this.delegates) listener(request);
  }

  private send(
    connectionId: string,
    toolCallId: string,
    message: object,
  ): boolean {
    const connection = this.connections.get(connectionId);
    if (
      !connection ||
      !connection.requestedToolCalls.has(toolCallId) ||
      connection.socket.destroyed
    )
      return false;
    return this.write(connection.socket, message);
  }

  private write(socket: net.Socket, message: object): boolean {
    const frame = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (frame.length > this.options.maxFrameBytes || socket.destroyed)
      return false;
    return socket.write(frame);
  }

  private matchesToken(token: string): boolean {
    if (!this.token) return false;
    const actual = Buffer.from(token, "utf8");
    const expected = Buffer.from(this.token, "utf8");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private reject(
    connectionId: string | undefined,
    socket: net.Socket,
    code: DelegationBridgeProtocolError["code"],
  ): void {
    this.options.onProtocolError?.(
      connectionId === undefined ? { code } : { connectionId, code },
    );
    socket.destroy();
  }

  private closeConnection(connection: Connection): void {
    clearTimeout(connection.authenticationTimer);
    if (this.connections.delete(connection.id))
      this.options.onConnectionClosed?.(connection.id);
  }
}
