#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  JsonObject,
  PiMessage,
  PiState,
  RpcResponseRecord,
} from "../types.js";

type PromptScenario =
  | "basic"
  | "tool"
  | "queue"
  | "compaction"
  | "retry"
  | "extension-ui"
  | "error"
  | "all";

interface FakeOptions {
  malformedOnStart: boolean;
  exitAfterFirstCommand: boolean;
  stderrOnStart: boolean;
  streamDelayMs: number;
  ignoredCommands: Set<string>;
  promptScenario: PromptScenario;
  dropCompletionEvents: boolean;
  sessionFile?: string;
}

type FakeCommandRecord = JsonObject & {
  id?: string;
  type?: string;
  command?: string;
  params?: JsonObject;
};

function parseOptions(argv: string[]): FakeOptions {
  const options: FakeOptions = {
    malformedOnStart: false,
    exitAfterFirstCommand: false,
    stderrOnStart: false,
    streamDelayMs: 5,
    ignoredCommands: new Set<string>(),
    promptScenario: "basic",
    dropCompletionEvents: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--malformed-on-start") {
      options.malformedOnStart = true;
    } else if (arg === "--exit-after-first-command") {
      options.exitAfterFirstCommand = true;
    } else if (arg === "--stderr-on-start") {
      options.stderrOnStart = true;
    } else if (arg === "--stream-delay-ms") {
      options.streamDelayMs = Number(argv[index + 1] ?? "5");
      index += 1;
    } else if (arg === "--ignore-command") {
      options.ignoredCommands.add(argv[index + 1] ?? "");
      index += 1;
    } else if (arg === "--prompt-scenario") {
      const scenario = argv[index + 1] ?? "basic";
      if (isPromptScenario(scenario)) {
        options.promptScenario = scenario;
      }
      index += 1;
    } else if (arg === "--drop-completion-events") {
      options.dropCompletionEvents = true;
    } else if (arg === "--session") {
      const sessionFile = argv[index + 1];
      if (sessionFile) {
        options.sessionFile = sessionFile;
      }
      index += 1;
    }
  }

  return options;
}

function isPromptScenario(value: string): value is PromptScenario {
  return [
    "basic",
    "tool",
    "queue",
    "compaction",
    "retry",
    "extension-ui",
    "error",
    "all",
  ].includes(value);
}

function commandName(command: FakeCommandRecord): string {
  if (typeof command.command === "string") {
    return command.command;
  }
  if (
    typeof command.type === "string" &&
    command.type !== "command" &&
    command.type !== "response"
  ) {
    return command.type;
  }
  return "";
}

function commandParams(command: FakeCommandRecord): JsonObject {
  if (
    command.params &&
    typeof command.params === "object" &&
    !Array.isArray(command.params)
  ) {
    return command.params;
  }

  const params: JsonObject = {};
  for (const [key, value] of Object.entries(command)) {
    if (key !== "id" && key !== "type" && key !== "command") {
      params[key] = value;
    }
  }
  return params;
}

class FakeRpcServer {
  private readonly decoder = new StringDecoder("utf8");
  private readonly options = parseOptions(process.argv.slice(2));
  private readonly sessionFile = this.resolveSessionFile();
  private readonly shouldPersistSessionFile = Boolean(
    this.options.sessionFile || process.env.PI_CODING_AGENT_DIR,
  );
  private buffer = "";
  private firstCommandSeen = false;
  private promptCounter = 0;
  private currentTimers: NodeJS.Timeout[] = [];
  private agentActive = false;
  private readonly steering: string[] = [];
  private readonly followUp: string[] = [];
  private messages: PiMessage[] = [
    {
      id: "msg_system_1",
      role: "system",
      content: "Fake RPC ready",
      createdAt: 1,
    },
  ];

  start(): void {
    this.ensurePersistedSessionRecord();
    if (this.options.stderrOnStart) {
      process.stderr.write("fake-rpc: deterministic stderr diagnostic\n");
    }
    if (this.options.malformedOnStart) {
      process.stdout.write("{ this is not valid json }\n");
    }

    process.stdin.on("data", (chunk: Buffer) => this.onData(chunk));
    process.stdin.on("end", () => {
      this.buffer += this.decoder.end();
      if (this.buffer.trim().length > 0) {
        this.handleLine(this.buffer);
      }
    });
    process.stdin.resume();
  }

