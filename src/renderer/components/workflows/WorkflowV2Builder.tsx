import { useMemo, useState, type ReactElement } from "react";
import {
  defaultV2Definition,
  definitionJson,
  graphEdges,
  validateJsonDraft,
  workflowRoleTemplates,
  type WorkflowRole,
  type WorkflowV2Definition,
  type WorkflowV2Node,
} from "../../workflows/workflowV2.js";

type View = "build" | "graph" | "json";

const rolePresentation: Record<
  WorkflowRole,
  { label: string; action: string }
> = {
  worker: { label: "Agent task", action: "Add agent task" },
  decider: { label: "Decision", action: "Add decision" },
  orchestrator: { label: "Coordinate tasks", action: "Add coordination" },
  human: { label: "Approval / input", action: "Add checkpoint" },
};
const nodeFor = (role: WorkflowRole, number: number): WorkflowV2Node => {
  const id = `${role}-${number}`;
  if (role === "worker")
    return {
      id,
      name: "New worker",
      role,
      config: { instructions: "Describe the work to perform." },
    };
  if (role === "decider")
    return {
      id,
      name: "New decision",
      role,
      config: { question: "Is this ready?" },
    };
  if (role === "orchestrator")
    return {
      id,
      name: "New orchestration",
      role,
      config: {
        mode: "fanout",
        agents: ["worker-1"],
        maxConcurrency: 1,
        completion: "all",
      },
    };
  return {
    id,
    name: "Checkpoint",
    role,
    config: { interaction: "approval", prompt: "Approve this result?" },
  };
};
function summary(node: WorkflowV2Node): string {
  switch (node.role) {
    case "worker":
      return node.config.instructions;
    case "decider":
      return node.config.question;
    case "orchestrator":
      return `${node.config.mode} · ${node.config.agents.length} managed role${node.config.agents.length === 1 ? "" : "s"}`;
    case "human":
      return `${node.config.interaction}: ${node.config.prompt}`;
  }
}

