#!/usr/bin/env node
import { StringDecoder } from "node:string_decoder";
import type {
  JsonObject,
  PiMessage,
  PiState,
  RpcCommandRecord,
  RpcResponseRecord,
} from "../types.js";

interface FakeOptions {
  malformedOnStart: boolean;
  exitAfterFirstCommand: boolean;
  stderrOnStart: boolean;
  streamDelayMs: number;
  ignoredCommands: Set<string>;
}

function parseOptions(argv: string[]): FakeOptions {
  const options: FakeOptions = {
    malformedOnStart: false,
    exitAfterFirstCommand: false,
    stderrOnStart: false,
    streamDelayMs: 5,
    ignoredCommands: new Set<string>(),
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
    }
  }

  return options;
}

class FakeRpcServer {
  private readonly decoder = new StringDecoder("utf8");
  private readonly options = parseOptions(process.argv.slice(2));
  private buffer = "";
  private firstCommandSeen = false;
  private promptCounter = 0;
  private currentTimers: NodeJS.Timeout[] = [];
  private agentActive = false;
  private messages: PiMessage[] = [
    {
      id: "msg_system_1",
      role: "system",
      content: "Fake RPC ready",
      createdAt: 1,
    },
  ];

  start(): void {
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
    let command: RpcCommandRecord;
    try {
      command = JSON.parse(line) as RpcCommandRecord;
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

    if (this.options.ignoredCommands.has(command.command)) {
      return;
    }

    switch (command.command) {
      case "get_state":
        this.respond(command.id, this.getState());
        break;
      case "get_messages":
        this.respond(command.id, this.messages);
        break;
      case "prompt":
        this.handlePrompt(command);
        break;
      case "abort":
        this.handleAbort(command);
        break;
      default:
        this.respond(command.id, undefined, {
          code: "FAKE_UNKNOWN_COMMAND",
          message: `Fake RPC does not implement command: ${command.command}`,
        });
        break;
    }
  }

  private getState(): PiState {
    return {
      sessionId: "fake-session-1",
      sessionFile: `${process.cwd()}/fake-session.jsonl`,
      cwd: process.cwd(),
      model: "fake-model",
      provider: "fake-provider",
      thinkingLevel: "medium",
      isAgentActive: this.agentActive,
    };
  }

  private handlePrompt(command: RpcCommandRecord): void {
    const text =
      typeof command.params?.text === "string" ? command.params.text : "";
    const userMessage: PiMessage = {
      id: `msg_user_${this.promptCounter + 1}`,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    this.messages.push(userMessage);
    this.promptCounter += 1;
    const assistantId = `msg_assistant_${this.promptCounter}`;
    const chunks = ["Fake response", " to: ", text || "(empty prompt)"];
    let accumulated = "";
    this.agentActive = true;

    this.respond(command.id, { accepted: true });
    this.write({
      type: "agent_start",
      runId: `run_${this.promptCounter}`,
      messageId: assistantId,
    });

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
          this.messages.push({
            id: assistantId,
            role: "assistant",
            content: accumulated,
            createdAt: Date.now(),
          });
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
        },
        this.options.streamDelayMs * (chunks.length + 1),
      ),
    );
  }

  private handleAbort(command: RpcCommandRecord): void {
    for (const timer of this.currentTimers) {
      clearTimeout(timer);
    }
    this.currentTimers = [];
    const wasActive = this.agentActive;
    this.agentActive = false;
    this.respond(command.id, { aborted: wasActive });
    this.write({
      type: "agent_end",
      runId: `run_${this.promptCounter}`,
      status: "aborted",
    });
  }

  private respond(
    id: string,
    result?: unknown,
    error?: { code?: string; message: string },
  ): void {
    const response: RpcResponseRecord = error
      ? { type: "response", id, ok: false, error }
      : { type: "response", id, ok: true, result: result as never };
    this.write(response as unknown as JsonObject);
  }

  private write(record: JsonObject): void {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

new FakeRpcServer().start();
