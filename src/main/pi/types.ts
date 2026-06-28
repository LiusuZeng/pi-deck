// G0 contract-review note: these are the minimal backend/RPC contracts for M2.
// They are intentionally renderer-agnostic and can be narrowed/expanded when the
// shared PiAdapter, IPC schemas, and normalized event model are frozen.

export type RuntimeSessionId = string;
export type Unsubscribe = () => void;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export interface RpcCommandRecord {
  id: string;
  type?: "command";
  command: string;
  params?: JsonObject;
}

export interface RpcResponseRecord<T = JsonValue> {
  id: string;
  type: "response";
  ok?: boolean;
  result?: T;
  error?: RpcErrorPayload | string;
}

export interface RpcErrorPayload {
  code?: string;
  message: string;
  details?: JsonValue;
}

export type RpcEventRecord = JsonObject & {
  type: string;
  id?: string;
};

export type RpcRecord = RpcCommandRecord | RpcResponseRecord | RpcEventRecord;

export interface PromptImageInput {
  mimeType: string;
  dataBase64: string;
}

export interface PromptInput {
  text: string;
  images?: PromptImageInput[];
  // M4 will add attachment token/path-reference plumbing at the backend boundary.
  [key: string]: unknown;
}

export interface PiState {
  runtimeId?: RuntimeSessionId;
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  thinkingLevel?: string;
  isAgentActive?: boolean;
  [key: string]: unknown;
}

export interface PiMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool" | string;
  content?: string;
  createdAt?: number;
  [key: string]: unknown;
}

export interface RuntimeDiagnosticEvent {
  type: "diagnostic";
  runtimeId: RuntimeSessionId;
  level: "info" | "warn" | "error";
  message: string;
  timestamp: number;
  details?: unknown;
}

export type RuntimeEvent =
  | RuntimeDiagnosticEvent
  | (JsonObject & {
      type: string;
      runtimeId: RuntimeSessionId;
    });

export interface WorkerDiagnostics {
  runtimeId: RuntimeSessionId;
  pid?: number;
  healthy: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderr: string;
  recentDiagnostics: RuntimeDiagnosticEvent[];
}

export interface PiAdapter {
  getState(runtimeId: RuntimeSessionId): Promise<PiState>;
  getMessages(runtimeId: RuntimeSessionId): Promise<PiMessage[]>;
  prompt(runtimeId: RuntimeSessionId, input: PromptInput): Promise<void>;
  abort(runtimeId: RuntimeSessionId): Promise<void>;
  closeSession(runtimeId: RuntimeSessionId): Promise<void>;
  onEvent(listener: (event: RuntimeEvent) => void): Unsubscribe;
}

export interface PiWorkerSpawnOptions {
  runtimeId?: RuntimeSessionId;
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  stderrBufferBytes?: number;
  killGraceMs?: number;
  commandProtocol?: "command-field" | "type-field";
}