/** Canonical v2 editor. Graph is derived only; JSON retains a last-valid draft until Apply. */
export function WorkflowV2Builder(props: {
  onSave(definition: WorkflowV2Definition): Promise<void> | void;
  onCancel(): void;
}): ReactElement {
  const [definition, setDefinition] = useState(defaultV2Definition);
  const [view, setView] = useState<View>("build");
  const [selectedId, setSelectedId] = useState(definition.entryNodeId);
  const [draft, setDraft] = useState(definitionJson(definition));
  const [jsonError, setJsonError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [showStepPicker, setShowStepPicker] = useState(false);
  const selected =
    definition.nodes.find((n) => n.id === selectedId) ?? definition.nodes[0]!;
  const edges = useMemo(() => graphEdges(definition), [definition]);
  const update = (next: WorkflowV2Definition) => {
    setDefinition(next);
    setDraft(definitionJson(next));
    setJsonError(undefined);
  };
  const patch = (node: WorkflowV2Node) =>
    update({
      ...definition,
      nodes: definition.nodes.map((item) =>
        item.id === node.id ? node : item,
      ),
    });
  const add = (role: WorkflowRole) => {
    const node = nodeFor(role, definition.nodes.length + 1);
    update({ ...definition, nodes: [...definition.nodes, node] });
    setSelectedId(node.id);
    setShowStepPicker(false);
  };
  const apply = () => {
    const result = validateJsonDraft(draft);
    if (!result.definition) {
      setJsonError(result.error);
      return;
    }
    update(result.definition);
    setSelectedId(result.definition.entryNodeId);
  };
  const save = async () => {
    const result = validateJsonDraft(definitionJson(definition));
    if (!result.definition) {
      setSaveError(result.error);
      return;
    }
    try {
      setSaveError(undefined);
      await props.onSave(result.definition);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="workflow-v2-builder">
      <header className="workflow-page-heading">
        <div>
          <button
            type="button"
            className="workflow-back-button"
            onClick={props.onCancel}
          >
            ← Agent Workflows
          </button>
          <h2>New agent workflow</h2>
          <p>Add tasks, decisions, coordination, and checkpoints.</p>
        </div>
        <div className="workflow-heading-actions">
          <button
            type="button"
            className="workflow-secondary-button"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="workflow-primary-button"
            onClick={() => void save()}
          >
            Save workflow
          </button>
        </div>
      </header>
      <div
        className="workflow-v2-tabs"
        role="tablist"
        aria-label="Workflow views"
      >
        {(["build", "graph", "json"] as View[]).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={view === item}
            className={view === item ? "is-active" : ""}
            onClick={() => setView(item)}
          >
            {item.toUpperCase()}
          </button>
        ))}
      </div>
      {view === "build" && (
        <div className="workflow-v2-build">
          <section
            className="workflow-v2-cards"
            aria-label="Workflow role cards"
          >
            <label className="workflow-field">
              <span>Workflow name</span>
              <input
                value={definition.name}
                onChange={(e) =>
                  update({ ...definition, name: e.target.value })
                }
              />
            </label>
            <div className="workflow-v2-add">
              <button
                type="button"
                className="workflow-secondary-button"
                aria-expanded={showStepPicker}
                aria-controls="workflow-step-picker"
                onClick={() => setShowStepPicker((open) => !open)}
              >
                + Add step
              </button>
              {showStepPicker && (
                <div
                  id="workflow-step-picker"
                  className="workflow-v2-step-picker"
                  role="menu"
                  aria-label="Choose step type"
                >
                  {workflowRoleTemplates.map((role) => (
                    <button
                      key={role.id}
                      type="button"
                      role="menuitem"
                      onClick={() => add(role.id)}
                    >
                      <strong>{rolePresentation[role.id].action}</strong>
                      <small>{rolePresentation[role.id].label}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {definition.nodes.map((node, index) => (
              <button
                key={node.id}
                type="button"
                className={`workflow-v2-step-card ${selected.id === node.id ? "is-selected" : ""}`}
                aria-pressed={selected.id === node.id}
                onClick={() => setSelectedId(node.id)}
              >
                <span className="workflow-v2-card-heading">
                  <b>{index + 1}</b>
                  <i>{rolePresentation[node.role].label}</i>
                </span>
                <strong>{node.name}</strong>
                <small>{summary(node)}</small>
                {edges
                  .filter((edge) => edge.from === node.id)
                  .map((edge) => (
                    <em key={`${edge.from}-${edge.to}-${edge.label}`}>
                      {edge.label} →{" "}
                      {definition.nodes.find((n) => n.id === edge.to)?.name ??
                        "End"}
                    </em>
                  ))}
              </button>
            ))}
          </section>
          <aside
            className="workflow-v2-inspector"
            aria-label="Focused role inspector"
          >
            <h3>{rolePresentation[selected.role].label}</h3>
            <label className="workflow-field">
              <span>Name</span>
              <input
                value={selected.name}
                onChange={(e) =>
                  patch({ ...selected, name: e.target.value } as WorkflowV2Node)
                }
              />
            </label>
            {selected.role === "worker" && (
              <label className="workflow-field">
                <span>Instructions</span>
                <textarea
                  value={selected.config.instructions}
                  onChange={(e) =>
                    patch({
                      ...selected,
                      config: {
                        ...selected.config,
                        instructions: e.target.value,
                      },
                    })
                  }
                />
              </label>
            )}
            {selected.role === "decider" && (
              <label className="workflow-field">
                <span>Question</span>
                <textarea
                  value={selected.config.question}
                  onChange={(e) =>
                    patch({
                      ...selected,
                      config: { ...selected.config, question: e.target.value },
                    })
                  }
                />
              </label>
            )}
            {selected.role === "human" && (
              <>
                <label className="workflow-field">
                  <span>Interaction</span>
                  <select
                    value={selected.config.interaction}
                    onChange={(e) =>
                      patch({
                        ...selected,
                        config: {
                          ...selected.config,
                          interaction: e.target.value as
                            | "input"
                            | "approval"
                            | "choice",
                        },
                      } as WorkflowV2Node)
                    }
                  >
                    <option value="input">Input</option>
                    <option value="approval">Approval</option>
                    <option value="choice">Choice</option>
                  </select>
                </label>
                <label className="workflow-field">
                  <span>Prompt</span>
                  <textarea
                    value={selected.config.prompt}
                    onChange={(e) =>
                      patch({
                        ...selected,
                        config: { ...selected.config, prompt: e.target.value },
                      })
                    }
                  />
                </label>
              </>
            )}
            {selected.role === "orchestrator" && (
              <p>
                {selected.config.mode === "loop"
                  ? `Loop limit: ${selected.config.maxIterations ?? "required"}`
                  : `Fan-out concurrency: ${selected.config.maxConcurrency ?? "required"}`}
              </p>
            )}
            <fieldset>
              <legend>Relationships</legend>
              {definition.relationships
                .filter((edge) => edge.from === selected.id)
                .map((edge) => (
                  <p key={edge.id}>
                    {edge.when ? String(edge.when.equals) : "then"} →{" "}
                    {"nodeId" in edge.to ? edge.to.nodeId : edge.to.end}
                  </p>
                ))}
              <label className="workflow-field">
                <span>Connect to</span>
                <select
                  aria-label="Connect selected role to"
                  defaultValue=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    const target = e.target.value;
                    update({
                      ...definition,
                      relationships: [
                        ...definition.relationships,
                        {
                          id: `relationship-${selected.id}-${target}-${definition.relationships.length + 1}`,
                          from: selected.id,
                          to: { nodeId: target },
                        },
                      ],
                    });
                    e.currentTarget.value = "";
                  }}
                >
                  <option value="">Choose role…</option>
                  {definition.nodes
                    .filter(
                      (n) =>
                        n.id !== selected.id &&
                        !("managedBy" in n && n.managedBy),
                    )
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                </select>
              </label>
            </fieldset>
            <details>
              <summary>Advanced execution settings</summary>
              <p>
                Model-backed roles may inherit model, thinking, attempts, and
                timeout settings.
              </p>
            </details>
          </aside>
        </div>
      )}
      {view === "graph" && (
        <section
          className="workflow-v2-graph"
          aria-label="Read-only workflow graph"
        >
          <h3>Workflow graph</h3>
          <p>Derived and read-only. Use Build to change relationships.</p>
          <ul>
            {definition.nodes
              .filter((n) => !("managedBy" in n && n.managedBy))
              .map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    aria-current={selected.id === node.id}
                    onClick={() => {
                      setSelectedId(node.id);
                      setView("build");
                    }}
                  >
                    <strong>{node.name}</strong> (
                    {rolePresentation[node.role].label})
                  </button>
                  {edges
                    .filter((e) => e.from === node.id)
                    .map((e) => (
                      <span key={`${e.from}-${e.to}-${e.label}`}>
                        {" "}
                        {e.label} →{" "}
                        {definition.nodes.find((n) => n.id === e.to)?.name ??
                          "end"}
                      </span>
                    ))}
                </li>
              ))}
          </ul>
        </section>
      )}
      {view === "json" && (
        <section className="workflow-v2-json">
          <h3>JSON draft</h3>
          <p>
            Parse, schema, and semantic validation occur before Apply. Invalid
            drafts never replace the last valid workflow.
          </p>
          <textarea
            aria-label="Workflow JSON draft"
            rows={22}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setJsonError(undefined);
            }}
          />
          <div className="workflow-form-actions">
            <button
              type="button"
              onClick={() => setDraft(definitionJson(definition))}
            >
              Revert
            </button>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(draft)}
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                try {
                  setDraft(JSON.stringify(JSON.parse(draft), null, 2));
                  setJsonError(undefined);
                } catch (error) {
                  setJsonError(
                    error instanceof Error
                      ? `Invalid JSON: ${error.message}`
                      : "Invalid JSON.",
                  );
                }
              }}
            >
              Format
            </button>
            <button
              type="button"
              className="workflow-primary-button"
              onClick={apply}
            >
              Apply
            </button>
          </div>
          {jsonError && (
            <p className="workflow-error" role="alert">
              {jsonError}
            </p>
          )}
        </section>
      )}
      {saveError && (
        <p className="workflow-error" role="alert">
          {saveError}
        </p>
      )}
    </div>
  );
}
