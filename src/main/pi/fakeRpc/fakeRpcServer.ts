#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
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
  | "delegate"
  | "routing"
  | "all";

interface FakeOptions {
  malformedOnStart: boolean;
  exitAfterFirstCommand: boolean;
  stderrOnStart: boolean;
  streamDelayMs: number;
  ignoredCommands: Set<string>;
  failedCommands: Set<string>;
  promptScenario: PromptScenario;
  dropCompletionEvents: boolean;
  extensionUiMethod: "select" | "confirm" | "input" | "editor";
  extraModel: boolean;
  productionShaped: boolean;
  noSession: boolean;
  sessionFile?: string;
  workflowDecisions: boolean[];
  workflowDecisionStateFile?: string;
  /**
   * Provider-independent ordinary-prompt routing fixture. This deliberately
   * does not call the deck_delegate bridge: production routing owns task
   * planning, while this process remains a real Pi RPC transport.
   */
  taskRoutingFixture?: string;
  fixtureTraceFile?: string;
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
    failedCommands: new Set<string>(),
    promptScenario: "basic",
    dropCompletionEvents: false,
    extensionUiMethod: "confirm",
    extraModel: false,
    productionShaped: false,
    noSession: false,
    workflowDecisions: [],
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
    } else if (arg === "--fail-command") {
      options.failedCommands.add(argv[index + 1] ?? "");
      index += 1;
    } else if (arg === "--prompt-scenario") {
      const scenario = argv[index + 1] ?? "basic";
      if (isPromptScenario(scenario)) {
        options.promptScenario = scenario;
      }
      index += 1;
    } else if (arg === "--drop-completion-events") {
      options.dropCompletionEvents = true;
    } else if (arg === "--extension-ui-method") {
      const method = argv[index + 1];
      if (
        method === "select" ||
        method === "confirm" ||
        method === "input" ||
        method === "editor"
      ) {
        options.extensionUiMethod = method;
      }
      index += 1;
    } else if (arg === "--extra-model") {
      options.extraModel = true;
    } else if (arg === "--production-shaped") {
      options.productionShaped = true;
    } else if (arg === "--no-session") {
      options.noSession = true;
    } else if (arg === "--session") {
      const sessionFile = argv[index + 1];
      if (sessionFile) {
        options.sessionFile = sessionFile;
      }
      index += 1;
    } else if (arg === "--workflow-decisions") {
      const decisions = (argv[index + 1] ?? "").split(",");
      if (
        decisions.every(
          (decision) => decision === "true" || decision === "false",
        )
      ) {
        options.workflowDecisions = decisions.map(
          (decision) => decision === "true",
        );
      }
      index += 1;
    } else if (arg === "--workflow-decision-state-file") {
      const stateFile = argv[index + 1];
      if (stateFile) options.workflowDecisionStateFile = stateFile;
      index += 1;
    } else if (arg === "--task-routing-fixture") {
      const fixture = argv[index + 1];
      if (fixture) options.taskRoutingFixture = fixture;
      index += 1;
    } else if (arg === "--fixture-trace-file") {
      const traceFile = argv[index + 1];
      if (traceFile) options.fixtureTraceFile = traceFile;
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
    "delegate",
    "routing",
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
  private readonly shouldPersistSessionFile =
    !this.options.noSession &&
    Boolean(this.options.sessionFile || process.env.PI_CODING_AGENT_DIR);
  private buffer = "";
  private firstCommandSeen = false;
  private promptCounter = 0;
  private workflowDecisionIndex = 0;
  private currentTimers: NodeJS.Timeout[] = [];
  private agentActive = false;
  private currentModel = "fake-model";
  private currentProvider = this.options.productionShaped
    ? "anthropic"
    : "fake-provider";
  private currentThinkingLevel = "medium";
  private pendingExtensionUi:
    | {
        id: string;
        assistantId: string;
        promptText: string;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private readonly steering: string[] = [];
  private readonly followUp: string[] = [];

  private traceFixture(event: string): void {
    const traceFile = this.options.fixtureTraceFile;
    if (!traceFile) return;
    fs.mkdirSync(path.dirname(traceFile), { recursive: true });
    fs.appendFileSync(traceFile, `${event}\n`);
  }

  /** Deterministic test-only parent-extension stand-in for bridge E2E tests. */
  private exerciseDelegationBridge(task: string): void {
    this.traceFixture("deck_delegate");
    const endpoint = process.env.DECK_DELEGATE_ENDPOINT;
    const token = process.env.DECK_DELEGATE_CAPABILITY;
    if (!endpoint?.startsWith("unix:") || !token) return;
    const socket = net.createConnection({ path: endpoint.slice(5) });
    const callId = `fake-delegate-${this.promptCounter}`;
    let authenticated = false;
    let buffer = "";
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ version: 1, type: "authenticate", token })}\n`,
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line) as {
            type?: string;
            outcome?: string;
            handoff?: { summary?: string };
          };
          if (!authenticated && message.type === "authenticated") {
            authenticated = true;
            socket.write(
              `${JSON.stringify({ version: 1, type: "delegate", toolCallId: callId, payload: { task, name: "Fake delegated task", parentRuntimeId: process.env.DECK_DELEGATE_PARENT_RUNTIME } })}\n`,
            );
          } else if (message.type === "child-result") {
            this.write({
              type: "custom",
              customType: "deck_delegate",
              content:
                message.handoff?.summary ?? message.outcome ?? "Child finished",
            });
            socket.destroy();
          }
        } catch {
          socket.destroy();
        }
      }
    });
    socket.on("error", () => undefined);
  }
  private messages: PiMessage[] = [
    {
      id: "msg_system_1",
      role: "system",
      content: "Fake RPC ready",
      createdAt: 1,
    },
  ];

  private modelDisplayName(modelId: string): string {
    if (this.options.productionShaped) {
      return modelId === "fake-model-2" ? "GPT-5 Codex" : "Claude Sonnet 4.5";
    }
    return modelId === "fake-model-2" ? "Fake model 2" : "Fake model";
  }

  private modelDisplayProvider(modelId: string): string {
    if (this.options.productionShaped) {
      return modelId === "fake-model-2" ? "openai" : "anthropic";
    }
    return "fake-provider";
  }

  start(): void {
    this.rehydratePersistedMessages();
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

  /**
   * The real Pi RPC process reconstructs get_messages from --session. Mirror
   * that behavior so a fake real-mode resume exercises the same snapshot path
   * after the worker (and app) have restarted.
   */
  private rehydratePersistedMessages(): void {
    if (!this.options.sessionFile || !fs.existsSync(this.sessionFile)) {
      return;
    }
    try {
      const messages: PiMessage[] = [];
      for (const line of fs
        .readFileSync(this.sessionFile, "utf8")
        .split(/\r?\n/)) {
        if (line.trim().length === 0) {
          continue;
        }
        const record = JSON.parse(line) as unknown;
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          continue;
        }
        const message = (record as { message?: unknown }).message;
        if (
          !message ||
          typeof message !== "object" ||
          Array.isArray(message) ||
          typeof (message as { role?: unknown }).role !== "string"
        ) {
          continue;
        }
        messages.push(message as PiMessage);
      }
      if (messages.length > 0) {
        this.messages = messages;
        this.promptCounter = messages.filter(
          (message) => message.role === "user",
        ).length;
      }
    } catch {
      // A damaged fixture should retain the deterministic new-session state.
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
    if (name === "extension_ui_response") {
      this.handleExtensionUiResponse(command);
      return;
    }
    if (this.options.ignoredCommands.has(name)) {
      return;
    }
    if (this.options.failedCommands.has(name)) {
      this.respond(
        command.id,
        name,
        undefined,
        `Fake RPC configured to fail command: ${name}`,
      );
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
      case "get_available_models":
        this.respond(command.id, name, {
          models: [
            {
              id: "fake-model",
              name: this.modelDisplayName("fake-model"),
              provider: this.modelDisplayProvider("fake-model"),
              reasoning: true,
              thinkingLevelMap: {
                minimal: "minimal",
                xhigh: "xhigh",
                max: "max",
              },
              input: ["text", "image"],
            },
            ...(this.options.extraModel
              ? [
                  {
                    id: "fake-model-2",
                    name: this.modelDisplayName("fake-model-2"),
                    provider: this.modelDisplayProvider("fake-model-2"),
                    reasoning: true,
                    input: ["text", "image"],
                  },
                ]
              : []),
          ],
        });
        break;
      case "get_available_thinking_levels":
        this.respond(command.id, name, {
          levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        });
        break;
      case "set_model": {
        const params = commandParams(command);
        if (typeof params.modelId === "string") {
          this.currentModel = params.modelId;
        }
        if (typeof params.provider === "string") {
          this.currentProvider = params.provider;
        }
        this.respond(command.id, name, {
          id: this.currentModel,
          name: this.modelDisplayName(this.currentModel),
          provider: this.currentProvider,
          reasoning: true,
          input: ["text", "image"],
        });
        break;
      }
      case "set_thinking_level": {
        const params = commandParams(command);
        if (typeof params.level === "string") {
          this.currentThinkingLevel = params.level;
        }
        this.respond(command.id, name);
        break;
      }
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
      model: this.currentModel,
      provider: this.currentProvider,
      thinkingLevel: this.currentThinkingLevel,
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
    const recordedTaskPrompt = this.decodeTaskSessionPrompt(text);
    const userMessage: PiMessage = {
      id: `msg_user_${this.promptCounter + 1}`,
      role: "user",
      content: recordedTaskPrompt ?? text,
      createdAt: Date.now(),
    };
    this.messages.push(userMessage);
    this.appendPersistedMessage(userMessage);
    if (recordedTaskPrompt !== undefined) {
      this.promptCounter += 1;
      this.respond(command.id, "prompt");
      this.traceFixture("task_session_prompt_recorded");
      return;
    }
    if (this.options.promptScenario === "routing") {
      this.traceFixture("ordinary_prompt");
    }
    this.promptCounter += 1;
    const assistantId = `msg_assistant_${this.promptCounter}`;
    this.agentActive = true;

    this.respond(command.id, "prompt");
    this.write({
      type: "agent_start",
      runId: `run_${this.promptCounter}`,
      messageId: assistantId,
    });

    if (
      this.options.promptScenario === "delegate" &&
      !this.isDirectHandlingOverride(text)
    ) {
      this.exerciseDelegationBridge(text);
    }

    if (this.options.promptScenario === "error") {
      const errorMessage = "Usage limit reached for fake provider.";
      const failedAssistant = {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: this.currentProvider,
        model: this.currentModel,
        responseId: assistantId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "error",
        errorMessage,
        timestamp: Date.now(),
      };
      this.agentActive = false;
      // Mirror Pi 0.81's assistant-stream failure and terminal event shapes,
      // rather than the legacy fixture-only status/error fields.
      this.write({
        type: "message_update",
        message: failedAssistant,
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: failedAssistant,
        },
      });
      this.write({
        type: "agent_end",
        messages: [failedAssistant],
        willRetry: false,
      });
      this.write({ type: "agent_settled" });
      return;
    }

    const isExtensionUiScenario =
      this.options.promptScenario === "extension-ui" ||
      this.options.promptScenario === "all";
    this.emitPromptScenarioEvents(assistantId);
    if (isExtensionUiScenario) {
      const id = "ext_fake_dialog_1";
      const timer = setTimeout(() => {
        if (this.pendingExtensionUi?.id === id) {
          this.pendingExtensionUi = undefined;
          this.completePrompt(assistantId, text);
        }
      }, 5_000);
      this.pendingExtensionUi = { id, assistantId, promptText: text, timer };
      return;
    }
    this.completePrompt(assistantId, text);
  }

  private decodeTaskSessionPrompt(text: string): string | undefined {
    const prefix = "/deck-task-prompt ";
    if (!text.startsWith(prefix)) return undefined;
    try {
      const payload: unknown = JSON.parse(
        Buffer.from(text.slice(prefix.length).trim(), "base64url").toString(
          "utf8",
        ),
      );
      const prompt = (payload as { prompt?: unknown }).prompt;
      return typeof prompt === "string" && prompt.trim()
        ? prompt.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The fake delegate scenario models the explicit user override in Deck's
   * delegate instruction. Keeping it here makes the GUI acceptance path
   * deterministic without asking a model to interpret the prompt.
   */
  private isDirectHandlingOverride(text: string): boolean {
    return /\bhandle(?:\s+this)?\s+directly\b/i.test(text);
  }

  private completePrompt(assistantId: string, text: string): void {
    const decision = this.workflowDecision(text);
    const chunks =
      decision !== undefined
        ? [String(decision)]
        : this.options.promptScenario === "routing"
          ? [
              "Ordinary routing fixture accepted ",
              `(${this.options.taskRoutingFixture ?? "default"}).`,
            ]
          : this.options.productionShaped
            ? ["I’ll review the workspace", " and summarize the next steps."]
            : ["Fake response", " to: ", text || "(empty prompt)"];
    let accumulated = "";
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
            this.write({ type: "agent_settled" });
          }
        },
        this.options.streamDelayMs * (chunks.length + 1),
      ),
    );
  }

  private workflowDecision(text: string): boolean | undefined {
    if (!text.includes("Return exactly true or false, with no other text."))
      return undefined;
    const stateFile = this.options.workflowDecisionStateFile;
    const index = stateFile
      ? this.allocateWorkflowDecisionIndex(stateFile)
      : this.workflowDecisionIndex;
    const decision = this.options.workflowDecisions[index];
    if (decision === undefined) return undefined;
    if (!stateFile) this.workflowDecisionIndex += 1;
    return decision;
  }

  /** Allocate across independent fake Pi processes without duplicate decisions. */
  private allocateWorkflowDecisionIndex(stateFile: string): number {
    const lockFile = `${stateFile}.lock`;
    let lock: number | undefined;
    while (lock === undefined) {
      try {
        lock = fs.openSync(lockFile, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      const index =
        Number.parseInt(fs.readFileSync(stateFile, "utf8"), 10) || 0;
      fs.writeFileSync(stateFile, String(index + 1));
      return index;
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(lockFile);
    }
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
        toolName: "read",
      });
      this.write({
        type: "tool_execution_update",
        toolCallId: "tool_fake_1",
        toolName: "read",
        output: "partial tool output",
      });
      this.write({
        type: "tool_execution_end",
        toolCallId: "tool_fake_1",
        toolName: "read",
        status: "completed",
        output: "final tool output",
      });
    }

    if (shouldEmit("extension-ui")) {
      const method = this.options.extensionUiMethod;
      this.write({
        type: "extension_ui_request",
        id: "ext_fake_dialog_1",
        messageId: assistantId,
        method,
        title: this.options.productionShaped
          ? "Workspace approval"
          : `Fake ${method}`,
        ...(method === "confirm"
          ? {
              message: this.options.productionShaped
                ? "Allow Pi to continue with this workspace action?"
                : "Approve fake extension UI request?",
            }
          : {}),
        ...(method === "select" ? { options: ["Allow", "Block"] } : {}),
        ...(method === "input" ? { placeholder: "Type a fake value" } : {}),
        ...(method === "editor" ? { prefill: "Fake editable text" } : {}),
        timeout: 5_000,
      });
    }
  }

  private handleExtensionUiResponse(command: FakeCommandRecord): void {
    const id = typeof command.id === "string" ? command.id : undefined;
    const pending = this.pendingExtensionUi;
    if (id === undefined || pending === undefined || pending.id !== id) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingExtensionUi = undefined;
    this.completePrompt(pending.assistantId, pending.promptText);
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
    this.write({ type: "agent_settled" });
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
