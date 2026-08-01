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
  AppBootstrapState,
  AppSettings,
  AttachmentDraft,
  ChatCommandSummary,
  ChatListModelsResult,
  ChatMessage,
  ChatModelSummary,
  ChatRuntimeEvent,
  ChatRuntimeStatus,
  ChatSessionSummary,
  ChatSnapshot,
  DiagnosticsSummary,
  ProjectListResult,
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
import { Button } from "./components/ui/Button.js";
import { IconButton } from "./components/ui/IconButton.js";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Copy,
  CornerUpLeft,
  FolderOpen,
  Gauge,
  History,
  ListPlus,
  LoaderCircle,
  Monitor,
  Moon,
  PanelLeft,
  Paperclip,
  Play,
  RotateCcw,
  Search,
  Square,
  SquarePen,
  Sun,
  Trash2,
  Unplug,
  Wrench,
  X,
  type LucideIcon,
} from "./components/ui/icons.js";
import { Menu } from "./components/ui/Menu.js";
import {
  attachmentTokens,
  getOrCreateAttachmentOwnerGeneration,
  mergeAttachmentDrafts,
  releaseAttachmentOwner,
  releaseAttachmentTokens,
  transferAttachmentOwnership,
} from "./attachmentLifecycle.js";
import { RuntimeEventBuffer } from "./runtimeEventBuffer.js";

type LoadState =
  | { state: "loading" }
  | {
      state: "ready";
      version: string;
      settings: AppSettings;
      diagnostics: DiagnosticsSummary;
    }
  | { state: "error"; message: string };

type SessionStatus =
  | "idle"
  | "starting"
  | "sending"
  | "working"
  | "aborting"
  | "reconnecting"
  | "waiting"
  | "error";

/** Kept local until the shared settings schema lands from the persistence worktree. */
type AppearanceTheme = "system" | "light" | "dark";

function appearanceThemeFromSettings(settings: AppSettings): AppearanceTheme {
  const theme = (settings as AppSettings & { theme?: unknown }).theme;
  return theme === "light" || theme === "dark" || theme === "system"
    ? theme
    : "system";
}

type ExtensionUiDialogMethod = "select" | "confirm" | "input" | "editor";

interface PendingExtensionUiRequest {
  id: string;
  method: ExtensionUiDialogMethod;
  title: string;
  message?: string | undefined;
  options?: string[] | undefined;
  placeholder?: string | undefined;
  prefill?: string | undefined;
  timeout?: number | undefined;
}

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
      status: "running" | "success" | "error" | "collapsed";
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
  workingStartedAtMs?: number | undefined;
  lastRuntimeEventLabel?: string | undefined;
  modelLabel?: string;
  thinkingLevel?: string;
  lastError?: string | undefined;
  runtimeBacked: boolean;
  backendMode?: "fake" | "real";
  sessionFile?: string;
  resumeBacked?: boolean;
  /** A local placeholder; its Pi worker is created only on first send. */
  draftSession?: boolean;
  projectId?: string;
  /** The saved session worker/transcript is being restored. */
  isResuming?: boolean;
  pendingExtensionUiRequests?: PendingExtensionUiRequest[];
  /** Prompt retained only after a failed send so recovery can retry it. */
  retryPrompt?: { text: string; attachments: AttachmentDraft[] } | undefined;
  /** A final message arrived but the authoritative agent_end has not. */
  awaitingAgentEnd?: boolean;
  /** A provider failure observed in a Pi runtime event, not a local UI error. */
  providerErrorObserved?: boolean;
}

interface ComposerDraftState {
  text: string;
  attachments: AttachmentDraft[];
  slashOpen: boolean;
}

type ComposerDraftsBySession = Record<string, ComposerDraftState | undefined>;

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
  insertText?: string;
}

interface RuntimeCapabilities {
  models?: ChatModelSummary[];
  thinkingLevels?: string[];
  commands?: SlashCommand[];
}

type RuntimeCapabilitiesById = Record<string, RuntimeCapabilities>;

