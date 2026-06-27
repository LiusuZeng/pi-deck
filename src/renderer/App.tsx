import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { AppSettings, DiagnosticsSummary } from "../shared/types.js";

type LoadState =
  | { state: "loading" }
  | {
      state: "ready";
      version: string;
      settings: AppSettings;
      diagnostics: DiagnosticsSummary;
    }
  | { state: "error"; message: string };

export function App(): ReactElement {
  const [loadState, setLoadState] = useState<LoadState>({ state: "loading" });

  useEffect(() => {
    let disposed = false;

    async function load(): Promise<void> {
      try {
        const [version, settings, diagnostics] = await Promise.all([
          window.piDeck.app.getVersion(),
          window.piDeck.settings.get(),
          window.piDeck.app.getDiagnosticsSummary(),
        ]);
        if (!disposed) {
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
    };
  }, []);

  const nodeAccessSummary = useMemo(() => getRendererNodeAccessSummary(), []);

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Session sidebar placeholder">
        <div className="brand">Pi Deck</div>
        <button className="new-session" type="button" disabled>
          + New session
        </button>
        <section className="session-list" aria-label="Mock sessions">
          <div className="session-item active">
            <span className="dot idle" /> Foundation setup
          </div>
          <div className="session-item muted">
            <span className="dot" /> Session list arrives in M3
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local GUI control plane</p>
            <h1>Pi Deck</h1>
          </div>
          <div className="model-controls" aria-label="Model placeholders">
            <span>Model: placeholder</span>
            <span>Thinking: placeholder</span>
          </div>
        </header>

        <section className="content-grid">
          <article className="card intro-card">
            <h2>Secure Electron foundation</h2>
            <p>
              Renderer is sandboxed and communicates through{" "}
              <code>window.piDeck</code>, a narrow typed preload API. Pi RPC
              worker spawning is intentionally left for later milestones.
            </p>
            <ul>
              <li>No generic IPC send/invoke is exposed to renderer code.</li>
              <li>
                Settings and diagnostics are persisted under Electron userData.
              </li>
              <li>IPC payloads are validated in the main process with zod.</li>
            </ul>
          </article>

          <StatusPanel
            loadState={loadState}
            nodeAccessSummary={nodeAccessSummary}
          />
        </section>

        <footer
          className="composer-placeholder"
          aria-label="Composer placeholder"
        >
          <button type="button" disabled aria-label="Attachment placeholder">
            +
          </button>
          <textarea
            disabled
            placeholder="Prompt composer arrives after Pi RPC integration"
          />
          <button type="button" disabled>
            Send
          </button>
        </footer>
      </section>
    </main>
  );
}

function StatusPanel(props: {
  loadState: LoadState;
  nodeAccessSummary: string;
}): ReactElement {
  if (props.loadState.state === "loading") {
    return <article className="card">Loading app-local diagnostics…</article>;
  }

  if (props.loadState.state === "error") {
    return (
      <article className="card error">
        Failed to load diagnostics: {props.loadState.message}
      </article>
    );
  }

  const { settings, diagnostics, version } = props.loadState;

  return (
    <article className="card diagnostics-card">
      <h2>Diagnostics summary</h2>
      <dl>
        <dt>App version</dt>
        <dd>{version}</dd>
        <dt>User data</dt>
        <dd>{diagnostics.userDataPath}</dd>
        <dt>Logs</dt>
        <dd>{diagnostics.logPath}</dd>
        <dt>Renderer Node access</dt>
        <dd>{props.nodeAccessSummary}</dd>
      </dl>

      <h3>Settings</h3>
      <pre>{JSON.stringify(settings, null, 2)}</pre>

      {diagnostics.recentErrors.length > 0 ? (
        <>
          <h3>Recent diagnostics</h3>
          <ul>
            {diagnostics.recentErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </>
      ) : null}
    </article>
  );
}

function getRendererNodeAccessSummary(): string {
  const hasProcess = Reflect.get(globalThis, "process") !== undefined;
  const hasRequire = Reflect.get(globalThis, "require") !== undefined;
  return hasProcess || hasRequire
    ? "unexpected Node globals visible"
    : "no process/require globals visible";
}
