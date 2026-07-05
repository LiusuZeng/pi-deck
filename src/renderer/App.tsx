import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import type {
  AppSettings,
  AttachmentDraft,
  ChatMessage,
  ChatModelSummary,
  ChatRuntimeEvent,
  ChatSessionSummary,
  ChatSnapshot,
  DiagnosticsSummary,
  ProjectRef,
} from "../shared/types.js";
import {
  parseSafeMarkdown,
  type InlineToken,
  type MarkdownBlock,
} from "./markdown.js";
import {
  emptyOverlays,
  selectSidebarIndicator,
  type BaseSessionState,
  type SessionOverlays,
} from "./sessionState.js";

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

interface TimelineAttachment {
  id: string;
  fileName: string;
  kind: AttachmentDraft["kind"];
  sendMode: AttachmentDraft["sendMode"];
  mimeType?: string;
  previewDataUrl?: string;
}

type TimelineItem =
  | {
      id: string;
      kind: "user";
      content: string;
      createdAt: string;
      attachments?: TimelineAttachment[];
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
      kind: "thinking";
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
      details: string;
      createdAt: string;
    };

interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  totalCostUsd?: number;
}

interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd?: number;
}

interface SessionViewModel {
  id: string;
  title: string;
  project: string;
  projectPath: string;
  subtitle: string;
  status: SessionStatus;
  updatedAt: string;
  updatedAtMs: number;
  timeline: TimelineItem[];
  baseState: BaseSessionState;
  overlays: SessionOverlays;
  usageStats?: UsageStats;
  usageByMessageId?: Record<string, MessageUsage>;
  modelLabel?: string;
  thinkingLevel?: string;
  lastError?: string;
  runtimeBacked: boolean;
  backendMode?: "fake" | "real";
  sessionFile?: string;
  resumeBacked?: boolean;
}

interface ModelOption {
  provider: string;
  id: string;
  displayName: string;
  supportsImages: boolean;
  supportsThinking: boolean;
  contextWindow?: string;
  unavailableReason?: string;
}

interface ThinkingOption {
  id: string;
  label: string;
  supported: boolean;
  note?: string;
}

interface SlashCommand {
  name: string;
  description: string;
  source: "extension" | "prompt template" | "skill";
}

const appStartedAt = Date.now();

const modelOptions: ModelOption[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4.5",
    displayName: "Claude Sonnet 4.5",
    supportsImages: true,
    supportsThinking: true,
    contextWindow: "200k",
  },
  {
    provider: "openai",
    id: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    supportsImages: false,
    supportsThinking: true,
    contextWindow: "128k",
  },
  {
    provider: "local",
    id: "offline-placeholder",
    displayName: "Offline placeholder",
    supportsImages: false,
    supportsThinking: false,
    unavailableReason: "Unavailable until provider/auth setup is complete",
  },
];

const thinkingOptions: ThinkingOption[] = [
  { id: "off", label: "Off", supported: true },
  { id: "low", label: "Low", supported: true },
  { id: "medium", label: "Medium", supported: true },
  { id: "high", label: "High", supported: true },
  {
    id: "max",
    label: "Max",
    supported: false,
    note: "Unsupported by current model",
  },
];

const realThinkingLevels = ["off", "low", "medium", "high", "xhigh"];

const slashCommands: SlashCommand[] = [
  {
    name: "/skill:frontend-polish",
    description: "Apply frontend polish checklist to the current prompt.",
    source: "skill",
  },
  {
    name: "/review",
    description: "Prompt template returned by the active Pi worker.",
    source: "prompt template",
  },
  {
    name: "/extension:open-pr",
    description: "Extension command exposed by get_commands.",
    source: "extension",
  },
];

const initialSessions: SessionViewModel[] = [
  {
    id: "session-active",
    title: "Local demo session",
    project: "Pi Deck",
    projectPath: "Local demo project",
    subtitle: "Idle · local demo backend",
    status: "idle",
    updatedAt: "Now",
    updatedAtMs: appStartedAt,
    baseState: "idle",
    overlays: { ...emptyOverlays },
    runtimeBacked: false,
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
          "# Welcome to Pi Deck\n\nThis is a chat-centered Electron renderer shell backed by sample data when no real backend is selected. Try sending a multiline prompt to see a streamed, sanitized markdown response.",
        createdAt: "09:42",
      },
      {
        id: "placeholder-tool",
        kind: "tool",
        title: "Tool output example",
        status: "collapsed",
        summary: "Tool activity appears as expandable cards in the timeline.",
        details: "Tool details appear here when expanded.",
        createdAt: "09:42",
      },
    ],
  },
  fixtureSession(
    "session-needs",
    "Extension approval request",
    "waitingForInput",
    {
      needsUserInput: true,
    },
  ),
  fixtureSession(
    "session-error",
    "Failed dependency install",
    "error",
    {},
    "Tool exited 1",
  ),
  fixtureSession("session-attach", "Opening old session", "attaching"),
  fixtureSession("session-compact", "Large refactor plan", "working", {
    compacting: true,
  }),
  fixtureSession("session-retry", "Provider retry", "working", {
    retrying: true,
  }),
  fixtureSession("session-tool", "Apply edit patch", "working", {
    toolRunning: true,
  }),
  fixtureSession("session-stream", "Streaming explanation", "working", {
    streaming: true,
  }),
  fixtureSession("session-queued", "Queued follow-ups", "idle", {
    localQueuedStartCount: 1,
    piQueuedSteeringCount: 1,
  }),
  fixtureSession("session-exited", "Closed session", "exited"),
  fixtureSession("session-unloaded", "Older unloaded session", "unloaded"),
];

const invalidRecentProject: ProjectRef = {
  id: "missing-demo",
  path: "Example deleted project",
  canonicalPath: "Example deleted project",
  displayName: "Deleted project",
  lastOpenedAt: appStartedAt - 86_400_000,
  invalidReason: "Project folder is missing or no longer readable.",
};

const loadingSession: SessionViewModel = {
  id: "loading-session",
  title: "Connecting to Pi…",
  project: "Pi Deck",
  projectPath: "Resolving backend session",
  subtitle: "Starting backend…",
  status: "idle",
  updatedAt: "Now",
  updatedAtMs: appStartedAt,
  baseState: "attaching",
  overlays: { ...emptyOverlays },
  runtimeBacked: false,
  backendMode: "real",
  timeline: [],
};

const fakeAttachmentFixture: AttachmentDraft[] = [
  {
    id: "fake-path-src",
    selectedPathToken: "token-src",
    fileName: "src/App.tsx",
    displayPath: "src/App.tsx",
    kind: "textFile",
    sendMode: "pathReference",
    outsideProject: false,
    status: "ready",
  },
  {
    id: "fake-image",
    selectedPathToken: "token-image",
    fileName: "screenshot.png",
    displayPath: "design/screenshot.png",
    mimeType: "image/png",
    kind: "image",
    sendMode: "imageInput",
    outsideProject: false,
    status: "ready",
  },
  {
    id: "fake-outside",
    selectedPathToken: "token-outside",
    fileName: "notes.pdf",
    displayPath: "/Users/example/Desktop/notes.pdf",
    kind: "binaryFile",
    sendMode: "pathReference",
    outsideProject: true,
    status: "ready",
    warning: "Outside selected project; referenced by absolute path only.",
  },
  {
    id: "fake-missing",
    selectedPathToken: "token-missing",
    fileName: "deleted.txt",
    displayPath: "docs/deleted.txt",
    kind: "textFile",
    sendMode: "pathReference",
    outsideProject: false,
    status: "missing",
    warning: "Deleted or unreadable; remove or reselect before sending.",
  },
];

