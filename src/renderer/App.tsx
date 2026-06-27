import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import type {
  AppSettings,
  ChatMessage,
  ChatRuntimeEvent,
  ChatSnapshot,
  DiagnosticsSummary,
} from "../shared/types.js";
import {
  parseSafeMarkdown,
  type InlineToken,
  type MarkdownBlock,
} from "./markdown.js";

type LoadState =
  | { state: "loading" }
  | {
      state: "ready";
      version: string;
      settings: AppSettings;
      diagnostics: DiagnosticsSummary;
    }
  | { state: "error"; message: string };

type SessionStatus = "idle" | "working" | "waiting" | "error";

type TimelineItem =
  | {
      id: string;
      kind: "user";
      content: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "assistant";
      content: string;
      createdAt: string;
      streaming?: boolean;
    }
  | {
      id: string;
      kind: "diagnostic";
      tone: "info" | "error";
      content: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "tool";
      title: string;
      status: "collapsed" | "running";
      summary: string;
      createdAt: string;
    };

interface SessionViewModel {
  id: string;
  title: string;
  project: string;
  subtitle: string;
  status: SessionStatus;
  updatedAt: string;
  timeline: TimelineItem[];
  modelLabel?: string;
  thinkingLevel?: string;
}

const initialSessions: SessionViewModel[] = [
  {
    id: "session-active",
    title: "Frontend chat shell",
    project: "pi-deck",
    subtitle: "Idle · fake IPC fixture",
    status: "idle",
    updatedAt: "Now",
    timeline: [
      {
        id: "welcome-user",
        kind: "user",
        content: "Build the first usable Pi Deck renderer shell.",
        createdAt: "09:41",
      },
      {
        id: "welcome-assistant",
        kind: "assistant",
        content:
          "# Welcome to Pi Deck\n\nThis is a chat-centered Electron renderer shell backed by fake data for now. Try sending a multiline prompt to see a streamed, sanitized markdown response.",
        createdAt: "09:42",
      },
      {
        id: "placeholder-tool",
        kind: "tool",
        title: "Tool card placeholder",
        status: "collapsed",
        summary:
          "Full tool rendering is reserved for M7; this compact row shows the intended timeline slot.",
        createdAt: "09:42",
      },
    ],
  },
  {
    id: "session-working",
    title: "RPC adapter spike",
    project: "pi-deck",
    subtitle: "Working · background placeholder",
    status: "working",
    updatedAt: "3m ago",
    timeline: [
      {
        id: "working-diagnostic",
        kind: "diagnostic",
        tone: "info",
        content:
          "Background worker state is mocked here; real multi-session event routing arrives in later milestones.",
        createdAt: "09:34",
      },
    ],
  },
  {
    id: "session-waiting",
    title: "Extension approval",
    project: "example-app",
    subtitle: "Waiting for user input",
    status: "waiting",
    updatedAt: "Yesterday",
    timeline: [],
  },
  {
    id: "session-error",
    title: "Old diagnostics run",
    project: "archive",
    subtitle: "Error · worker exited",
    status: "error",
    updatedAt: "Jun 26",
    timeline: [
      {
        id: "error-item",
        kind: "diagnostic",
        tone: "error",
        content: "Mock error state: failed to attach fake worker.",
        createdAt: "18:02",
      },
    ],
  },
];