const appStartedAt = Date.now();
const WORKING_SESSION_RECONCILE_AFTER_MS = 3_000;
const NO_VISIBLE_OUTPUT_NOTICE_MS = 3_000;
const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

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
  status: "starting",
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
  const [composerDrafts, setComposerDrafts] = useState<ComposerDraftsBySession>(
    {},
  );
  const [composerError, setComposerError] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<ProjectRef>(() => ({
    id: "pending-project",
    path: "Resolving project…",
    canonicalPath: "",
    displayName: "Pi Deck",
    lastOpenedAt: appStartedAt,
  }));
  const [recentProjects, setRecentProjects] = useState<ProjectRef[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(
    modelOptions[0]?.id ?? "",
  );
  const [selectedThinking, setSelectedThinking] = useState("medium");
  const [realCapabilitiesByRuntime, setRealCapabilitiesByRuntime] =
    useState<RuntimeCapabilitiesById>({});
  const [projectModelConfiguration, setProjectModelConfiguration] =
    useState<ChatListModelsResult>({ models: [], thinkingLevels: [] });
  const [sidebarVisible, setSidebarVisible] = useState(() =>
    loadSidebarVisiblePreference(),
  );
  const [usageStatsVisible, setUsageStatsVisible] = useState(() =>
    loadUsageStatsVisiblePreference(),
  );
  const [appearanceTheme, setAppearanceTheme] =
    useState<AppearanceTheme>("system");
  const [appearanceThemePending, setAppearanceThemePending] = useState(false);
  const [uiMessage, setUiMessage] = useState(
    "Starting Pi Deck and resolving the active backend session.",
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  // closeSession intentionally terminates its child process. Ignore that
  // expected worker_exit while converting the row to a resumable saved session.
  const intentionallyClosingRuntimeIds = useRef(new Set<string>());
  // A stale/missed lifecycle event may need recovery, but never let repeated
  // renders fan out duplicate status requests for the same runtime.
  const reconcilingRuntimeIds = useRef(new Set<string>());
  const sessionsRef = useRef<SessionViewModel[]>([]);
  const composerDraftsRef = useRef<ComposerDraftsBySession>({});
  // Stable session IDs can reappear after project switches/reloads, so each
  // composer incarnation gets a unique, one-use attachment owner generation.
  const attachmentOwnersBySession = useRef(new Map<string, string>());
  const blockedAttachmentOwnerIds = useRef(new Set<string>());
  const selectedSessionIdRef = useRef(selectedSessionId);
  const currentProjectRef = useRef(currentProject);
  const sessionListGeneration = useRef(0);
  const reconciliationRetryTimers = useRef(new Map<string, number>());
  const reconciliationRetryAttempts = useRef(new Map<string, number>());
  sessionsRef.current = sessions;
  composerDraftsRef.current = composerDrafts;
  selectedSessionIdRef.current = selectedSessionId;
  currentProjectRef.current = currentProject;

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let eventBuffer: RuntimeEventBuffer | undefined;
    let bootstrapRefreshFrame: number | undefined;
    let bootstrapRefreshSecondFrame: number | undefined;

    async function refreshBootstrapSessionList(
      api: typeof window.piDeck,
      bootstrap: AppBootstrapState,
      generation: number,
    ): Promise<void> {
      try {
        const listed = await api.chat.listSessions({
          projectId: bootstrap.project.id,
        });
        // Do not let a late startup scan replace a project the user has since
        // selected, or overwrite a newer explicit refresh.
        if (
          disposed ||
          generation !== sessionListGeneration.current ||
          currentProjectRef.current.id !== bootstrap.project.id
        ) {
          return;
        }
        setSessions((items) =>
          mergeSessions(
            items.filter(
              (item) =>
                item.runtimeBacked ||
                item.draftSession === true ||
                hasComposerDraft(composerDraftsRef.current, item.id) ||
                item.projectId !== bootstrap.project.id,
            ),
            listed.sessions.map((summary) =>
              sessionFromSummary(summary, bootstrap.project.id),
            ),
          ),
        );
        setUiMessage(
          `Real Pi mode active. Found ${listed.sessions.length} saved session(s) for this project.`,
        );
      } catch (error) {
        if (
          !disposed &&
          generation === sessionListGeneration.current &&
          currentProjectRef.current.id === bootstrap.project.id
        ) {
          setUiMessage(
            `Saved-session refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

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
            const status = await deckApi.chat.getRuntimeStatus({ runtimeId });
            if (disposed || status.runtimeId !== runtimeId) {
              return;
            }
            setSessions((items) =>
              updateSessionByRuntimeId(items, runtimeId, (item) =>
                mergeSessionUsageFromRuntimeStatus(item, status),
              ),
            );
          } catch {
            // Usage is best-effort; keep the streamed conversation visible.
          }
        }

        eventBuffer = new RuntimeEventBuffer({
          deliver: (event) => {
            if (!disposed) {
              applyRuntimeEvent(event);
            }
          },
          isRuntimeVisible: (runtimeId) =>
            selectedSessionIdRef.current === runtimeId,
        });
        unsubscribe = api.chat.onEvent((event) => {
          if (disposed) {
            return;
          }
          eventBuffer?.handle(event);
          // agent_end is a synchronous buffer barrier, so its preceding
          // message/tool updates have already reached the reducer here.
          // Pi's final event often already contains usage. Only fall back to
          // compact get_state metadata when it does not.
          if (event.type === "agent_end" && !eventHasUsageMetadata(event)) {
            void refreshRuntimeUsage(event.runtimeId);
          }
        });
        const bootstrap = await api.app.getBootstrapState();
        if (disposed) {
          return;
        }

        // A draft is a renderer-only shell. It intentionally has no runtime
        // id, so the first send is the only path that can create a Pi worker.
        const draft = draftSessionForProject(
          bootstrap.project,
          createId("draft-session"),
          bootstrap.backendMode,
        );
        const cachedRows = bootstrap.cachedSessions.map((summary) =>
          sessionFromSummary(summary, bootstrap.project.id),
        );
        setSessions(
          bootstrap.backendMode === "real"
            ? mergeSessions([draft], cachedRows)
            : [
                draft,
                ...initialSessions.filter(
                  (session) => session.id !== "session-active",
                ),
              ],
        );
        setSelectedSessionId(draft.id);
        setCurrentProject(bootstrap.project);
        setRecentProjects(
          bootstrap.backendMode === "real"
            ? bootstrap.projects
            : [invalidRecentProject],
        );
        setUiMessage(
          bootstrap.backendMode === "real"
            ? `Real Pi mode active. Showing ${cachedRows.length} cached session(s); refreshing saved sessions in the background.`
            : "Local demo mode active. Pi starts when you send the first prompt.",
        );
        setLoadState({
          state: "ready",
          version: bootstrap.version,
          settings: bootstrap.settings,
          diagnostics: bootstrap.diagnostics,
        });
        setAppearanceTheme(appearanceThemeFromSettings(bootstrap.settings));

        if (bootstrap.backendMode === "real") {
          void api.chat
            .listModels({ projectId: bootstrap.project.id })
            .then((result) => {
              if (!disposed) {
                setProjectModelConfiguration(result);
                setSessions((items) =>
                  applyPiDefaultsToDraftSessions(
                    items,
                    bootstrap.project.id,
                    result,
                  ),
                );
              }
            })
            .catch(() => {
              if (!disposed) {
                setProjectModelConfiguration({
                  models: [],
                  thinkingLevels: [],
                });
              }
            });
          const generation = ++sessionListGeneration.current;
          // Two animation frames guarantee the ready shell has an opportunity
          // to commit and paint before main begins its potentially expensive
          // repository scan.
          bootstrapRefreshFrame = window.requestAnimationFrame(() => {
            bootstrapRefreshSecondFrame = window.requestAnimationFrame(() => {
              void refreshBootstrapSessionList(api, bootstrap, generation);
            });
          });
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
      eventBuffer?.dispose();
      if (bootstrapRefreshFrame !== undefined) {
        window.cancelAnimationFrame(bootstrapRefreshFrame);
      }
      if (bootstrapRefreshSecondFrame !== undefined) {
        window.cancelAnimationFrame(bootstrapRefreshSecondFrame);
      }
      for (const timer of reconciliationRetryTimers.current.values()) {
        window.clearTimeout(timer);
      }
      reconciliationRetryTimers.current.clear();
      reconciliationRetryAttempts.current.clear();
    };
  }, []);

  // A renderer reload/disposal loses all composer and retry references. Main
  // retains each selection only by its owner, so revoke every owner we created
  // rather than relying solely on the ten-minute expiry fallback.
  useEffect(() => {
    return () => {
      for (const ownerId of attachmentOwnersBySession.current.values()) {
        void releaseAttachmentOwner(window.piDeck.attachments, ownerId).catch(
          () => undefined,
        );
      }
    };
  }, []);

  // A session-list refresh may remove a saved row while a native picker is
  // still resolving. Revoke its owner on the next render even if the async
  // callback raced the state replacement.
  useEffect(() => {
    const visibleSessionIds = new Set(sessions.map((session) => session.id));
    for (const sessionId of attachmentOwnersBySession.current.keys()) {
      if (!visibleSessionIds.has(sessionId)) {
        discardComposerAttachmentOwner(sessionId);
      }
    }
  }, [composerDrafts, sessions]);

  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ??
    sessions[0] ??
    loadingSession;
  const selectedModel =
    modelOptions.find((model) => model.id === selectedModelId) ??
    modelOptions[0];
  const selectedRealCapabilities =
    selectedSession.backendMode === "real"
      ? runtimeCapabilitiesFor(realCapabilitiesByRuntime, selectedSession.id)
      : undefined;
  const runtimeModels = selectedRealCapabilities?.models ?? [];
  const realModels =
    runtimeModels.length > 0 ? runtimeModels : projectModelConfiguration.models;
  const activeRealModel = findActiveRealModel(selectedSession, realModels);
  const runtimeThinkingLevels = selectedRealCapabilities?.thinkingLevels ?? [];
  const availableRealThinkingLevels =
    runtimeThinkingLevels.length > 0
      ? runtimeThinkingLevels
      : thinkingLevelsForModel(
          activeRealModel,
          projectModelConfiguration.thinkingLevels,
        );
  const realCommands = selectedRealCapabilities?.commands ?? [];
  const composerDraft = composerDraftForSession(
    composerDrafts,
    selectedSession.id,
  );
  const draft = composerDraft.text;
  const attachments = composerDraft.attachments;
  const slashOpen = composerDraft.slashOpen;
  const isWorking = selectedSession.status === "working";
  const isBusy = isSessionBusy(selectedSession);
  const isResuming = selectedSession.status === "reconnecting";
  const isRealBackendMode = selectedSession.backendMode === "real";
  const hasBlockingAttachment = attachments.some(
    (attachment) => attachment.status !== "ready",
  );
  const hasImageAttachment = attachments.some(
    (attachment) => attachment.kind === "image",
  );
  const canSend =
    draft.trim().length > 0 &&
    !isBusy &&
    !isResuming &&
    loadState.state === "ready";
  const canIntervene =
    draft.trim().length > 0 &&
    isWorking &&
    !isResuming &&
    loadState.state === "ready";
  const availableSlashCommands = isRealBackendMode
    ? realCommands
    : slashCommands;
  const knownExtensionCommand = findKnownExtensionCommand(
    draft,
    availableSlashCommands,
  );
  const filteredCommands = availableSlashCommands.filter((command) =>
    command.name.toLowerCase().includes(draft.trim().toLowerCase()),
  );
  const showStarterPage =
    selectedSession.timeline.length === 0 && selectedSession.status === "idle";

  useEffect(() => {
    const compactLayout = window.matchMedia("(max-width: 760px)");
    const collapseSidebarForCompactLayout = (): void => {
      if (compactLayout.matches) {
        // Preserve the desktop preference, but never let the session drawer
        // consume the narrow layout on launch or after a resize.
        setSidebarVisible(false);
      }
    };
    collapseSidebarForCompactLayout();
    compactLayout.addEventListener("change", collapseSidebarForCompactLayout);
    return () => {
      compactLayout.removeEventListener(
        "change",
        collapseSidebarForCompactLayout,
      );
    };
  }, []);

  useEffect(() => {
    const hasWorkingSession = sessions.some(isSessionBusy);
    if (!hasWorkingSession) {
      return;
    }
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [sessions]);

  useEffect(() => {
    if (loadState.state !== "ready") {
      return;
    }
    const runtimeIds = sessions
      .filter(
        (session) =>
          session.backendMode === "real" &&
          session.runtimeBacked &&
          shouldReconcileSession(session),
      )
      .map((session) => session.id);
    if (runtimeIds.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      void reconcileWorkingSessions(runtimeIds);
    }, WORKING_SESSION_RECONCILE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [loadState.state, sessions]);

  async function reconcileWorkingSessions(runtimeIds: string[]): Promise<void> {
    for (const runtimeId of runtimeIds) {
      if (
        !shouldReconcileSession(
          sessionsRef.current.find((session) => session.id === runtimeId) ??
            loadingSession,
        ) ||
        reconcilingRuntimeIds.current.has(runtimeId)
      ) {
        continue;
      }
      reconcilingRuntimeIds.current.add(runtimeId);
      try {
        const status = await window.piDeck.chat.getRuntimeStatus({ runtimeId });
        setSessions((current) =>
          updateSessionByRuntimeId(current, runtimeId, (session) =>
            shouldReconcileSession(session)
              ? reconcileSessionWithRuntimeStatus(session, status)
              : session,
          ),
        );
        const currentSession = sessionsRef.current.find(
          (session) => session.id === runtimeId,
        );
        if (
          status.state.isAgentActive &&
          currentSession !== undefined &&
          shouldReconcileSession(currentSession)
        ) {
          scheduleRuntimeStatusRetry(runtimeId);
        } else {
          clearRuntimeStatusRetry(runtimeId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSessions((current) =>
          updateSessionByRuntimeId(current, runtimeId, (session) =>
            isLifecycleTransition(session.status)
              ? appendDiagnostic(session, {
                  tone: "error",
                  content: `Could not reconcile Pi runtime: ${message}`,
                })
              : session,
          ),
        );
      } finally {
        reconcilingRuntimeIds.current.delete(runtimeId);
      }
    }
  }

  function scheduleRuntimeStatusRetry(runtimeId: string): void {
    if (reconciliationRetryTimers.current.has(runtimeId)) {
      return;
    }
    const attempt = reconciliationRetryAttempts.current.get(runtimeId) ?? 0;
    const delayMs = Math.min(
      WORKING_SESSION_RECONCILE_AFTER_MS * 2 ** attempt,
      30_000,
    );
    reconciliationRetryAttempts.current.set(runtimeId, attempt + 1);
    const timer = window.setTimeout(() => {
      reconciliationRetryTimers.current.delete(runtimeId);
      if (
        shouldReconcileSession(
          sessionsRef.current.find((session) => session.id === runtimeId) ??
            loadingSession,
        )
      ) {
        void reconcileWorkingSessions([runtimeId]);
      }
    }, delayMs);
    reconciliationRetryTimers.current.set(runtimeId, timer);
  }

  function clearRuntimeStatusRetry(runtimeId: string): void {
    const timer = reconciliationRetryTimers.current.get(runtimeId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      reconciliationRetryTimers.current.delete(runtimeId);
    }
    reconciliationRetryAttempts.current.delete(runtimeId);
  }

  function attachmentOwnerForSession(sessionId: string): string {
    return getOrCreateAttachmentOwnerGeneration(
      attachmentOwnersBySession.current,
      blockedAttachmentOwnerIds.current,
      sessionId,
      () => createId("attachment-owner"),
    );
  }

  function blockAttachmentOwner(sessionId: string): void {
    blockedAttachmentOwnerIds.current.add(sessionId);
  }

  function unblockAttachmentOwner(sessionId: string): void {
    blockedAttachmentOwnerIds.current.delete(sessionId);
  }

  function releaseSelectedAttachmentTokens(
    ownerId: string,
    selectedPathTokens: readonly string[],
  ): void {
    void releaseAttachmentTokens(
      window.piDeck.attachments,
      ownerId,
      selectedPathTokens,
    ).catch(() => undefined);
  }

  function discardComposerAttachmentOwner(sessionId: string): void {
    discardComposerAttachmentOwners([sessionId]);
  }

  function discardComposerAttachmentOwners(
    sessionIds: readonly string[],
  ): void {
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (uniqueSessionIds.length === 0) {
      return;
    }
    const ownerIds: string[] = [];
    for (const sessionId of uniqueSessionIds) {
      blockAttachmentOwner(sessionId);
      const ownerId = attachmentOwnersBySession.current.get(sessionId);
      if (ownerId !== undefined) {
        ownerIds.push(ownerId);
        attachmentOwnersBySession.current.delete(sessionId);
      }
    }
    setComposerDrafts((items) =>
      clearComposerDraftsForSessions(items, uniqueSessionIds),
    );
    for (const ownerId of ownerIds) {
      void releaseAttachmentOwner(window.piDeck.attachments, ownerId).catch(
        () => undefined,
      );
    }
  }

  /**
   * Complete a deletion only for rows main has confirmed absent. The untouched
   * candidate rows retain both their composer state and main-process owners.
   */
  function finalizeSavedSessionDeletion(
    candidates: readonly SessionViewModel[],
    removed: readonly SessionViewModel[],
  ): void {
    const removedIds = new Set(removed.map((session) => session.id));
    if (removedIds.size === 0) {
      for (const session of candidates) {
        unblockAttachmentOwner(session.id);
      }
      return;
    }

    discardComposerAttachmentOwners([...removedIds]);
    for (const session of candidates) {
      if (!removedIds.has(session.id)) {
        unblockAttachmentOwner(session.id);
      }
    }

    // Preserve updates that arrived while the deletion IPC was in flight and
    // only remove rows known to have been torn down.
    const remainingSessions = removeSessionsByIds(
      sessionsRef.current,
      removedIds,
    );
    setSessions((items) => removeSessionsByIds(items, removedIds));
    if (removedIds.has(selectedSessionIdRef.current)) {
      const nextSession =
        remainingSessions.find((session) => session.runtimeBacked) ??
        remainingSessions[0];
      if (nextSession !== undefined) {
        setSelectedSessionId(nextSession.id);
      } else {
        void handleNewSession();
      }
    }
  }

  function canAcceptAttachmentsForSession(sessionId: string): boolean {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    return (
      session !== undefined &&
      !isLifecycleTransition(session.status) &&
      !blockedAttachmentOwnerIds.current.has(sessionId)
    );
  }

  function acceptImportedAttachments(
    sessionId: string,
    ownerId: string,
    imported: AttachmentDraft[],
  ): boolean {
    const ownerIsCurrent =
      attachmentOwnersBySession.current.get(sessionId) === ownerId;
    if (!ownerIsCurrent || !canAcceptAttachmentsForSession(sessionId)) {
      releaseSelectedAttachmentTokens(ownerId, attachmentTokens(imported));
      return false;
    }

    setComposerDrafts((items) => {
      // The native picker/import may resolve after its target session was
      // closed, resumed, or began delivery. Never create an orphan composer
      // draft in that case or attach it to a newer owner generation.
      if (
        !canAcceptAttachmentsForSession(sessionId) ||
        attachmentOwnersBySession.current.get(sessionId) !== ownerId
      ) {
        releaseSelectedAttachmentTokens(ownerId, attachmentTokens(imported));
        return items;
      }
      const current = composerDraftForSession(items, sessionId);
      const merged = mergeAttachmentDrafts(current.attachments, imported);
      releaseSelectedAttachmentTokens(
        ownerId,
        attachmentTokens(merged.discarded),
      );
      return updateComposerDraft(items, sessionId, (draft) => ({
        ...draft,
        attachments: merged.attachments,
      }));
    });
    return true;
  }

  async function transferComposerAttachmentOwnership(
    previousSessionId: string,
    sessionId: string,
    attachmentsToTransfer: AttachmentDraft[],
  ): Promise<boolean> {
    if (previousSessionId === sessionId) {
      return true;
    }
    const previousOwnerId =
      attachmentOwnersBySession.current.get(previousSessionId);
    const readyTokens = attachmentTokens(
      attachmentsToTransfer.filter(
        (attachment) => attachment.status === "ready",
      ),
    );
    if (readyTokens.length === 0) {
      if (previousOwnerId !== undefined) {
        attachmentOwnersBySession.current.delete(previousSessionId);
        void releaseAttachmentOwner(
          window.piDeck.attachments,
          previousOwnerId,
        ).catch(() => undefined);
      }
      return true;
    }
    if (previousOwnerId === undefined) {
      return false;
    }

    const existingOwnerId = attachmentOwnersBySession.current.get(sessionId);
    const ownerId = existingOwnerId ?? attachmentOwnerForSession(sessionId);
    try {
      await transferAttachmentOwnership(
        window.piDeck.attachments,
        previousOwnerId,
        previousSessionId,
        ownerId,
        sessionId,
        attachmentsToTransfer,
      );
      // Revoke the old generation after its represented tokens moved. Any
      // omitted stale token is discarded rather than following the session.
      void releaseAttachmentOwner(
        window.piDeck.attachments,
        previousOwnerId,
      ).catch(() => undefined);
      attachmentOwnersBySession.current.delete(previousSessionId);
      return true;
    } catch {
      if (existingOwnerId === undefined) {
        attachmentOwnersBySession.current.delete(sessionId);
        void releaseAttachmentOwner(window.piDeck.attachments, ownerId).catch(
          () => undefined,
        );
      }
      return false;
    }
  }

  function applyRuntimeEvent(event: ChatRuntimeEvent): void {
    if (event.type === "agent_end" || event.type === "worker_exit") {
      clearRuntimeStatusRetry(event.runtimeId);
    }
    if (event.type === "agent_end") {
      unblockAttachmentOwner(event.runtimeId);
    }
    if (
      event.type === "worker_exit" &&
      intentionallyClosingRuntimeIds.current.delete(event.runtimeId)
    ) {
      return;
    }
    if (event.type === "worker_exit") {
      // Main has already released this runtime owner. Drop renderer references
      // too, so a later resume cannot try to reuse revoked tokens.
      discardComposerAttachmentOwner(event.runtimeId);
    }
    setSessions((current) =>
      updateSessionByRuntimeId(current, event.runtimeId, (session) =>
        reduceRuntimeEvent(session, event),
      ),
    );
  }

  function handleComposerKeyDown(
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    if (isWorking) {
      handleSteer();
    } else {
      handleSend();
    }
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
    setComposerDrafts((items) =>
      updateComposerDraft(items, selectedSession.id, (current) => ({
        ...current,
        text: value,
        slashOpen: value.trimStart().startsWith("/"),
      })),
    );
  }

  function handleSelectSession(sessionId: string): void {
    const session = sessions.find((item) => item.id === sessionId);
    if (session?.isResuming === true) {
      return;
    }
    if (
      session?.backendMode === "real" &&
      session.resumeBacked === true &&
      session.sessionFile !== undefined
    ) {
      void resumeSession(session);
      return;
    }
    setSelectedSessionId(sessionId);
    if (session?.backendMode === "real" && session.runtimeBacked) {
      loadRealCapabilities(session.id);
    }
  }

  async function resumeSession(
    session: SessionViewModel,
  ): Promise<SessionViewModel | undefined> {
    if (session.sessionFile === undefined) {
      return undefined;
    }
    setComposerError(null);
    setSelectedSessionId(session.id);
    blockAttachmentOwner(session.id);
    setSessions((items) =>
      items.map((item) =>
        item.id === session.id
          ? {
              ...item,
              isResuming: true,
              status: "reconnecting",
              baseState: "attaching",
              subtitle: "Reconnecting · loading previous context…",
            }
          : item,
      ),
    );
    setUiMessage(`Loading previous context for ${session.title}…`);
    try {
      const snapshot = await window.piDeck.chat.resumeSession({
        projectId: currentProject.id,
        sessionFile: session.sessionFile,
      });
      const resumed = sessionFromSnapshot(snapshot);
      const draftToMove = composerDraftForSession(
        composerDraftsRef.current,
        session.id,
      );
      const transferred = await transferComposerAttachmentOwnership(
        session.id,
        resumed.id,
        draftToMove.attachments,
      );
      if (!transferred) {
        // The worker is usable, but an expired/stale selection cannot safely
        // follow it to the new runtime. Preserve typed text and ask for a
        // fresh attachment instead of carrying a dead token into retry.
        const expiredOwnerId = attachmentOwnersBySession.current.get(
          session.id,
        );
        attachmentOwnersBySession.current.delete(session.id);
        if (expiredOwnerId !== undefined) {
          void releaseAttachmentOwner(
            window.piDeck.attachments,
            expiredOwnerId,
          ).catch(() => undefined);
        }
        setComposerDrafts((items) =>
          updateComposerDraft(items, session.id, (current) => ({
            ...current,
            attachments: [],
          })),
        );
        setComposerError(
          "One or more attachments expired; reselect them before sending.",
        );
      }
      // Use the state at completion time: another runtime can stream while
      // this saved session is being resumed.
      setSessions((items) => replaceResumedSession(items, session.id, resumed));
      setSelectedSessionId(resumed.id);
      setComposerDrafts((items) =>
        moveComposerDraft(items, session.id, resumed.id),
      );
      loadRealCapabilities(resumed.id);
      setUiMessage(
        transferred
          ? "Resumed saved Pi session."
          : "Resumed saved Pi session; reselect expired attachments before sending.",
      );
      return transferred ? resumed : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingSessionFileError(message)) {
        // Do not restore the pre-await render's session array here. Runtime
        // events from other workers may have arrived while resume was pending.
        const remainingSessions = removeSessionById(
          sessionsRef.current,
          session.id,
        );
        setSessions((items) => removeSessionById(items, session.id));
        discardComposerAttachmentOwner(session.id);
        if (selectedSessionIdRef.current === session.id) {
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
      unblockAttachmentOwner(session.id);
      setUiMessage(`Failed to resume session: ${message}`);
      setSessions((items) =>
        items.map((item) =>
          item.id === session.id
            ? appendDiagnostic(
                {
                  ...item,
                  status: "error",
                  baseState: "error",
                  isResuming: false,
                  subtitle: "Error · unable to resume saved session",
                },
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
    const validationError = validateComposerInput({
      attachments: promptAttachments,
      supportsImages: selectedSessionSupportsImages(
        session,
        realModels,
        selectedModel,
      ),
    });
    if (validationError !== undefined) {
      setComposerError(validationError);
      return;
    }
    const resumed = await resumeSession(session);
    if (resumed !== undefined) {
      await sendPrompt(resumed.id, prompt, promptAttachments);
    }
  }

  function handleSend(): void {
    if (!canSend) {
      return;
    }
    const prompt = draft.trimEnd();
    const promptAttachments = attachments;
    const validationError = validateComposerInput({
      attachments: promptAttachments,
      supportsImages: selectedSessionSupportsImages(
        selectedSession,
        realModels,
        selectedModel,
      ),
    });
    if (validationError !== undefined) {
      setComposerError(validationError);
      return;
    }
    if (
      selectedSession.resumeBacked === true &&
      selectedSession.sessionFile !== undefined
    ) {
      void resumeSessionAndSend(selectedSession, prompt, promptAttachments);
      return;
    }
    if (selectedSession.draftSession === true) {
      void startDraftSessionAndSend(selectedSession, prompt, promptAttachments);
      return;
    }
    if (!selectedSession.runtimeBacked) {
      setComposerError(
        "This session row is not attached to a Pi runtime. Select a real backend session or relaunch in real mode.",
      );
      return;
    }

    void sendPrompt(selectedSession.id, prompt, promptAttachments);
  }

  async function startDraftSessionAndSend(
    draftSession: SessionViewModel,
    prompt: string,
    promptAttachments: AttachmentDraft[],
  ): Promise<void> {
    const validationError = validateComposerInput({
      attachments: promptAttachments,
      supportsImages: selectedSessionSupportsImages(
        draftSession,
        realModels,
        selectedModel,
      ),
    });
    if (validationError !== undefined) {
      setComposerError(validationError);
      return;
    }
    setComposerError(null);
    blockAttachmentOwner(draftSession.id);
    setSessions((items) =>
      items.map((session) =>
        session.id === draftSession.id
          ? {
              ...session,
              status: "starting",
              baseState: "attaching",
              subtitle: "Starting · launching Pi RPC worker for first prompt",
            }
          : session,
      ),
    );
    setUiMessage("Starting Pi for this session…");
    let createdRuntimeId: string | undefined;
    let backendSession: SessionViewModel | undefined;
    try {
      let snapshot = await window.piDeck.chat.createSession({
        projectId: draftSession.projectId ?? currentProject.id,
      });
      // Configuration RPCs can fail after main has successfully spawned and
      // registered this worker. Retain the original id so this setup attempt
      // can be rolled back instead of becoming an invisible capacity consumer.
      createdRuntimeId = snapshot.runtimeId;
      const selectedDraftModel = parseModelLabel(draftSession.modelLabel);
      if (selectedDraftModel !== undefined) {
        snapshot = await window.piDeck.chat.setModel({
          runtimeId: snapshot.runtimeId,
          provider: selectedDraftModel.provider,
          modelId: selectedDraftModel.modelId,
        });
      }
      if (draftSession.thinkingLevel !== undefined) {
        snapshot = await window.piDeck.chat.setThinking({
          runtimeId: snapshot.runtimeId,
          level: draftSession.thinkingLevel,
        });
      }
      const transferred = await transferComposerAttachmentOwnership(
        draftSession.id,
        snapshot.runtimeId,
        promptAttachments,
      );
      if (!transferred) {
        const expiredOwnerId = attachmentOwnersBySession.current.get(
          draftSession.id,
        );
        attachmentOwnersBySession.current.delete(draftSession.id);
        if (expiredOwnerId !== undefined) {
          void releaseAttachmentOwner(
            window.piDeck.attachments,
            expiredOwnerId,
          ).catch(() => undefined);
        }
        setComposerDrafts((items) =>
          updateComposerDraft(items, draftSession.id, (current) => ({
            ...current,
            attachments: [],
          })),
        );
      }
      const initializedSession = {
        ...sessionFromSnapshot(snapshot),
        title: draftSession.title,
      };
      backendSession = initializedSession;
      setSessions((items) =>
        mergeSessions(
          [initializedSession],
          items.filter((item) => item.id !== draftSession.id),
        ),
      );
      setSelectedSessionId(initializedSession.id);
      setComposerDrafts((items) =>
        moveComposerDraft(items, draftSession.id, initializedSession.id),
      );
      if (initializedSession.backendMode === "real") {
        rememberPiDefaults(initializedSession);
        loadRealCapabilities(initializedSession.id);
      }
      if (snapshot.projectId !== undefined) {
        // Project IDs are app-owned references, not cwd strings. Preserve the
        // selected record when an ID is path-independent in a future/migrated
        // ProjectStore, rather than reconstructing one from Pi's cwd.
        const snapshotProject = [currentProject, ...recentProjects].find(
          (candidate) => candidate.id === snapshot.projectId,
        );
        if (snapshotProject !== undefined) {
          setCurrentProject(snapshotProject);
        }
      } else if (snapshot.state.cwd) {
        setCurrentProject(projectFromCwd(snapshot.state.cwd));
      }
      if (!transferred) {
        setComposerError(
          "One or more attachments expired; reselect them before sending.",
        );
        setUiMessage(
          "Pi is ready, but expired attachments were removed. Reselect them before sending.",
        );
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unblockAttachmentOwner(draftSession.id);
      if (createdRuntimeId !== undefined) {
        try {
          await window.piDeck.chat.closeSession({
            runtimeId: createdRuntimeId,
          });
        } catch (cleanupError) {
          // Preserve the setup failure for the retryable draft; main still
          // clears its runtime maps in a closeSession finally path.
          console.error(
            `Failed to clean up new Pi runtime ${createdRuntimeId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
      setComposerError(message);
      setComposerDrafts((items) =>
        updateComposerDraft(items, draftSession.id, (current) => ({
          ...current,
          attachments: promptAttachments,
        })),
      );
      setSessions((items) =>
        items.map((session) =>
          session.id === draftSession.id
            ? appendDiagnostic(
                {
                  ...session,
                  status: "error",
                  baseState: "error",
                  subtitle: "Error · unable to start Pi worker",
                },
                { tone: "error", content: `New session failed: ${message}` },
              )
            : session,
        ),
      );
      setUiMessage(`Failed to start a new Pi session: ${message}`);
      return;
    }

    // sendPrompt has its own failure/retry path. Keep it outside the setup
    // transaction so a worker is never closed after Pi accepted a prompt.
    if (backendSession !== undefined) {
      await sendPrompt(backendSession.id, prompt, promptAttachments);
    }
  }

  async function sendPrompt(
    runtimeId: string,
    prompt: string,
    promptAttachments: AttachmentDraft[],
  ): Promise<void> {
    const now = formatTime();
    const sentAttachments = timelineAttachmentsFromDrafts(promptAttachments);
    setComposerError(null);
    blockAttachmentOwner(runtimeId);
    setComposerDrafts((items) => clearComposerDraft(items, runtimeId));
    setSessions((current) =>
      current.map((session) =>
        session.id === runtimeId
          ? {
              ...session,
              title: isPlaceholderSessionTitle(session.title)
                ? summarizeTitle(prompt, 64)
                : session.title,
              status: "sending",
              baseState: "attaching",
              overlays: { ...session.overlays, streaming: false },
              subtitle: `Sending · waiting for ${backendLabel(session)} confirmation`,
              workingStartedAtMs: session.workingStartedAtMs ?? Date.now(),
              lastRuntimeEventLabel: "Prompt sent; awaiting Pi confirmation",
              retryPrompt: { text: prompt, attachments: promptAttachments },
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
      const attachmentOwnerId =
        promptAttachments.length > 0
          ? attachmentOwnersBySession.current.get(runtimeId)
          : undefined;
      if (promptAttachments.length > 0 && attachmentOwnerId === undefined) {
        throw new Error(
          "Attachment owner generation is unavailable; reselect attachments and retry.",
        );
      }
      await window.piDeck.chat.prompt({
        runtimeId,
        text: prompt,
        attachments: promptAttachments.map((attachment) => ({
          selectedPathToken: attachment.selectedPathToken,
          sendMode: attachment.sendMode,
        })),
        ...(attachmentOwnerId !== undefined ? { attachmentOwnerId } : {}),
      });
    } catch (error) {
      unblockAttachmentOwner(runtimeId);
      setComposerError(error instanceof Error ? error.message : String(error));
      setComposerDrafts((items) =>
        updateComposerDraft(items, runtimeId, (current) => ({
          ...current,
          attachments: promptAttachments,
        })),
      );
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

  function handleSteer(): void {
    void sendIntervention("steer");
  }

  function handleFollowUp(): void {
    void sendIntervention("followUp");
  }

  function handleRunExtensionCommand(): void {
    if (knownExtensionCommand === undefined) {
      return;
    }
    const prompt = draft.trimEnd();
    const promptAttachments = attachments;
    const validationError = validateComposerInput({
      attachments: promptAttachments,
      supportsImages: selectedSessionSupportsImages(
        selectedSession,
        realModels,
        selectedModel,
      ),
    });
    if (validationError !== undefined) {
      setComposerError(validationError);
      return;
    }
    if (selectedSession.draftSession === true) {
      void startDraftSessionAndSend(selectedSession, prompt, promptAttachments);
      return;
    }
    if (!selectedSession.runtimeBacked) {
      setComposerError("This session is not attached to a Pi runtime.");
      return;
    }
    // Pi executes extension commands immediately through `prompt`, even while
    // streaming. They cannot be sent through steer or follow_up.
    void sendPrompt(selectedSession.id, prompt, promptAttachments);
  }

  async function sendIntervention(kind: "steer" | "followUp"): Promise<void> {
    if (!canIntervene) {
      return;
    }
    if (knownExtensionCommand !== undefined) {
      setComposerError(
        `${knownExtensionCommand} is an extension command and cannot be queued as ${kind === "steer" ? "steering" : "a follow-up"}. Use Run command now instead.`,
      );
      return;
    }
    if (!selectedSession.runtimeBacked) {
      setComposerError("This session is not attached to a Pi runtime.");
      return;
    }
    if (hasBlockingAttachment) {
      setComposerError(
        "Remove or reselect deleted/unreadable attachments before queuing.",
      );
      return;
    }
    if (
      hasImageAttachment &&
      !selectedSessionSupportsImages(selectedSession, realModels, selectedModel)
    ) {
      setComposerError("Selected model does not support image input.");
      return;
    }

    const text = draft.trimEnd();
    const queuedAttachments = attachments;
    setComposerError(null);
    try {
      const attachmentOwnerId =
        queuedAttachments.length > 0
          ? attachmentOwnersBySession.current.get(selectedSession.id)
          : undefined;
      if (queuedAttachments.length > 0 && attachmentOwnerId === undefined) {
        throw new Error(
          "Attachment owner generation is unavailable; reselect attachments and retry.",
        );
      }
      const request = {
        runtimeId: selectedSession.id,
        text,
        attachments: queuedAttachments.map((attachment) => ({
          selectedPathToken: attachment.selectedPathToken,
          sendMode: attachment.sendMode,
        })),
        ...(attachmentOwnerId !== undefined ? { attachmentOwnerId } : {}),
      };
      if (kind === "steer") {
        await window.piDeck.chat.steer(request);
      } else {
        await window.piDeck.chat.followUp(request);
      }
      setComposerDrafts((items) =>
        clearComposerDraft(items, selectedSession.id),
      );
      setUiMessage(
        kind === "steer"
          ? "Steering instruction queued in Pi."
          : "Follow-up queued in Pi after current work.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setComposerError(message);
      setComposerDrafts((items) =>
        updateComposerDraft(items, selectedSession.id, (current) => ({
          ...current,
          attachments: queuedAttachments,
        })),
      );
      setSessions((current) =>
        current.map((session) =>
          session.id === selectedSession.id
            ? appendDiagnostic(session, {
                tone: "error",
                content: `${kind === "steer" ? "Steer" : "Follow-up"} failed: ${message}`,
              })
            : session,
        ),
      );
    }
  }

  function handleAbort(): void {
    void abortPrompt(selectedSession.id);
  }

  async function handleExtensionUiResponse(
    requestId: string,
    response: { confirmed: boolean } | { value: string } | { cancelled: true },
  ): Promise<void> {
    if (!selectedSession.runtimeBacked) {
      throw new Error(
        "This extension UI request no longer has an attached Pi runtime.",
      );
    }
    try {
      await window.piDeck.chat.respondToExtensionUi({
        runtimeId: selectedSession.id,
        requestId,
        response,
      });
      setUiMessage("Extension UI response delivered to Pi.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setComposerError(message);
      throw error;
    }
  }

  function handleRecoverSelectedSession(): void {
    if (selectedSession.sessionFile === undefined) {
      setUiMessage(
        "This session does not have a saved Pi session file to reopen.",
      );
      return;
    }
    void resumeSession({ ...selectedSession, resumeBacked: true });
  }

  function handleRetrySelectedSession(): void {
    const retry = selectedSession.retryPrompt;
    if (!selectedSession.runtimeBacked || retry === undefined) {
      setUiMessage("There is no failed prompt available to retry.");
      return;
    }
    void sendPrompt(selectedSession.id, retry.text, retry.attachments);
  }

  async function handleCopySelectedDiagnostics(): Promise<void> {
    const diagnostics = selectedSession.timeline
      .filter(
        (item): item is Extract<TimelineItem, { kind: "diagnostic" }> =>
          item.kind === "diagnostic",
      )
      .map((item) => `${item.tone.toUpperCase()}: ${item.content}`)
      .join("\n");
    const text =
      diagnostics || selectedSession.lastError || "No diagnostics recorded.";
    try {
      await navigator.clipboard.writeText(text);
      setUiMessage("Copied session diagnostics to the clipboard.");
    } catch {
      setUiMessage("Could not copy diagnostics. Clipboard access was denied.");
    }
  }

  async function abortPrompt(runtimeId: string): Promise<void> {
    if (selectedSession.status !== "working") {
      return;
    }
    setComposerError(null);
    setSessions((current) =>
      current.map((session) =>
        session.id === runtimeId
          ? {
              ...session,
              status: "aborting",
              baseState: "working",
              subtitle: "Aborting · waiting for Pi confirmation",
              lastRuntimeEventLabel: "Abort requested; awaiting Pi completion",
            }
          : session,
      ),
    );
    try {
      await window.piDeck.chat.abort({ runtimeId });
      setUiMessage("Abort requested; waiting for Pi to confirm completion.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const status = await window.piDeck.chat.getRuntimeStatus({ runtimeId });
        if (status.runtimeId !== runtimeId) {
          return;
        }
        if (!status.state.isAgentActive) {
          setSessions((current) =>
            updateSessionByRuntimeId(current, runtimeId, (session) =>
              appendDiagnostic(
                reconcileSessionWithRuntimeStatus(session, status),
                {
                  tone: "info",
                  content: `Abort returned an error, but Pi now reports this session idle: ${message}`,
                },
              ),
            ),
          );
          setUiMessage("Pi reports the session is idle after abort.");
          return;
        }
        // The abort request failed, but this status authoritatively says the
        // turn remains active. Restore working controls; do not claim idle.
        setSessions((current) =>
          updateSessionByRuntimeId(current, runtimeId, (session) =>
            appendDiagnostic(
              {
                ...session,
                status: "working",
                baseState: "working",
                subtitle: `Working · ${backendLabel(session)} confirmed by Pi`,
              },
              {
                tone: "info",
                content: `Abort failed and Pi still reports active work: ${message}`,
              },
            ),
          ),
        );
        setComposerError(message);
        return;
      } catch {
        // Fall through to surfacing the original abort error.
      }
      setComposerError(message);
      setSessions((current) =>
        current.map((session) =>
          session.id === runtimeId
            ? appendDiagnostic(session, {
                tone: "error",
                content: `Abort failed: ${message}`,
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
      const refreshedProjects = await listProjectsIfAvailable(
        window.piDeck,
        result.project,
      );
      await switchProjectView(result.project, refreshedProjects.projects);
    } catch (error) {
      setUiMessage(
        `Project picker failed; no project was selected (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  async function handleSelectProject(project: ProjectRef): Promise<void> {
    if (project.invalidReason) {
      setUiMessage(project.invalidReason);
      return;
    }
    try {
      const result = await selectProjectIfAvailable(window.piDeck, project);
      await switchProjectView(result.activeProject ?? project, result.projects);
    } catch (error) {
      setUiMessage(
        `Failed to select project: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Project navigation is deliberately a view transaction, not a worker
   * transaction. The project store changes first; only after the destination
   * session list is available do we replace the visible project rows. Attached
   * workers (including active, waiting, and Pi-queued work) are never reset or
   * closed here and remain addressable by their runtime id.
   */
  async function switchProjectView(
    project: ProjectRef,
    projects: ProjectRef[],
  ): Promise<void> {
    const sessionListRequest = ++sessionListGeneration.current;
    if (!isRealBackendMode) {
      setCurrentProject(project);
      setRecentProjects(projects);
      setUiMessage(`Selected project ${project.displayName}.`);
      return;
    }
    setComposerError(null);
    setProjectModelConfiguration({ models: [], thinkingLevels: [] });
    setUiMessage(
      `Opening ${project.displayName}; existing Pi workers stay attached…`,
    );
    const modelConfigurationPromise = window.piDeck.chat
      .listModels({ projectId: project.id })
      .catch(() => undefined);
    const listedSessions = await window.piDeck.chat.listSessions({
      projectId: project.id,
    });
    if (sessionListRequest !== sessionListGeneration.current) {
      return;
    }
    const savedRows = listedSessions.sessions.map((summary) =>
      sessionFromSummary(summary, project.id),
    );
    const existingProjectRuntime = sessions
      .filter(
        (session) => session.runtimeBacked && session.projectId === project.id,
      )
      .sort(
        (left, right) =>
          Number(right.status === "working") -
          Number(left.status === "working"),
      )[0];
    const existingProjectDraft = sessions.find(
      (session) =>
        session.draftSession === true && session.projectId === project.id,
    );
    const selectedId =
      existingProjectRuntime?.id ??
      savedRows.find((session) => session.runtimeBacked)?.id ??
      existingProjectDraft?.id ??
      createId("draft-session");
    const draft =
      existingProjectRuntime === undefined &&
      !savedRows.some((session) => session.runtimeBacked) &&
      existingProjectDraft === undefined
        ? draftSessionForProject(project, selectedId)
        : undefined;

    setSessions((items) => {
      // Keep every attached runtime and drafts from other projects. Replace
      // only stale saved rows for the destination project with the fresh scan.
      const retained = items.filter(
        (session) =>
          session.runtimeBacked ||
          session.draftSession === true ||
          hasComposerDraft(composerDraftsRef.current, session.id) ||
          session.projectId !== project.id,
      );
      return mergeSessions(retained, draft ? [...savedRows, draft] : savedRows);
    });
    setCurrentProject(project);
    setRecentProjects(projects);
    setSelectedSessionId(selectedId);
    void modelConfigurationPromise.then((result) => {
      if (sessionListRequest !== sessionListGeneration.current) {
        return;
      }
      if (result === undefined) {
        setProjectModelConfiguration({ models: [], thinkingLevels: [] });
        return;
      }
      setProjectModelConfiguration(result);
      setSessions((items) =>
        applyPiDefaultsToDraftSessions(items, project.id, result),
      );
    });
    if (existingProjectRuntime?.runtimeBacked) {
      loadRealCapabilities(existingProjectRuntime.id);
    }
    const backgroundCount = sessions.filter(
      (session) =>
        session.projectId !== project.id && isBackgroundActiveWork(session),
    ).length;
    setUiMessage(
      `Project view switched to ${project.displayName}. No Pi worker was closed; ${backgroundCount} background active work item${backgroundCount === 1 ? "" : "s"} ${backgroundCount === 1 ? "remains" : "remain"} in Active work.`,
    );
  }

  function loadRealCapabilities(runtimeId: string): void {
    void loadRealModels(runtimeId);
    void loadRealCommands(runtimeId);
  }

  async function loadRealModels(runtimeId: string): Promise<void> {
    try {
      const result = await window.piDeck.chat.listModels({ runtimeId });
      setRealCapabilitiesByRuntime((current) =>
        updateRuntimeCapabilities(current, runtimeId, {
          models: result.models,
          thinkingLevels: result.thinkingLevels,
        }),
      );
    } catch {
      setRealCapabilitiesByRuntime((current) =>
        updateRuntimeCapabilities(current, runtimeId, {
          models: [],
          thinkingLevels: [],
        }),
      );
    }
  }

  async function loadRealCommands(runtimeId: string): Promise<void> {
    try {
      const result = await window.piDeck.chat.listCommands({ runtimeId });
      setRealCapabilitiesByRuntime((current) =>
        updateRuntimeCapabilities(current, runtimeId, {
          commands: result.commands.map(slashCommandFromWorkerCommand),
        }),
      );
    } catch {
      setRealCapabilitiesByRuntime((current) =>
        updateRuntimeCapabilities(current, runtimeId, { commands: [] }),
      );
    }
  }

  async function refreshRealSessions(): Promise<void> {
    if (!isRealBackendMode || loadState.state !== "ready") {
      return;
    }
    const sessionListRequest = ++sessionListGeneration.current;
    const projectId = currentProject.id;
    setUiMessage("Refreshing saved Pi sessions…");
    try {
      const result = await window.piDeck.chat.listSessions({ projectId });
      if (
        sessionListRequest !== sessionListGeneration.current ||
        currentProjectRef.current.id !== projectId
      ) {
        return;
      }
      setSessions((items) =>
        mergeSessions(
          items.filter(
            (item) =>
              item.runtimeBacked ||
              item.draftSession === true ||
              hasComposerDraft(composerDraftsRef.current, item.id),
          ),
          result.sessions.map((summary) =>
            sessionFromSummary(summary, projectId),
          ),
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
    const projectId = currentProject.id;
    const savedSessions = savedSessionsForProject(sessions, projectId);
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

    for (const session of savedSessions) {
      blockAttachmentOwner(session.id);
    }
    try {
      const result = await window.piDeck.chat.deleteAllSessions({ projectId });
      // Counts are not enough when Pi skips individual files. Main returns
      // the exact canonical files it removed, so drafts on skipped rows stay
      // intact instead of being blanket-discarded.
      finalizeSavedSessionDeletion(
        savedSessions,
        savedSessionsForDeletedFiles(savedSessions, result.deletedSessionFiles),
      );
      setUiMessage(
        `Deleted ${result.deletedCount} saved session${result.deletedCount === 1 ? "" : "s"}.${result.skippedCount > 0 ? ` Skipped ${result.skippedCount} attached or unavailable session${result.skippedCount === 1 ? "" : "s"}.` : ""}`,
      );
    } catch (error) {
      // Main returns successful prefixes as an exact result. A rejected bulk
      // request therefore has no confirmed removals, so preserve every draft
      // rather than guessing from a potentially incomplete session scan.
      for (const session of savedSessions) {
        unblockAttachmentOwner(session.id);
      }
      setUiMessage(
        `Failed to delete saved sessions: ${error instanceof Error ? error.message : String(error)}. Drafts were retained; refresh before retrying.`,
      );
    }
  }

  async function handleCloseRuntime(sessionId: string): Promise<void> {
    const session = sessions.find((item) => item.id === sessionId);
    if (session === undefined || !session.runtimeBacked) {
      return;
    }
    if (isSessionBusy(session)) {
      setUiMessage(
        "Wait for Pi to complete or reconcile before closing this runtime.",
      );
      return;
    }

    blockAttachmentOwner(session.id);
    intentionallyClosingRuntimeIds.current.add(session.id);
    try {
      await window.piDeck.chat.closeSession({ runtimeId: session.id });
      discardComposerAttachmentOwner(session.id);
      // Derive both the visible state and selection fallback from the latest
      // render, rather than the array captured before closeSession awaited.
      const remainingSessions = closeRuntimeInSessionState(
        sessionsRef.current,
        session.id,
      );
      setSessions((items) => closeRuntimeInSessionState(items, session.id));
      const detached = remainingSessions.some((item) => item.id === session.id);
      if (selectedSessionIdRef.current === session.id) {
        const nextSession = remainingSessions.find(
          (item) => item.id !== session.id && item.runtimeBacked,
        );
        if (nextSession !== undefined) {
          setSelectedSessionId(nextSession.id);
        } else {
          await handleNewSession();
        }
      }
      setUiMessage(
        detached
          ? "Closed the Pi runtime. The saved session can be resumed later."
          : "Closed the Pi runtime.",
      );
    } catch (error) {
      intentionallyClosingRuntimeIds.current.delete(session.id);
      discardComposerAttachmentOwner(session.id);
      setComposerError(error instanceof Error ? error.message : String(error));
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

    blockAttachmentOwner(session.id);
    if (session.runtimeBacked) {
      // Main must close an attached Pi worker before moving its live session
      // file. Suppress that expected exit while the delete transaction settles.
      intentionallyClosingRuntimeIds.current.add(session.id);
    }
    try {
      const result = await window.piDeck.chat.deleteSession({
        projectId: currentProject.id,
        sessionFile,
      });
      finalizeSavedSessionDeletion(
        [session],
        savedSessionsForDeletedFiles([session], [result.sessionFile]),
      );
      setUiMessage("Deleted Pi session.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let runtimeDetached = false;
      if (session.runtimeBacked) {
        try {
          await window.piDeck.chat.getRuntimeStatus({
            runtimeId: session.id,
          });
          intentionallyClosingRuntimeIds.current.delete(session.id);
        } catch (statusError) {
          runtimeDetached = isDetachedRuntimeError(
            statusError instanceof Error
              ? statusError.message
              : String(statusError),
          );
          if (!runtimeDetached) {
            intentionallyClosingRuntimeIds.current.delete(session.id);
          }
        }
      }

      if (runtimeDetached) {
        // Main deliberately preserved the generation when file removal failed.
        // Keep the same row/id so a later resume can atomically transfer its
        // typed draft and still-live attachment tokens to the new runtime.
        setSessions((items) => closeRuntimeInSessionState(items, session.id));
      }
      unblockAttachmentOwner(session.id);
      setUiMessage(
        runtimeDetached
          ? `Failed to delete session after closing its runtime: ${message}. The saved file and draft were retained; click the session to resume.`
          : `Failed to delete session: ${message}. Draft was retained.`,
      );
    }
  }

  function rememberPiDefaults(session: SessionViewModel): void {
    const activeModel = findActiveRealModel(session, realModels);
    setProjectModelConfiguration((current) => ({
      ...current,
      ...(activeModel !== undefined ? { activeModel } : {}),
      ...(session.thinkingLevel !== undefined
        ? { thinkingLevel: session.thinkingLevel }
        : {}),
      thinkingLevels: thinkingLevelsForModel(
        activeModel,
        current.thinkingLevels,
      ),
    }));
  }

  async function handleSetRealModel(
    provider: string,
    modelId: string,
  ): Promise<void> {
    if (isSessionBusy(selectedSession)) {
      return;
    }
    setComposerError(null);
    if (selectedSession.draftSession === true) {
      const nextModel = realModels.find(
        (model) => model.provider === provider && model.id === modelId,
      );
      const nextThinkingLevels = thinkingLevelsForModel(
        nextModel,
        projectModelConfiguration.thinkingLevels,
      );
      setSessions((items) =>
        items.map((session) =>
          session.id === selectedSession.id
            ? {
                ...session,
                modelLabel: `${provider} / ${modelId}`,
                ...(session.thinkingLevel !== undefined
                  ? {
                      thinkingLevel: clampThinkingLevel(
                        session.thinkingLevel,
                        nextThinkingLevels,
                      ),
                    }
                  : {}),
              }
            : session,
        ),
      );
      setUiMessage(`New session will use ${provider}/${modelId}.`);
      return;
    }
    if (!selectedSession.runtimeBacked) {
      return;
    }
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
            ? mergeSessionUsageFromSnapshot(item, updated)
            : item,
        ),
      );
      rememberPiDefaults(updated);
      void loadRealModels(updated.id);
      setUiMessage(`Switched model to ${provider}/${modelId}.`);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSetRealThinking(level: string): Promise<void> {
    if (isSessionBusy(selectedSession)) {
      return;
    }
    setComposerError(null);
    if (selectedSession.draftSession === true) {
      setSessions((items) =>
        items.map((session) =>
          session.id === selectedSession.id
            ? { ...session, thinkingLevel: level }
            : session,
        ),
      );
      setUiMessage(`New session will use ${level} thinking.`);
      return;
    }
    if (!selectedSession.runtimeBacked) {
      return;
    }
    try {
      const snapshot = await window.piDeck.chat.setThinking({
        runtimeId: selectedSession.id,
        level,
      });
      const updated = sessionFromSnapshot(snapshot);
      setSessions((items) =>
        items.map((item) =>
          item.id === updated.id
            ? mergeSessionUsageFromSnapshot(item, updated)
            : item,
        ),
      );
      rememberPiDefaults(updated);
      setUiMessage(`Switched thinking to ${level}.`);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handlePickAttachments(): Promise<void> {
    const sessionId = selectedSession.id;
    const ownerId = attachmentOwnerForSession(sessionId);
    try {
      const result = await window.piDeck.attachments.pickFiles({
        projectPath: currentProject.canonicalPath,
        ownerId,
        sessionId,
      });
      if (!result.selected) {
        setUiMessage("Attachment picker canceled.");
        return;
      }
      if (acceptImportedAttachments(sessionId, ownerId, result.attachments)) {
        setUiMessage(`Added ${result.attachments.length} attachment(s).`);
      }
    } catch (error) {
      setUiMessage(
        `Attachment picker failed; no files were added (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  async function handleImportDroppedFileAttachments(
    files: File[],
  ): Promise<void> {
    const sessionId = selectedSession.id;
    const ownerId = attachmentOwnerForSession(sessionId);
    try {
      const result = await window.piDeck.attachments.importDroppedFiles(files, {
        projectPath: currentProject.canonicalPath,
        ownerId,
        sessionId,
      });
      if (
        result.selected &&
        acceptImportedAttachments(sessionId, ownerId, result.attachments)
      ) {
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
    const sessionId = selectedSession.id;
    const imageFiles = files.filter((file) => isSupportedDroppedImage(file));
    if (imageFiles.length === 0) {
      setUiMessage("Drop or paste PNG, JPEG, WebP, or GIF images.");
      return;
    }

    const ownerId = attachmentOwnerForSession(sessionId);
    try {
      const images = await Promise.all(imageFiles.map(readDroppedImageFile));
      const result = await window.piDeck.attachments.importImages({
        images,
        ownerId,
        sessionId,
      });
      if (
        result.selected &&
        acceptImportedAttachments(sessionId, ownerId, result.attachments)
      ) {
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

  function handleRemoveAttachment(id: string): void {
    const ownerId = selectedSession.id;
    const attachment = composerDraftForSession(
      composerDraftsRef.current,
      ownerId,
    ).attachments.find((item) => item.id === id);
    if (attachment === undefined) {
      return;
    }
    setComposerDrafts((items) =>
      updateComposerDraft(items, ownerId, (current) => ({
        ...current,
        attachments: current.attachments.filter((item) => item.id !== id),
      })),
    );
    const attachmentOwnerId = attachmentOwnersBySession.current.get(ownerId);
    if (attachmentOwnerId !== undefined) {
      releaseSelectedAttachmentTokens(attachmentOwnerId, [
        attachment.selectedPathToken,
      ]);
    }
  }

  async function handleNewSession(): Promise<void> {
    const next = draftSessionForProject(
      currentProject,
      createId("draft-session"),
      isRealBackendMode ? "real" : "fake",
      isRealBackendMode ? projectModelConfiguration : undefined,
    );
    setComposerError(null);
    setSessions((items) =>
      mergeSessions(
        [next],
        items.filter(
          (item) =>
            item.draftSession !== true ||
            hasComposerDraft(composerDrafts, item.id) ||
            item.projectId !== currentProject.id,
        ),
      ),
    );
    setSelectedSessionId(next.id);
    setUiMessage(
      "Created a new session. Pi will start when you send a prompt.",
    );
  }

  function handleSelectCommand(command: SlashCommand): void {
    const inserted = command.insertText ?? `${command.name} `;
    setComposerDrafts((items) =>
      updateComposerDraft(items, selectedSession.id, (current) => ({
        ...current,
        text: inserted.endsWith(" ") ? inserted : `${inserted} `,
        slashOpen: false,
      })),
    );
    setUiMessage(
      isRealBackendMode
        ? `${command.name} inserted from the active Pi worker command list.`
        : `${command.name} inserted into the normal prompt path; command behavior is not reimplemented in the GUI.`,
    );
  }

  async function handleAppearanceThemeChange(
    nextTheme: AppearanceTheme,
  ): Promise<void> {
    if (appearanceThemePending || nextTheme === appearanceTheme) {
      return;
    }

    const previousTheme = appearanceTheme;
    setAppearanceTheme(nextTheme);
    setAppearanceThemePending(true);
    try {
      // The shared AppSettings theme field is introduced by the persistence
      // workstream. Keep this bridge narrowly scoped so this UI can merge
      // cleanly before that branch lands.
      const patch: Partial<AppSettings> & { theme: AppearanceTheme } = {
        theme: nextTheme,
      };
      const settings = await window.piDeck.settings.update(patch);
      setAppearanceTheme(appearanceThemeFromSettings(settings));
      setLoadState((current) =>
        current.state === "ready" ? { ...current, settings } : current,
      );
      setUiMessage(
        `Appearance set to ${nextTheme === "system" ? "System" : nextTheme === "light" ? "Light" : "Dark"}.`,
      );
    } catch (error) {
      setAppearanceTheme(previousTheme);
      const message = error instanceof Error ? error.message : String(error);
      setUiMessage(`Could not change appearance: ${message}`);
    } finally {
      setAppearanceThemePending(false);
    }
  }

  const composer = (
    <Composer
      value={draft}
      isWorking={isWorking}
      status={selectedSession.status}
      canSend={canSend}
      canIntervene={canIntervene}
      knownExtensionCommand={knownExtensionCommand}
      error={composerError}
      attachments={attachments}
      slashOpen={slashOpen}
      slashCommands={filteredCommands}
      selectedModel={selectedModel}
      backendLabel={backendLabel(selectedSession)}
      realModels={realModels}
      realThinkingLevels={availableRealThinkingLevels}
      selectedSession={selectedSession}
      allowAttachments={true}
      onChange={handleDraftChange}
      onKeyDown={handleComposerKeyDown}
      onSend={handleSend}
      onSteer={handleSteer}
      onFollowUp={handleFollowUp}
      onRunExtensionCommand={handleRunExtensionCommand}
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
      onRemoveAttachment={handleRemoveAttachment}
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
          currentProject={currentProject}
          composerDrafts={composerDrafts}
          onSelect={handleSelectSession}
          onHideSidebar={() => handleSidebarVisibleChange(false)}
          onNewSession={() => void handleNewSession()}
          onCloseRuntime={(sessionId) => void handleCloseRuntime(sessionId)}
          onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
          onDeleteAllSessions={() => void handleDeleteAllSessions()}
          onRefresh={refreshRealSessions}
        />
      ) : null}

      <section
        className="workspace"
        aria-label="Pi Deck chat workspace"
        data-load-state={loadState.state}
      >
        <AppHeader
          loadState={loadState}
          selectedSession={selectedSession}
          currentProject={currentProject}
          recentProjects={recentProjects}
          selectedModelId={selectedModelId}
          selectedThinking={selectedThinking}
          realMode={isRealBackendMode}
          sidebarVisible={sidebarVisible}
          usageStatsVisible={usageStatsVisible}
          appearanceTheme={appearanceTheme}
          appearanceThemePending={appearanceThemePending}
          onToggleSidebar={() => handleSidebarVisibleChange(!sidebarVisible)}
          onToggleUsageStats={() =>
            handleUsageStatsVisibleChange(!usageStatsVisible)
          }
          onAppearanceThemeChange={(theme) =>
            void handleAppearanceThemeChange(theme)
          }
          onPickProject={() => void handlePickProject()}
          onSelectRecent={(project) => void handleSelectProject(project)}
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

        <div
          className="ui-status-message"
          key={uiMessage}
          role="status"
          aria-live="polite"
          title={uiMessage}
        >
          {uiMessage}
        </div>

        {isResuming ? (
          <TranscriptLoading sessionTitle={selectedSession.title} />
        ) : showStarterPage ? (
          <StarterPage composer={composer} />
        ) : (
          <>
            <ChatTimeline
              session={selectedSession}
              uiMessage={uiMessage}
              showAttachmentExamples={!isRealBackendMode}
              nowMs={nowMs}
              onRecoverSession={handleRecoverSelectedSession}
              onRespondToExtensionUi={handleExtensionUiResponse}
              onRetrySession={handleRetrySelectedSession}
              onCloseSession={() => void handleCloseRuntime(selectedSession.id)}
              onCopyDiagnostics={() => void handleCopySelectedDiagnostics()}
            />
            {composer}
          </>
        )}
      </section>
    </main>
  );
}

async function listProjectsIfAvailable(
  api: typeof window.piDeck,
  fallbackProject: ProjectRef,
): Promise<ProjectListResult> {
  const projectsApi = api.projects as Partial<typeof api.projects>;
  if (typeof projectsApi.list === "function") {
    return projectsApi.list();
  }

  return {
    activeProjectId: fallbackProject.id,
    activeProject: fallbackProject,
    projects: [fallbackProject],
  };
}

async function selectProjectIfAvailable(
  api: typeof window.piDeck,
  project: ProjectRef,
): Promise<ProjectListResult> {
  const projectsApi = api.projects as Partial<typeof api.projects>;
  if (typeof projectsApi.select === "function") {
    return projectsApi.select({ projectId: project.id });
  }

  return {
    activeProjectId: project.id,
    activeProject: project,
    projects: [project],
  };
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

function isDetachedRuntimeError(message: string): boolean {
  return /chat runtime is no longer attached|unknown pi runtime/i.test(message);
}

function composerDraftForSession(
  drafts: ComposerDraftsBySession,
  sessionId: string,
): ComposerDraftState {
  return (
    drafts[sessionId] ?? {
      text: "",
      attachments: [],
      slashOpen: false,
    }
  );
}

function updateComposerDraft(
  drafts: ComposerDraftsBySession,
  sessionId: string,
  update: (current: ComposerDraftState) => ComposerDraftState,
): ComposerDraftsBySession {
  return {
    ...drafts,
    [sessionId]: update(composerDraftForSession(drafts, sessionId)),
  };
}

function clearComposerDraft(
  drafts: ComposerDraftsBySession,
  sessionId: string,
): ComposerDraftsBySession {
  return clearComposerDraftsForSessions(drafts, [sessionId]);
}

function clearComposerDraftsForSessions(
  drafts: ComposerDraftsBySession,
  sessionIds: readonly string[],
): ComposerDraftsBySession {
  const uniqueSessionIds = new Set(sessionIds);
  if (uniqueSessionIds.size === 0) {
    return drafts;
  }
  const remaining = { ...drafts };
  let changed = false;
  for (const sessionId of uniqueSessionIds) {
    if (Object.hasOwn(remaining, sessionId)) {
      delete remaining[sessionId];
      changed = true;
    }
  }
  return changed ? remaining : drafts;
}

function moveComposerDraft(
  drafts: ComposerDraftsBySession,
  fromSessionId: string,
  toSessionId: string,
): ComposerDraftsBySession {
  if (fromSessionId === toSessionId || drafts[fromSessionId] === undefined) {
    return drafts;
  }
  const { [fromSessionId]: draft, ...remaining } = drafts;
  return { ...remaining, [toSessionId]: draft };
}

function hasComposerDraft(
  drafts: ComposerDraftsBySession,
  sessionId: string,
): boolean {
  const draft = drafts[sessionId];
  return Boolean(
    draft && (draft.text.trim().length > 0 || draft.attachments.length > 0),
  );
}

function validateComposerInput(input: {
  attachments: AttachmentDraft[];
  supportsImages: boolean;
}): string | undefined {
  if (input.attachments.some((attachment) => attachment.status !== "ready")) {
    return "Remove or reselect deleted/unreadable attachments before sending.";
  }
  if (
    input.attachments.some((attachment) => attachment.kind === "image") &&
    !input.supportsImages
  ) {
    return "Selected model does not support image input.";
  }
  return undefined;
}

function replaceResumedSession(
  sessions: SessionViewModel[],
  previousSessionId: string,
  resumed: SessionViewModel,
): SessionViewModel[] {
  return mergeSessions(
    [resumed],
    sessions.filter((session) => session.id !== previousSessionId),
  );
}

function removeSessionById(
  sessions: SessionViewModel[],
  sessionId: string,
): SessionViewModel[] {
  return removeSessionsByIds(sessions, new Set([sessionId]));
}

function removeSessionsByIds(
  sessions: SessionViewModel[],
  sessionIds: ReadonlySet<string>,
): SessionViewModel[] {
  return sessionIds.size === 0
    ? sessions
    : sessions.filter((session) => !sessionIds.has(session.id));
}

function closeRuntimeInSessionState(
  sessions: SessionViewModel[],
  sessionId: string,
): SessionViewModel[] {
  return sessions.flatMap((session) => {
    if (session.id !== sessionId) {
      return [session];
    }
    if (session.sessionFile === undefined) {
      return [];
    }
    return [
      {
        ...session,
        runtimeBacked: false,
        resumeBacked: true,
        status: "idle" as const,
        baseState: "idle" as const,
        subtitle: "Saved · click to resume",
      },
    ];
  });
}

function savedSessionsForProject(
  sessions: SessionViewModel[],
  projectId: string,
): SessionViewModel[] {
  return sessions.filter(
    (session) =>
      session.resumeBacked === true &&
      sessionBelongsToProject(session, projectId),
  );
}

function savedSessionsForDeletedFiles(
  savedSessions: readonly SessionViewModel[],
  deletedSessionFiles: readonly string[],
): SessionViewModel[] {
  const deletedFiles = new Set(deletedSessionFiles);
  return savedSessions.filter(
    (session) =>
      session.sessionFile !== undefined &&
      deletedFiles.has(session.sessionFile),
  );
}

function removeSavedSessionsForProject(
  sessions: SessionViewModel[],
  projectId: string,
): SessionViewModel[] {
  return sessions.filter(
    (session) =>
      session.resumeBacked !== true ||
      !sessionBelongsToProject(session, projectId),
  );
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

function slashCommandFromWorkerCommand(
  command: ChatCommandSummary,
): SlashCommand {
  return {
    name: command.name,
    description:
      command.description ?? "Command returned by the active Pi worker.",
    source: command.source ?? "extension",
    ...(command.insertText !== undefined
      ? { insertText: command.insertText }
      : {}),
  };
}

function applyPiDefaultsToDraftSessions(
  sessions: SessionViewModel[],
  projectId: string,
  configuration: ChatListModelsResult,
): SessionViewModel[] {
  const modelLabel = configuration.activeModel
    ? modelLabelForChatModel(configuration.activeModel)
    : undefined;
  return sessions.map((session) =>
    session.projectId === projectId && session.draftSession === true
      ? {
          ...session,
          ...(session.modelLabel === undefined && modelLabel !== undefined
            ? { modelLabel }
            : {}),
          ...(session.thinkingLevel === undefined &&
          configuration.thinkingLevel !== undefined
            ? { thinkingLevel: configuration.thinkingLevel }
            : {}),
        }
      : session,
  );
}

function modelLabelForChatModel(model: ChatModelSummary): string {
  return model.provider ? `${model.provider} / ${model.id}` : model.id;
}

function draftSessionForProject(
  project: ProjectRef,
  id: string,
  backendMode: "fake" | "real" = "real",
  configuration?: ChatListModelsResult,
): SessionViewModel {
  return {
    ...(configuration?.activeModel
      ? { modelLabel: modelLabelForChatModel(configuration.activeModel) }
      : {}),
    ...(configuration?.thinkingLevel !== undefined
      ? { thinkingLevel: configuration.thinkingLevel }
      : {}),
    id,
    title: "Untitled new session",
    project: project.displayName,
    projectPath: project.path,
    projectId: project.id,
    subtitle: "Idle · Pi starts when you send the first prompt",
    status: "idle",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    baseState: "idle",
    overlays: { ...emptyOverlays },
    runtimeBacked: false,
    resumeBacked: false,
    draftSession: true,
    backendMode,
    timeline: [],
  };
}

function sessionFromSummary(
  summary: ChatSessionSummary,
  projectId?: string,
): SessionViewModel {
  return {
    id: summary.attachedRuntimeId ?? summary.id,
    title: summary.title,
    project: summary.cwd?.split(/[\\/]/).pop() ?? "Pi project",
    projectPath: summary.cwd ?? "Unknown project",
    ...(projectId !== undefined
      ? { projectId }
      : summary.cwd !== undefined
        ? { projectId: summary.cwd }
        : {}),
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
  const isAgentActive = isSnapshotAgentActive(snapshot);

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
    ...(isAgentActive
      ? {
          workingStartedAtMs: Date.now(),
          lastRuntimeEventLabel: "Pi reports active work",
        }
      : {}),
    runtimeBacked: true,
    resumeBacked: false,
    backendMode: snapshot.backendMode,
    ...(snapshot.projectId !== undefined
      ? { projectId: snapshot.projectId }
      : snapshot.state.cwd
        ? { projectId: snapshot.state.cwd }
        : {}),
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

function isSnapshotAgentActive(snapshot: ChatSnapshot): boolean {
  const stateRecord = snapshot.state as Record<string, unknown>;
  return Boolean(
    snapshot.state.isAgentActive ??
    (typeof stateRecord.isStreaming === "boolean"
      ? stateRecord.isStreaming
      : undefined),
  );
}

function titleFromSnapshot(snapshot: ChatSnapshot): string {
  const stateRecord = snapshot.state as Record<string, unknown>;
  // Pi RPC exposes a user-assigned display name as sessionName, rather than
  // the older title/name aliases used by some fixtures.
  const stateTitle = [
    stateRecord.sessionName,
    stateRecord.title,
    stateRecord.name,
  ].find(
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

function mergeSessionUsageFromRuntimeStatus(
  session: SessionViewModel,
  status: ChatRuntimeStatus,
): SessionViewModel {
  if (status.runtimeId !== session.id || status.usage === undefined) {
    return session;
  }
  return {
    ...session,
    usageStats: {
      inputTokens: status.usage.inputTokens,
      outputTokens: status.usage.outputTokens,
      cacheReadTokens: status.usage.cacheReadTokens,
      cacheWriteTokens: status.usage.cacheWriteTokens,
      totalTokens: status.usage.totalTokens,
      ...(status.usage.contextUsedTokens !== undefined
        ? { contextUsedTokens: status.usage.contextUsedTokens }
        : {}),
      ...(status.usage.contextWindowTokens !== undefined
        ? { contextWindowTokens: status.usage.contextWindowTokens }
        : {}),
      ...(status.usage.totalCostUsd !== undefined
        ? { totalCostUsd: status.usage.totalCostUsd }
        : {}),
    },
    ...(modelLabelFromState(status.state).length > 0
      ? { modelLabel: modelLabelFromState(status.state) }
      : {}),
    ...(status.state.thinkingLevel !== undefined
      ? { thinkingLevel: status.state.thinkingLevel }
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

function parseModelLabel(
  label: string | undefined,
): { provider: string; modelId: string } | undefined {
  if (!label) {
    return undefined;
  }
  const separator = label.indexOf("/");
  if (separator === -1) {
    return undefined;
  }
  const provider = label.slice(0, separator).trim();
  const modelId = label.slice(separator + 1).trim();
  return provider && modelId ? { provider, modelId } : undefined;
}

function timelineToolStatus(streaming: boolean): "running" | "success" {
  return streaming ? "running" : "success";
}

function toolTimelineItemFromContent(options: {
  id: string;
  content: string;
  createdAt: string;
  status: "running" | "success" | "error" | "collapsed";
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

function safeToolDetails(content: string): string {
  const maxLength = 20_000;
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n\n… Tool output truncated in Pi Deck after ${formatInteger(maxLength)} characters.`;
}

function formatToolStatus(
  status: Extract<TimelineItem, { kind: "tool" }>["status"],
): string {
  switch (status) {
    case "running":
      return "running";
    case "success":
      return "success";
    case "error":
      return "error";
    default:
      return "collapsed";
  }
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
        awaitingAgentEnd: false,
        status: "working",
        baseState: "working",
        overlays: { ...session.overlays, streaming: true },
        subtitle: `Working · ${backendLabel(session)} stream`,
        workingStartedAtMs: session.workingStartedAtMs ?? Date.now(),
        lastRuntimeEventLabel: "Pi agent started",
        retryPrompt: undefined,
        providerErrorObserved: false,
        lastError: undefined,
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    case "message_update":
      return reduceMessageUpdate(session, event);
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return reduceToolExecutionEvent(session, event);
    case "queue_update": {
      const steeringCount =
        getArray(event, "steering")?.length ??
        getNumber(event, "steeringCount") ??
        0;
      const followUpCount =
        getArray(event, "followUp")?.length ??
        getNumber(event, "followUpCount") ??
        0;
      return {
        ...session,
        overlays: {
          ...session.overlays,
          piQueuedSteeringCount: steeringCount,
          piQueuedFollowUpCount: followUpCount,
        },
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    }
    case "compaction_start":
      return {
        ...session,
        overlays: { ...session.overlays, compacting: true },
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    case "compaction_end":
      return {
        ...session,
        overlays: { ...session.overlays, compacting: false },
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    case "auto_retry_start":
      // Pi 0.81 emits this after agent_end({ willRetry: true }). Keep the
      // runtime busy through backoff rather than exposing idle/send controls.
      return {
        ...session,
        awaitingAgentEnd: false,
        status: session.status === "aborting" ? "aborting" : "working",
        baseState: "working",
        overlays: {
          ...session.overlays,
          streaming: false,
          retrying: true,
        },
        subtitle: `Retrying · ${backendLabel(session)} will retry this turn`,
        workingStartedAtMs: session.workingStartedAtMs ?? Date.now(),
        lastRuntimeEventLabel: "Pi scheduled an automatic retry",
        providerErrorObserved: false,
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
    case "auto_retry_end": {
      const retryStatus = getString(event, "status");
      // Real Pi reports success/finalError. Keep the status fallback solely
      // for older fake fixtures and manually recorded event logs.
      const retryFailed =
        getBoolean(event, "success") === false ||
        retryStatus === "failed" ||
        retryStatus === "error";

      // Pi 0.81 AgentSession.abort() cancels retry backoff and emits
      // auto_retry_end({ success: false, finalError: "Retry cancelled" }).
      // The renderer has already recorded the user's abort intent, and Pi
      // does not emit another successful agent_end to repair this state.
      // Handle that terminal cancellation before generic retry failures.
      if (session.status === "aborting" && retryFailed) {
        return {
          ...session,
          awaitingAgentEnd: false,
          providerErrorObserved: false,
          status: "idle",
          baseState: "idle",
          overlays: {
            ...session.overlays,
            streaming: false,
            toolRunning: false,
            retrying: false,
            needsUserInput: false,
          },
          subtitle: "Idle · backend stream aborted",
          workingStartedAtMs: undefined,
          retryPrompt: undefined,
          lastError: undefined,
          lastRuntimeEventLabel: "Pi cancelled the automatic retry after abort",
          updatedAt: "Now",
          updatedAtMs: Date.now(),
        };
      }

      const retryError = getRuntimeEventErrorMessage(event);
      const nextSession: SessionViewModel = {
        ...session,
        awaitingAgentEnd: retryFailed
          ? false
          : (session.awaitingAgentEnd ?? false),
        // A successful retry_end is emitted before the authoritative final
        // agent_end, so it must not expose an idle session in that gap.
        status: retryFailed ? "error" : "working",
        baseState: retryFailed ? "error" : "working",
        overlays: {
          ...session.overlays,
          streaming: false,
          retrying: false,
        },
        subtitle: retryFailed
          ? "Error · automatic retry failed"
          : `Working · ${backendLabel(session)} retry complete`,
        workingStartedAtMs: retryFailed
          ? undefined
          : (session.workingStartedAtMs ?? Date.now()),
        lastRuntimeEventLabel: retryFailed
          ? "Pi reported a final retry error"
          : "Pi finished an automatic retry",
        providerErrorObserved: retryFailed,
        ...(retryFailed ? {} : { lastError: undefined }),
        updatedAt: "Now",
        updatedAtMs: Date.now(),
      };
      return retryFailed
        ? appendRuntimeErrorDiagnostic(
            nextSession,
            retryError ?? "Pi automatic retry failed.",
          )
        : nextSession;
    }
    case "extension_ui_request":
      return reduceExtensionUiRequestEvent(session, event);
    case "extension_ui_response_sent":
    case "extension_ui_request_timeout":
      return clearExtensionUiRequest(session, getString(event, "requestId"));
    case "extension_ui_response_failed":
      return appendDiagnostic(
        {
          ...session,
          status: "error",
          baseState: "error",
          subtitle: "Error · extension UI response was not delivered",
        },
        {
          tone: "error",
          content:
            getString(event, "message") ??
            "Pi Deck could not write the extension UI response to Pi.",
        },
      );
    case "agent_end": {
      const status = getString(event, "status");
      const willRetry = getBoolean(event, "willRetry") === true;
      const errorMessage = getRuntimeEventErrorMessage(event);
      // Production Pi sends agent_end({ messages, willRetry }) without the
      // fixture-only status/error fields. Carry only an error observed in a
      // Pi runtime event, never a previous UI/local error state, into this
      // terminal classification.
      const endedWithError =
        !willRetry &&
        (hasRuntimeEventError(event) || session.providerErrorObserved === true);
      const stillWaitingForInput = session.overlays.needsUserInput;
      const finalEventUsage = getMessageUsageFromEvent(event);
      const finalUsageMessageId =
        getMessageUpdateId(event) ??
        getMostRecentAssistantMessageId(session) ??
        getString(event, "runId") ??
        "agent-end";
      const usageByMessageId =
        finalEventUsage !== undefined
          ? {
              ...(session.usageByMessageId ?? {}),
              [finalUsageMessageId]: finalEventUsage,
            }
          : session.usageByMessageId;
      const completedTimeline = removeEmptyAssistantMessages(
        session.timeline.map((item) =>
          item.kind === "assistant" && item.streaming === true
            ? { ...item, streaming: false }
            : item,
        ),
      );

      if (willRetry) {
        return {
          ...session,
          awaitingAgentEnd: false,
          ...(usageByMessageId !== undefined ? { usageByMessageId } : {}),
          ...(usageByMessageId !== undefined
            ? {
                usageStats: summarizeUsageByMessage(
                  usageByMessageId,
                  session.usageStats?.contextWindowTokens,
                ),
              }
            : {}),
          status: "working",
          baseState: "working",
          providerErrorObserved: false,
          lastError: undefined,
          overlays: {
            ...session.overlays,
            streaming: false,
            toolRunning: false,
            retrying: true,
            needsUserInput: false,
          },
          subtitle: `Retrying · ${backendLabel(session)} will retry this turn`,
          workingStartedAtMs: session.workingStartedAtMs ?? Date.now(),
          lastRuntimeEventLabel: "Pi ended an attempt and scheduled a retry",
          updatedAt: "Now",
          updatedAtMs: Date.now(),
          timeline: completedTimeline,
        };
      }

      const nextSession: SessionViewModel = {
        ...session,
        awaitingAgentEnd: false,
        ...(usageByMessageId !== undefined ? { usageByMessageId } : {}),
        ...(usageByMessageId !== undefined
          ? {
              usageStats: summarizeUsageByMessage(
                usageByMessageId,
                session.usageStats?.contextWindowTokens,
              ),
            }
          : {}),
        status: endedWithError
          ? "error"
          : stillWaitingForInput
            ? "waiting"
            : "idle",
        baseState: endedWithError
          ? "error"
          : stillWaitingForInput
            ? "waitingForInput"
            : "idle",
        providerErrorObserved: false,
        ...(endedWithError ? {} : { lastError: undefined }),
        overlays: {
          ...session.overlays,
          streaming: false,
          toolRunning: false,
          retrying: false,
          needsUserInput: stillWaitingForInput && !endedWithError,
        },
        subtitle: endedWithError
          ? "Error · backend stream failed"
          : stillWaitingForInput
            ? "Waiting · extension input required"
            : status === "aborted"
              ? "Idle · backend stream aborted"
              : "Idle · backend stream complete",
        workingStartedAtMs: undefined,
        retryPrompt: endedWithError ? session.retryPrompt : undefined,
        lastRuntimeEventLabel: endedWithError
          ? "Pi reported an error"
          : status === "aborted"
            ? "Pi aborted the turn"
            : "Pi completed the turn",
        updatedAt: "Now",
        updatedAtMs: Date.now(),
        timeline: completedTimeline,
      };
      return endedWithError
        ? appendRuntimeErrorDiagnostic(
            nextSession,
            errorMessage ?? session.lastError ?? "Pi agent failed.",
          )
        : nextSession;
    }
    case "diagnostic":
      return appendDiagnostic(session, {
        tone: getString(event, "level") === "error" ? "error" : "info",
        content: getString(event, "message") ?? "Backend diagnostic event",
      });
    case "worker_exit":
      // An intentional close already detached this runtime and preserved the
      // saved-session row. Its late process-exit event must not turn that row
      // into an error.
      if (!session.runtimeBacked && session.resumeBacked === true) {
        return session;
      }
      return appendDiagnostic(
        {
          ...session,
          status: "error",
          baseState: "error",
          awaitingAgentEnd: false,
          runtimeBacked: false,
          resumeBacked: session.sessionFile !== undefined,
          subtitle: session.sessionFile
            ? "Error · worker exited; click to resume saved session"
            : "Error · backend worker exited",
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

function reduceExtensionUiRequestEvent(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  const method = getString(event, "method");
  if (!isExtensionUiDialogMethod(method)) {
    return appendDiagnostic(session, {
      tone: "info",
      content: `Extension UI method “${method ?? "unknown"}” is not supported by Pi Deck. Only select, confirm, input, and editor requests can be answered.`,
    });
  }

  // Pi puts dialog fields at the top level. params supports old fixture events.
  const params = getRecord(event, "params");
  const requestId = getString(event, "id") ?? getString(event, "requestId");
  if (requestId === undefined) {
    return appendDiagnostic(session, {
      tone: "error",
      content:
        "Pi sent an extension UI dialog without an id, so Pi Deck cannot safely answer it.",
    });
  }
  const options = getStringArray(event, "options");
  const request: PendingExtensionUiRequest = {
    id: requestId,
    method,
    title:
      getString(event, "title") ??
      getStringFromRecord(params, "title") ??
      method,
    ...((getString(event, "message") ?? getStringFromRecord(params, "message"))
      ? {
          message:
            getString(event, "message") ??
            getStringFromRecord(params, "message"),
        }
      : {}),
    ...(options !== undefined ? { options } : {}),
    ...(getString(event, "placeholder") !== undefined
      ? { placeholder: getString(event, "placeholder") }
      : {}),
    ...(getString(event, "prefill") !== undefined
      ? { prefill: getString(event, "prefill") }
      : {}),
    ...(getNumber(event, "timeout") !== undefined
      ? { timeout: getNumber(event, "timeout") }
      : {}),
  };
  const pending = session.pendingExtensionUiRequests ?? [];
  const pendingExtensionUiRequests = pending.some(
    (item) => item.id === request.id,
  )
    ? pending.map((item) => (item.id === request.id ? request : item))
    : [...pending, request];

  return {
    ...session,
    status: "waiting",
    baseState: "waitingForInput",
    overlays: { ...session.overlays, needsUserInput: true },
    pendingExtensionUiRequests,
    subtitle: "Waiting · extension input required",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
  };
}

function clearExtensionUiRequest(
  session: SessionViewModel,
  requestId: string | undefined,
): SessionViewModel {
  const pending = session.pendingExtensionUiRequests ?? [];
  const pendingExtensionUiRequests =
    requestId === undefined
      ? pending.slice(1)
      : pending.filter((request) => request.id !== requestId);
  const stillWaiting = pendingExtensionUiRequests.length > 0;
  return {
    ...session,
    status: stillWaiting ? "waiting" : "working",
    baseState: stillWaiting ? "waitingForInput" : "working",
    pendingExtensionUiRequests,
    overlays: { ...session.overlays, needsUserInput: stillWaiting },
    subtitle: stillWaiting
      ? "Waiting · extension input required"
      : `Working · ${backendLabel(session)} stream`,
    updatedAt: "Now",
    updatedAtMs: Date.now(),
  };
}

function isExtensionUiDialogMethod(
  method: string | undefined,
): method is ExtensionUiDialogMethod {
  return (
    method === "select" ||
    method === "confirm" ||
    method === "input" ||
    method === "editor"
  );
}

function getStringArray(
  event: ChatRuntimeEvent,
  key: string,
): string[] | undefined {
  const value = getArray(event, key);
  return value?.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

function reduceToolExecutionEvent(
  session: SessionViewModel,
  event: ChatRuntimeEvent,
): SessionViewModel {
  const status =
    event.type === "tool_execution_end"
      ? getBoolean(event, "isError") || getString(event, "status") === "error"
        ? "error"
        : "success"
      : "running";
  const toolItem = toolTimelineItemFromRuntimeEvent(event, status);
  const timeline = toolItem
    ? upsertToolMessage(session.timeline, toolItem)
    : session.timeline;
  const toolRunning = timeline.some(
    (item) => item.kind === "tool" && item.status === "running",
  );

  const isAborting = session.status === "aborting";
  return {
    ...session,
    status: isAborting ? "aborting" : "working",
    baseState: "working",
    overlays: { ...session.overlays, toolRunning },
    subtitle: isAborting
      ? "Aborting · waiting for Pi confirmation"
      : `Working · ${backendLabel(session)} stream`,
    workingStartedAtMs: session.workingStartedAtMs ?? Date.now(),
    lastRuntimeEventLabel:
      event.type === "tool_execution_end"
        ? "Tool finished"
        : event.type === "tool_execution_update"
          ? "Tool output updated"
          : "Tool started",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline,
  };
}

function toolTimelineItemFromRuntimeEvent(
  event: ChatRuntimeEvent,
  status: "running" | "success" | "error" | "collapsed",
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
  const details = safeToolDetails(
    JSON.stringify(
      {
        type: event.type,
        toolName: title,
        ...(args !== undefined ? { args } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(result !== undefined ? { result } : {}),
        status: getString(event, "status"),
        isError: getBoolean(event, "isError"),
      },
      null,
      2,
    ),
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

  const errorMessage = getRuntimeEventErrorMessage(event);
  const isErrorUpdate = hasRuntimeEventError(event);
  const nextSession: SessionViewModel = {
    ...session,
    ...(usageByMessageId !== undefined ? { usageByMessageId } : {}),
    ...(usageStats !== undefined ? { usageStats } : {}),
    providerErrorObserved:
      isErrorUpdate || session.providerErrorObserved === true,
    // An assistant message's `done` only completes that message. The agent
    // may still be running tools or emit an authoritative agent_end next.
    status: isErrorUpdate
      ? "error"
      : session.status === "aborting"
        ? "aborting"
        : "working",
    baseState: isErrorUpdate ? "error" : "working",
    overlays: { ...session.overlays, streaming: !done && !isErrorUpdate },
    subtitle: isErrorUpdate
      ? "Error · backend stream failed"
      : session.status === "aborting"
        ? "Aborting · waiting for Pi confirmation"
        : done
          ? "Working · waiting for Pi completion"
          : `Working · ${backendLabel(session)} stream`,
    ...(isErrorUpdate ? { workingStartedAtMs: undefined } : {}),
    awaitingAgentEnd: done && !isErrorUpdate,
    lastRuntimeEventLabel: isErrorUpdate
      ? "Pi reported an error"
      : done
        ? "Assistant message complete; awaiting Pi turn completion"
        : hasReplyContent
          ? "Receiving assistant text"
          : hasThinkingContent
            ? "Receiving thinking update"
            : "Pi sent a runtime update",
    updatedAt: "Now",
    updatedAtMs: Date.now(),
    timeline,
  };

  return isErrorUpdate
    ? appendRuntimeErrorDiagnostic(
        nextSession,
        errorMessage ?? "Pi message update failed.",
      )
    : nextSession;
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

function getMostRecentAssistantMessageId(
  session: SessionViewModel,
): string | undefined {
  return [...session.timeline]
    .reverse()
    .find((item) => item.kind === "assistant")?.id;
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

function eventHasUsageMetadata(event: ChatRuntimeEvent): boolean {
  return getMessageUsageFromEvent(event) !== undefined;
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

function selectedSessionSupportsImages(
  session: SessionViewModel,
  realModels: ChatModelSummary[],
  selectedModel: ModelOption | undefined,
): boolean {
  if (session.backendMode !== "real") {
    return Boolean(selectedModel?.supportsImages);
  }
  return realModelSupportsImages(findActiveRealModel(session, realModels));
}

function findActiveRealModel(
  session: SessionViewModel,
  realModels: ChatModelSummary[],
): ChatModelSummary | undefined {
  const normalizedLabel = session.modelLabel?.replace(/\s+\/\s+/, "/");
  if (!normalizedLabel) {
    return undefined;
  }
  return realModels.find((model) => {
    const providerModel = `${model.provider ?? ""}/${model.id}`;
    return providerModel === normalizedLabel || model.id === normalizedLabel;
  });
}

function realModelSupportsImages(model: ChatModelSummary | undefined): boolean {
  if (model === undefined) {
    return true;
  }
  return model.input?.some((value) => /image/i.test(value)) ?? false;
}

function thinkingLevelsForModel(
  model: ChatModelSummary | undefined,
  fallback: string[],
): string[] {
  if (model === undefined || model.reasoning === undefined) {
    return fallback.length > 0 ? fallback : ["off"];
  }
  if (!model.reasoning) {
    return ["off"];
  }
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    return level !== "xhigh" && level !== "max" ? true : mapped !== undefined;
  });
}

function clampThinkingLevel(level: string, availableLevels: string[]): string {
  if (availableLevels.includes(level)) {
    return level;
  }
  const requestedIndex = PI_THINKING_LEVELS.indexOf(
    level as (typeof PI_THINKING_LEVELS)[number],
  );
  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }
  for (
    let index = requestedIndex;
    index < PI_THINKING_LEVELS.length;
    index += 1
  ) {
    const candidate = PI_THINKING_LEVELS[index];
    if (candidate !== undefined && availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = PI_THINKING_LEVELS[index];
    if (candidate !== undefined && availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  return availableLevels[0] ?? "off";
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

function appendRuntimeErrorDiagnostic(
  session: SessionViewModel,
  content: string,
): SessionViewModel {
  const mostRecentTimelineItem = session.timeline[session.timeline.length - 1];
  if (
    mostRecentTimelineItem?.kind === "diagnostic" &&
    mostRecentTimelineItem.tone === "error" &&
    mostRecentTimelineItem.content === content
  ) {
    return {
      ...session,
      status: "error",
      baseState: "error",
      lastError: content,
    };
  }
  return appendDiagnostic(session, { tone: "error", content });
}

function SessionSidebar(props: {
  sessions: SessionViewModel[];
  selectedSessionId: string;
  realMode: boolean;
  currentProject: ProjectRef;
  composerDrafts: ComposerDraftsBySession;
  onSelect(sessionId: string): void;
  onHideSidebar(): void;
  onNewSession(): void;
  onCloseRuntime(sessionId: string): void;
  onDeleteSession(sessionId: string): void;
  onDeleteAllSessions(): void;
  onRefresh(): Promise<void>;
}): ReactElement {
  const [sessionFilter, setSessionFilter] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const sidebarSessions = props.realMode
    ? props.sessions.filter(
        (session) =>
          sessionBelongsToProject(session, props.currentProject.id) &&
          shouldShowSessionInSidebar(
            session,
            hasComposerDraft(props.composerDrafts, session.id),
          ),
      )
    : props.sessions;
  const activeWork = props.realMode
    ? props.sessions.filter(
        (session) =>
          !sessionBelongsToProject(session, props.currentProject.id) &&
          isBackgroundActiveWork(session),
      )
    : [];
  const allRealInbox = props.realMode
    ? buildRealSessionInbox(sidebarSessions, "")
    : undefined;
  const inbox = props.realMode
    ? sessionFilter.trim().length === 0
      ? allRealInbox
      : buildRealSessionInbox(sidebarSessions, sessionFilter)
    : undefined;
  const visibleIdleSavedSessions = inbox?.idleSaved ?? [];
  const visibleSessions = props.realMode
    ? [
        ...(inbox?.needsInput ?? []),
        ...(inbox?.errors ?? []),
        ...(inbox?.working ?? []),
        ...(inbox?.queued ?? []),
        ...(inbox?.attached ?? []),
        ...visibleIdleSavedSessions,
      ]
    : sidebarSessions;

  async function handleRefresh(): Promise<void> {
    setIsRefreshing(true);
    try {
      await props.onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-header">
        <div className="sidebar-brand-row">
          <span className="brand-mark" aria-hidden="true">
            π
          </span>
          <span className="brand">Pi Deck</span>
        </div>
        <div className="sidebar-header-actions">
          <IconButton
            className="sidebar-dismiss"
            icon={X}
            label="Hide sessions"
            size="sm"
            onClick={props.onHideSidebar}
          />
          {props.realMode ? (
            <IconButton
              icon={RotateCcw}
              label="Refresh sessions"
              loading={isRefreshing}
              size="sm"
              onClick={() => void handleRefresh()}
            />
          ) : null}
          {props.realMode ? (
            <IconButton
              icon={Trash2}
              label="Delete saved sessions"
              size="sm"
              variant="danger"
              onClick={props.onDeleteAllSessions}
            />
          ) : null}
        </div>
      </div>

      <Button className="sidebar-new-chat" onClick={props.onNewSession}>
        <SquarePen aria-hidden="true" size={16} strokeWidth={1.75} />
        New session
      </Button>

      {activeWork.length > 0 ? (
        <section
          className="active-work-list"
          aria-label="Active work across projects"
        >
          <p className="active-work-heading">Active work · other projects</p>
          {activeWork.map((session) => (
            <Button
              className={`session-item active-work-item ${session.id === props.selectedSessionId ? "active" : ""}`}
              key={session.id}
              aria-label={`Active work in ${session.project}: ${session.title}`}
              title={`Open background work from ${session.project}`}
              onClick={() => props.onSelect(session.id)}
            >
              <StateIndicator session={session} />
              <span className="session-copy">
                <span className="session-title">{session.title}</span>
                <span className="session-meta">
                  {session.project} · {session.subtitle}
                </span>
              </span>
              <span className="session-time">{session.updatedAt}</span>
            </Button>
          ))}
        </section>
      ) : null}

      {props.realMode ? (
        <>
          <label className="sr-only" htmlFor="session-search">
            Search sessions
          </label>
          <div className="session-search-wrap">
            <Search aria-hidden="true" size={16} strokeWidth={1.75} />
            <input
              id="session-search"
              className="session-search"
              type="search"
              value={sessionFilter}
              placeholder="Search saved sessions"
              onChange={(event) => setSessionFilter(event.target.value)}
            />
          </div>
          {(allRealInbox?.needsInput.length ?? 0) +
            (allRealInbox?.errors.length ?? 0) +
            (allRealInbox?.working.length ?? 0) >
          0 ? (
            <p className="attention-summary" aria-live="polite">
              {allRealInbox?.needsInput.length
                ? `${allRealInbox.needsInput.length} needs input`
                : null}
              {allRealInbox?.errors.length
                ? `${allRealInbox.needsInput.length ? " · " : ""}${allRealInbox.errors.length} error${allRealInbox.errors.length === 1 ? "" : "s"}`
                : null}
              {allRealInbox?.working.length
                ? `${(allRealInbox.needsInput.length ?? 0) + (allRealInbox.errors.length ?? 0) > 0 ? " · " : ""}${allRealInbox.working.length} working`
                : null}
            </p>
          ) : null}
        </>
      ) : null}

      <section
        className="session-list"
        aria-label="Session list with priority states"
      >
        {visibleSessions.length === 0 ? (
          <p className="empty-session-list">
            {props.realMode
              ? sessionFilter.trim().length > 0
                ? "No sessions match this search."
                : "No sessions in this project yet."
              : "No local demo sessions."}
          </p>
        ) : null}
        {visibleSessions.map((session) => {
          const canDelete = isSessionDeletable(session, props.realMode);
          const canCloseRuntime =
            props.realMode && session.runtimeBacked && !isSessionBusy(session);
          return (
            <div className="session-item-wrap" key={session.id}>
              <Button
                className={`session-item ${session.id === props.selectedSessionId ? "active" : ""}`}
                aria-label={`Session: ${session.title}`}
                onClick={() => {
                  props.onSelect(session.id);
                }}
              >
                <StateIndicator session={session} />
                <span className="session-copy">
                  <span className="session-title">
                    <span className="session-title-copy">{session.title}</span>
                    {hasComposerDraft(props.composerDrafts, session.id) ? (
                      <span className="session-draft-marker">Draft</span>
                    ) : null}
                  </span>
                  {session.status !== "idle" ? (
                    <span className="session-meta">{session.subtitle}</span>
                  ) : null}
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
              </Button>
              {canCloseRuntime ? (
                <IconButton
                  className="session-delete-button session-close-button"
                  icon={Unplug}
                  label={`Close runtime for ${session.title}`}
                  size="sm"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onCloseRuntime(session.id);
                  }}
                />
              ) : canDelete ? (
                <IconButton
                  className="session-delete-button"
                  icon={Trash2}
                  label={`Delete ${session.title}`}
                  size="sm"
                  variant="danger"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDeleteSession(session.id);
                  }}
                />
              ) : null}
            </div>
          );
        })}
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

function sessionBelongsToProject(
  session: SessionViewModel,
  projectId: string,
): boolean {
  return session.projectId === projectId || session.projectPath === projectId;
}

function isBackgroundActiveWork(session: SessionViewModel): boolean {
  return (
    session.status === "working" ||
    session.status === "waiting" ||
    session.overlays.localQueuedStartCount > 0 ||
    session.overlays.piQueuedSteeringCount > 0 ||
    session.overlays.piQueuedFollowUpCount > 0
  );
}

function shouldShowSessionInSidebar(
  session: SessionViewModel,
  hasDraft: boolean,
): boolean {
  if (session.draftSession === true) {
    return hasDraft;
  }
  return !(
    session.backendMode === "real" &&
    session.runtimeBacked &&
    session.resumeBacked !== true &&
    session.status === "idle" &&
    session.timeline.length === 0 &&
    isPlaceholderSessionTitle(session.title) &&
    !hasDraft
  );
}

interface RealSessionInbox {
  needsInput: SessionViewModel[];
  errors: SessionViewModel[];
  working: SessionViewModel[];
  queued: SessionViewModel[];
  attached: SessionViewModel[];
  idleSaved: SessionViewModel[];
}

/**
 * Attention rows are deliberately outside the five-row saved-session limit.
 * The remaining persisted, idle sessions retain their familiar recency order.
 */
function buildRealSessionInbox(
  sessions: SessionViewModel[],
  filter: string,
): RealSessionInbox {
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const matches = sessions.filter((session) => {
    if (normalizedFilter.length === 0) {
      return true;
    }
    const indicator = selectSidebarIndicator(session);
    return [
      session.title,
      session.subtitle,
      session.project,
      session.projectPath,
      indicator.label,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedFilter));
  });
  const newestFirst = (items: SessionViewModel[]): SessionViewModel[] =>
    [...items].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  const inbox: RealSessionInbox = {
    needsInput: [],
    errors: [],
    working: [],
    queued: [],
    attached: [],
    idleSaved: [],
  };

  for (const session of matches) {
    const indicator = selectSidebarIndicator(session);
    if (indicator.kind === "needsInput") {
      inbox.needsInput.push(session);
    } else if (indicator.kind === "error") {
      inbox.errors.push(session);
    } else if (
      session.status === "working" ||
      session.baseState === "attaching" ||
      [
        "attaching",
        "compacting",
        "retrying",
        "toolRunning",
        "working",
      ].includes(indicator.kind)
    ) {
      inbox.working.push(session);
    } else if (
      session.overlays.localQueuedStartCount > 0 ||
      session.overlays.piQueuedSteeringCount > 0 ||
      session.overlays.piQueuedFollowUpCount > 0
    ) {
      // Queued work is also always visible: it has user-visible work pending.
      inbox.queued.push(session);
    } else if (session.runtimeBacked) {
      inbox.attached.push(session);
    } else {
      inbox.idleSaved.push(session);
    }
  }

  return {
    needsInput: newestFirst(inbox.needsInput),
    errors: newestFirst(inbox.errors),
    working: newestFirst(inbox.working),
    queued: newestFirst(inbox.queued),
    attached: newestFirst(inbox.attached),
    idleSaved: newestFirst(inbox.idleSaved),
  };
}

function queueBadgeLabels(overlays: SessionOverlays): string[] {
  const labels: string[] = [];
  if (overlays.piQueuedSteeringCount > 0) {
    labels.push(`Steer ${overlays.piQueuedSteeringCount}`);
  }
  if (overlays.piQueuedFollowUpCount > 0) {
    labels.push(`Follow-up ${overlays.piQueuedFollowUpCount}`);
  }
  if (overlays.localQueuedStartCount > 0) {
    labels.push(`Start ${overlays.localQueuedStartCount}`);
  }
  return labels;
}

function StateIndicator(props: {
  session: Pick<SessionViewModel, "baseState" | "overlays">;
  verbose?: boolean;
}): ReactElement {
  const indicator = selectSidebarIndicator(props.session);
  const queueLabels = queueBadgeLabels(props.session.overlays);
  const badge = indicator.kind === "queued" ? indicator.queuedCount : undefined;
  const accessibleLabel = [indicator.label, ...queueLabels].join("; ");
  return (
    <span
      className={`state-indicator ${indicator.kind}`}
      title={accessibleLabel}
      role="img"
      aria-label={accessibleLabel}
    >
      <span className="state-dot" />
      {badge ? <span className="queue-badge">{badge}</span> : null}
      {queueLabels.length > 0 ? (
        <span className="queue-badges" aria-hidden="true">
          {queueLabels.map((label) => (
            <span className="queue-badge" key={label}>
              {label}
            </span>
          ))}
        </span>
      ) : null}
      {props.verbose ? <span>{indicator.label}</span> : null}
    </span>
  );
}

function StatusMark(props: { status: SessionStatus }): ReactElement {
  const icon =
    props.status === "working" ||
    props.status === "starting" ||
    props.status === "sending" ||
    props.status === "reconnecting"
      ? LoaderCircle
      : props.status === "waiting"
        ? CircleDot
        : props.status === "error"
          ? CircleAlert
          : Check;
  const Icon = icon;
  return (
    <span className={`status-mark ${props.status}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={1.75} />
      {statusLabel(props.status)}
    </span>
  );
}

function AppHeader(props: {
  loadState: LoadState;
  selectedSession: SessionViewModel;
  currentProject: ProjectRef;
  recentProjects: ProjectRef[];
  selectedModelId: string;
  selectedThinking: string;
  realMode: boolean;
  sidebarVisible: boolean;
  usageStatsVisible: boolean;
  appearanceTheme: AppearanceTheme;
  appearanceThemePending: boolean;
  onToggleSidebar(): void;
  onToggleUsageStats(): void;
  onAppearanceThemeChange(theme: AppearanceTheme): void;
  onPickProject(): void;
  onSelectRecent(project: ProjectRef): void;
  onModelChange(id: string): void;
  onThinkingChange(id: string): void;
}): ReactElement {
  return (
    <header className="topbar">
      <div className="header-left">
        <IconButton
          className="sidebar-toggle"
          icon={PanelLeft}
          label={props.sidebarVisible ? "Hide sessions" : "Show sessions"}
          pressed={props.sidebarVisible}
          onClick={props.onToggleSidebar}
        />
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
        <AppearanceMenu
          theme={props.appearanceTheme}
          pending={props.appearanceThemePending}
          onChange={props.onAppearanceThemeChange}
        />
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
        <LoadStateBadge loadState={props.loadState} />
      </div>
    </header>
  );
}

function AppearanceMenu(props: {
  theme: AppearanceTheme;
  pending: boolean;
  onChange(theme: AppearanceTheme): void;
}): ReactElement {
  const options: Array<{
    theme: AppearanceTheme;
    label: string;
    icon: LucideIcon;
  }> = [
    { theme: "system", label: "System", icon: Monitor },
    { theme: "light", label: "Light", icon: Sun },
    { theme: "dark", label: "Dark", icon: Moon },
  ];
  const current = options.find((option) => option.theme === props.theme)!;

  return (
    <Menu
      disabled={props.pending}
      icon={current.icon}
      label={`Appearance: ${current.label}${props.pending ? ", saving" : ""}`}
      loading={props.pending}
      menuLabel="Appearance options"
    >
      {options.map((option) => {
        const selected = option.theme === props.theme;
        const Icon = option.icon;
        return (
          <Button
            aria-checked={selected}
            disabled={props.pending}
            key={option.theme}
            role="menuitemradio"
            size="sm"
            variant="menuItem"
            onClick={() => props.onChange(option.theme)}
          >
            <Icon aria-hidden="true" size={14} strokeWidth={1.75} />
            <span>{option.label}</span>
            <Check
              aria-hidden="true"
              size={14}
              strokeWidth={1.75}
              visibility={selected ? "visible" : "hidden"}
            />
          </Button>
        );
      })}
    </Menu>
  );
}

function UsageStatsToggle(props: {
  session: SessionViewModel;
  visible: boolean;
  onToggle(): void;
}): ReactElement {
  const hasStats = props.session.usageStats !== undefined;
  return (
    <IconButton
      className={`usage-toggle ${props.visible ? "active" : ""}`}
      icon={Gauge}
      label={
        hasStats
          ? props.visible
            ? "Hide session usage stats"
            : "Show session usage stats"
          : "Usage stats unavailable"
      }
      pressed={props.visible}
      onClick={props.onToggle}
    />
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
  const switcherProjects = projectsForSwitcher(
    props.project,
    props.realMode
      ? props.recentProjects.filter(
          (project) => project.invalidReason === undefined,
        )
      : [...props.recentProjects, invalidRecentProject],
  );

  return (
    <div className="title-block project-header">
      <div className="session-heading-line">
        <h1>{props.selectedSession.title}</h1>
        <StatusMark status={props.selectedSession.status} />
      </div>
      <div
        className="project-context"
        aria-label={props.realMode ? "Current project" : "Recent projects"}
      >
        <ProjectSwitcher
          activeProject={props.project}
          projects={switcherProjects}
          onSelect={props.onSelectRecent}
        />
        <IconButton
          icon={FolderOpen}
          label="Open project"
          size="sm"
          onClick={props.onPickProject}
        />
      </div>
    </div>
  );
}

function ProjectSwitcher(props: {
  activeProject: ProjectRef;
  projects: ProjectRef[];
  onSelect(project: ProjectRef): void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  return (
    <div
      className="project-switcher-menu"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
        }
      }}
    >
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Switch project. Current: ${props.activeProject.displayName}`}
        className="project-switcher-trigger"
        data-project-id={props.activeProject.id}
        size="sm"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{props.activeProject.displayName}</span>
        <ChevronDown aria-hidden="true" size={13} strokeWidth={1.75} />
      </Button>
      {open ? (
        <div className="project-switcher-popover" role="menu">
          {props.projects.map((project) => {
            const active = project.id === props.activeProject.id;
            return (
              <Button
                aria-current={active ? "true" : undefined}
                className="project-switcher-option"
                data-project-id={project.id}
                disabled={project.invalidReason !== undefined}
                key={project.id}
                role="menuitem"
                variant="menuItem"
                onClick={() => {
                  setOpen(false);
                  if (!active) {
                    props.onSelect(project);
                  }
                }}
              >
                <Check
                  aria-hidden="true"
                  className="project-switcher-check"
                  size={14}
                  strokeWidth={1.75}
                  visibility={active ? "visible" : "hidden"}
                />
                <span className="project-switcher-copy">
                  <strong>{project.displayName}</strong>
                  <small>{project.invalidReason ?? project.path}</small>
                </span>
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function projectsForSwitcher(
  activeProject: ProjectRef,
  recentProjects: ProjectRef[],
): ProjectRef[] {
  const unique = new Map<string, ProjectRef>();
  for (const project of [activeProject, ...recentProjects]) {
    const identity = project.canonicalPath || project.id;
    if (!unique.has(identity)) {
      unique.set(identity, project);
    }
  }
  return [...unique.values()].slice(0, 10);
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

function LoadStateBadge(props: { loadState: LoadState }): ReactElement | null {
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

  return null;
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
        <h2>What can I help with?</h2>
        {props.composer}
      </div>
    </section>
  );
}

function TranscriptLoading(props: { sessionTitle: string }): ReactElement {
  return (
    <section
      className="transcript-loading"
      aria-label="Loading previous context"
      aria-live="polite"
    >
      <span className="transcript-loading-spinner" aria-hidden="true" />
      <h2>Loading previous context…</h2>
      <p>Restoring the conversation for “{props.sessionTitle}”.</p>
    </section>
  );
}

function ChatTimeline(props: {
  session: SessionViewModel;
  uiMessage: string;
  showAttachmentExamples: boolean;
  nowMs: number;
  onRecoverSession(): void;
  onRespondToExtensionUi(
    requestId: string,
    response: { confirmed: boolean } | { value: string } | { cancelled: true },
  ): Promise<void>;
  onRetrySession(): void;
  onCloseSession(): void;
  onCopyDiagnostics(): void;
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
            <span>This session is in an error state.</span>
            <div className="recovery-actions">
              {props.session.retryPrompt !== undefined &&
              props.session.runtimeBacked ? (
                <IconButton
                  icon={RotateCcw}
                  label="Retry prompt"
                  onClick={props.onRetrySession}
                />
              ) : null}
              {props.session.sessionFile !== undefined ? (
                <IconButton
                  icon={History}
                  label="Reopen saved session"
                  onClick={props.onRecoverSession}
                />
              ) : null}
              {props.session.runtimeBacked ? (
                <IconButton
                  icon={Unplug}
                  label="Close runtime"
                  onClick={props.onCloseSession}
                />
              ) : null}
              <IconButton
                icon={Copy}
                label="Copy diagnostics"
                onClick={props.onCopyDiagnostics}
              />
            </div>
          </div>
        ) : null}
        {props.session.status === "waiting" ? (
          <div className="state-banner waiting">
            This session is waiting for user input.
          </div>
        ) : null}

        {props.showAttachmentExamples ? <AttachmentExampleStrip /> : null}

        {(props.session.pendingExtensionUiRequests ?? []).map((request) => (
          <ExtensionUiCard
            key={request.id}
            request={request}
            onRespond={props.onRespondToExtensionUi}
          />
        ))}

        {props.session.timeline.map((item) => (
          <TimelineRow key={item.id} item={item} />
        ))}
        {showPendingAgent ? (
          <PendingAgentRow session={props.session} nowMs={props.nowMs} />
        ) : null}
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

function PendingAgentRow(props: {
  session: SessionViewModel;
  nowMs: number;
}): ReactElement {
  const startedAt =
    props.session.workingStartedAtMs ?? props.session.updatedAtMs;
  const elapsedMs = Math.max(0, props.nowMs - startedAt);
  const showNoOutputNotice = elapsedMs >= NO_VISIBLE_OUTPUT_NOTICE_MS;
  const lastEvent = props.session.lastRuntimeEventLabel ?? "Prompt sent to Pi";

  return (
    <article className="timeline-row assistant-row pending-agent-row">
      <div className="assistant-avatar">π</div>
      <div className="assistant-message pending-agent-message">
        <span className="pending-agent-primary">
          <span className="spinner" aria-hidden="true" />
          <span>
            Agent is working… {formatElapsedSeconds(elapsedMs)} elapsed.
          </span>
        </span>
        <small>{lastEvent}</small>
        {showNoOutputNotice ? (
          <small>
            No visible output yet. Pi may still be thinking, waiting on the
            model, or running tools.
          </small>
        ) : null}
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
      <div className="empty-icon">
        <SquarePen aria-hidden="true" size={28} strokeWidth={1.75} />
      </div>
      <h2>No messages yet</h2>
      <p>{copy}</p>
    </div>
  );
}

function ExtensionUiCard(props: {
  request: PendingExtensionUiRequest;
  onRespond(
    requestId: string,
    response: { confirmed: boolean } | { value: string } | { cancelled: true },
  ): Promise<void>;
}): ReactElement {
  const [value, setValue] = useState(props.request.prefill ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function respond(
    response: { confirmed: boolean } | { value: string } | { cancelled: true },
  ): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    try {
      await props.onRespond(props.request.id, response);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  }

  return (
    <article
      className="extension-ui-card"
      aria-label={`Extension request: ${props.request.title}`}
    >
      <p className="eyebrow">Pi extension request</p>
      <h3>{props.request.title}</h3>
      {props.request.message ? <p>{props.request.message}</p> : null}
      {props.request.timeout !== undefined ? (
        <small>Pi owns this request timeout; answer before it expires.</small>
      ) : null}
      {props.request.method === "confirm" ? (
        <div className="extension-ui-actions">
          <IconButton
            icon={X}
            label="Decline"
            disabled={submitting}
            variant="outline"
            onClick={() => void respond({ confirmed: false })}
          />
          <IconButton
            icon={Check}
            label="Confirm"
            disabled={submitting}
            variant="solid"
            onClick={() => void respond({ confirmed: true })}
          />
        </div>
      ) : null}
      {props.request.method === "select" ? (
        <div className="extension-ui-actions">
          {(props.request.options ?? []).map((option) => (
            <Button
              key={option}
              disabled={submitting}
              onClick={() => void respond({ value: option })}
            >
              {option}
            </Button>
          ))}
          <IconButton
            icon={X}
            label="Cancel"
            disabled={submitting}
            onClick={() => void respond({ cancelled: true })}
          />
        </div>
      ) : null}
      {props.request.method === "input" || props.request.method === "editor" ? (
        <form
          className="extension-ui-form"
          onSubmit={(event) => {
            event.preventDefault();
            void respond({ value });
          }}
        >
          {props.request.method === "editor" ? (
            <textarea
              aria-label={`${props.request.title} value`}
              value={value}
              placeholder={props.request.placeholder}
              disabled={submitting}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <input
              aria-label={`${props.request.title} value`}
              value={value}
              placeholder={props.request.placeholder}
              disabled={submitting}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          <div className="extension-ui-actions">
            <IconButton
              icon={X}
              label="Cancel"
              disabled={submitting}
              onClick={() => void respond({ cancelled: true })}
            />
            <IconButton
              icon={ArrowUp}
              label="Submit"
              loading={submitting}
              type="submit"
              variant="solid"
            />
          </div>
        </form>
      ) : null}
      {error ? <p className="inline-error">{error}</p> : null}
    </article>
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
            <ChevronRight
              aria-hidden="true"
              className="disclosure-chevron"
              size={16}
              strokeWidth={1.75}
            />
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
            <ToolStatus status={props.item.status} />
            <ChevronRight
              aria-hidden="true"
              className="disclosure-chevron"
              size={16}
              strokeWidth={1.75}
            />
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

function ToolStatus(props: {
  status: Extract<TimelineItem, { kind: "tool" }>["status"];
}): ReactElement {
  const icon =
    props.status === "running"
      ? LoaderCircle
      : props.status === "error"
        ? CircleAlert
        : props.status === "success"
          ? Check
          : Wrench;
  const Icon = icon;
  return (
    <span className={`tool-status ${props.status}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={1.75} />
      {formatToolStatus(props.status)}
    </span>
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

function PiModelThinkingMenu(props: {
  models: ChatModelSummary[];
  selectedModel: ChatModelSummary | undefined;
  thinkingLevels: string[];
  selectedThinking: string | undefined;
  disabled: boolean;
  onSelectModel(provider: string, modelId: string): void;
  onSelectThinking(level: string): void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  function close(restoreFocus = false): void {
    setOpen(false);
    setModelMenuOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }

  const modelName =
    props.selectedModel?.name ?? props.selectedModel?.id ?? "Model";
  const thinkingName = props.selectedThinking ?? "Thinking";

  return (
    <div
      className="pi-configuration-menu"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (modelMenuOpen) {
            setModelMenuOpen(false);
            modelTriggerRef.current?.focus();
          } else {
            close(true);
          }
        }
        if (
          event.key === "ArrowRight" &&
          event.target === modelTriggerRef.current
        ) {
          event.preventDefault();
          setModelMenuOpen(true);
        }
        if (
          event.key === "ArrowLeft" &&
          (event.target as HTMLElement).closest(".pi-model-submenu")
        ) {
          event.preventDefault();
          setModelMenuOpen(false);
          modelTriggerRef.current?.focus();
        }
      }}
    >
      <Button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Model and thinking. Current model: ${modelName}. Current thinking: ${thinkingName}.`}
        className="pi-configuration-trigger"
        data-model-id={props.selectedModel?.id}
        data-model-provider={props.selectedModel?.provider}
        data-thinking-level={props.selectedThinking}
        disabled={props.disabled}
        size="sm"
        onClick={() => {
          setOpen((value) => !value);
          setModelMenuOpen(false);
        }}
      >
        <span>{thinkingName}</span>
        <ChevronDown aria-hidden="true" size={13} strokeWidth={1.75} />
      </Button>
      {open ? (
        <div
          aria-label="Model and thinking options"
          className="pi-configuration-popover"
          role="menu"
        >
          <span className="pi-configuration-heading">Thinking</span>
          {props.thinkingLevels.map((level) => {
            const selected = level === props.selectedThinking;
            return (
              <Button
                aria-checked={selected}
                className="pi-configuration-option"
                data-thinking-level={level}
                key={level}
                role="menuitemradio"
                size="sm"
                variant="menuItem"
                onClick={() => {
                  close();
                  if (!selected) {
                    props.onSelectThinking(level);
                  }
                }}
              >
                <span>{level}</span>
                <Check
                  aria-hidden="true"
                  size={14}
                  strokeWidth={1.75}
                  visibility={selected ? "visible" : "hidden"}
                />
              </Button>
            );
          })}
          {props.models.length > 0 ? (
            <>
              <div className="pi-configuration-divider" />
              <Button
                ref={modelTriggerRef}
                aria-expanded={modelMenuOpen}
                aria-haspopup="menu"
                className="pi-configuration-option model"
                role="menuitem"
                size="sm"
                variant="menuItem"
                onClick={() => setModelMenuOpen(true)}
                onMouseEnter={() => setModelMenuOpen(true)}
              >
                <span title={modelName}>{modelName}</span>
                <ChevronRight aria-hidden="true" size={14} strokeWidth={1.75} />
              </Button>
              {modelMenuOpen ? (
                <div
                  aria-label="Available Pi models"
                  className="pi-model-submenu"
                  role="menu"
                >
                  {props.models.map((model) => {
                    const selected =
                      model.id === props.selectedModel?.id &&
                      model.provider === props.selectedModel?.provider;
                    const name = model.name ?? model.id;
                    return (
                      <Button
                        aria-checked={selected}
                        className="pi-configuration-option model-choice"
                        data-model-id={model.id}
                        data-model-provider={model.provider}
                        key={`${model.provider ?? ""}/${model.id}`}
                        role="menuitemradio"
                        size="sm"
                        variant="menuItem"
                        onClick={() => {
                          close();
                          if (!selected && model.provider) {
                            props.onSelectModel(model.provider, model.id);
                          }
                        }}
                      >
                        <span title={name}>{name}</span>
                        <Check
                          aria-hidden="true"
                          size={14}
                          strokeWidth={1.75}
                          visibility={selected ? "visible" : "hidden"}
                        />
                      </Button>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Composer(props: {
  value: string;
  isWorking: boolean;
  status: SessionStatus;
  canSend: boolean;
  canIntervene: boolean;
  knownExtensionCommand: string | undefined;
  error: string | null;
  attachments: AttachmentDraft[];
  slashOpen: boolean;
  slashCommands: SlashCommand[];
  selectedModel: ModelOption | undefined;
  backendLabel: string;
  realModels: ChatModelSummary[];
  realThinkingLevels: string[];
  selectedSession: SessionViewModel;
  allowAttachments: boolean;
  onChange(value: string): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onSend(): void;
  onSteer(): void;
  onFollowUp(): void;
  onRunExtensionCommand(): void;
  onAbort(): void;
  onPickAttachments(): void;
  onImportDroppedFileAttachments(files: File[]): void;
  onImportImageAttachments(files: File[]): void;
  onSetModel(provider: string, modelId: string): void;
  onSetThinking(level: string): void;
  onRemoveAttachment(id: string): void;
  onSelectCommand(command: SlashCommand): void;
}): ReactElement {
  const activeRealModel = findActiveRealModel(
    props.selectedSession,
    props.realModels,
  );
  const selectedModelSupportsImages =
    props.selectedSession.backendMode === "real"
      ? realModelSupportsImages(activeRealModel)
      : Boolean(props.selectedModel?.supportsImages);
  const hasImageWarning =
    props.attachments.some((attachment) => attachment.kind === "image") &&
    !selectedModelSupportsImages;
  const selectedRealModel =
    activeRealModel ??
    (props.realModels.length === 1 ? props.realModels[0] : undefined);
  const [dragActive, setDragActive] = useState(false);
  const isActionPending = isLifecycleTransition(props.status);

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
          disabled={isActionPending}
          placeholder="Ask Pi…"
          rows={2}
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
            <IconButton
              className="attachment-button"
              icon={Paperclip}
              label="Add attachments"
              disabled={isActionPending}
              onClick={props.onPickAttachments}
            />
          ) : null}
          {props.selectedSession.backendMode === "real" ? (
            <PiModelThinkingMenu
              disabled={isActionPending}
              models={props.realModels}
              selectedModel={selectedRealModel}
              selectedThinking={props.selectedSession.thinkingLevel}
              thinkingLevels={props.realThinkingLevels}
              onSelectModel={props.onSetModel}
              onSelectThinking={props.onSetThinking}
            />
          ) : null}
          {props.error !== null ? (
            <span className="composer-error">{props.error}</span>
          ) : isActionPending ? (
            <span>
              {statusLabel(props.status)} · waiting for Pi confirmation…
            </span>
          ) : props.knownExtensionCommand !== undefined ? (
            <span className="composer-error">
              {props.knownExtensionCommand} is an extension command. It runs
              immediately and cannot be queued.
            </span>
          ) : props.isWorking ? (
            <span>Working in {props.backendLabel}…</span>
          ) : hasImageWarning ? (
            <span className="composer-error">
              Selected model does not support image input.
            </span>
          ) : null}
          <span className="composer-spacer" />
          {props.isWorking ? (
            <>
              <IconButton
                icon={CornerUpLeft}
                label="Steer"
                size="lg"
                variant="solid"
                disabled={
                  !props.canIntervene ||
                  props.knownExtensionCommand !== undefined
                }
                onClick={props.onSteer}
              />
              <IconButton
                icon={ListPlus}
                label="Follow-up"
                variant="outline"
                disabled={
                  !props.canIntervene ||
                  props.knownExtensionCommand !== undefined
                }
                onClick={props.onFollowUp}
              />
              {props.knownExtensionCommand !== undefined ? (
                <IconButton
                  icon={Play}
                  label="Run command now"
                  variant="outline"
                  disabled={!props.canIntervene}
                  onClick={props.onRunExtensionCommand}
                />
              ) : null}
              <IconButton
                icon={Square}
                label="Abort"
                variant="danger"
                onClick={props.onAbort}
              />
            </>
          ) : (
            <IconButton
              className="send-button"
              icon={ArrowUp}
              label="Send"
              aria-keyshortcuts="Enter"
              shortcut="Enter"
              size="lg"
              variant="solid"
              disabled={!props.canSend}
              onClick={props.onSend}
            />
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
          <IconButton
            icon={X}
            label={`Remove ${attachment.fileName}`}
            size="sm"
            onClick={() => props.onRemove(attachment.id)}
          />
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
          <Button
            key={command.name}
            role="option"
            onClick={() => props.onSelect(command)}
          >
            <strong>{command.name}</strong>
            <span>{command.description}</span>
            <small>{command.source}</small>
          </Button>
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
  if (baseState === "attaching") {
    return "starting";
  }
  if (baseState === "working") {
    return "working";
  }
  return "idle";
}

function isLifecycleTransition(status: SessionStatus): boolean {
  return (
    status === "starting" ||
    status === "sending" ||
    status === "aborting" ||
    status === "reconnecting"
  );
}

function isSessionBusy(
  session: Pick<SessionViewModel, "status" | "overlays">,
): boolean {
  return (
    isLifecycleTransition(session.status) ||
    session.status === "working" ||
    session.overlays.retrying
  );
}

function shouldReconcileSession(session: SessionViewModel): boolean {
  // Runtime events remain authoritative, but a bounded status fallback must
  // include working turns so dropping both terminal events cannot leave the UI
  // permanently busy.
  return session.runtimeBacked && isSessionBusy(session);
}

function reconcileSessionWithRuntimeStatus(
  session: SessionViewModel,
  status: ChatRuntimeStatus,
): SessionViewModel {
  // A response for another runtime must never mutate the selected/session row.
  if (status.runtimeId !== session.id) {
    return session;
  }
  if (status.state.isAgentActive) {
    // Abort remains pending until Pi reports a terminal completion event or an
    // authoritative inactive status; a still-active status is not success.
    if (session.status === "aborting" || session.status === "working") {
      return session;
    }
    return {
      ...session,
      status: "working",
      baseState: "working",
      overlays: { ...session.overlays, streaming: true },
      subtitle: `Working · ${backendLabel(session)} confirmed by Pi`,
      lastRuntimeEventLabel: "Pi reconciliation confirmed active work",
    };
  }

  return appendDiagnostic(
    {
      ...session,
      status: "idle",
      baseState: "idle",
      awaitingAgentEnd: false,
      providerErrorObserved: false,
      lastError: undefined,
      overlays: {
        ...session.overlays,
        streaming: false,
        toolRunning: false,
        retrying: false,
      },
      workingStartedAtMs: undefined,
      subtitle: `Idle · ${backendLabel(session)} reconciled`,
      lastRuntimeEventLabel: "Pi reconciliation confirmed completion",
      updatedAt: "Now",
      updatedAtMs: Date.now(),
    },
    {
      tone: "info",
      content:
        "Reconciled from Pi runtime status because the live completion event was not observed.",
    },
  );
}

function updateSessionByRuntimeId(
  sessions: SessionViewModel[],
  runtimeId: string,
  update: (session: SessionViewModel) => SessionViewModel,
): SessionViewModel[] {
  const index = sessions.findIndex((session) => session.id === runtimeId);
  if (index < 0) {
    return sessions;
  }
  const current = sessions[index];
  if (current === undefined) {
    return sessions;
  }
  const updated = update(current);
  if (updated === current) {
    return sessions;
  }
  const next = sessions.slice();
  next[index] = updated;
  return next;
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

function getRuntimeEventErrorMessage(
  event: ChatRuntimeEvent,
): string | undefined {
  const directError =
    getString(event, "error") ??
    getString(event, "errorMessage") ??
    getString(event, "finalError") ??
    getString(event, "message");
  if (directError !== undefined) {
    return directError;
  }

  const assistantEvent = getRecord(event, "assistantMessageEvent");
  return (
    getErrorMessageFromRecord(getRecord(event, "error")) ??
    getAssistantMessageEventErrorMessage(assistantEvent) ??
    getAssistantMessageErrorMessage(getRecord(event, "message")) ??
    getAssistantMessageErrorMessage(getFinalAssistantMessage(event))
  );
}

function hasRuntimeEventError(event: ChatRuntimeEvent): boolean {
  const status = getString(event, "status");
  const assistantEvent = getRecord(event, "assistantMessageEvent");
  return (
    status === "error" ||
    status === "failed" ||
    hasDirectRuntimeEventError(event) ||
    isAssistantMessageEventFailure(assistantEvent) ||
    isErrorAssistantMessage(getRecord(event, "message")) ||
    isErrorAssistantMessage(getRecordFromRecord(assistantEvent, "error")) ||
    isErrorAssistantMessage(getFinalAssistantMessage(event))
  );
}

function hasDirectRuntimeEventError(event: ChatRuntimeEvent): boolean {
  return (
    getString(event, "error") !== undefined ||
    getString(event, "errorMessage") !== undefined ||
    getString(event, "finalError") !== undefined ||
    getString(event, "message") !== undefined ||
    getErrorMessageFromRecord(getRecord(event, "error")) !== undefined
  );
}

function isAssistantMessageEventFailure(
  assistantEvent: Record<string, unknown> | undefined,
): boolean {
  if (getStringFromRecord(assistantEvent, "type") !== "error") {
    return false;
  }
  return (
    getStringFromRecord(assistantEvent, "reason") !== "aborted" &&
    getStringFromRecord(
      getRecordFromRecord(assistantEvent, "error"),
      "stopReason",
    ) !== "aborted"
  );
}

function isErrorAssistantMessage(
  message: Record<string, unknown> | undefined,
): boolean {
  const stopReason = getStringFromRecord(message, "stopReason");
  return (
    stopReason !== "aborted" &&
    (stopReason === "error" ||
      getAssistantMessageErrorMessage(message) !== undefined)
  );
}

function getAssistantMessageEventErrorMessage(
  assistantEvent: Record<string, unknown> | undefined,
): string | undefined {
  return (
    getErrorMessageFromRecord(getRecordFromRecord(assistantEvent, "error")) ??
    getAssistantMessageErrorMessage(
      getRecordFromRecord(assistantEvent, "message"),
    ) ??
    getAssistantMessageErrorMessage(
      getRecordFromRecord(assistantEvent, "partial"),
    ) ??
    getStringFromRecord(assistantEvent, "errorMessage")
  );
}

function getAssistantMessageErrorMessage(
  message: Record<string, unknown> | undefined,
): string | undefined {
  return (
    getStringFromRecord(message, "errorMessage") ??
    getStringFromRecord(message, "error") ??
    getErrorMessageFromRecord(getRecordFromRecord(message, "error"))
  );
}

function getErrorMessageFromRecord(
  error: Record<string, unknown> | undefined,
): string | undefined {
  return (
    getStringFromRecord(error, "errorMessage") ??
    getStringFromRecord(error, "message") ??
    getStringFromRecord(error, "error")
  );
}

function getFinalAssistantMessage(
  event: ChatRuntimeEvent,
): Record<string, unknown> | undefined {
  const messages = getArray(event, "messages");
  if (messages === undefined) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (getStringFromRecord(record, "role") === "assistant") {
      return record;
    }
  }

  return undefined;
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

function getArray(event: ChatRuntimeEvent, key: string): unknown[] | undefined {
  const value = getUnknown(event, key);
  return Array.isArray(value) ? value : undefined;
}

function getNumber(event: ChatRuntimeEvent, key: string): number | undefined {
  const value = getUnknown(event, key);
  return typeof value === "number" && Number.isFinite(value)
    ? value
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
    case "starting":
      return "Starting";
    case "sending":
      return "Sending";
    case "working":
      return "Working";
    case "aborting":
      return "Aborting";
    case "reconnecting":
      return "Reconnecting";
    case "waiting":
      return "Needs input";
    case "error":
      return "Error";
    case "idle":
      return "Idle";
  }
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

function formatElapsedSeconds(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
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

function runtimeCapabilitiesFor(
  capabilitiesByRuntime: RuntimeCapabilitiesById,
  runtimeId: string,
): RuntimeCapabilities {
  return capabilitiesByRuntime[runtimeId] ?? {};
}

function updateRuntimeCapabilities(
  capabilitiesByRuntime: RuntimeCapabilitiesById,
  runtimeId: string,
  update: RuntimeCapabilities,
): RuntimeCapabilitiesById {
  return {
    ...capabilitiesByRuntime,
    [runtimeId]: {
      ...runtimeCapabilitiesFor(capabilitiesByRuntime, runtimeId),
      ...update,
    },
  };
}

export function findKnownExtensionCommand(
  text: string,
  commands: SlashCommand[],
): string | undefined {
  const command = text.trimStart().split(/\s+/, 1)[0];
  if (!command?.startsWith("/")) {
    return undefined;
  }
  const normalized = command.slice(1);
  return commands.find(
    (item) =>
      item.source === "extension" &&
      item.name.replace(/^\//, "") === normalized,
  )?.name;
}

export const __rendererTestHooks = {
  reduceRuntimeEvent,
  sessionFromSnapshot,
  mergeSessionUsageFromSnapshot,
  composerDraftForSession,
  updateComposerDraft,
  clearComposerDraft,
  clearComposerDraftsForSessions,
  moveComposerDraft,
  hasComposerDraft,
  validateComposerInput,
  mergeAttachmentDrafts: (
    existing: AttachmentDraft[],
    incoming: AttachmentDraft[],
  ) => mergeAttachmentDrafts(existing, incoming).attachments,
  isMissingSessionFileError,
  isDetachedRuntimeError,
  isSessionDeletable,
  listProjectsIfAvailable,
  selectProjectIfAvailable,
  projectsForSwitcher,
  findKnownExtensionCommand,
  buildRealSessionInbox,
  queueBadgeLabels,
  isSessionBusy,
  shouldReconcileSession,
  reconcileSessionWithRuntimeStatus,
  mergeSessionUsageFromRuntimeStatus,
  updateSessionByRuntimeId,
  eventHasUsageMetadata,
  replaceResumedSession,
  removeSessionById,
  removeSessionsByIds,
  closeRuntimeInSessionState,
  savedSessionsForProject,
  savedSessionsForDeletedFiles,
  removeSavedSessionsForProject,
  runtimeCapabilitiesFor,
  updateRuntimeCapabilities,
  thinkingLevelsForModel,
  clampThinkingLevel,
  applyPiDefaultsToDraftSessions,
  draftSessionForProject,
};
