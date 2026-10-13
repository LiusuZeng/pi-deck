import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import type {
  SavedAnswerDetail,
  SavedAnswerSummary,
  WorkspaceRef,
} from "../../shared/types.js";
import { Button } from "./ui/Button.js";

export function SavedAnswers(props: {
  workspaceId: string;
  workspaceName: string;
  workspaces: readonly WorkspaceRef[];
  selectedOutputId?: string;
  onSelect(outputId: string | undefined, workspaceId?: string): void;
  onRevise(detail: SavedAnswerDetail): void;
  onBack(): void;
}): ReactElement {
  const [items, setItems] = useState<SavedAnswerSummary[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [detail, setDetail] = useState<SavedAnswerDetail | undefined>();
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [listError, setListError] = useState<string | undefined>();
  const [detailError, setDetailError] = useState<string | undefined>();
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const loading = listLoading || detailLoading || mutationPending;
  const error = detailError ?? listError;

  async function loadList(): Promise<void> {
    const generation = ++listGeneration.current;
    const workspaceId = props.workspaceId;
    setListLoading(true);
    setListError(undefined);
    try {
      const result = await window.piDeck.savedAnswers.list({
        ...(scope === "workspace" ? { workspaceId } : {}),
        ...(query ? { query } : {}),
      });
      if (generation !== listGeneration.current) return;
      setItems(result.items);
      setWarnings(result.warnings);
    } catch (reason) {
      if (generation !== listGeneration.current) return;
      setListError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === listGeneration.current) setListLoading(false);
    }
  }

  async function loadDetail(revisionId?: string): Promise<void> {
    const outputId = props.selectedOutputId;
    if (outputId === undefined) return;
    const generation = ++detailGeneration.current;
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const result = await window.piDeck.savedAnswers.read({
        workspaceId: props.workspaceId,
        outputId,
        ...(revisionId === undefined ? {} : { revisionId }),
      });
      if (generation !== detailGeneration.current) return;
      setDetail(result);
      setReviewNote("");
    } catch (reason) {
      if (generation !== detailGeneration.current) return;
      setDetail(undefined);
      setDetailError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  }

  useEffect(() => {
    setItems([]);
    setWarnings([]);
    setDetail(undefined);
    setDetailError(undefined);
    void loadList();
    return () => {
      listGeneration.current += 1;
    };
  }, [props.workspaceId, scope, query]);

  useEffect(() => {
    if (props.selectedOutputId === undefined) {
      setDetail(undefined);
      setDetailError(undefined);
      setDetailLoading(false);
      return;
    }
    void loadDetail();
    return () => {
      detailGeneration.current += 1;
    };
  }, [props.selectedOutputId, props.workspaceId]);

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setQuery(queryDraft.trim());
  }

  async function mutateReview(
    action: "note" | "changes-requested" | "accepted" | "reopened",
  ): Promise<void> {
    if (detail === undefined) return;
    setMutationPending(true);
    setDetailError(undefined);
    try {
      const next = await window.piDeck.savedAnswers.review({
        workspaceId: detail.workspaceId,
        outputId: detail.outputId,
        revisionId: detail.selectedRevisionId,
        action,
        ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}),
      });
      setDetail(next);
      setReviewNote("");
      void loadList();
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMutationPending(false);
    }
  }

  async function revealOutput(): Promise<void> {
    if (detail === undefined) return;
    setMutationPending(true);
    setDetailError(undefined);
    try {
      await window.piDeck.savedAnswers.reveal({
        workspaceId: detail.workspaceId,
        outputId: detail.outputId,
      });
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMutationPending(false);
    }
  }

  if (props.selectedOutputId !== undefined) {
    return (
      <section
        className="saved-answers outputs-library"
        aria-label="Output detail"
      >
        <header className="saved-answers-header">
          <div>
            <p className="saved-answers-eyebrow">Text deliverable</p>
            <h1>{detail?.title ?? "Loading output…"}</h1>
            {detail ? (
              <p>
                {workspaceNameFor(props.workspaces, detail.workspaceId)} ·
                Revision {detail.selectedDisplayNumber} of{" "}
                {detail.revisionCount} · {formatBytes(detail.size)}
              </p>
            ) : null}
          </div>
          <div className="saved-answers-header-actions">
            <Button onClick={() => props.onSelect(undefined)}>
              All outputs
            </Button>
            <Button
              disabled={loading || detail === undefined}
              onClick={() => void revealOutput()}
            >
              Reveal files
            </Button>
          </div>
        </header>
        {error ? (
          <p className="saved-answers-error" role="alert">
            {error}
          </p>
        ) : null}
        {detailLoading && detail === undefined ? (
          <p className="saved-answers-empty" role="status">
            Loading output…
          </p>
        ) : detail ? (
          <>
            <div className="output-detail-grid">
              <aside className="output-revisions" aria-label="Revision history">
                <h2>Revisions</h2>
                {detail.revisions.map((revision) => (
                  <Button
                    key={revision.revisionId}
                    className={
                      revision.revisionId === detail.selectedRevisionId
                        ? "output-revision active"
                        : "output-revision"
                    }
                    disabled={revision.integrity === "damaged" || detailLoading}
                    onClick={() => void loadDetail(revision.revisionId)}
                  >
                    <span>Revision {revision.displayNumber}</span>
                    <small>
                      {revision.integrity === "damaged"
                        ? "Damaged"
                        : reviewLabel(revision.reviewState)}
                    </small>
                  </Button>
                ))}
              </aside>
              <div className="output-preview">
                <div className={`output-review-state ${detail.reviewState}`}>
                  {reviewLabel(detail.reviewState)}
                </div>
                <pre className="saved-answer-content">{detail.content}</pre>
              </div>
            </div>
            <section
              className="output-review"
              aria-label="Review this revision"
            >
              <h2>Review revision {detail.selectedDisplayNumber}</h2>
              <textarea
                aria-label="Review feedback"
                maxLength={4000}
                placeholder="What should change, or add a note…"
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
              />
              <div className="saved-answers-header-actions">
                <Button
                  disabled={mutationPending || !reviewNote.trim()}
                  onClick={() => void mutateReview("note")}
                >
                  Add note
                </Button>
                <Button
                  disabled={mutationPending || !reviewNote.trim()}
                  onClick={() => void mutateReview("changes-requested")}
                >
                  Request changes
                </Button>
                <Button
                  disabled={mutationPending}
                  onClick={() => void mutateReview("accepted")}
                >
                  Accept
                </Button>
                {detail.reviewState === "unreviewed" ? null : (
                  <Button
                    disabled={mutationPending}
                    onClick={() => void mutateReview("reopened")}
                  >
                    Reopen review
                  </Button>
                )}
                <Button
                  disabled={mutationPending}
                  onClick={() => props.onRevise(detail)}
                >
                  Revise in new session
                </Button>
              </div>
              {detail.reviews.filter(
                (event) => event.revisionId === detail.selectedRevisionId,
              ).length > 0 ? (
                <ol className="output-review-history">
                  {detail.reviews
                    .filter(
                      (event) => event.revisionId === detail.selectedRevisionId,
                    )
                    .map((event, index) => (
                      <li key={`${event.createdAtMs}-${index}`}>
                        <strong>{reviewActionLabel(event.action)}</strong>
                        {event.note ? ` — ${event.note}` : ""}
                        <small>
                          {formatSavedAnswerDate(event.createdAtMs)}
                        </small>
                      </li>
                    ))}
                </ol>
              ) : null}
            </section>
          </>
        ) : null}
      </section>
    );
  }

  return (
    <section className="saved-answers outputs-library" aria-label="Outputs">
      <header className="saved-answers-header">
        <div>
          <p className="saved-answers-eyebrow">Local deliverable library</p>
          <h1>Outputs</h1>
          <p>Find, review, and continue durable assistant deliverables.</p>
        </div>
        <div className="saved-answers-header-actions">
          <Button onClick={props.onBack}>Back to Work</Button>
          <Button disabled={loading} onClick={() => void loadList()}>
            Refresh
          </Button>
        </div>
      </header>
      <form className="outputs-search" onSubmit={submitSearch}>
        <input
          aria-label="Search outputs"
          placeholder="Search titles and contents"
          value={queryDraft}
          onChange={(event) => setQueryDraft(event.target.value)}
        />
        <select
          aria-label="Output scope"
          value={scope}
          onChange={(event) =>
            setScope(event.target.value as "workspace" | "all")
          }
        >
          <option value="workspace">{props.workspaceName}</option>
          <option value="all">All workspaces</option>
        </select>
        <Button type="submit" disabled={listLoading}>
          Search
        </Button>
      </form>
      {error ? (
        <p className="saved-answers-error" role="alert">
          {error}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <div className="saved-answers-warning" role="status">
          {warnings.length} output package{warnings.length === 1 ? "" : "s"}{" "}
          could not be verified and {warnings.length === 1 ? "is" : "are"}{" "}
          hidden.
        </div>
      ) : null}
      {listLoading && items.length === 0 ? (
        <p className="saved-answers-empty" role="status">
          Loading outputs…
        </p>
      ) : items.length === 0 ? (
        <div className="saved-answers-empty">
          <h2>{query ? "No matching outputs" : "No outputs yet"}</h2>
          <p>
            {query
              ? "Try a different phrase or scope."
              : "Open a completed assistant response and choose Save as output."}
          </p>
        </div>
      ) : (
        <div className="saved-answers-list">
          {items.map((item) => (
            <Button
              className="saved-answer-row"
              key={item.outputId}
              onClick={() => props.onSelect(item.outputId, item.workspaceId)}
            >
              <span>
                <strong>{item.title}</strong>
                <small>
                  {workspaceNameFor(props.workspaces, item.workspaceId)} ·
                  Revision {item.displayNumber} ·{" "}
                  {reviewLabel(item.reviewState)} ·{" "}
                  {formatSavedAnswerDate(item.updatedAtMs)}
                </small>
              </span>
              <small>{formatBytes(item.size)}</small>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

function workspaceNameFor(
  workspaces: readonly WorkspaceRef[],
  id: string,
): string {
  return (
    workspaces.find((workspace) => workspace.id === id)?.name ?? "Workspace"
  );
}

function reviewLabel(value: SavedAnswerSummary["reviewState"]): string {
  if (value === "changes-requested") return "Changes requested";
  if (value === "accepted") return "Accepted";
  return "Unreviewed";
}

function reviewActionLabel(
  action: SavedAnswerDetail["reviews"][number]["action"],
): string {
  if (action === "changes-requested") return "Changes requested";
  if (action === "accepted") return "Accepted";
  if (action === "reopened") return "Reopened";
  return "Note";
}

function formatSavedAnswerDate(value: number): string {
  return new Date(value).toLocaleString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
}
