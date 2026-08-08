import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import {
  addRole,
  defaultV2Definition,
  definitionJson,
  graphEdges,
  setLoopDecider,
  setManagedWorkers,
  validateJsonDraft,
  workflowRoleTemplates,
  type WorkflowRole,
  type WorkflowV2Definition,
  type WorkflowV2Node,
} from "../../workflows/workflowV2.js";
import { WorkflowV2Graph } from "./v2/WorkflowV2Graph.js";

type View = "build" | "graph" | "json";
const presentation: Record<WorkflowRole, string> = {
  worker: "Agent task",
  decider: "Decision",
  orchestrator: "Coordinate tasks",
  human: "Approval / input",
};
const addAction: Record<WorkflowRole, string> = {
  worker: "Add agent task",
  decider: "Add decision",
  orchestrator: "Add coordination",
  human: "Add checkpoint",
};
const updateNode = (
  definition: WorkflowV2Definition,
  node: WorkflowV2Node,
) => ({
  ...definition,
  nodes: definition.nodes.map((item) => (item.id === node.id ? node : item)),
});
const optional = (value: string) => value || undefined;

/** Canonical v2 editor. Build mutations only update the canonical workflow document. */
export function WorkflowV2Builder(props: {
  initialDefinition?: WorkflowV2Definition;
  onSave(definition: WorkflowV2Definition): Promise<void> | void;
  onCancel(): void;
}): ReactElement {
  const [definition, setDefinition] = useState(
    () => props.initialDefinition ?? defaultV2Definition(),
  );
  const [view, setView] = useState<View>("build");
  const [selectedId, setSelectedId] = useState(definition.entryNodeId);
  const [draft, setDraft] = useState(definitionJson(definition));
  const [jsonError, setJsonError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef(0);
  const selected =
    definition.nodes.find((node) => node.id === selectedId) ??
    definition.nodes[0]!;
  const edges = useMemo(() => graphEdges(definition), [definition]);
  const update = (next: WorkflowV2Definition) => {
    setDefinition(next);
    setDraft(definitionJson(next));
    setJsonError(undefined);
  };
  const patch = (node: WorkflowV2Node) => update(updateNode(definition, node));
  useEffect(() => {
    if (!showPicker) return;
    pickerRef.current
      ?.querySelectorAll<HTMLElement>('[role="menuitem"]')
      [initialFocus.current]?.focus();
    initialFocus.current = 0;
    const outside = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node))
        setShowPicker(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowPicker(false);
        addRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [showPicker]);
  const pickerKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      pickerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        [],
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (index + 1 + items.length) % items.length
        : event.key === "ArrowUp"
          ? (index - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    }
  };
  const topLevel = definition.nodes.filter((node) => !node.managedBy);
  const relationship = (
    from: string,
    equals: boolean | string | undefined,
    value: string,
  ) => {
    const to = value.startsWith("end:")
      ? { end: value.slice(4) }
      : { nodeId: value };
    const existing = definition.relationships.find(
      (edge) =>
        edge.from === from &&
        (equals === undefined ? !edge.when : edge.when?.equals === equals),
    );
    const edge = {
      id:
        existing?.id ??
        `relationship-${from}-${String(equals ?? "then")}-${definition.relationships.length + 1}`,
      from,
      ...(equals === undefined ? {} : { when: { equals } }),
      to,
    };
    update({
      ...definition,
      relationships: [
        ...definition.relationships.filter((item) => item !== existing),
        edge,
      ],
    });
  };
  const changeMode = (
    node: Extract<WorkflowV2Node, { role: "orchestrator" }>,
    mode: "loop" | "fanout",
  ) => {
    if (mode === "fanout")
      return patch({
        ...node,
        config: {
          mode,
          agents: node.config.agents,
          maxConcurrency: 1,
          completion: "all",
        },
      });
    const deciderId = `decider-${definition.nodes.length + 1}`;
    const decider: WorkflowV2Node = {
      id: deciderId,
      name: "Loop completion",
      role: "decider",
      managedBy: node.id,
      config: { question: "Is the loop complete?" },
    };
    update({ ...definition, nodes: [...definition.nodes, decider] });
    // The second update intentionally establishes the loop config after the child exists.
    const next = {
      ...definition,
      nodes: [
        ...definition.nodes.filter((item) => item.id !== node.id),
        {
          ...node,
          config: {
            mode,
            agents: node.config.agents,
            decider: deciderId,
            maxIterations: 1,
          },
        },
        decider,
      ],
    } as WorkflowV2Definition;
    update(next);
    setSelectedId(node.id);
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
  const destinationOptions = (includeEnd = true) => (
    <>
      {includeEnd && (
        <>
          <option value="end:completed">Terminal: completed</option>
          <option value="end:rejected">Terminal: rejected</option>
        </>
      )}
      {topLevel
        .filter((node) => node.id !== selected.id)
        .map((node) => (
          <option key={node.id} value={node.id}>
            {node.name}
          </option>
        ))}
    </>
  );
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
          <h2>
            {props.initialDefinition
              ? `Edit ${props.initialDefinition.name}`
              : "New agent workflow"}
          </h2>
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
            onClick={() => {
              setShowPicker(false);
              setView(item);
            }}
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
            <div ref={pickerRef} className="workflow-v2-add">
              <button
                ref={addRef}
                type="button"
                className="workflow-secondary-button"
                aria-haspopup="menu"
                aria-expanded={showPicker}
                onClick={() => setShowPicker((open) => !open)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    initialFocus.current = e.key === "ArrowDown" ? 0 : 3;
                    setShowPicker(true);
                  }
                }}
              >
                + Add step
              </button>
              {showPicker && (
                <div
                  className="workflow-v2-step-picker"
                  role="menu"
                  aria-label="Choose step type"
                  onKeyDown={pickerKeys}
                >
                  {workflowRoleTemplates.map((role) => (
                    <button
                      key={role.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        const next = addRole(definition, role.id);
                        update(next.definition);
                        setSelectedId(next.selectedId);
                        setShowPicker(false);
                      }}
                    >
                      <strong>{addAction[role.id]}</strong>
                      <small>{presentation[role.id]}</small>
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
                  <i>
                    {presentation[node.role]}
                    {node.managedBy ? " (managed)" : ""}
                  </i>
                </span>
                <strong>{node.name}</strong>
                <small>
                  {node.role === "orchestrator"
                    ? `${node.config.mode}: ${node.config.agents.length} managed worker${node.config.agents.length === 1 ? "" : "s"}`
                    : node.role === "human"
                      ? `${node.config.interaction}: ${node.config.prompt}`
                      : node.role === "worker"
                        ? node.config.instructions
                        : node.config.question}
                </small>
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
            <h3>{presentation[selected.role]}</h3>
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
              <>
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
                <label className="workflow-field">
                  <span>Input (optional)</span>
                  <textarea
                    value={selected.config.input ?? ""}
                    onChange={(e) =>
                      patch({
                        ...selected,
                        config: {
                          ...selected.config,
                          input: optional(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label className="workflow-field">
                  <span>Expected output (optional)</span>
                  <input
                    value={selected.config.expectedOutput ?? ""}
                    onChange={(e) =>
                      patch({
                        ...selected,
                        config: {
                          ...selected.config,
                          expectedOutput: optional(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            {selected.role === "decider" && (
              <>
                <label className="workflow-field">
                  <span>Question</span>
                  <textarea
                    value={selected.config.question}
                    onChange={(e) =>
                      patch({
                        ...selected,
                        config: {
                          ...selected.config,
                          question: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label className="workflow-field">
                  <span>Input (optional)</span>
                  <textarea
                    value={selected.config.input ?? ""}
                    onChange={(e) =>
                      patch({
                        ...selected,
                        config: {
                          ...selected.config,
                          input: optional(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label className="workflow-field">
                  <span>True label</span>
                  <input
                    value={selected.config.trueLabel ?? ""}
                    placeholder="Yes"
                    onChange={(e) =>
                      patch({
                        ...selected,
                        config: {
                          ...selected.config,
                          trueLabel: optional(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label className="workflow-field">
                  <span>False label</span>
                  <input
                    value={selected.config.falseLabel ?? ""}
                    placeholder="No"
                    onChange={(e) =>
                      patch({
                        ...selected,
                        config: {
                          ...selected.config,
                          falseLabel: optional(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            {selected.role === "human" && (
              <>
                <label className="workflow-field">
                  <span>Interaction</span>
                  <select
                    value={selected.config.interaction}
                    onChange={(e) => {
                      const interaction = e.target.value as
                        | "input"
                        | "approval"
                        | "choice";
                      patch({
                        ...selected,
                        config:
                          interaction === "choice"
                            ? {
                                interaction,
                                prompt: selected.config.prompt,
                                options: ["Option 1"],
                              }
                            : {
                                interaction,
                                prompt: selected.config.prompt,
                                ...(selected.config.input
                                  ? { input: selected.config.input }
                                  : {}),
                              },
                      } as WorkflowV2Node);
                    }}
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
                      } as WorkflowV2Node)
                    }
                  />
                </label>
                <label className="workflow-field">
                  <span>Input (optional)</span>
                  <textarea
                    value={selected.config.input ?? ""}
                    onChange={(e) =>
                      patch({
                        ...selected,
                        config: {
                          ...selected.config,
                          input: optional(e.target.value),
                        },
                      } as WorkflowV2Node)
                    }
                  />
                </label>
                {selected.config.interaction === "choice" && (
                  <label className="workflow-field">
                    <span>Choice options (one per line)</span>
                    <textarea
                      value={selected.config.options.join("\n")}
                      onChange={(e) =>
                        patch({
                          ...selected,
                          config: {
                            ...selected.config,
                            options: e.target.value.split("\n").filter(Boolean),
                          },
                        } as WorkflowV2Node)
                      }
                    />
                  </label>
                )}
              </>
            )}
            {selected.role === "orchestrator" && (
              <>
                <label className="workflow-field">
                  <span>Mode</span>
                  <select
                    value={selected.config.mode}
                    onChange={(e) =>
                      changeMode(selected, e.target.value as "loop" | "fanout")
                    }
                  >
                    <option value="fanout">Fan-out</option>
                    <option value="loop">Loop</option>
                  </select>
                </label>
                <fieldset>
                  <legend>Managed workers (fixed list)</legend>
                  {definition.nodes
                    .filter(
                      (node) =>
                        node.role === "worker" &&
                        (!node.managedBy || node.managedBy === selected.id),
                    )
                    .map((node) => (
                      <label key={node.id} className="workflow-v2-check">
                        <input
                          type="checkbox"
                          checked={selected.config.agents.includes(node.id)}
                          disabled={
                            selected.config.agents.length === 1 &&
                            selected.config.agents.includes(node.id)
                          }
                          onChange={(e) =>
                            update(
                              setManagedWorkers(
                                definition,
                                selected.id,
                                e.target.checked
                                  ? [...selected.config.agents, node.id]
                                  : selected.config.agents.filter(
                                      (id) => id !== node.id,
                                    ),
                              ),
                            )
                          }
                        />
                        {node.name}
                      </label>
                    ))}
                  <p>
                    Derived fan-out worker count:{" "}
                    <strong>{selected.config.agents.length}</strong>
                  </p>
                </fieldset>
                {selected.config.mode === "loop" ? (
                  <>
                    <label className="workflow-field">
                      <span>Loop decider</span>
                      <select
                        value={selected.config.decider}
                        onChange={(e) =>
                          update(
                            setLoopDecider(
                              definition,
                              selected.id,
                              e.target.value,
                            ),
                          )
                        }
                      >
                        {definition.nodes
                          .filter(
                            (node) =>
                              node.role === "decider" &&
                              (!node.managedBy ||
                                node.managedBy === selected.id),
                          )
                          .map((node) => (
                            <option key={node.id} value={node.id}>
                              {node.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="workflow-field">
                      <span>Maximum iterations</span>
                      <input
                        type="number"
                        min="1"
                        value={selected.config.maxIterations}
                        onChange={(e) =>
                          patch({
                            ...selected,
                            config: {
                              ...selected.config,
                              maxIterations: Number(e.target.value),
                            },
                          } as WorkflowV2Node)
                        }
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="workflow-field">
                      <span>Maximum concurrency</span>
                      <input
                        type="number"
                        min="1"
                        value={selected.config.maxConcurrency}
                        onChange={(e) =>
                          patch({
                            ...selected,
                            config: {
                              ...selected.config,
                              maxConcurrency: Number(e.target.value),
                            },
                          } as WorkflowV2Node)
                        }
                      />
                    </label>
                    <label className="workflow-field">
                      <span>Completion policy</span>
                      <select
                        value={selected.config.completion}
                        onChange={(e) =>
                          patch({
                            ...selected,
                            config: {
                              ...selected.config,
                              completion: e.target.value as "all" | "any",
                            },
                          } as WorkflowV2Node)
                        }
                      >
                        <option value="all">All workers</option>
                        <option value="any">Any worker</option>
                      </select>
                    </label>
                  </>
                )}
              </>
            )}
            {!selected.managedBy && (
              <fieldset>
                <legend>Relationships</legend>
                {definition.relationships
                  .filter((edge) => edge.from === selected.id)
                  .map((edge) => (
                    <p key={edge.id}>
                      {edge.when ? String(edge.when.equals) : "then"} →{" "}
                      {"nodeId" in edge.to ? edge.to.nodeId : edge.to.end}{" "}
                      <button
                        type="button"
                        onClick={() =>
                          update({
                            ...definition,
                            relationships: definition.relationships.filter(
                              (item) => item.id !== edge.id,
                            ),
                          })
                        }
                      >
                        Remove
                      </button>
                    </p>
                  ))}
                {selected.role === "decider" ? (
                  <>
                    <label className="workflow-field">
                      <span>
                        {selected.config.trueLabel ?? "Yes"} destination
                      </span>
                      <select
                        aria-label="True destination"
                        value=""
                        onChange={(e) => {
                          if (e.target.value)
                            relationship(selected.id, true, e.target.value);
                        }}
                      >
                        <option value="">Choose destination…</option>
                        {destinationOptions()}
                      </select>
                    </label>
                    <label className="workflow-field">
                      <span>
                        {selected.config.falseLabel ?? "No"} destination
                      </span>
                      <select
                        aria-label="False destination"
                        value=""
                        onChange={(e) => {
                          if (e.target.value)
                            relationship(selected.id, false, e.target.value);
                        }}
                      >
                        <option value="">Choose destination…</option>
                        {destinationOptions()}
                      </select>
                    </label>
                  </>
                ) : (
                  <label className="workflow-field">
                    <span>Connect to</span>
                    <select
                      aria-label="Connect selected role to"
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          relationship(selected.id, undefined, e.target.value);
                      }}
                    >
                      <option value="">Choose destination…</option>
                      {destinationOptions()}
                    </select>
                  </label>
                )}
              </fieldset>
            )}
            {selected.role !== "human" && (
              <details>
                <summary>Advanced execution settings</summary>
                {(
                  [
                    "model",
                    "thinking",
                    "maxAttempts",
                    "timeoutSeconds",
                  ] as const
                ).map((field) => (
                  <label className="workflow-field" key={field}>
                    <span>
                      {field === "maxAttempts"
                        ? "Max attempts"
                        : field === "timeoutSeconds"
                          ? "Timeout seconds"
                          : field}
                    </span>
                    <input
                      type={
                        field === "maxAttempts" || field === "timeoutSeconds"
                          ? "number"
                          : "text"
                      }
                      value={selected.execution?.[field] ?? ""}
                      onChange={(e) => {
                        const value =
                          field === "maxAttempts" || field === "timeoutSeconds"
                            ? e.target.value
                              ? Number(e.target.value)
                              : undefined
                            : optional(e.target.value);
                        patch({
                          ...selected,
                          execution: { ...selected.execution, [field]: value },
                        } as WorkflowV2Node);
                      }}
                    />
                  </label>
                ))}
              </details>
            )}
          </aside>
        </div>
      )}
      {view === "graph" && (
        <WorkflowV2Graph
          definition={definition}
          selectedNodeId={selected.id}
          onSelectNode={(nodeId) => {
            setSelectedId(nodeId);
            setView("build");
          }}
        />
      )}
      {view === "json" && (
        <section className="workflow-v2-json">
          <h3>JSON draft</h3>
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
                } catch {
                  setJsonError("Invalid JSON.");
                }
              }}
            >
              Format
            </button>
            <button
              type="button"
              className="workflow-primary-button"
              onClick={() => {
                const result = validateJsonDraft(draft);
                if (result.definition) {
                  update(result.definition);
                  setSelectedId(result.definition.entryNodeId);
                } else setJsonError(result.error);
              }}
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