export function App(): ReactElement {
  const [loadState, setLoadState] = useState<LoadState>({ state: "loading" });
  const [sessions, setSessions] = useState<SessionViewModel[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const [composerError, setComposerError] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<ProjectRef>(() => ({
    id: "pending-project",
    path: "Resolving project…",
    canonicalPath: "",
    displayName: "Pi Deck",
    lastOpenedAt: appStartedAt,
  }));
  const [recentProjects, setRecentProjects] = useState<ProjectRef[]>(() =>
    loadRecentProjects(),
  );
  const [selectedModelId, setSelectedModelId] = useState(
    modelOptions[0]?.id ?? "",
  );
  const [selectedThinking, setSelectedThinking] = useState("medium");
  const [slashOpen, setSlashOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [realModels, setRealModels] = useState<ChatModelSummary[]>([]);
  const [enterToSend, setEnterToSend] = useState(() =>
    loadEnterToSendPreference(),
  );
  const [sidebarVisible, setSidebarVisible] = useState(() =>
    loadSidebarVisiblePreference(),
  );
  const [usageStatsVisible, setUsageStatsVisible] = useState(() =>
    loadUsageStatsVisiblePreference(),
  );
  const [uiMessage, setUiMessage] = useState(
    "Starting Pi Deck and resolving the active backend session.",
  );

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
        const deckApi = api;
        async function refreshRuntimeUsage(runtimeId: string): Promise<void> {
          try {
            const snapshot = await deckApi.chat.getSnapshot();
            if (disposed || snapshot.runtimeId !== runtimeId) {
              return;
            }
            const refreshed = sessionFromSnapshot(snapshot);
            setSessions((items) =>
              items.map((item) =>
                item.id === runtimeId
                  ? mergeSessionUsageFromSnapshot(item, refreshed)
                  : item,
              ),
            );
          } catch {
            // Usage is best-effort; keep the streamed conversation visible.
          }
        }

        unsubscribe = api.chat.onEvent((event) => {
          if (!disposed) {
            applyRuntimeEvent(event);
            if (event.type === "agent_end") {
              void refreshRuntimeUsage(event.runtimeId);
            }
          }
        });
        const [version, settings, diagnostics, snapshot] = await Promise.all([
          api.app.getVersion(),
          api.settings.get(),
          api.app.getDiagnosticsSummary(),
          api.chat.getSnapshot(),
        ]);
        const listedSessions =
          snapshot.backendMode === "real"
            ? await api.chat.listSessions()
            : undefined;
        if (!disposed) {
          const backendSession = sessionFromSnapshot(snapshot);
          setSessions(
            snapshot.backendMode === "real"
              ? mergeSessions(
                  [backendSession],
                  (listedSessions?.sessions ?? []).map(sessionFromSummary),
                )
              : [
                  backendSession,
                  ...initialSessions.filter(
                    (session) => session.id !== "session-active",
                  ),
                ],
          );
          setSelectedSessionId(backendSession.id);
          if (snapshot.backendMode === "real" && snapshot.state.cwd) {
            setCurrentProject(projectFromCwd(snapshot.state.cwd));
          }
          if (snapshot.backendMode === "real") {
            void loadRealModels(backendSession.id);
          }
          setUiMessage(
            snapshot.backendMode === "real"
              ? `Real Pi mode active. Found ${listedSessions?.sessions.length ?? 0} persisted session(s) for this project; click one to resume.`
              : "Local demo mode active. Demo backend is ready.",
          );
          setLoadState({ state: "ready", version, settings, diagnostics });
        }
      } catch (error) {
        if (!disposed) {
          const message =
            error instanceof Error ? error.message : String(error);
          setSessions([startupErrorSession(message)]);
          setSelectedSessionId("startup-error");
          setComposerError(
            "Real Pi backend is not attached. Fully quit and relaunch from the intended project directory.",
          );
          setUiMessage(`Startup error: ${message}`);
          setLoadState({
            state: "error",
            message,
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
    loadingSession;
  const selectedModel =
    modelOptions.find((model) => model.id === selectedModelId) ??
    modelOptions[0];
  const isWorking = selectedSession.status === "working";
  const isRealBackendMode = selectedSession.backendMode === "real";
  const hasBlockingAttachment = attachments.some(
    (attachment) => attachment.status !== "ready",
  );
  const hasImageAttachment = attachments.some(
    (attachment) => attachment.kind === "image",
  );
  const canSend =
    draft.trim().length > 0 && !isWorking && loadState.state === "ready";
  const filteredCommands = slashCommands.filter((command) =>
    command.name.toLowerCase().includes(draft.trim().toLowerCase()),
  );
  const showStarterPage =
    selectedSession.timeline.length === 0 && selectedSession.status === "idle";

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
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    if (enterToSend || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      handleSend();
    }
  }

  function handleEnterToSendChange(value: boolean): void {
    setEnterToSend(value);
    saveEnterToSendPreference(value);
  }

  function handleSidebarVisibleChange(value: boolean): void {
    setSidebarVisible(value);
    saveSidebarVisiblePreference(value);
  }

  function handleUsageStatsVisibleChange(value: boolean): void {
    setUsageStatsVisible(value);
    saveUsageStatsVisiblePreference(value);
  }

  function handleDraftChange(value: string): void {
    setDraft(value);
    setSlashOpen(value.trimStart().startsWith("/"));
  }

  function handleSelectSession(sessionId: string): void {
    const session = sessions.find((item) => item.id === sessionId);
    if (
      session?.backendMode === "real" &&
      session.resumeBacked === true &&
      session.sessionFile !== undefined
    ) {
      void resumeSession(session);
      return;
    }
    setSelectedSessionId(sessionId);
  }

  async function resumeSession(
    session: SessionViewModel,
  ): Promise<SessionViewModel | undefined> {
    if (session.sessionFile === undefined) {
      return undefined;
    }
    setComposerError(null);
    setSelectedSessionId(session.id);
    setUiMessage(`Resuming ${session.title}…`);
    try {
      const snapshot = await window.piDeck.chat.resumeSession({
        sessionFile: session.sessionFile,
      });
      const resumed = sessionFromSnapshot(snapshot);
      setSessions((items) =>
        mergeSessions(
          [resumed],
          items.filter((item) => item.id !== session.id),
        ),
      );
      setSelectedSessionId(resumed.id);
      void loadRealModels(resumed.id);
      setUiMessage("Resumed saved Pi session.");
      return resumed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingSessionFileError(message)) {
        const remainingSessions = sessions.filter(
          (item) => item.id !== session.id,
        );
        setSessions(remainingSessions);
        if (selectedSessionId === session.id) {
          const nextSession =
            remainingSessions.find((item) => item.runtimeBacked) ??
            remainingSessions[0];
          if (nextSession !== undefined) {
            setSelectedSessionId(nextSession.id);
          }
        }
        setUiMessage(
          "Saved session file is missing or unreadable. Removed it from the list.",
        );
        return undefined;
      }
      setUiMessage(`Failed to resume session: ${message}`);
      setSessions((items) =>
        items.map((item) =>
          item.id === session.id
            ? appendDiagnostic(
                { ...item, status: "error", baseState: "error" },
                { tone: "error", content: `Resume failed: ${message}` },
              )
            : item,
        ),
      );
      return undefined;
    }
  }

  async function resumeSessionAndSend(
    session: SessionViewModel,
    prompt: string,
    promptAttachments: AttachmentDraft[],
  ): Promise<void> {
    const resumed = await resumeSession(session);
    if (resumed !== undefined) {
      await sendPrompt(resumed.id, prompt, promptAttachments);
    }
  }

  function handleSend(): void {
    if (!canSend) {
      return;
    }
    if (
      selectedSession.resumeBacked === true &&
      selectedSession.sessionFile !== undefined
    ) {
      void resumeSessionAndSend(selectedSession, draft.trimEnd(), attachments);
      return;
    }
    if (!selectedSession.runtimeBacked) {
      setComposerError(
        "This session row is not attached to a Pi runtime. Select a real backend session or relaunch in real mode.",
      );
      return;
    }
    if (hasBlockingAttachment) {
      setComposerError(
        "Remove or reselect deleted/unreadable attachments before sending.",
      );
      return;
    }
    if (hasImageAttachment && selectedModel && !selectedModel.supportsImages) {
      setComposerError("Selected model does not support image input.");
      return;
    }

    void sendPrompt(selectedSession.id, draft.trimEnd(), attachments);
  }

  async function sendPrompt(
    runtimeId: string,
    prompt: string,
    promptAttachments: AttachmentDraft[],
  ): Promise<void> {
    const now = formatTime();
    const sentAttachments = timelineAttachmentsFromDrafts(promptAttachments);
    setComposerError(null);
    setDraft("");
    setSlashOpen(false);
    setAttachments([]);
    setSessions((current) =>
      current.map((session) =>
        session.id === runtimeId
          ? {
              ...session,
              title: isPlaceholderSessionTitle(session.title)
                ? summarizeTitle(prompt, 64)
                : session.title,
              status: "working",
              baseState: "working",
              overlays: { ...session.overlays, streaming: true },
              subtitle: `Working · ${backendLabel(session)} stream`,
              updatedAt: "Now",
              updatedAtMs: Date.now(),
              timeline: [
                ...session.timeline,
                {
                  id: createId("user"),
                  kind: "user",
                  content: prompt,
                  createdAt: now,
                  ...(sentAttachments ? { attachments: sentAttachments } : {}),
                },
              ],
            }
          : session,
      ),
    );

    try {
      await window.piDeck.chat.prompt({
        runtimeId,
        text: prompt,
        attachments: promptAttachments.map((attachment) => ({
          selectedPathToken: attachment.selectedPathToken,
          sendMode: attachment.sendMode,
        })),
      });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
      setAttachments(promptAttachments);
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

  async function handlePickProject(): Promise<void> {
    try {
      const result = await window.piDeck.projects.pickProject();
      if (!result.selected) {
        setUiMessage("Project picker canceled.");
        return;
      }
      setCurrentProject(result.project);
      setRecentProjects((projects) =>
        saveRecentProjects(result.project, projects),
      );

      if (isRealBackendMode) {
        setComposerError(null);
        setUiMessage(`Switching real Pi project to ${result.project.path}…`);
        const snapshot = await window.piDeck.chat.reset();
        const listedSessions = await window.piDeck.chat.listSessions();
        const backendSession = sessionFromSnapshot(snapshot);
        setSessions(
          mergeSessions(
            [backendSession],
            listedSessions.sessions.map(sessionFromSummary),
          ),
        );
        setSelectedSessionId(backendSession.id);
        void loadRealModels(backendSession.id);
        setUiMessage(
          `Real Pi project switched. Found ${listedSessions.sessions.length} saved session(s) for this project.`,
        );
        return;
      }

      setUiMessage(
        "Project picker used preload/main IPC; renderer received metadata only.",
      );
    } catch (error) {
      setUiMessage(
        `Project picker failed; no project was selected (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  async function loadRealModels(runtimeId: string): Promise<void> {
    try {
      const result = await window.piDeck.chat.listModels({ runtimeId });
      setRealModels(result.models);
    } catch {
      setRealModels([]);
    }
  }

  async function refreshRealSessions(): Promise<void> {
    if (!isRealBackendMode || loadState.state !== "ready") {
      return;
    }
    setUiMessage("Refreshing saved Pi sessions…");
    try {
      const result = await window.piDeck.chat.listSessions();
      setSessions((items) =>
        mergeSessions(
          items.filter((item) => item.runtimeBacked),
          result.sessions.map(sessionFromSummary),
        ),
      );
      setUiMessage(
        `Found ${result.sessions.length} saved session(s) for this project.`,
      );
    } catch (error) {
      setUiMessage(
        `Failed to refresh sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function handleDeleteAllSessions(): Promise<void> {
    const savedSessions = sessions.filter(
      (session) => session.resumeBacked === true,
    );
    if (savedSessions.length === 0) {
      setUiMessage("No inactive saved sessions to delete.");
      return;
    }
    const confirmed = window.confirm(
      `Delete ${savedSessions.length} inactive saved Pi session${savedSessions.length === 1 ? "" : "s"}? Files will be moved to Trash when possible.`,
    );
    if (!confirmed) {
      return;
    }

    try {
      const result = await window.piDeck.chat.deleteAllSessions();
      setSessions((items) =>
        items.filter((item) => item.resumeBacked !== true),
      );
      setUiMessage(
        `Deleted ${result.deletedCount} saved session${result.deletedCount === 1 ? "" : "s"}.${result.skippedCount > 0 ? ` Skipped ${result.skippedCount} attached or unavailable session${result.skippedCount === 1 ? "" : "s"}.` : ""}`,
      );
    } catch (error) {
      setUiMessage(
        `Failed to delete saved sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function handleDeleteSession(sessionId: string): Promise<void> {
    const session = sessions.find((item) => item.id === sessionId);
    if (
      session === undefined ||
      typeof session.sessionFile !== "string" ||
      !isSessionDeletable(session, isRealBackendMode)
    ) {
      setUiMessage("Only saved Pi sessions can be deleted.");
      return;
    }
    const sessionFile = session.sessionFile;
    const confirmed = window.confirm(
      `Delete Pi session “${session.title}”?${session.runtimeBacked ? " This will close it first." : ""} It will be moved to Trash when possible.`,
    );
    if (!confirmed) {
      return;
    }

    try {
      await window.piDeck.chat.deleteSession({
        sessionFile,
      });
      const remainingSessions = sessions.filter(
        (item) => item.id !== session.id,
      );
      setSessions(remainingSessions);
      if (selectedSessionId === session.id) {
        const nextSession =
          remainingSessions.find((item) => item.runtimeBacked) ??
          remainingSessions[0];
        if (nextSession !== undefined) {
          setSelectedSessionId(nextSession.id);
        } else {
          await handleNewSession();
        }
      }
      setUiMessage("Deleted Pi session.");
    } catch (error) {
      setUiMessage(
        `Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function handleSetRealModel(
    provider: string,
    modelId: string,
  ): Promise<void> {
    if (!selectedSession.runtimeBacked) {
      return;
    }
    setComposerError(null);
    try {
      const snapshot = await window.piDeck.chat.setModel({
        runtimeId: selectedSession.id,
        provider,
        modelId,
      });
      const updated = sessionFromSnapshot(snapshot);
      setSessions((items) =>
        items.map((item) =>
          item.id === updated.id
            ? { ...updated, timeline: item.timeline }
            : item,
        ),
      );
      setUiMessage(`Switched model to ${provider}/${modelId}.`);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSetRealThinking(level: string): Promise<void> {
    if (!selectedSession.runtimeBacked) {
      return;
    }
    setComposerError(null);
    try {
      const snapshot = await window.piDeck.chat.setThinking({
        runtimeId: selectedSession.id,
        level,
      });
      const updated = sessionFromSnapshot(snapshot);
      setSessions((items) =>
        items.map((item) =>
          item.id === updated.id
            ? { ...updated, timeline: item.timeline }
            : item,
        ),
      );
      setUiMessage(`Switched thinking to ${level}.`);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handlePickAttachments(): Promise<void> {
    try {
      const result = await window.piDeck.attachments.pickFiles({
        projectPath: currentProject.canonicalPath,
      });
      if (!result.selected) {
        setUiMessage("Attachment picker canceled.");
        return;
      }
      setAttachments((existing) =>
        mergeAttachmentDrafts(existing, result.attachments),
      );
      setUiMessage(`Added ${result.attachments.length} attachment(s).`);
    } catch (error) {
      setUiMessage(
        `Attachment picker failed; no files were added (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  async function handleImportDroppedFileAttachments(
    files: File[],
  ): Promise<void> {
    try {
      const result = await window.piDeck.attachments.importDroppedFiles(files, {
        projectPath: currentProject.canonicalPath,
      });
      if (result.selected) {
        setAttachments((existing) =>
          mergeAttachmentDrafts(existing, result.attachments),
        );
        setUiMessage(
          `Added ${result.attachments.length} dropped file attachment(s).`,
        );
      }
    } catch (error) {
      setUiMessage(
        `Dropped file import failed (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  async function handleImportImageAttachments(files: File[]): Promise<void> {
    const imageFiles = files.filter((file) => isSupportedDroppedImage(file));
    if (imageFiles.length === 0) {
      setUiMessage("Drop or paste PNG, JPEG, WebP, or GIF images.");
      return;
    }

    try {
      const images = await Promise.all(imageFiles.map(readDroppedImageFile));
      const result = await window.piDeck.attachments.importImages({ images });
      if (result.selected) {
        setAttachments((existing) =>
          mergeAttachmentDrafts(existing, result.attachments),
        );
        setUiMessage(
          `Imported ${result.attachments.length} image attachment(s).`,
        );
      }
    } catch (error) {
      setUiMessage(
        `Image import failed (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  async function handleNewSession(): Promise<void> {
    if (isRealBackendMode) {
      const optimisticId = createId("starting-real");
      const optimisticSession: SessionViewModel = {
        id: optimisticId,
        title: "Starting real Pi chat",
        project: currentProject.displayName,
        projectPath: currentProject.path,
        subtitle: "Attaching · starting Pi RPC worker",
        status: "idle",
        updatedAt: "Now",
        updatedAtMs: Date.now(),
        baseState: "attaching",
        overlays: { ...emptyOverlays },
        runtimeBacked: false,
        resumeBacked: false,
        backendMode: "real",
        timeline: [],
      };
      setComposerError(null);
      setSessions((items) => mergeSessions([optimisticSession], items));
      setSelectedSessionId(optimisticId);
      setUiMessage("Starting a new real Pi session…");
      try {
        const snapshot = await window.piDeck.chat.createSession();
        const backendSession = sessionFromSnapshot(snapshot);
        setSessions((items) =>
          mergeSessions(
            [backendSession],
            items.filter((item) => item.id !== optimisticId),
          ),
        );
        setSelectedSessionId(backendSession.id);
        void loadRealModels(backendSession.id);
        if (snapshot.state.cwd) {
          setCurrentProject(projectFromCwd(snapshot.state.cwd));
        }
        setUiMessage(
          backendSession.sessionFile
            ? "New real Pi chat is ready and backed by a session file."
            : "New real Pi chat is ready. It will be persisted after Pi reports a session file.",
        );
      } catch (error) {
        setSessions((items) =>
          items.map((item) =>
            item.id === optimisticId
              ? appendDiagnostic(
                  { ...item, status: "error", baseState: "error" },
                  {
                    tone: "error",
                    content: `New session failed: ${error instanceof Error ? error.message : String(error)}`,
                  },
                )
              : item,
          ),
        );
        setUiMessage(
          `Failed to start a new real Pi session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    const id = `local-new-${Date.now()}`;
    const next: SessionViewModel = {
      id,
      title: "Untitled new session",
      project: currentProject.displayName,
      projectPath: currentProject.path,
      subtitle: "Idle · local demo session",
      status: "idle",
      updatedAt: "Now",
      updatedAtMs: Date.now(),
      baseState: "idle",
      overlays: { ...emptyOverlays },
      runtimeBacked: false,
      timeline: [],
    };
    setSessions((items) => [next, ...items]);
    setSelectedSessionId(id);
    setUiMessage("Created a new local demo session.");
  }

  function handleSelectCommand(command: SlashCommand): void {
    setDraft(`${command.name} `);
    setSlashOpen(false);
    setUiMessage(
      `${command.name} inserted into the normal prompt path; command behavior is not reimplemented in the GUI.`,
    );
  }

  const composer = (
    <Composer
      value={draft}
      isWorking={isWorking}
      canSend={canSend}
      error={composerError}
      attachments={attachments}
      slashOpen={slashOpen}
      slashCommands={filteredCommands}
      selectedModel={selectedModel}
      backendLabel={backendLabel(selectedSession)}
      modelInfo={composerModelInfo(selectedSession)}
      realModels={realModels}
      realThinkingLevels={realThinkingLevels}
      selectedSession={selectedSession}
      allowAttachments={true}
      enterToSend={enterToSend}
      onEnterToSendChange={handleEnterToSendChange}
      onChange={handleDraftChange}
      onKeyDown={handleComposerKeyDown}
      onSend={handleSend}
      onAbort={handleAbort}
      onPickAttachments={() => void handlePickAttachments()}
      onImportDroppedFileAttachments={(files) =>
        void handleImportDroppedFileAttachments(files)
      }
      onImportImageAttachments={(files) =>
        void handleImportImageAttachments(files)
      }
      onSetModel={(provider, modelId) =>
        void handleSetRealModel(provider, modelId)
      }
      onSetThinking={(level) => void handleSetRealThinking(level)}
      onRemoveAttachment={(id) =>
        setAttachments((items) => items.filter((item) => item.id !== id))
      }
      onSelectCommand={handleSelectCommand}
    />
  );

  return (
    <main className={`app-shell ${sidebarVisible ? "" : "sidebar-hidden"}`}>
      {sidebarVisible ? (
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={selectedSession.id}
          realMode={isRealBackendMode}
          onSelect={handleSelectSession}
          onNewSession={() => void handleNewSession()}
          onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
          onDeleteAllSessions={() => void handleDeleteAllSessions()}
        />
      ) : null}

      <section className="workspace" aria-label="Pi Deck chat workspace">
        <AppHeader
          loadState={loadState}
          nodeAccessSummary={nodeAccessSummary}
          selectedSession={selectedSession}
          currentProject={currentProject}
          recentProjects={recentProjects}
          selectedModelId={selectedModelId}
          selectedThinking={selectedThinking}
          realMode={isRealBackendMode}
          sidebarVisible={sidebarVisible}
          usageStatsVisible={usageStatsVisible}
          onToggleSidebar={() => handleSidebarVisibleChange(!sidebarVisible)}
          onToggleUsageStats={() =>
            handleUsageStatsVisibleChange(!usageStatsVisible)
          }
          onPickProject={() => void handlePickProject()}
          onSelectRecent={(project) => {
            setCurrentProject(project);
            setUiMessage(
              "Recent project selected; invalid rows remain visibly recoverable.",
            );
          }}
          onModelChange={setSelectedModelId}
          onThinkingChange={(level) => {
            setSelectedThinking(level);
            setUiMessage(
              isRealBackendMode
                ? "The active Pi worker uses its current model and thinking configuration."
                : "Updated the local demo thinking level.",
            );
          }}
        />

        <div className="ui-status-message" role="status" aria-live="polite">
          {uiMessage}
        </div>

        {showStarterPage ? (
          <StarterPage composer={composer} />
        ) : (
          <>
            <ChatTimeline
              session={selectedSession}
              uiMessage={uiMessage}
              showAttachmentExamples={!isRealBackendMode}
            />
            {composer}
          </>
        )}
      </section>
    </main>
  );
}

function projectFromCwd(cwd: string): ProjectRef {
  const normalized = cwd.replace(/\/$/, "");
  const displayName = normalized.split(/[\\/]/).pop() || normalized;
  return {
    id: normalized,
    path: normalized,
    canonicalPath: normalized,
    displayName,
    lastOpenedAt: Date.now(),
  };
}

function startupErrorSession(message: string): SessionViewModel {
  return {
    id: "startup-error",
    title: "Real Pi backend failed",
    project: "Pi Deck",
    projectPath: "No Pi runtime attached",
    subtitle: "Error · relaunch from intended project",
    status: "error",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    baseState: "error",
    overlays: { ...emptyOverlays },
    runtimeBacked: false,
    backendMode: "real",
    timeline: [
      {
        id: "startup-error-diagnostic",
        kind: "diagnostic",
        tone: "error",
        content: message,
        createdAt: formatTime(),
      },
    ],
  };
}

function isMissingSessionFileError(message: string): boolean {
  return /session file is missing or unreadable/i.test(message);
}

function mergeAttachmentDrafts(
  existing: AttachmentDraft[],
  incoming: AttachmentDraft[],
): AttachmentDraft[] {
  const merged = [...existing];
  const seen = new Set(existing.map(attachmentDedupKey));
  for (const attachment of incoming) {
    const key = attachmentDedupKey(attachment);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(attachment);
    }
  }
  return merged;
}

function attachmentDedupKey(attachment: AttachmentDraft): string {
  return [
    attachment.kind,
    attachment.sendMode,
    attachment.displayPath,
    attachment.size ?? "unknown-size",
  ].join("|");
}

function mergeSessions(
  primary: SessionViewModel[],
  secondary: SessionViewModel[],
): SessionViewModel[] {
  const merged: SessionViewModel[] = [];
  for (const session of [...primary, ...secondary]) {
    const duplicateIndex = merged.findIndex(
      (existing) =>
        existing.id === session.id ||
        (existing.sessionFile !== undefined &&
          existing.sessionFile === session.sessionFile),
    );
    if (duplicateIndex === -1) {
      merged.push(session);
    }
  }
  return merged;
}

function sessionFromSummary(summary: ChatSessionSummary): SessionViewModel {
  return {
    id: summary.attachedRuntimeId ?? summary.id,
    title: summary.title,
    project: summary.cwd?.split(/[\\/]/).pop() ?? "Pi project",
    projectPath: summary.cwd ?? "Unknown project",
    subtitle: summary.attachedRuntimeId
      ? "Idle · attached real Pi session"
      : "Saved · click to resume",
    status: "idle",
    updatedAt: formatRelativeTime(summary.updatedAtMs),
    updatedAtMs: summary.updatedAtMs,
    baseState: "idle",
    overlays: { ...emptyOverlays },
    runtimeBacked: summary.attachedRuntimeId !== undefined,
    resumeBacked: summary.attachedRuntimeId === undefined,
    backendMode: "real",
    sessionFile: summary.sessionFile,
    timeline: summary.preview
      ? [
          {
            id: `preview-${summary.id}`,
            kind: "diagnostic",
            tone: "info",
            content: `Saved session preview: ${summary.preview}`,
            createdAt: formatRelativeTime(summary.updatedAtMs),
          },
        ]
      : [],
  };
}

function sessionFromSnapshot(snapshot: ChatSnapshot): SessionViewModel {
  const modelLabel = modelLabelFromState(snapshot.state);
  const { usageStats, usageByMessageId } = usageFromMessages(
    snapshot.messages,
    getContextWindowTokens(snapshot.state),
  );
  const stateRecord = snapshot.state as Record<string, unknown>;
  const isAgentActive = Boolean(
    snapshot.state.isAgentActive ??
    (typeof stateRecord.isStreaming === "boolean"
      ? stateRecord.isStreaming
      : undefined),
  );

  const session: SessionViewModel = {
    id: snapshot.runtimeId,
    title: titleFromSnapshot(snapshot),
    project: snapshot.state.cwd?.split(/[\\/]/).pop() ?? "pi-deck",
    projectPath:
      snapshot.state.cwd ?? processCwdPlaceholder(snapshot.backendMode),
    subtitle: isAgentActive
      ? `Working · ${backendLabelFromMode(snapshot.backendMode)}`
      : `Idle · ${backendLabelFromMode(snapshot.backendMode)} ready`,
    status: isAgentActive ? "working" : "idle",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    baseState: isAgentActive ? "working" : "idle",
    overlays: {
      ...emptyOverlays,
      streaming: isAgentActive,
    },
    runtimeBacked: true,
    resumeBacked: false,
    backendMode: snapshot.backendMode,
    timeline: timelineFromMessages(snapshot.messages),
  };
  if (usageStats !== undefined) {
    session.usageStats = usageStats;
  }
  if (usageByMessageId !== undefined) {
    session.usageByMessageId = usageByMessageId;
  }
  if (typeof snapshot.state.sessionFile === "string") {
    session.sessionFile = snapshot.state.sessionFile;
  }
  if (modelLabel.length > 0) {
    session.modelLabel = modelLabel;
  }
  if (snapshot.state.thinkingLevel !== undefined) {
    session.thinkingLevel = snapshot.state.thinkingLevel;
  }
  return session;
}

function titleFromSnapshot(snapshot: ChatSnapshot): string {
  const stateRecord = snapshot.state as Record<string, unknown>;
  const stateTitle = [stateRecord.title, stateRecord.name].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (
    stateTitle !== undefined &&
    !isPlaceholderSessionTitle(stateTitle) &&
    !isNoisyBackendTitle(stateTitle)
  ) {
    return summarizeTitle(stateTitle, 64);
  }

  const firstUserPrompt = snapshot.messages.find(
    (message) => message.role === "user" && message.content?.trim(),
  )?.content;
  if (firstUserPrompt !== undefined) {
    return summarizeTitle(firstUserPrompt, 64);
  }

  return snapshot.backendMode === "real" ? "New chat" : "Local demo chat";
}

function isPlaceholderSessionTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === "new chat" ||
    normalized === "untitled new session" ||
    normalized === "local demo chat" ||
    isNoisyBackendTitle(title)
  );
}

function isNoisyBackendTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === "backend real pi rpc session" ||
    normalized === "local demo backend session"
  );
}

function summarizeTitle(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function mergeSessionUsageFromSnapshot(
  session: SessionViewModel,
  snapshotSession: SessionViewModel,
): SessionViewModel {
  return {
    ...session,
    ...(snapshotSession.usageStats !== undefined
      ? { usageStats: snapshotSession.usageStats }
      : {}),
    ...(snapshotSession.usageByMessageId !== undefined
      ? { usageByMessageId: snapshotSession.usageByMessageId }
      : {}),
    ...(snapshotSession.modelLabel !== undefined
      ? { modelLabel: snapshotSession.modelLabel }
      : {}),
    ...(snapshotSession.thinkingLevel !== undefined
      ? { thinkingLevel: snapshotSession.thinkingLevel }
      : {}),
  };
}

function modelLabelFromState(state: ChatSnapshot["state"]): string {
  const provider = typeof state.provider === "string" ? state.provider : "";
  const model = state.model;
  if (typeof model === "string") {
    return [provider, model].filter((part) => part.length > 0).join(" / ");
  }
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const modelId =
      typeof model.id === "string"
        ? model.id
        : typeof model.name === "string"
          ? model.name
          : "";
    const modelProvider =
      typeof model.provider === "string" ? model.provider : provider;
    return [modelProvider, modelId]
      .filter((part) => part.length > 0)
      .join(" / ");
  }
  return provider;
}

function timelineToolStatus(streaming: boolean): "collapsed" | "running" {
  return streaming ? "running" : "collapsed";
}

function toolTimelineItemFromContent(options: {
  id: string;
  content: string;
  createdAt: string;
  status: "collapsed" | "running";
  role?: string | undefined;
}): Extract<TimelineItem, { kind: "tool" }> | undefined {
  const toolPayload = parseToolPayload(options.content);
  const isToolRole =
    options.role === "tool" ||
    options.role === "toolResult" ||
    options.role === "tool_use" ||
    options.role === "tool_result";

  if (toolPayload === undefined && !isToolRole) {
    return undefined;
  }

  return {
    id: options.id,
    kind: "tool",
    title: toolPayload?.title ?? "Tool output",
    status: options.status,
    summary: toolPayload?.summary ?? summarizeToolDetails(options.content, 180),
    details: toolPayload?.details ?? options.content,
    createdAt: options.createdAt,
  };
}

function parseToolPayload(
  content: string,
): { title: string; summary: string; details: string } | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const details = JSON.stringify(record, null, 2);
  if (typeof record.command === "string") {
    return {
      title: "Command",
      summary: record.command,
      details,
    };
  }
  if (typeof record.path === "string") {
    const limit =
      typeof record.limit === "number" ? ` · ${record.limit} lines` : "";
    return {
      title: "Read file",
      summary: `${record.path}${limit}`,
      details,
    };
  }
  if (Array.isArray(record.edits) || record.oldText !== undefined) {
    return {
      title: "Edit file",
      summary:
        typeof record.path === "string"
          ? record.path
          : "Patch details available when expanded",
      details,
    };
  }
  if (typeof record.tool === "string" || typeof record.name === "string") {
    return {
      title: String(record.tool ?? record.name),
      summary: summarizeToolDetails(details, 180),
      details,
    };
  }
  return undefined;
}

function summarizeToolDetails(content: string, maxLength: number): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine || "Tool output";
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function timelineAttachmentsFromMessage(
  message: ChatMessage,
  messageId: string,
): TimelineAttachment[] | undefined {
  const imageAttachments = Array.isArray(message.imageAttachments)
    ? message.imageAttachments
    : [];
  const timelineAttachments = imageAttachments.map((attachment, index) => ({
    id: attachment.id ?? `${messageId}-image-${index}`,
    fileName: attachment.fileName ?? `Image ${index + 1}`,
    kind: "image" as const,
    sendMode: "imageInput" as const,
    mimeType: attachment.mimeType,
    previewDataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
  }));
  return timelineAttachments.length > 0 ? timelineAttachments : undefined;
}

function timelineAttachmentsFromDrafts(
  attachments: AttachmentDraft[],
): TimelineAttachment[] | undefined {
  const timelineAttachments = attachments
    .filter((attachment) => attachment.status === "ready")
    .map(
      (attachment): TimelineAttachment => ({
        id: attachment.id,
        fileName: attachment.fileName,
        kind: attachment.kind,
        sendMode: attachment.sendMode,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.previewDataUrl
          ? { previewDataUrl: attachment.previewDataUrl }
          : {}),
      }),
    );
  return timelineAttachments.length > 0 ? timelineAttachments : undefined;
}

function timelineFromMessages(messages: ChatMessage[]): TimelineItem[] {
  const timeline = messages.flatMap((message, index): TimelineItem[] => {
    const content = typeof message.content === "string" ? message.content : "";
    const timestamp =
      typeof message.createdAt === "number"
        ? message.createdAt
        : typeof message.timestamp === "number"
          ? message.timestamp
          : undefined;
    const createdAt = formatMessageTime(timestamp);
    const id = message.id ?? `message-${index}`;

    if (message.role === "user") {
      const attachments = timelineAttachmentsFromMessage(message, id);
      return [
        {
          id,
          kind: "user",
          content,
          createdAt,
          ...(attachments ? { attachments } : {}),
        },
      ];
    }

    const toolItem = toolTimelineItemFromContent({
      id,
      content,
      createdAt,
      status: "collapsed",
      role: message.role,
    });
    if (toolItem !== undefined) {
      return [toolItem];
    }

    if (message.role === "assistant") {
      return content.trim().length > 0
        ? [{ id, kind: "assistant", content, createdAt }]
        : [];
    }

    if (message.role === "system" && content.length > 0) {
      return [
        {
          id,
          kind: "diagnostic",
          tone: "info",
          content,
          createdAt,
        },
      ];
    }

    return [];
  });

  return timeline;
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
        baseState: "working",
        overlays: { ...session.overlays, streaming: true },
        subtitle: `Working · ${backendLabel(session)} stream`,
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    case "message_update":
      return reduceMessageUpdate(session, event);
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return reduceToolExecutionEvent(session, event);
    case "agent_end": {
      const status = getString(event, "status");
      return {
        ...session,
        status: "idle",
        baseState: "idle",
        overlays: { ...session.overlays, streaming: false, toolRunning: false },
        subtitle:
          status === "aborted"
            ? "Idle · backend stream aborted"
            : "Idle · backend stream complete",
        updatedAt: "Now",
        updatedAtMs: Date.now(),
        timeline: removeEmptyAssistantMessages(
          session.timeline.map((item) =>
            item.kind === "assistant" && item.streaming === true
              ? { ...item, streaming: false }
              : item,
          ),
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
          baseState: "error",
          subtitle: "Error · backend worker exited",
        },
        {
          tone: "error",
          content: `${backendLabel(session)} worker exited (code=${String(getUnknown(event, "code") ?? "null")}).`,
        },
      );
    default:
      return session;
  }
}

function reduceToolExecutionEvent(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  const status = event.type === "tool_execution_end" ? "collapsed" : "running";
  const toolItem = toolTimelineItemFromRuntimeEvent(event, status);
  const timeline = toolItem
    ? upsertToolMessage(session.timeline, toolItem)
    : session.timeline;
  const toolRunning = timeline.some(
    (item) => item.kind === "tool" && item.status === "running",
  );

  return {
    ...session,
    status: "working",
    baseState: "working",
    overlays: { ...session.overlays, toolRunning },
    subtitle: `Working · ${backendLabel(session)} stream`,
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline,
  };
}

function toolTimelineItemFromRuntimeEvent(
  event: ChatRuntimeEvent,
  status: "collapsed" | "running",
): Extract<TimelineItem, { kind: "tool" }> | undefined {
  const id = getString(event, "toolCallId") ?? getString(event, "id");
  if (id === undefined) {
    return undefined;
  }
  const title =
    getString(event, "toolName") ?? getString(event, "name") ?? "Tool";
  const args = getRecord(event, "args");
  const result =
    getRecord(event, "result") ?? getRecord(event, "partialResult");
  const output = getString(event, "output");
  const command = getStringFromRecord(args, "command");
  const path = getStringFromRecord(args, "path");
  const summary =
    command ??
    path ??
    output ??
    summarizeToolDetails(JSON.stringify({ title, args, result }, null, 2), 180);
  const details = JSON.stringify(
    {
      type: event.type,
      toolName: title,
      ...(args !== undefined ? { args } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(result !== undefined ? { result } : {}),
      isError: getBoolean(event, "isError"),
    },
    null,
    2,
  );

  return {
    id,
    kind: "tool",
    title,
    status,
    summary,
    details,
    createdAt: formatTime(),
  };
}

function reduceMessageUpdate(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  const messageId =
    getMessageUpdateId(event) ??
    getActiveAssistantMessageId(session) ??
    createId("assistant");
  const assistantEventType = getAssistantMessageEventType(event);
  const done =
    getBoolean(event, "done") ??
    (assistantEventType === "done" || assistantEventType === "error");
  const textUpdate = getMessageTextUpdate(event);
  const content = textUpdate?.content ?? "";
  const thinking = getThinkingUpdateContent(event);
  const role = getMessageUpdateRole(event);
  const existingAssistantContent = getAssistantContent(
    session.timeline,
    messageId,
  );
  const nextAssistantContent =
    textUpdate?.mode === "append" ||
    shouldAppendShortStreamingReplacement(
      existingAssistantContent,
      content,
      done,
    )
      ? `${existingAssistantContent ?? ""}${content}`
      : content;
  const toolItem = toolTimelineItemFromContent({
    id: messageId,
    content: nextAssistantContent,
    createdAt: formatTime(),
    status: timelineToolStatus(!done),
    role,
  });
  const hasReplyContent = nextAssistantContent.trim().length > 0;
  const hasThinkingContent =
    thinking !== undefined && thinking.trim().length > 0;

  let timeline = session.timeline;
  if (toolItem !== undefined) {
    timeline = upsertToolMessage(timeline, toolItem);
  } else if (hasReplyContent) {
    timeline = upsertAssistantMessage(
      timeline,
      messageId,
      nextAssistantContent,
      !done,
    );
  } else if (hasThinkingContent) {
    timeline = upsertThinkingMessage(
      timeline,
      `thinking-${messageId}`,
      thinking,
      !done,
    );
  }

  const eventUsage = getMessageUsageFromEvent(event);
  const usageByMessageId =
    eventUsage !== undefined
      ? { ...(session.usageByMessageId ?? {}), [messageId]: eventUsage }
      : session.usageByMessageId;
  const usageStats =
    usageByMessageId !== undefined
      ? summarizeUsageByMessage(
          usageByMessageId,
          session.usageStats?.contextWindowTokens,
        )
      : undefined;

  return {
    ...session,
    ...(usageByMessageId !== undefined ? { usageByMessageId } : {}),
    ...(usageStats !== undefined ? { usageStats } : {}),
    status: done ? "idle" : "working",
    baseState: done ? "idle" : "working",
    overlays: { ...session.overlays, streaming: !done },
    subtitle: done
      ? "Idle · backend stream complete"
      : `Working · ${backendLabel(session)} stream`,
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline,
  };
}

function removeEmptyAssistantMessages(items: TimelineItem[]): TimelineItem[] {
  return items.filter(
    (item) => item.kind !== "assistant" || item.content.trim().length > 0,
  );
}

function getActiveAssistantMessageId(
  session: SessionViewModel,
): string | undefined {
  const activeAssistant = [...session.timeline]
    .reverse()
    .find((item) => item.kind === "assistant" && item.streaming === true);
  return activeAssistant?.id;
}

function getAssistantContent(
  items: TimelineItem[],
  id: string,
): string | undefined {
  const existing = items.find(
    (item) => item.kind === "assistant" && item.id === id,
  );
  return existing?.kind === "assistant" ? existing.content : undefined;
}

function shouldAppendShortStreamingReplacement(
  existingContent: string | undefined,
  nextContent: string,
  done: boolean,
): boolean {
  return (
    existingContent !== undefined &&
    !done &&
    nextContent.length > 0 &&
    nextContent.length < existingContent.length &&
    nextContent !== existingContent
  );
}

function upsertToolMessage(
  items: TimelineItem[],
  toolItem: Extract<TimelineItem, { kind: "tool" }>,
): TimelineItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.id !== toolItem.id) {
      return item;
    }
    found = true;
    return toolItem;
  });
  return found ? next : [...next, toolItem];
}

function upsertAssistantMessage(
  items: TimelineItem[],
  id: string,
  content: string,
  streaming: boolean,
): TimelineItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.kind !== "assistant" || item.id !== id) {
      return item;
    }
    found = true;
    return { ...item, content, streaming };
  });
  if (found) {
    return next;
  }
  return [
    ...next,
    { id, kind: "assistant", content, createdAt: formatTime(), streaming },
  ];
}

function upsertThinkingMessage(
  items: TimelineItem[],
  id: string,
  content: string,
  streaming: boolean,
): TimelineItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.kind !== "thinking" || item.id !== id) {
      return item;
    }
    found = true;
    return { ...item, content, streaming };
  });
  if (found) {
    return next;
  }
  return [
    ...next,
    { id, kind: "thinking", content, createdAt: formatTime(), streaming },
  ];
}

function usageFromMessages(
  messages: ChatMessage[],
  contextWindowTokens: number | undefined,
): {
  usageStats?: UsageStats;
  usageByMessageId?: Record<string, MessageUsage>;
} {
  const usageByMessageId: Record<string, MessageUsage> = {};
  messages.forEach((message, index) => {
    const usage = extractMessageUsage(message);
    if (usage !== undefined) {
      usageByMessageId[message.id ?? `message-${index}`] = usage;
    }
  });

  if (Object.keys(usageByMessageId).length === 0) {
    if (contextWindowTokens === undefined) {
      return {};
    }
    return {
      usageStats: summarizeUsageByMessage({}, contextWindowTokens),
    };
  }

  return {
    usageByMessageId,
    usageStats: summarizeUsageByMessage(usageByMessageId, contextWindowTokens),
  };
}

function summarizeUsageByMessage(
  usageByMessageId: Record<string, MessageUsage>,
  contextWindowTokens: number | undefined,
): UsageStats {
  const values = Object.values(usageByMessageId);
  const inputTokens = sumUsage(values, "inputTokens");
  const outputTokens = sumUsage(values, "outputTokens");
  const cacheReadTokens = sumUsage(values, "cacheReadTokens");
  const cacheWriteTokens = sumUsage(values, "cacheWriteTokens");
  const contextUsedTokens = values.reduce((peak, usage) => {
    const contextTokens =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    return Math.max(peak, contextTokens);
  }, 0);
  const costValues = values
    .map((usage) => usage.totalCostUsd)
    .filter((value): value is number => value !== undefined);
  const totalCostUsd =
    costValues.length > 0
      ? costValues.reduce((total, value) => total + value, 0)
      : undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens:
      inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    ...(contextUsedTokens > 0 ? { contextUsedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

function sumUsage(
  values: MessageUsage[],
  key: keyof Pick<
    MessageUsage,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): number {
  return values.reduce((total, usage) => total + usage[key], 0);
}

function getMessageUsageFromEvent(
  event: ChatRuntimeEvent,
): MessageUsage | undefined {
  return extractMessageUsage(getRecord(event, "message") ?? event);
}

function extractMessageUsage(value: unknown): MessageUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  const usageRecord =
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)
      : record;
  const inputTokens = readNumber(usageRecord, [
    "input",
    "inputTokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const outputTokens = readNumber(usageRecord, [
    "output",
    "outputTokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const cacheReadTokens = readNumber(usageRecord, [
    "cacheRead",
    "cacheReadTokens",
    "cache_read",
    "cache_read_tokens",
  ]);
  const cacheWriteTokens = readNumber(usageRecord, [
    "cacheWrite",
    "cacheWriteTokens",
    "cache_write",
    "cache_write_tokens",
  ]);
  const totalCostUsd = readCostUsd(usageRecord);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

function getContextWindowTokens(
  state: ChatSnapshot["state"],
): number | undefined {
  const direct = readNumber(state as Record<string, unknown>, [
    "contextWindow",
    "contextWindowTokens",
    "context_window",
  ]);
  if (direct !== undefined) {
    return direct;
  }
  const model = state.model;
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return undefined;
  }
  return readNumber(model as Record<string, unknown>, [
    "contextWindow",
    "contextWindowTokens",
    "context_window",
  ]);
}

function readCostUsd(record: Record<string, unknown>): number | undefined {
  const direct = readNumber(record, [
    "costUsd",
    "totalCostUsd",
    "total_cost_usd",
  ]);
  if (direct !== undefined) {
    return direct;
  }
  const cost = record.cost;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return cost;
  }
  if (cost && typeof cost === "object" && !Array.isArray(cost)) {
    return readNumber(cost as Record<string, unknown>, ["total", "usd"]);
  }
  return undefined;
}

function readNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function composerModelInfo(session: SessionViewModel): string | undefined {
  if (session.backendMode !== "real") {
    return undefined;
  }
  const parts = [
    session.modelLabel,
    session.thinkingLevel ? `Thinking: ${session.thinkingLevel}` : undefined,
  ].filter((part): part is string => Boolean(part && part.trim().length > 0));
  return parts.length > 0 ? parts.join(" · ") : "Pi selected model";
}

function backendLabel(session: SessionViewModel): string {
  return backendLabelFromMode(session.backendMode ?? "fake");
}

function backendLabelFromMode(mode: "fake" | "real"): string {
  return mode === "real" ? "Pi RPC backend" : "local demo backend";
}

function appendDiagnostic(
  session: SessionViewModel,
  diagnostic: { tone: "info" | "error"; content: string },
): SessionViewModel {
  return {
    ...session,
    status: diagnostic.tone === "error" ? "error" : session.status,
    baseState: diagnostic.tone === "error" ? "error" : session.baseState,
    ...(diagnostic.tone === "error" ? { lastError: diagnostic.content } : {}),
    updatedAt: "Now",
    updatedAtMs: Date.now(),
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

function SessionSidebar(props: {
  sessions: SessionViewModel[];
  selectedSessionId: string;
  realMode: boolean;
  onSelect(sessionId: string): void;
  onNewSession(): void;
  onDeleteSession(sessionId: string): void;
  onDeleteAllSessions(): void;
}): ReactElement {
  const [showOlderRealSessions, setShowOlderRealSessions] = useState(false);
  const sidebarSessions = props.realMode
    ? props.sessions.filter(shouldShowSessionInSidebar)
    : props.sessions;
  const visibleSessions =
    props.realMode && !showOlderRealSessions
      ? sidebarSessions.slice(0, 5)
      : sidebarSessions;
  const hiddenSessionCount = Math.max(0, sidebarSessions.length - 5);

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-header">
        <div>
          <p className="eyebrow dark">
            {props.realMode ? "Real Pi session" : "Local projects"}
          </p>
          <div className="brand">Pi Deck</div>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="New session"
          onClick={props.onNewSession}
        >
          +
        </button>
      </div>

      {!props.realMode ? (
        <button
          className="new-session"
          type="button"
          onClick={props.onNewSession}
        >
          + New session
        </button>
      ) : (
        <button
          className="delete-all-sessions"
          type="button"
          onClick={props.onDeleteAllSessions}
        >
          Delete saved sessions…
        </button>
      )}

      <section
        className="session-list"
        aria-label="Session list with priority states"
      >
        {visibleSessions.map((session) => {
          const canDelete = isSessionDeletable(session, props.realMode);
          return (
            <div className="session-item-wrap" key={session.id}>
              <button
                className={`session-item ${session.id === props.selectedSessionId ? "active" : ""}`}
                type="button"
                title={`${session.title}\n${formatReadableTimestamp(session.updatedAtMs)}`}
                onClick={() => {
                  props.onSelect(session.id);
                }}
              >
                <StateIndicator session={session} />
                <span className="session-copy">
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">{session.subtitle}</span>
                  {!props.realMode ? (
                    <span className="session-meta">{session.projectPath}</span>
                  ) : null}
                </span>
                <span
                  className="session-time"
                  title={formatReadableTimestamp(session.updatedAtMs)}
                >
                  {session.updatedAt}
                </span>
              </button>
              {canDelete ? (
                <button
                  className="session-delete-button"
                  type="button"
                  aria-label={`Delete ${session.title}`}
                  title="Delete saved session"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDeleteSession(session.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
        {props.realMode && hiddenSessionCount > 0 ? (
          <button
            className="browse-sessions"
            type="button"
            onClick={() => setShowOlderRealSessions((value) => !value)}
          >
            {showOlderRealSessions
              ? "Show recent only"
              : `Browse ${hiddenSessionCount} older session${hiddenSessionCount === 1 ? "" : "s"}`}
          </button>
        ) : null}
      </section>

      {!props.realMode ? (
        <div className="sidebar-note">
          Red dot means supported extension UI is waiting for input. Fixture
          rows exercise sidebar priority until the session repository lands.
        </div>
      ) : null}
    </aside>
  );
}

function isSessionDeletable(
  session: SessionViewModel,
  realMode: boolean,
): boolean {
  return (
    realMode &&
    session.backendMode === "real" &&
    typeof session.sessionFile === "string" &&
    session.sessionFile.length > 0
  );
}

function shouldShowSessionInSidebar(session: SessionViewModel): boolean {
  return !(
    session.backendMode === "real" &&
    session.runtimeBacked &&
    session.resumeBacked !== true &&
    session.status === "idle" &&
    session.timeline.length === 0 &&
    isPlaceholderSessionTitle(session.title)
  );
}

function StateIndicator(props: {
  session: Pick<SessionViewModel, "baseState" | "overlays">;
  verbose?: boolean;
}): ReactElement {
  const indicator = selectSidebarIndicator(props.session);
  const badge = indicator.kind === "queued" ? indicator.queuedCount : undefined;
  return (
    <span
      className={`state-indicator ${indicator.kind}`}
      title={indicator.label}
    >
      <span className="state-dot" />
      {badge ? <span className="queue-badge">{badge}</span> : null}
      {props.verbose ? <span>{indicator.label}</span> : null}
    </span>
  );
}

function AppHeader(props: {
  loadState: LoadState;
  nodeAccessSummary: string;
  selectedSession: SessionViewModel;
  currentProject: ProjectRef;
  recentProjects: ProjectRef[];
  selectedModelId: string;
  selectedThinking: string;
  realMode: boolean;
  sidebarVisible: boolean;
  usageStatsVisible: boolean;
  onToggleSidebar(): void;
  onToggleUsageStats(): void;
  onPickProject(): void;
  onSelectRecent(project: ProjectRef): void;
  onModelChange(id: string): void;
  onThinkingChange(id: string): void;
}): ReactElement {
  return (
    <header className="topbar">
      <div className="header-left">
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={props.sidebarVisible ? "Hide sessions" : "Show sessions"}
          aria-pressed={!props.sidebarVisible}
          title={props.sidebarVisible ? "Hide sessions" : "Show sessions"}
          onClick={props.onToggleSidebar}
        >
          {props.sidebarVisible ? "‹" : "☰"}
        </button>
        <ProjectHeader
          project={props.currentProject}
          selectedSession={props.selectedSession}
          recentProjects={props.recentProjects}
          realMode={props.realMode}
          onPickProject={props.onPickProject}
          onSelectRecent={props.onSelectRecent}
        />
      </div>

      <div className="header-right">
        <UsageStatsToggle
          session={props.selectedSession}
          visible={props.usageStatsVisible}
          onToggle={props.onToggleUsageStats}
        />
        {props.usageStatsVisible ? (
          <UsageStatsPanel session={props.selectedSession} />
        ) : null}
        {props.loadState.state === "error" || props.realMode ? null : (
          <ModelThinkingControls
            selectedModelId={props.selectedModelId}
            selectedThinking={props.selectedThinking}
            realMode={props.realMode}
            selectedSession={props.selectedSession}
            onModelChange={props.onModelChange}
            onThinkingChange={props.onThinkingChange}
          />
        )}
        <LoadStateBadge
          loadState={props.loadState}
          nodeAccessSummary={props.nodeAccessSummary}
        />
      </div>
    </header>
  );
}

function UsageStatsToggle(props: {
  session: SessionViewModel;
  visible: boolean;
  onToggle(): void;
}): ReactElement {
  const hasStats = props.session.usageStats !== undefined;
  return (
    <button
      className={`usage-toggle ${props.visible ? "active" : ""}`}
      type="button"
      aria-label={
        props.visible ? "Hide session usage stats" : "Show session usage stats"
      }
      aria-pressed={props.visible}
      title={
        hasStats
          ? "Toggle session usage stats"
          : "Usage stats appear after Pi returns usage data"
      }
      onClick={props.onToggle}
    >
      ◷
    </button>
  );
}

function UsageStatsPanel(props: { session: SessionViewModel }): ReactElement {
  const stats = props.session.usageStats;
  if (stats === undefined) {
    return (
      <div className="usage-stats empty" aria-live="polite">
        Usage stats unavailable until Pi returns usage data.
      </div>
    );
  }

  return (
    <div className="usage-stats" aria-live="polite">
      <span title="Peak prompt/context tokens compared with the model context window">
        Context: {formatContextUsage(stats)}
      </span>
      <span title="Session token totals from Pi message usage">
        Tokens: {formatInteger(stats.inputTokens)} in /{" "}
        {formatInteger(stats.outputTokens)} out
      </span>
      <span title="Cached token totals, when reported by the provider">
        Cache: {formatInteger(stats.cacheReadTokens)} read /{" "}
        {formatInteger(stats.cacheWriteTokens)} write
      </span>
      <span title="Total reported provider cost for this loaded session">
        Cost: {formatCurrency(stats.totalCostUsd)}
      </span>
    </div>
  );
}

function ProjectHeader(props: {
  project: ProjectRef;
  selectedSession: SessionViewModel;
  recentProjects: ProjectRef[];
  realMode: boolean;
  onPickProject(): void;
  onSelectRecent(project: ProjectRef): void;
}): ReactElement {
  const storedRecent = props.recentProjects.filter(
    (project) => project.id !== props.project.id,
  );
  const visibleRecent = [...storedRecent, invalidRecentProject];

  return (
    <div className="title-block project-header">
      <p className="eyebrow">Project / Session</p>
      <h1>
        {props.project.displayName} / {props.selectedSession.title}
      </h1>
      <span className={`status-pill ${props.selectedSession.status}`}>
        {statusLabel(props.selectedSession.status)}
      </span>
      <p className="project-path">{props.project.path}</p>
      {props.realMode ? null : (
        <>
          <div className="header-actions">
            <button type="button" onClick={props.onPickProject}>
              Open project…
            </button>
          </div>
          <div className="recent-projects" aria-label="Recent projects">
            <strong>Recent projects</strong>
            {storedRecent.length === 0 ? (
              <p className="empty-state-copy">No saved recent projects yet.</p>
            ) : null}
            {visibleRecent.map((project) => (
              <button
                key={project.id}
                type="button"
                className={project.invalidReason ? "recent invalid" : "recent"}
                onClick={() => props.onSelectRecent(project)}
              >
                <span>{project.displayName}</span>
                <small>{project.invalidReason ?? project.path}</small>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ModelThinkingControls(props: {
  selectedModelId: string;
  selectedThinking: string;
  realMode: boolean;
  selectedSession: SessionViewModel;
  onModelChange(id: string): void;
  onThinkingChange(id: string): void;
}): ReactElement {
  const selectedModel =
    modelOptions.find((model) => model.id === props.selectedModelId) ??
    modelOptions[0];
  const selectedThinking = thinkingOptions.find(
    (level) => level.id === props.selectedThinking,
  );

  if (props.realMode) {
    return (
      <div className="model-controls compact" aria-label="Real Pi config">
        <div className="capabilities" aria-live="polite">
          <strong>
            {props.selectedSession.modelLabel || "Pi-selected model"}
          </strong>
          {props.selectedSession.thinkingLevel ? (
            <span>Thinking: {props.selectedSession.thinkingLevel}</span>
          ) : null}
          <span>Real Pi active worker config</span>
        </div>
      </div>
    );
  }

  return (
    <div className="model-controls" aria-label="Model and thinking controls">
      <label>
        <span>Model</span>
        <select
          value={props.selectedModelId}
          onChange={(event) => props.onModelChange(event.target.value)}
        >
          {modelOptions.map((model) => (
            <option
              key={model.id}
              value={model.id}
              disabled={Boolean(model.unavailableReason)}
            >
              {model.provider}/{model.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Thinking</span>
        <select
          value={props.selectedThinking}
          onChange={(event) => props.onThinkingChange(event.target.value)}
        >
          {thinkingOptions.map((level) => (
            <option key={level.id} value={level.id} disabled={!level.supported}>
              {level.label}
            </option>
          ))}
        </select>
      </label>
      <div className="capabilities" aria-live="polite">
        <strong>
          {selectedModel?.provider}/{selectedModel?.id}
        </strong>
        <span>{selectedModel?.supportsImages ? "Images" : "No images"}</span>
        <span>
          {selectedModel?.supportsThinking ? "Reasoning" : "No reasoning"}
        </span>
        <span>{selectedModel?.contextWindow ?? "Context unknown"}</span>
        <span>Thinking: {selectedThinking?.label ?? "Unsupported"}</span>
        {selectedModel?.unavailableReason ? (
          <span className="inline-error">
            {selectedModel.unavailableReason}
          </span>
        ) : null}
      </div>
    </div>
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
        Startup error
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

function isScrolledNearBottom(scrollContainer: HTMLElement): boolean {
  const distanceFromBottom =
    scrollContainer.scrollHeight -
    scrollContainer.scrollTop -
    scrollContainer.clientHeight;
  return distanceFromBottom < 80;
}

function getTimelineScrollMarker(session: SessionViewModel): string {
  const timelineMarker = session.timeline
    .map((item) => {
      if (item.kind === "tool") {
        return `${item.id}:${item.status}:${item.summary.length}:${item.details.length}`;
      }

      return `${item.id}:${item.kind}:${"content" in item ? item.content.length : 0}`;
    })
    .join("|");

  return `${session.id}|${session.status}|${session.baseState}|${session.overlays.streaming}|${session.overlays.toolRunning}|${timelineMarker}`;
}

function StarterPage(props: { composer: ReactElement }): ReactElement {
  return (
    <section className="starter-page" aria-label="Start a new chat">
      <div className="starter-content">
        <h2>What’s on the agenda today?</h2>
        {props.composer}
      </div>
    </section>
  );
}

function ChatTimeline(props: {
  session: SessionViewModel;
  uiMessage: string;
  showAttachmentExamples: boolean;
}): ReactElement {
  const hasItems = props.session.timeline.length > 0;
  const showPendingAgent =
    props.session.status === "working" &&
    !hasActiveTimelineOutput(props.session.timeline);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousSessionIdRef = useRef(props.session.id);
  const timelineScrollMarker = getTimelineScrollMarker(props.session);

  useLayoutEffect(() => {
    const scrollContainer = timelineScrollRef.current;
    if (scrollContainer === null) {
      return;
    }

    const sessionChanged = previousSessionIdRef.current !== props.session.id;
    previousSessionIdRef.current = props.session.id;
    if (!sessionChanged && !shouldStickToBottomRef.current) {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      shouldStickToBottomRef.current = true;
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [props.session.id, timelineScrollMarker]);

  function handleTimelineScroll(): void {
    const scrollContainer = timelineScrollRef.current;
    if (scrollContainer === null) {
      return;
    }
    shouldStickToBottomRef.current = isScrolledNearBottom(scrollContainer);
  }

  return (
    <section className="timeline-shell" aria-label="Chat / Agent Timeline">
      <div
        className="timeline-scroll"
        ref={timelineScrollRef}
        onScroll={handleTimelineScroll}
      >
        {!hasItems ? (
          <EmptyTimelineState
            status={props.session.status}
            backendMode={props.session.backendMode ?? "fake"}
          />
        ) : null}
        {props.session.status === "error" ? (
          <div className="state-banner error">
            This session is in an error state.
          </div>
        ) : null}
        {props.session.status === "waiting" ? (
          <div className="state-banner waiting">
            This session is waiting for user input.
          </div>
        ) : null}

        {props.showAttachmentExamples ? <AttachmentExampleStrip /> : null}

        {props.session.timeline.map((item) => (
          <TimelineRow key={item.id} item={item} />
        ))}
        {showPendingAgent ? <PendingAgentRow /> : null}
      </div>
    </section>
  );
}

function hasActiveTimelineOutput(items: TimelineItem[]): boolean {
  return items.some(
    (item) =>
      (item.kind === "assistant" && item.streaming === true) ||
      (item.kind === "thinking" && item.streaming === true) ||
      (item.kind === "tool" && item.status === "running"),
  );
}

function PendingAgentRow(): ReactElement {
  return (
    <article className="timeline-row assistant-row pending-agent-row">
      <div className="assistant-avatar">π</div>
      <div className="assistant-message pending-agent-message">
        <span className="spinner" aria-hidden="true" />
        <span>Agent is working…</span>
      </div>
    </article>
  );
}

function EmptyTimelineState(props: {
  status: SessionStatus;
  backendMode: "fake" | "real";
}): ReactElement {
  const copy =
    props.status === "waiting"
      ? "A pending input request will appear here once extension UI wiring exists."
      : props.backendMode === "real"
        ? "Send a prompt to the active real Pi session."
        : "Send a prompt to start a streamed assistant response.";

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
          {props.item.attachments ? (
            <TimelineAttachmentGrid attachments={props.item.attachments} />
          ) : null}
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

  if (props.item.kind === "thinking") {
    return (
      <article className="thinking-row">
        <details>
          <summary>
            {props.item.streaming ? "Thinking…" : "Thought process"}
          </summary>
          <p>{props.item.content}</p>
        </details>
      </article>
    );
  }

  if (props.item.kind === "tool") {
    return (
      <article className={`tool-card ${props.item.status}`}>
        <details>
          <summary>
            <span className="tool-copy">
              <span className="tool-title">{props.item.title}</span>
              <span className="tool-summary">{props.item.summary}</span>
            </span>
            <span className="tool-status">
              {props.item.status === "running" ? "running" : "collapsed"}
            </span>
          </summary>
          <pre>{props.item.details}</pre>
        </details>
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

function TimelineAttachmentGrid(props: {
  attachments: TimelineAttachment[];
}): ReactElement {
  return (
    <div className="timeline-attachments" aria-label="Sent attachments">
      {props.attachments.map((attachment) => (
        <span className="timeline-attachment" key={attachment.id}>
          {attachment.previewDataUrl ? (
            <img src={attachment.previewDataUrl} alt={attachment.fileName} />
          ) : null}
          <span>
            <strong>{attachment.fileName}</strong>
            <em>
              {attachment.sendMode === "imageInput"
                ? (attachment.mimeType ?? "Image")
                : "Referenced path"}
            </em>
          </span>
        </span>
      ))}
    </div>
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
  attachments: AttachmentDraft[];
  slashOpen: boolean;
  slashCommands: SlashCommand[];
  selectedModel: ModelOption | undefined;
  backendLabel: string;
  modelInfo?: string | undefined;
  realModels: ChatModelSummary[];
  realThinkingLevels: string[];
  selectedSession: SessionViewModel;
  allowAttachments: boolean;
  enterToSend: boolean;
  onEnterToSendChange(value: boolean): void;
  onChange(value: string): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onSend(): void;
  onAbort(): void;
  onPickAttachments(): void;
  onImportDroppedFileAttachments(files: File[]): void;
  onImportImageAttachments(files: File[]): void;
  onSetModel(provider: string, modelId: string): void;
  onSetThinking(level: string): void;
  onRemoveAttachment(id: string): void;
  onSelectCommand(command: SlashCommand): void;
}): ReactElement {
  const hasImageWarning =
    props.attachments.some((attachment) => attachment.kind === "image") &&
    !props.selectedModel?.supportsImages;
  const currentRealModelValue = props.selectedSession.modelLabel?.replace(
    /\s+\/\s+/,
    "/",
  );
  const [dragActive, setDragActive] = useState(false);

  function handleDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      const imageFiles = files.filter(isSupportedDroppedImage);
      const fileAttachments = files.filter(
        (file) => !isSupportedDroppedImage(file),
      );
      if (fileAttachments.length > 0) {
        props.onImportDroppedFileAttachments(fileAttachments);
      }
      if (imageFiles.length > 0) {
        props.onImportImageAttachments(imageFiles);
      }
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (files.some(isSupportedDroppedImage)) {
      props.onImportImageAttachments(files);
    }
  }

  return (
    <footer
      className={`composer ${dragActive ? "drag-active" : ""}`}
      aria-label="Prompt composer"
      onDragEnter={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          setDragActive(false);
        }
      }}
      onDrop={handleDrop}
    >
      <div className="composer-input-wrap">
        {props.allowAttachments && props.attachments.length > 0 ? (
          <AttachmentChipRow
            attachments={props.attachments}
            onRemove={props.onRemoveAttachment}
          />
        ) : null}
        <textarea
          aria-label="Prompt text"
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
          onKeyDown={props.onKeyDown}
          onPaste={handlePaste}
          placeholder={
            props.enterToSend
              ? "Prompt Pi Deck… Enter to send, Shift+Enter for newline"
              : "Prompt Pi Deck… Shift+Enter for newline, ⌘/Ctrl+Enter to send"
          }
          rows={3}
          value={props.value}
        />
        {props.slashOpen ? (
          <SlashPicker
            commands={props.slashCommands}
            onSelect={props.onSelectCommand}
          />
        ) : null}
        <div className="composer-meta">
          {props.allowAttachments ? (
            <button
              className="attachment-button"
              type="button"
              aria-label="Add attachments"
              onClick={props.onPickAttachments}
            >
              +
            </button>
          ) : null}
          {props.realModels.length > 0 ? (
            <select
              className="composer-select"
              aria-label="Real Pi model"
              value={currentRealModelValue ?? ""}
              onChange={(event) => {
                const [provider, modelId] = event.target.value.split("/");
                if (provider && modelId) {
                  props.onSetModel(provider, modelId);
                }
              }}
            >
              {props.realModels.map((model) => (
                <option
                  key={`${model.provider ?? ""}/${model.id}`}
                  value={`${model.provider ?? ""}/${model.id}`}
                >
                  {model.name ?? model.id}
                </option>
              ))}
            </select>
          ) : props.modelInfo ? (
            <span className="composer-model-pill">{props.modelInfo}</span>
          ) : null}
          {props.selectedSession.backendMode === "real" ? (
            <select
              className="composer-select thinking"
              aria-label="Real Pi thinking"
              value={props.selectedSession.thinkingLevel ?? "off"}
              onChange={(event) => props.onSetThinking(event.target.value)}
            >
              {props.realThinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          ) : null}
          <label className="composer-option">
            <input
              checked={props.enterToSend}
              type="checkbox"
              onChange={(event) => {
                props.onEnterToSendChange(event.target.checked);
              }}
            />
            <span>Enter sends</span>
          </label>
          {props.error !== null ? (
            <span className="composer-error">{props.error}</span>
          ) : props.isWorking ? (
            <span>Streaming from {props.backendLabel}…</span>
          ) : hasImageWarning ? (
            <span className="composer-error">
              Selected model does not support image input.
            </span>
          ) : null}
          <span className="composer-spacer" />
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
              aria-label="Send prompt"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}

function AttachmentExampleStrip(): ReactElement {
  return (
    <section
      className="attachment-examples"
      aria-label="Attachment state examples"
    >
      <strong>Attachment state examples (not selected)</strong>
      <div className="attachment-row">
        {fakeAttachmentFixture.map((attachment) => (
          <span
            key={attachment.id}
            className={`attachment-chip example ${attachment.status !== "ready" ? "bad" : ""}`}
          >
            <strong>{attachment.fileName}</strong>
            <em>
              {attachment.kind === "image"
                ? attachment.mimeType
                : "Referenced path"}
            </em>
            {attachment.outsideProject ? <small>Outside project</small> : null}
            {attachment.status !== "ready" ? (
              <small>{attachment.status}</small>
            ) : null}
            {attachment.warning ? <small>{attachment.warning}</small> : null}
          </span>
        ))}
      </div>
    </section>
  );
}

function AttachmentChipRow(props: {
  attachments: AttachmentDraft[];
  onRemove(id: string): void;
}): ReactElement {
  if (props.attachments.length === 0) {
    return <></>;
  }

  return (
    <div className="attachment-row">
      {props.attachments.map((attachment) => (
        <span
          key={attachment.id}
          className={`attachment-chip ${attachment.status !== "ready" ? "bad" : ""}`}
        >
          {attachment.previewDataUrl ? (
            <img src={attachment.previewDataUrl} alt="" />
          ) : null}
          <strong>{attachment.fileName}</strong>
          <em>
            {attachment.kind === "image"
              ? attachment.mimeType
              : "Referenced path"}
          </em>
          {attachment.outsideProject ? <small>Outside project</small> : null}
          {attachment.warning ? <small>{attachment.warning}</small> : null}
          <button
            type="button"
            aria-label={`Remove ${attachment.fileName}`}
            onClick={() => props.onRemove(attachment.id)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

function SlashPicker(props: {
  commands: SlashCommand[];
  onSelect(command: SlashCommand): void;
}): ReactElement {
  return (
    <div
      className="slash-picker"
      role="listbox"
      aria-label="Slash command picker"
    >
      {props.commands.length === 0 ? (
        <p>
          No active-worker commands match. TUI-only commands are not listed.
        </p>
      ) : (
        props.commands.map((command) => (
          <button
            key={command.name}
            type="button"
            role="option"
            onClick={() => props.onSelect(command)}
          >
            <strong>{command.name}</strong>
            <span>{command.description}</span>
            <small>{command.source}</small>
          </button>
        ))
      )}
    </div>
  );
}

function fixtureSession(
  id: string,
  title: string,
  baseState: BaseSessionState,
  overlayPatch: Partial<SessionOverlays> = {},
  lastError?: string,
): SessionViewModel {
  const status = toSessionStatus(baseState, overlayPatch);
  const session: SessionViewModel = {
    id,
    title,
    project: "pi-deck",
    projectPath: "Local demo project",
    subtitle: selectSidebarIndicator({
      baseState,
      overlays: { ...emptyOverlays, ...overlayPatch },
    }).label,
    status,
    updatedAt: formatRelativeTime(
      appStartedAt - Math.floor(Math.random() * 4_000_000),
    ),
    updatedAtMs: appStartedAt - Math.floor(Math.random() * 4_000_000),
    baseState,
    overlays: { ...emptyOverlays, ...overlayPatch },
    runtimeBacked: false,
    timeline: lastError
      ? [
          {
            id: `${id}-error`,
            kind: "diagnostic",
            tone: "error",
            content: lastError,
            createdAt: "18:02",
          },
        ]
      : [],
  };
  if (lastError) {
    session.lastError = lastError;
  }
  return session;
}

function toSessionStatus(
  baseState: BaseSessionState,
  overlays: Partial<SessionOverlays>,
): SessionStatus {
  if (baseState === "error") {
    return "error";
  }
  if (baseState === "waitingForInput" || overlays.needsUserInput === true) {
    return "waiting";
  }
  if (baseState === "working" || baseState === "attaching") {
    return "working";
  }
  return "idle";
}

function getMessageUpdateId(event: ChatRuntimeEvent): string | undefined {
  const direct = getString(event, "messageId");
  if (direct !== undefined) {
    return direct;
  }

  const message = getRecord(event, "message");
  const messageId = getStringFromRecord(message, "id");
  if (messageId !== undefined) {
    return messageId;
  }
  const responseId = getStringFromRecord(message, "responseId");
  if (responseId !== undefined) {
    return responseId;
  }

  const assistantEvent = getRecord(event, "assistantMessageEvent");
  const assistantResponseId = getStringFromRecord(assistantEvent, "responseId");
  if (assistantResponseId !== undefined) {
    return assistantResponseId;
  }
  const partial = getRecordFromRecord(assistantEvent, "partial");
  return getStringFromRecord(partial, "responseId");
}

function getMessageUpdateRole(event: ChatRuntimeEvent): string | undefined {
  const message = getRecord(event, "message");
  return getString(event, "role") ?? getStringFromRecord(message, "role");
}

type MessageTextUpdate = {
  content: string;
  mode: "replace" | "append";
};

function getMessageTextUpdate(
  event: ChatRuntimeEvent,
): MessageTextUpdate | undefined {
  const directDelta = getString(event, "delta");
  const assistantDelta = getAssistantMessageDelta(event);
  if (directDelta !== undefined) {
    return { content: directDelta, mode: "append" };
  }
  if (assistantDelta !== undefined) {
    return { content: assistantDelta, mode: "append" };
  }

  const directContent = getString(event, "content");
  if (directContent !== undefined) {
    return { content: directContent, mode: "replace" };
  }

  const messageContent = getMessageUpdateContent(event);
  if (messageContent !== undefined) {
    return { content: messageContent, mode: "replace" };
  }

  const assistantContent = getAssistantMessageContent(event);
  if (assistantContent !== undefined) {
    return { content: assistantContent, mode: "replace" };
  }

  return undefined;
}

function getMessageUpdateContent(event: ChatRuntimeEvent): string | undefined {
  const message = getUnknown(event, "message");
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  return extractTextContent((message as Record<string, unknown>).content);
}

function getAssistantMessageEventType(
  event: ChatRuntimeEvent,
): string | undefined {
  const assistantEvent = getUnknown(event, "assistantMessageEvent");
  if (
    !assistantEvent ||
    typeof assistantEvent !== "object" ||
    Array.isArray(assistantEvent)
  ) {
    return undefined;
  }
  const type = (assistantEvent as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}

function getAssistantMessageDelta(event: ChatRuntimeEvent): string | undefined {
  const assistantEvent = getUnknown(event, "assistantMessageEvent");
  if (
    !assistantEvent ||
    typeof assistantEvent !== "object" ||
    Array.isArray(assistantEvent)
  ) {
    return undefined;
  }
  const record = assistantEvent as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type !== "" && type !== "text_delta") {
    return undefined;
  }
  return typeof record.delta === "string" ? record.delta : undefined;
}

function getAssistantMessageContent(
  event: ChatRuntimeEvent,
): string | undefined {
  const assistantEvent = getUnknown(event, "assistantMessageEvent");
  if (
    !assistantEvent ||
    typeof assistantEvent !== "object" ||
    Array.isArray(assistantEvent)
  ) {
    return undefined;
  }
  const record = assistantEvent as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type !== "" && !type.startsWith("text_") && type !== "done") {
    return undefined;
  }
  if (type === "done") {
    return extractTextContent(record.partial);
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  return extractTextContent(record.partial);
}

function getThinkingUpdateContent(event: ChatRuntimeEvent): string | undefined {
  const assistantEvent = getRecord(event, "assistantMessageEvent");
  const type = getStringFromRecord(assistantEvent, "type") ?? "";
  if (type.includes("thinking")) {
    return (
      getStringFromRecord(assistantEvent, "delta") ??
      getStringFromRecord(assistantEvent, "content") ??
      extractThinkingContent(assistantEvent?.partial)
    );
  }
  return extractThinkingContent(getRecord(event, "message")?.content);
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((item): string[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") {
      return [record.text];
    }
    return [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractThinkingContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((item): string[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.thinking === "string") {
      return [record.thinking];
    }
    if (
      typeof record.type === "string" &&
      record.type.includes("thinking") &&
      typeof record.text === "string"
    ) {
      return [record.text];
    }
    return [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function getString(event: ChatRuntimeEvent, key: string): string | undefined {
  const value = getUnknown(event, key);
  return typeof value === "string" ? value : undefined;
}

function getRecord(
  event: ChatRuntimeEvent,
  key: string,
): Record<string, unknown> | undefined {
  const value = getUnknown(event, key);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getStringFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function getRecordFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getBoolean(event: ChatRuntimeEvent, key: string): boolean | undefined {
  const value = getUnknown(event, key);
  return typeof value === "boolean" ? value : undefined;
}

function getUnknown(event: ChatRuntimeEvent, key: string): unknown {
  return (event as Record<string, unknown>)[key];
}

function isSupportedDroppedImage(file: File): boolean {
  return new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(
    file.type,
  );
}

async function readDroppedImageFile(file: File): Promise<{
  fileName: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read image data."));
      }
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
  const [, dataBase64] = dataUrl.split(",", 2);
  if (!dataBase64) {
    throw new Error("Failed to decode image data.");
  }
  return {
    fileName: file.name || `dropped-image-${Date.now()}`,
    mimeType: file.type,
    size: file.size,
    dataBase64,
  };
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

function loadEnterToSendPreference(): boolean {
  return localStorage.getItem("piDeck.enterToSend") === "true";
}

function saveEnterToSendPreference(value: boolean): void {
  localStorage.setItem("piDeck.enterToSend", String(value));
}

function loadSidebarVisiblePreference(): boolean {
  return localStorage.getItem("piDeck.sidebarVisible") !== "false";
}

function saveSidebarVisiblePreference(value: boolean): void {
  localStorage.setItem("piDeck.sidebarVisible", String(value));
}

function loadUsageStatsVisiblePreference(): boolean {
  return localStorage.getItem("piDeck.usageStatsVisible") === "true";
}

function saveUsageStatsVisiblePreference(value: boolean): void {
  localStorage.setItem("piDeck.usageStatsVisible", String(value));
}

function loadRecentProjects(): ProjectRef[] {
  try {
    const raw = localStorage.getItem("piDeck.recentProjects");
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as ProjectRef[];
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function saveRecentProjects(
  project: ProjectRef,
  projects: ProjectRef[],
): ProjectRef[] {
  const next = [
    project,
    ...projects.filter((item) => item.id !== project.id),
  ].slice(0, 5);
  localStorage.setItem("piDeck.recentProjects", JSON.stringify(next));
  return next;
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

function formatTime(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function formatRelativeTime(timestamp: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatReadableTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatContextUsage(stats: UsageStats): string {
  if (stats.contextUsedTokens === undefined) {
    return stats.contextWindowTokens === undefined
      ? "unknown"
      : `0 / ${formatInteger(stats.contextWindowTokens)}`;
  }
  if (stats.contextWindowTokens === undefined) {
    return formatInteger(stats.contextUsedTokens);
  }
  const percent = Math.min(
    999,
    Math.round((stats.contextUsedTokens / stats.contextWindowTokens) * 100),
  );
  return `${formatInteger(stats.contextUsedTokens)} / ${formatInteger(stats.contextWindowTokens)} (${percent}%)`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatCurrency(value: number | undefined): string {
  if (value === undefined) {
    return "unavailable";
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function processCwdPlaceholder(mode: "fake" | "real"): string {
  return mode === "real"
    ? "Real Pi worker cwd unavailable"
    : "Local demo backend cwd unavailable";
}

export const __rendererTestHooks = {
  reduceRuntimeEvent,
  sessionFromSnapshot,
  mergeSessionUsageFromSnapshot,
  mergeAttachmentDrafts,
  isMissingSessionFileError,
  isSessionDeletable,
};

function getRendererNodeAccessSummary(): string {
  const hasProcess = Reflect.get(globalThis, "process") !== undefined;
  const hasRequire = Reflect.get(globalThis, "require") !== undefined;
  return hasProcess || hasRequire
    ? "unexpected Node globals visible"
    : "no process/require globals visible";
}