  private resolveSessionFile(): string {
    if (this.options.sessionFile) {
      return path.resolve(this.options.sessionFile);
    }
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (agentDir) {
      return path.join(
        path.resolve(agentDir),
        "sessions",
        "--fake-rpc--",
        `fake-session-${Date.now()}-${process.pid}.jsonl`,
      );
    }
    return path.join(process.cwd(), "fake-session.jsonl");
  }

  private ensurePersistedSessionRecord(): void {
    if (!this.shouldPersistSessionFile) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      if (!fs.existsSync(this.sessionFile)) {
        fs.writeFileSync(
          this.sessionFile,
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: path.basename(this.sessionFile, ".jsonl"),
            timestamp: new Date().toISOString(),
            cwd: process.cwd(),
          })}\n`,
        );
      }
    } catch {
      // Fake persistence is best-effort and should not break RPC tests.
    }
  }

  private appendPersistedMessage(message: PiMessage): void {
    if (!this.shouldPersistSessionFile) {
      return;
    }
    try {
      this.ensurePersistedSessionRecord();
      fs.appendFileSync(
        this.sessionFile,
        `${JSON.stringify({
          type: "message",
          id: `record_${message.id}`,
          timestamp: new Date(
            typeof message.createdAt === "number"
              ? message.createdAt
              : Date.now(),
          ).toISOString(),
          message,
        })}\n`,
      );
    } catch {
      // Fake persistence is best-effort and should not break RPC tests.
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let lfIndex = this.buffer.indexOf("\n");
    while (lfIndex !== -1) {
      const line = this.buffer.slice(0, lfIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(lfIndex + 1);
      this.handleLine(line);
      lfIndex = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let command: FakeCommandRecord;
    try {
      command = JSON.parse(line) as FakeCommandRecord;
    } catch (error) {
      this.write({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (this.options.exitAfterFirstCommand && !this.firstCommandSeen) {
      this.firstCommandSeen = true;
      process.exit(42);
      return;
    }
    this.firstCommandSeen = true;

    const name = commandName(command);
    if (this.options.ignoredCommands.has(name)) {
      return;
    }

    switch (name) {
      case "get_state":
        this.respond(command.id, name, this.getState());
        break;
      case "get_messages":
        this.respond(command.id, name, { messages: this.messages });
        break;
      case "prompt":
        this.handlePrompt(command);
        break;
      case "steer":
        this.handleIntervention(command, "steer");
        break;
      case "follow_up":
        this.handleIntervention(command, "follow_up");
        break;
      case "abort":
        this.handleAbort(command);
        break;
      case "get_commands":
        this.respond(command.id, name, {
          commands: [
            {
              name: "review",
              description: "Review the current change with the active worker.",
              source: "prompt",
            },
            {
              name: "skill:frontend-polish",
              description: "Apply frontend polish checklist to the prompt.",
              source: "skill",
            },
            {
              name: "fake-worker-command",
              description: "Command discovered from the active fake Pi worker.",
              source: "extension",
            },
          ],
        });
        break;
      default:
        this.respond(
          command.id,
          name || "unknown",
          undefined,
          `Fake RPC does not implement command: ${name || "<missing>"}`,
        );
        break;
    }
  }

  private getState(): PiState {
    return {
      sessionId: this.shouldPersistSessionFile
        ? path.basename(this.sessionFile, ".jsonl")
        : "fake-session-1",
      sessionFile: this.sessionFile,
      cwd: process.cwd(),
      model: "fake-model",
      provider: "fake-provider",
      thinkingLevel: "medium",
      isStreaming: this.agentActive,
    };
  }

  private handlePrompt(command: FakeCommandRecord): void {
    const params = commandParams(command);
    const text =
      typeof params.message === "string"
        ? params.message
        : typeof params.text === "string"
          ? params.text
          : "";
    const userMessage: PiMessage = {
      id: `msg_user_${this.promptCounter + 1}`,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    this.messages.push(userMessage);
    this.appendPersistedMessage(userMessage);
    this.promptCounter += 1;
    const assistantId = `msg_assistant_${this.promptCounter}`;
    const chunks = ["Fake response", " to: ", text || "(empty prompt)"];
    let accumulated = "";
    this.agentActive = true;

    this.respond(command.id, "prompt");
    this.write({
      type: "agent_start",
      runId: `run_${this.promptCounter}`,
      messageId: assistantId,
    });

    if (this.options.promptScenario === "error") {
      const errorMessage = "Usage limit reached for fake provider.";
      this.agentActive = false;
      this.write({
        type: "message_update",
        messageId: assistantId,
        role: "assistant",
        content: errorMessage,
        done: true,
        isError: true,
        error: errorMessage,
      });
      this.write({
        type: "agent_end",
        runId: `run_${this.promptCounter}`,
        status: "error",
        error: errorMessage,
      });
      return;
    }

    this.emitPromptScenarioEvents(assistantId);

    chunks.forEach((chunk, index) => {
      this.currentTimers.push(
        setTimeout(
          () => {
            accumulated += chunk;
            this.write({
              type: "message_update",
              messageId: assistantId,
              role: "assistant",
              delta: chunk,
              content: accumulated,
              done: false,
            });
          },
          this.options.streamDelayMs * (index + 1),
        ),
      );
    });

    this.currentTimers.push(
      setTimeout(
        () => {
          this.agentActive = false;
          const assistantMessage: PiMessage = {
            id: assistantId,
            role: "assistant",
            content: accumulated,
            createdAt: Date.now(),
          };
          this.messages.push(assistantMessage);
          this.appendPersistedMessage(assistantMessage);
          if (!this.options.dropCompletionEvents) {
            this.write({
              type: "message_update",
              messageId: assistantId,
              role: "assistant",
              content: accumulated,
              done: true,
            });
            this.write({
              type: "agent_end",
              runId: `run_${this.promptCounter}`,
              status: "completed",
            });
          }
        },
        this.options.streamDelayMs * (chunks.length + 1),
      ),
    );
  }

  private emitPromptScenarioEvents(assistantId: string): void {
    const scenario = this.options.promptScenario;
    const shouldEmit = (target: PromptScenario): boolean =>
      scenario === target || scenario === "all";

    if (shouldEmit("queue")) {
      this.steering.splice(0, this.steering.length, "Queued steering fixture");
      this.followUp.splice(
        0,
        this.followUp.length,
        "Queued follow-up fixture one",
        "Queued follow-up fixture two",
      );
      this.emitQueueUpdate();
    }

    if (shouldEmit("compaction")) {
      this.write({ type: "compaction_start", reason: "fake-fixture" });
      this.write({ type: "compaction_end", status: "completed" });
    }

    if (shouldEmit("retry")) {
      this.write({ type: "auto_retry_start", attempt: 1, maxAttempts: 2 });
      this.write({ type: "auto_retry_end", attempt: 1, status: "recovered" });
    }

    if (shouldEmit("tool")) {
      this.write({
        type: "tool_execution_start",
        toolCallId: "tool_fake_1",
        name: "read",
        title: "Read fixture file",
      });
      this.write({
        type: "tool_execution_update",
        toolCallId: "tool_fake_1",
        output: "partial tool output",
      });
      this.write({
        type: "tool_execution_end",
        toolCallId: "tool_fake_1",
        status: "completed",
        output: "final tool output",
      });
    }

    if (shouldEmit("extension-ui")) {
      this.write({
        type: "extension_ui_request",
        requestId: "ext_fake_dialog_1",
        messageId: assistantId,
        method: "confirm",
        params: {
          title: "Fake confirmation",
          message: "Approve fake extension UI request?",
        },
        timeout: 250,
      });
    }
  }

  private handleIntervention(
    command: FakeCommandRecord,
    kind: "steer" | "follow_up",
  ): void {
    const params = commandParams(command);
    const message =
      typeof params.message === "string"
        ? params.message
        : typeof params.text === "string"
          ? params.text
          : "";
    if (kind === "steer") {
      this.steering.push(message);
    } else {
      this.followUp.push(message);
    }
    this.respond(command.id, kind);
    this.emitQueueUpdate();
  }

  private handleAbort(command: FakeCommandRecord): void {
    for (const timer of this.currentTimers) {
      clearTimeout(timer);
    }
    this.currentTimers = [];
    const wasActive = this.agentActive;
    this.agentActive = false;
    this.respond(command.id, "abort");
    this.write({
      type: "agent_end",
      runId: `run_${this.promptCounter}`,
      status: "aborted",
    });
  }

  private emitQueueUpdate(): void {
    this.write({
      type: "queue_update",
      steering: [...this.steering],
      followUp: [...this.followUp],
    });
  }

  private respond(
    id: string | undefined,
    command: string,
    data?: unknown,
    error?: string,
  ): void {
    const response: RpcResponseRecord = error
      ? {
          type: "response",
          ...(id ? { id } : {}),
          command,
          success: false,
          error,
        }
      : {
          type: "response",
          ...(id ? { id } : {}),
          command,
          success: true,
          ...(data === undefined ? {} : { data: data as never }),
        };
    this.write(response as unknown as JsonObject);
  }

  private write(record: JsonObject): void {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

new FakeRpcServer().start();