export function App(): ReactElement {
  const [loadState, setLoadState] = useState<LoadState>({ state: "loading" });
  const [sessions, setSessions] = useState(initialSessions);
  const [selectedSessionId, setSelectedSessionId] = useState("session-active");
  const [draft, setDraft] = useState("");
  const [composerError, setComposerError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    async function load(): Promise<void> {
      try {
        const api = Reflect.get(window, "piDeck") as
          | typeof window.piDeck
          | undefined;
        if (api === undefined) {
          throw new Error("Preload API window.piDeck is unavailable");
        }
        unsubscribe = api.chat.onEvent((event) => {
          if (!disposed) {
            applyRuntimeEvent(event);
          }
        });
        const [version, settings, diagnostics, snapshot] = await Promise.all([
          api.app.getVersion(),
          api.settings.get(),
          api.app.getDiagnosticsSummary(),
          api.chat.getSnapshot(),
        ]);
        if (!disposed) {
          const backendSession = sessionFromSnapshot(snapshot);
          setSessions([
            backendSession,
            ...initialSessions.filter(
              (session) => session.id !== "session-active",
            ),
          ]);
          setSelectedSessionId(backendSession.id);
          setLoadState({ state: "ready", version, settings, diagnostics });
        }
      } catch (error) {
        if (!disposed) {
          setLoadState({
            state: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    void load();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const nodeAccessSummary = useMemo(() => getRendererNodeAccessSummary(), []);
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ??
    sessions[0] ??
    initialSessions[0]!;
  const isWorking = selectedSession.status === "working";
  const canSend = draft.trim().length > 0 && !isWorking;

  function handleSend(): void {
    if (!canSend) {
      return;
    }

    void sendPrompt(selectedSession.id, draft.trimEnd());
  }

  async function sendPrompt(runtimeId: string, prompt: string): Promise<void> {
    const now = formatTime();
    setComposerError(null);
    setDraft("");
    setSessions((current) =>
      current.map((session) =>
        session.id === runtimeId
          ? {
              ...session,
              status: "working",
              subtitle: "Working · backend fake RPC stream",
              updatedAt: "Now",
              timeline: [
                ...session.timeline,
                {
                  id: createId("user"),
                  kind: "user",
                  content: prompt,
                  createdAt: now,
                },
              ],
            }
          : session,
      ),
    );

    try {
      await window.piDeck.chat.prompt({ runtimeId, text: prompt });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
      setSessions((current) =>
        current.map((session) =>
          session.id === runtimeId
            ? appendDiagnostic(session, {
                tone: "error",
                content: `Prompt failed: ${error instanceof Error ? error.message : String(error)}`,
              })
            : session,
        ),
      );
    }
  }

  function handleAbort(): void {
    void abortPrompt(selectedSession.id);
  }

  async function abortPrompt(runtimeId: string): Promise<void> {
    setComposerError(null);
    try {
      await window.piDeck.chat.abort({ runtimeId });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
      setSessions((current) =>
        current.map((session) =>
          session.id === runtimeId
            ? appendDiagnostic(session, {
                tone: "error",
                content: `Abort failed: ${error instanceof Error ? error.message : String(error)}`,
              })
            : session,
        ),
      );
    }
  }

  function applyRuntimeEvent(event: ChatRuntimeEvent): void {
    setSessions((current) =>
      current.map((session) =>
        session.id === event.runtimeId
          ? reduceRuntimeEvent(session, event)
          : session,
      ),
    );
  }

  function handleComposerKeyDown(
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      handleSend();
    }
  }

  return (
    <main className="app-shell">
      <SessionSidebar
        sessions={sessions}
        selectedSessionId={selectedSession.id}
        onSelect={setSelectedSessionId}
      />

      <section className="workspace" aria-label="Pi Deck chat workspace">
        <AppHeader
          loadState={loadState}
          nodeAccessSummary={nodeAccessSummary}
          selectedSession={selectedSession}
        />

        <ChatTimeline session={selectedSession} />

        <Composer
          value={draft}
          isWorking={isWorking}
          canSend={canSend}
          error={composerError}
          onChange={setDraft}
          onKeyDown={handleComposerKeyDown}
          onSend={handleSend}
          onAbort={handleAbort}
        />
      </section>
    </main>
  );
}

function sessionFromSnapshot(snapshot: ChatSnapshot): SessionViewModel {
  const modelLabel = [snapshot.state.provider, snapshot.state.model]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(" / ");

  const session: SessionViewModel = {
    id: snapshot.runtimeId,
    title: "Backend fake RPC session",
    project: snapshot.state.cwd?.split(/[\\/]/).pop() ?? "pi-deck",
    subtitle: snapshot.state.isAgentActive
      ? "Working · backend fake RPC"
      : "Idle · backend fake RPC ready",
    status: snapshot.state.isAgentActive ? "working" : "idle",
    updatedAt: "Now",
    timeline: timelineFromMessages(snapshot.messages),
  };
  if (modelLabel.length > 0) {
    session.modelLabel = modelLabel;
  }
  if (snapshot.state.thinkingLevel !== undefined) {
    session.thinkingLevel = snapshot.state.thinkingLevel;
  }
  return session;
}

function timelineFromMessages(messages: ChatMessage[]): TimelineItem[] {
  const timeline = messages.flatMap((message): TimelineItem[] => {
    const content = typeof message.content === "string" ? message.content : "";
    const createdAt = formatMessageTime(message.createdAt);

    if (message.role === "user") {
      return [{ id: message.id, kind: "user", content, createdAt }];
    }

    if (message.role === "assistant") {
      return [{ id: message.id, kind: "assistant", content, createdAt }];
    }

    if (message.role === "tool") {
      return [
        {
          id: message.id,
          kind: "tool",
          title: "Tool output placeholder",
          status: "collapsed",
          summary: content || "Tool output rendering arrives in M7.",
          createdAt,
        },
      ];
    }

    if (message.role === "system" && content.length > 0) {
      return [
        {
          id: message.id,
          kind: "diagnostic",
          tone: "info",
          content,
          createdAt,
        },
      ];
    }

    return [];
  });

  if (timeline.length > 0) {
    return timeline;
  }

  return [
    {
      id: "backend-empty-diagnostic",
      kind: "diagnostic",
      tone: "info",
      content:
        "Connected to the backend fake RPC worker. Send a prompt to stream assistant output through preload IPC.",
      createdAt: formatTime(),
    },
  ];
}

function reduceRuntimeEvent(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  switch (event.type) {
    case "agent_start":
      return {
        ...session,
        status: "working",
        subtitle: "Working · backend fake RPC stream",
        updatedAt: "Now",
      };
    case "message_update":
      return reduceMessageUpdate(session, event);
    case "agent_end": {
      const status = getString(event, "status");
      return {
        ...session,
        status: "idle",
        subtitle:
          status === "aborted"
            ? "Idle · backend stream aborted"
            : "Idle · backend stream complete",
        updatedAt: "Now",
        timeline: session.timeline.map((item) =>
          item.kind === "assistant" && item.streaming === true
            ? { ...item, streaming: false }
            : item,
        ),
      };
    }
    case "diagnostic":
      return appendDiagnostic(session, {
        tone: getString(event, "level") === "error" ? "error" : "info",
        content: getString(event, "message") ?? "Backend diagnostic event",
      });
    case "worker_exit":
      return appendDiagnostic(
        {
          ...session,
          status: "error",
          subtitle: "Error · backend worker exited",
        },
        {
          tone: "error",
          content: `Backend fake RPC worker exited (code=${String(getUnknown(event, "code") ?? "null")}).`,
        },
      );
    default:
      return session;
  }
}

function reduceMessageUpdate(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  const messageId = getString(event, "messageId") ?? createId("assistant");
  const done = getBoolean(event, "done") ?? false;
  const content =
    getString(event, "content") ?? getString(event, "delta") ?? "";
  let found = false;

  const timeline = session.timeline.map((item) => {
    if (item.kind !== "assistant" || item.id !== messageId) {
      return item;
    }
    found = true;
    return {
      ...item,
      content,
      streaming: !done,
    };
  });

  if (!found) {
    timeline.push({
      id: messageId,
      kind: "assistant",
      content,
      createdAt: formatTime(),
      streaming: !done,
    });
  }

  return {
    ...session,
    status: done ? "idle" : "working",
    subtitle: done
      ? "Idle · backend stream complete"
      : "Working · backend fake RPC stream",
    updatedAt: "Now",
    timeline,
  };
}

function appendDiagnostic(
  session: SessionViewModel,
  diagnostic: { tone: "info" | "error"; content: string },
): SessionViewModel {
  return {
    ...session,
    status: diagnostic.tone === "error" ? "error" : session.status,
    updatedAt: "Now",
    timeline: [
      ...session.timeline,
      {
        id: createId("diagnostic"),
        kind: "diagnostic",
        tone: diagnostic.tone,
        content: diagnostic.content,
        createdAt: formatTime(),
      },
    ],
  };
}

function getString(event: ChatRuntimeEvent, key: string): string | undefined {
  const value = getUnknown(event, key);
  return typeof value === "string" ? value : undefined;
}

function getBoolean(event: ChatRuntimeEvent, key: string): boolean | undefined {
  const value = getUnknown(event, key);
  return typeof value === "boolean" ? value : undefined;
}

function getUnknown(event: ChatRuntimeEvent, key: string): unknown {
  return (event as Record<string, unknown>)[key];
}

function formatMessageTime(timestamp: number | undefined): string {
  if (timestamp === undefined) {
    return formatTime();
  }
  const date = new Date(
    timestamp > 10_000_000_000 ? timestamp : timestamp * 1000,
  );
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function SessionSidebar(props: {
  sessions: SessionViewModel[];
  selectedSessionId: string;
  onSelect(sessionId: string): void;
}): ReactElement {
  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-header">
        <div>
          <p className="eyebrow dark">Local projects</p>
          <div className="brand">Pi Deck</div>
        </div>
        <button
          className="icon-button"
          type="button"
          disabled
          aria-label="New session placeholder"
        >
          +
        </button>
      </div>

      <button className="new-session" type="button" disabled>
        + New session
      </button>

      <section className="session-list" aria-label="Placeholder session list">
        {props.sessions.map((session) => (
          <button
            key={session.id}
            className={`session-item ${session.id === props.selectedSessionId ? "active" : ""}`}
            type="button"
            onClick={() => {
              props.onSelect(session.id);
            }}
          >
            <span className={`dot ${session.status}`} aria-hidden="true" />
            <span className="session-copy">
              <span className="session-title">{session.title}</span>
              <span className="session-meta">{session.subtitle}</span>
            </span>
            <span className="session-time">{session.updatedAt}</span>
          </button>
        ))}
      </section>

      <div className="sidebar-note">
        Sidebar data is mocked until session repository/resume work lands.
      </div>
    </aside>
  );
}

function AppHeader(props: {
  loadState: LoadState;
  nodeAccessSummary: string;
  selectedSession: SessionViewModel;
}): ReactElement {
  return (
    <header className="topbar">
      <div className="title-block">
        <p className="eyebrow">Project / Session</p>
        <h1>
          {props.selectedSession.project} / {props.selectedSession.title}
        </h1>
        <span className={`status-pill ${props.selectedSession.status}`}>
          {statusLabel(props.selectedSession.status)}
        </span>
      </div>

      <div className="header-right">
        <div className="model-controls" aria-label="Model placeholders">
          <span>
            Model: {props.selectedSession.modelLabel ?? "placeholder"}
          </span>
          <span>
            Thinking: {props.selectedSession.thinkingLevel ?? "placeholder"}
          </span>
        </div>
        <LoadStateBadge
          loadState={props.loadState}
          nodeAccessSummary={props.nodeAccessSummary}
        />
      </div>
    </header>
  );
}

function LoadStateBadge(props: {
  loadState: LoadState;
  nodeAccessSummary: string;
}): ReactElement {
  if (props.loadState.state === "loading") {
    return <span className="diagnostic-badge">Loading preload API…</span>;
  }

  if (props.loadState.state === "error") {
    return (
      <span className="diagnostic-badge error" title={props.loadState.message}>
        Preload error
      </span>
    );
  }

  return (
    <span
      className="diagnostic-badge"
      title={`${props.nodeAccessSummary}; userData: ${props.loadState.diagnostics.userDataPath}`}
    >
      v{props.loadState.version} · secure renderer
    </span>
  );
}

function ChatTimeline(props: { session: SessionViewModel }): ReactElement {
  const hasItems = props.session.timeline.length > 0;
  return (
    <section className="timeline-shell" aria-label="Chat / Agent Timeline">
      <div className="timeline-scroll">
        {!hasItems ? (
          <EmptyTimelineState status={props.session.status} />
        ) : null}
        {props.session.status === "error" ? (
          <div className="state-banner error">
            This session is in an error state.
          </div>
        ) : null}
        {props.session.status === "waiting" ? (
          <div className="state-banner waiting">
            This placeholder session is waiting for user input.
          </div>
        ) : null}

        {props.session.timeline.map((item) => (
          <TimelineRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

function EmptyTimelineState(props: { status: SessionStatus }): ReactElement {
  const copy =
    props.status === "waiting"
      ? "A pending input request will appear here once extension UI wiring exists."
      : "Send a prompt to start a fake streamed assistant response.";

  return (
    <div className="empty-state">
      <div className="empty-icon">◇</div>
      <h2>No messages yet</h2>
      <p>{copy}</p>
    </div>
  );
}

function TimelineRow(props: { item: TimelineItem }): ReactElement {
  if (props.item.kind === "user") {
    return (
      <article className="timeline-row user-row">
        <div className="bubble user-bubble">
          <p>{props.item.content}</p>
          <time>{props.item.createdAt}</time>
        </div>
      </article>
    );
  }

  if (props.item.kind === "assistant") {
    return (
      <article className="timeline-row assistant-row">
        <div className="assistant-avatar">π</div>
        <div className="assistant-message">
          <MarkdownView markdown={props.item.content} />
          {props.item.streaming === true ? (
            <span
              className="stream-caret"
              aria-label="Assistant is streaming"
            />
          ) : null}
          <time>{props.item.createdAt}</time>
        </div>
      </article>
    );
  }

  if (props.item.kind === "tool") {
    return (
      <article className="tool-card">
        <div>
          <p className="tool-title">{props.item.title}</p>
          <p>{props.item.summary}</p>
        </div>
        <span className="tool-status">{props.item.status}</span>
      </article>
    );
  }

  return (
    <article className={`diagnostic-message ${props.item.tone}`}>
      <strong>{props.item.tone === "error" ? "Error" : "Diagnostic"}</strong>
      <span>{props.item.content}</span>
    </article>
  );
}

function MarkdownView(props: { markdown: string }): ReactElement {
  const blocks = useMemo(
    () => parseSafeMarkdown(props.markdown),
    [props.markdown],
  );

  if (blocks.length === 0) {
    return <p className="stream-placeholder">Waiting for assistant output…</p>;
  }

  return (
    <div className="markdown-body">
      {blocks.map((block, index) => (
        <MarkdownBlockView block={block} key={`${block.type}-${index}`} />
      ))}
    </div>
  );
}

function MarkdownBlockView(props: { block: MarkdownBlock }): ReactElement {
  switch (props.block.type) {
    case "heading": {
      const HeadingTag = `h${props.block.level}` as "h1" | "h2" | "h3";
      return (
        <HeadingTag>
          <InlineTokens tokens={props.block.children} />
        </HeadingTag>
      );
    }
    case "list":
      return (
        <ul>
          {props.block.items.map((item, index) => (
            <li key={index}>
              <InlineTokens tokens={item} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote>
          <InlineTokens tokens={props.block.children} />
        </blockquote>
      );
    case "code":
      return (
        <pre>
          <code>{props.block.code}</code>
        </pre>
      );
    case "paragraph":
      return (
        <p>
          <InlineTokens tokens={props.block.children} />
        </p>
      );
  }
}

function InlineTokens(props: { tokens: InlineToken[] }): ReactElement {
  return (
    <>
      {props.tokens.map((token, index) => {
        if (token.type === "code") {
          return <code key={index}>{token.text}</code>;
        }
        if (token.type === "strong") {
          return (
            <strong key={index}>
              <InlineTokens tokens={token.children} />
            </strong>
          );
        }
        if (token.type === "link") {
          return (
            <a
              href={token.href}
              key={index}
              onClick={(event) => {
                event.preventDefault();
                window.open(token.href, "_blank", "noopener,noreferrer");
              }}
              rel="noreferrer"
              target="_blank"
            >
              {token.text}
            </a>
          );
        }
        return <span key={index}>{token.text}</span>;
      })}
    </>
  );
}

function Composer(props: {
  value: string;
  isWorking: boolean;
  canSend: boolean;
  error: string | null;
  onChange(value: string): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onSend(): void;
  onAbort(): void;
}): ReactElement {
  return (
    <footer className="composer" aria-label="Prompt composer">
      <button
        className="attachment-button"
        type="button"
        disabled
        aria-label="Attachment placeholder"
      >
        +
      </button>
      <div className="composer-input-wrap">
        <textarea
          aria-label="Prompt text"
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
          onKeyDown={props.onKeyDown}
          placeholder="Prompt Pi Deck… (⌘/Ctrl + Enter to send)"
          rows={3}
          value={props.value}
        />
        <div className="composer-meta">
          {props.error !== null ? (
            <span className="composer-error">{props.error}</span>
          ) : props.isWorking ? (
            <span>Streaming from backend fake RPC…</span>
          ) : (
            <span>Backend fake RPC active · attachments come later</span>
          )}
        </div>
      </div>
      {props.isWorking ? (
        <button
          className="send-button abort"
          type="button"
          onClick={props.onAbort}
        >
          Abort
        </button>
      ) : (
        <button
          className="send-button"
          type="button"
          disabled={!props.canSend}
          onClick={props.onSend}
        >
          Send
        </button>
      )}
    </footer>
  );
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "working":
      return "Working";
    case "waiting":
      return "Needs input";
    case "error":
      return "Error";
    case "idle":
      return "Idle";
  }
}

function formatTime(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getRendererNodeAccessSummary(): string {
  const hasProcess = Reflect.get(globalThis, "process") !== undefined;
  const hasRequire = Reflect.get(globalThis, "require") !== undefined;
  return hasProcess || hasRequire
    ? "unexpected Node globals visible"
    : "no process/require globals visible";
}
