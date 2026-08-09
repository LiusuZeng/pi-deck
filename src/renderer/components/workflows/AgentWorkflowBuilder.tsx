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
  defaultAgentWorkflowDefinition,
  definitionJson,
  graphEdges,
  setLoopDecider,
  setManagedWorkers,
  setOrchestratorMode,
  validateJsonDraft,
  workflowRoleTemplates,
  type WorkflowRole,
  type AgentWorkflowDefinition,
  type AgentWorkflowNode,
} from "../../workflows/agentWorkflowDefinition.js";
import { PiModelThinkingMenu } from "../PiModelThinkingMenu.js";
import { AgentWorkflowGraph } from "./AgentWorkflowGraph.js";

type View = "build" | "graph" | "json";
interface WorkflowThinkingChoice {
  id: string;
  label: string;
  disabled?: boolean;
  note?: string;
}
interface WorkflowModelChoice {
  provider?: string;
  id: string;
  label: string;
  disabled?: boolean;
  note?: string;
  thinkingChoices?: WorkflowThinkingChoice[];
}
const modelChoiceValue = (
  choice: Pick<WorkflowModelChoice, "provider" | "id">,
) => [choice.provider, choice.id].filter(Boolean).join("/");
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
  definition: AgentWorkflowDefinition,
  node: AgentWorkflowNode,
) => ({
  ...definition,
  nodes: definition.nodes.map((item) => (item.id === node.id ? node : item)),
});
const optional = (value: string) => value || undefined;
const destinationLabel = (
  definition: AgentWorkflowDefinition,
  target: AgentWorkflowDefinition["relationships"][number]["to"],
): string =>
  "nodeId" in target
    ? (definition.nodes.find((node) => node.id === target.nodeId)?.name ??
      "Unavailable step")
    : `End workflow: ${target.end}`;
const connectionLabel = (equals: boolean | string | undefined): string =>
  equals === undefined ? "On completion" : `When ${String(equals)}`;

/** Canonical agentWorkflow editor. Build mutations only update the canonical workflow document. */
export function AgentWorkflowBuilder(props: {
  initialDefinition?: AgentWorkflowDefinition;
  modelChoices?: WorkflowModelChoice[];
  thinkingChoices?: WorkflowThinkingChoice[];
  onSave(definition: AgentWorkflowDefinition): Promise<void> | void;
  onCancel(): void;
}): ReactElement {
  const [definition, setDefinition] = useState(
    () => props.initialDefinition ?? defaultAgentWorkflowDefinition(),
  );
  const [view, setView] = useState<View>("build");
  const [selectedId, setSelectedId] = useState(definition.entryNodeId);
  const [draft, setDraft] = useState(definitionJson(definition));
  const [jsonError, setJsonError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [showPicker, setShowPicker] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);
  const originCardRef = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef(0);
  const selected =
    definition.nodes.find((node) => node.id === selectedId) ??
    definition.nodes[0]!;
  const selectedExecution =
    selected.role === "human" ? undefined : selected.execution;
  const selectedModelValue =
    selectedExecution?.model === "inherit"
      ? ""
      : (selectedExecution?.model ?? "");
  const selectedModelChoice = props.modelChoices?.find(
    (choice) => modelChoiceValue(choice) === selectedModelValue,
  );
  const availableThinkingChoices =
    selectedModelChoice?.thinkingChoices ?? props.thinkingChoices ?? [];
  const selectedThinkingValue =
    selectedExecution?.thinking === "inherit"
      ? ""
      : (selectedExecution?.thinking ?? "");
  const menuModels = (props.modelChoices ?? [])
    .filter((choice) => !choice.disabled && choice.provider)
    .map((choice) => ({
      id: choice.id,
      name: choice.label,
      provider: choice.provider,
    }));
  const selectedMenuModel =
    menuModels.find(
      (model) =>
        [model.provider, model.id].filter(Boolean).join("/") ===
        selectedModelValue,
    ) ??
    (() => {
      if (!selectedModelValue) return undefined;
      const separator = selectedModelValue.indexOf("/");
      return separator > 0
        ? {
            provider: selectedModelValue.slice(0, separator),
            id: selectedModelValue.slice(separator + 1),
            name: selectedModelValue,
          }
        : { id: selectedModelValue, name: selectedModelValue };
    })();
  const menuThinkingLevels = availableThinkingChoices
    .filter((choice) => !choice.disabled)
    .map((choice) => choice.id);
  const edges = useMemo(() => graphEdges(definition), [definition]);
  const validationError = useMemo(
    () => validateJsonDraft(definitionJson(definition)).error,
    [definition],
  );
  const update = (next: AgentWorkflowDefinition) => {
    setDefinition(next);
    setDraft(definitionJson(next));
    setJsonError(undefined);
  };
  const patch = (node: AgentWorkflowNode) =>
    update(updateNode(definition, node));
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
  useEffect(() => {
    if (inspectorOpen && window.matchMedia?.("(max-width: 720px)").matches)
      inspectorCloseRef.current?.focus();
  }, [inspectorOpen, selectedId, view]);
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
  const relationshipDefinition = (
    from: string,
    equals: boolean | string | undefined,
    value: string,
  ): AgentWorkflowDefinition => {
    const existing = definition.relationships.find(
      (edge) =>
        edge.from === from &&
        (equals === undefined ? !edge.when : edge.when?.equals === equals),
    );
    if (!value)
      return {
        ...definition,
        relationships: definition.relationships.filter(
          (item) => item !== existing,
        ),
      };
    const to = value.startsWith("end:")
      ? { end: value.slice(4) }
      : { nodeId: value };
    const edge = {
      id:
        existing?.id ??
        `relationship-${from}-${String(equals ?? "then")}-${(() => {
          let n = 1;
          const ids = new Set(definition.relationships.map((item) => item.id));
          while (
            ids.has(`relationship-${from}-${String(equals ?? "then")}-${n}`)
          )
            n += 1;
          return n;
        })()}`,
      from,
      ...(equals === undefined ? {} : { when: { equals } }),
      to,
    };
    return {
      ...definition,
      relationships: [
        ...definition.relationships.filter((item) => item !== existing),
        edge,
      ],
    } as AgentWorkflowDefinition;
  };
  const canSetRelationship = (
    from: string,
    equals: boolean | string | undefined,
    value: string,
  ): boolean =>
    validateJsonDraft(
      definitionJson(relationshipDefinition(from, equals, value)),
    ).definition !== undefined;
  const relationship = (
    from: string,
    equals: boolean | string | undefined,
    value: string,
  ) => {
    const next = relationshipDefinition(from, equals, value);
    if (validateJsonDraft(definitionJson(next)).definition) update(next);
  };
  const changeMode = (
    node: Extract<AgentWorkflowNode, { role: "orchestrator" }>,
    mode: "loop" | "fanout",
  ) => update(setOrchestratorMode(definition, node.id, mode));
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
  const relationshipValue = (equals: boolean | string | undefined): string => {
    const target = definition.relationships.find(
      (edge) =>
        edge.from === selected.id &&
        (equals === undefined ? !edge.when : edge.when?.equals === equals),
    )?.to;
    return target
      ? "nodeId" in target
        ? target.nodeId
        : `end:${target.end}`
      : "";
  };
  const destinationOptions = (
    equals: boolean | string | undefined,
    currentValue: string,
    includeEnd = true,
  ) => (
    <>
      {includeEnd &&
        ["completed", "rejected", "stopped"].map((end) => {
          const value = `end:${end}`;
          return canSetRelationship(selected.id, equals, value) ? (
            <option key={value} value={value}>
              End workflow: {end}
            </option>
          ) : null;
        })}
      {currentValue.startsWith("end:") &&
      !["end:completed", "end:rejected", "end:stopped"].includes(
        currentValue,
      ) ? (
        <option value={currentValue}>
          End workflow: {currentValue.slice(4)}
        </option>
      ) : null}
      {topLevel
        .filter(
          (node) =>
            node.id !== selected.id &&
            canSetRelationship(selected.id, equals, node.id),
        )
        .map((node) => (
          <option key={node.id} value={node.id}>
            {node.name}
          </option>
        ))}
    </>
  );
  const canClearRelationship = (equals: boolean | string | undefined) =>
    relationshipValue(equals) !== "" &&
    canSetRelationship(selected.id, equals, "");
  return (
    <div className="agent-workflow-builder">
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
        className="agent-workflow-tabs"
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
        <div className="agent-workflow-build">
          <section
            className="agent-workflow-cards"
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
            <label className="workflow-field">
              <span>Starts with</span>
              <select
                aria-label="Workflow starting step"
                value={definition.entryNodeId}
                onChange={(event) =>
                  update({ ...definition, entryNodeId: event.target.value })
                }
              >
                {definition.nodes
                  .filter((node) => !node.managedBy)
                  .map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.name}
                    </option>
                  ))}
              </select>
              <small>The first step Pi Deck runs.</small>
            </label>
            <div ref={pickerRef} className="agent-workflow-add">
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
                  className="agent-workflow-step-picker"
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
                data-workflow-node-id={node.id}
                className={`agent-workflow-step-card ${selected.id === node.id ? "is-selected" : ""}`}
                aria-pressed={selected.id === node.id}
                onClick={(event) => {
                  originCardRef.current = event.currentTarget;
                  setSelectedId(node.id);
                  setInspectorOpen(true);
                }}
              >
                <span className="agent-workflow-card-heading">
                  <b>{index + 1}</b>
                  <i>
                    {presentation[node.role]}
                    {node.managedBy
                      ? " (managed)"
                      : node.id === definition.entryNodeId
                        ? " · Starts workflow"
                        : ""}
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
                      {edge.label === "then" ? "Next" : edge.label} →{" "}
                      {edge.to
                        ? (definition.nodes.find((n) => n.id === edge.to)
                            ?.name ?? "Unavailable step")
                        : `End workflow: ${edge.end ?? "completed"}`}
                    </em>
                  ))}
              </button>
            ))}
          </section>
          <aside
            className={`agent-workflow-inspector ${inspectorOpen ? "is-open" : ""}`}
            aria-label="Focused role inspector"
          >
            <div className="agent-workflow-inspector-heading">
              <h3>{presentation[selected.role]}</h3>
              <button
                ref={inspectorCloseRef}
                type="button"
                className="agent-workflow-inspector-close"
                onClick={() => {
                  setInspectorOpen(false);
                  const origin = originCardRef.current?.isConnected
                    ? originCardRef.current
                    : Array.from(
                        document.querySelectorAll<HTMLButtonElement>(
                          "[data-workflow-node-id]",
                        ),
                      ).find(
                        (card) => card.dataset.workflowNodeId === selected.id,
                      );
                  (origin ?? addRef.current)?.focus();
                }}
              >
                Close inspector
              </button>
            </div>
            {validationError && (
              <p className="agent-workflow-validation" role="alert">
                {validationError}
              </p>
            )}
            <label className="workflow-field">
              <span>Name</span>
              <input
                value={selected.name}
                onChange={(e) =>
                  patch({
                    ...selected,
                    name: e.target.value,
                  } as AgentWorkflowNode)
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
                      const config =
                        interaction === "choice"
                          ? {
                              interaction,
                              prompt: selected.config.prompt,
                              ...(selected.config.input
                                ? { input: selected.config.input }
                                : {}),
                              options: ["Option 1"],
                            }
                          : {
                              interaction,
                              prompt: selected.config.prompt,
                              ...(selected.config.input
                                ? { input: selected.config.input }
                                : {}),
                            };
                      update({
                        ...updateNode(definition, {
                          ...selected,
                          config,
                        } as AgentWorkflowNode),
                        relationships: definition.relationships.filter(
                          (edge) => edge.from !== selected.id,
                        ),
                      });
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
                      } as AgentWorkflowNode)
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
                      } as AgentWorkflowNode)
                    }
                  />
                </label>
                {selected.config.interaction === "choice" && (
                  <label className="workflow-field">
                    <span>Choice options (one per line)</span>
                    <textarea
                      value={selected.config.options.join("\n")}
                      onChange={(e) => {
                        const options = e.target.value
                          .split("\n")
                          .map((option) => option.trim())
                          .filter(Boolean);
                        update({
                          ...updateNode(definition, {
                            ...selected,
                            config: { ...selected.config, options },
                          } as AgentWorkflowNode),
                          relationships: definition.relationships.filter(
                            (edge) =>
                              edge.from !== selected.id ||
                              !edge.when ||
                              (typeof edge.when.equals === "string" &&
                                options.includes(edge.when.equals)),
                          ),
                        });
                      }}
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
                      } as AgentWorkflowNode)
                    }
                  />
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
                      <label key={node.id} className="agent-workflow-check">
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
                  <p className="agent-workflow-policy">
                    Workers are owned exclusively. Removing an assigned worker
                    deletes it and its routes; at least one worker is required.
                  </p>
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
                          } as AgentWorkflowNode)
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
                          } as AgentWorkflowNode)
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
                          } as AgentWorkflowNode)
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
                <legend>Workflow connection</legend>
                {definition.relationships
                  .filter((edge) => edge.from === selected.id)
                  .map((edge) => (
                    <p key={edge.id} className="agent-workflow-connection">
                      <span>
                        {connectionLabel(edge.when?.equals)} →{" "}
                        <strong>{destinationLabel(definition, edge.to)}</strong>
                      </span>{" "}
                      {canSetRelationship(edge.from, edge.when?.equals, "") ? (
                        <button
                          type="button"
                          onClick={() =>
                            relationship(edge.from, edge.when?.equals, "")
                          }
                        >
                          Remove
                        </button>
                      ) : null}
                    </p>
                  ))}
                {selected.role === "decider" ||
                (selected.role === "human" &&
                  selected.config.interaction === "approval") ? (
                  <>
                    <label className="workflow-field">
                      <span>
                        {selected.role === "human"
                          ? "Approved"
                          : (selected.config.trueLabel ?? "Yes")}{" "}
                        destination
                      </span>
                      <select
                        aria-label="True destination"
                        value={relationshipValue(true)}
                        onChange={(e) =>
                          relationship(selected.id, true, e.target.value)
                        }
                      >
                        {relationshipValue(true) === "" ? (
                          <option value="">Choose destination…</option>
                        ) : canClearRelationship(true) ? (
                          <option value="">
                            No destination (remove route)
                          </option>
                        ) : null}
                        {destinationOptions(true, relationshipValue(true))}
                      </select>
                    </label>
                    <label className="workflow-field">
                      <span>
                        {selected.role === "human"
                          ? "Rejected"
                          : (selected.config.falseLabel ?? "No")}{" "}
                        destination
                      </span>
                      <select
                        aria-label="False destination"
                        value={relationshipValue(false)}
                        onChange={(e) =>
                          relationship(selected.id, false, e.target.value)
                        }
                      >
                        {relationshipValue(false) === "" ? (
                          <option value="">Choose destination…</option>
                        ) : canClearRelationship(false) ? (
                          <option value="">
                            No destination (remove route)
                          </option>
                        ) : null}
                        {destinationOptions(false, relationshipValue(false))}
                      </select>
                    </label>
                  </>
                ) : selected.role === "human" &&
                  selected.config.interaction === "choice" ? (
                  <>
                    {selected.config.options.map((option) => (
                      <label className="workflow-field" key={option}>
                        <span>{option} destination</span>
                        <select
                          aria-label={`${option} destination`}
                          value={relationshipValue(option)}
                          onChange={(e) =>
                            relationship(selected.id, option, e.target.value)
                          }
                        >
                          {relationshipValue(option) === "" ? (
                            <option value="">Choose destination…</option>
                          ) : canClearRelationship(option) ? (
                            <option value="">
                              No destination (remove route)
                            </option>
                          ) : null}
                          {destinationOptions(
                            option,
                            relationshipValue(option),
                          )}
                        </select>
                      </label>
                    ))}
                  </>
                ) : (
                  <label className="workflow-field">
                    <span>Next step</span>
                    <select
                      aria-label="Choose the next workflow step"
                      value={relationshipValue(undefined)}
                      onChange={(e) =>
                        relationship(selected.id, undefined, e.target.value)
                      }
                    >
                      {relationshipValue(undefined) === "" ? (
                        <option value="">Choose next step…</option>
                      ) : canClearRelationship(undefined) ? (
                        <option value="">No next step (remove route)</option>
                      ) : null}
                      {destinationOptions(
                        undefined,
                        relationshipValue(undefined),
                      )}
                    </select>
                  </label>
                )}
              </fieldset>
            )}
            {selected.role !== "human" && (
              <details>
                <summary>Advanced execution settings</summary>
                <div className="agent-workflow-execution-configuration">
                  <PiModelThinkingMenu
                    models={menuModels}
                    selectedModel={selectedMenuModel}
                    thinkingLevels={menuThinkingLevels}
                    selectedThinking={selectedThinkingValue || undefined}
                    disabled={false}
                    onSelectModel={(provider, modelId) => {
                      const model = `${provider}/${modelId}`;
                      const nextChoice = props.modelChoices?.find(
                        (choice) => modelChoiceValue(choice) === model,
                      );
                      const nextThinkingChoices =
                        nextChoice?.thinkingChoices ??
                        props.thinkingChoices ??
                        [];
                      const thinkingUnsupported =
                        selectedThinkingValue !== "" &&
                        nextThinkingChoices.length > 0 &&
                        !nextThinkingChoices.some(
                          (choice) =>
                            choice.id === selectedThinkingValue &&
                            !choice.disabled,
                        );
                      patch({
                        ...selected,
                        execution: {
                          ...selected.execution,
                          model,
                          ...(thinkingUnsupported
                            ? { thinking: undefined }
                            : {}),
                        },
                      } as AgentWorkflowNode);
                    }}
                    onSelectThinking={(thinking) =>
                      patch({
                        ...selected,
                        execution: { ...selected.execution, thinking },
                      } as AgentWorkflowNode)
                    }
                  />
                  <span className="agent-workflow-policy">
                    {selectedModelValue || selectedThinkingValue
                      ? "Overrides Pi Deck defaults for this step."
                      : "Using Pi Deck defaults for this step."}
                  </span>
                  {selectedModelValue || selectedThinkingValue ? (
                    <button
                      type="button"
                      className="workflow-secondary-button"
                      onClick={() =>
                        patch({
                          ...selected,
                          execution: {
                            ...selected.execution,
                            model: undefined,
                            thinking: undefined,
                          },
                        } as AgentWorkflowNode)
                      }
                    >
                      Use Pi Deck defaults
                    </button>
                  ) : null}
                </div>
                {(["maxAttempts", "timeoutSeconds"] as const).map((field) => (
                  <label className="workflow-field" key={field}>
                    <span>
                      {field === "maxAttempts"
                        ? "Max attempts"
                        : "Timeout seconds"}
                    </span>
                    <input
                      type="number"
                      min="1"
                      value={selected.execution?.[field] ?? ""}
                      onChange={(event) =>
                        patch({
                          ...selected,
                          execution: {
                            ...selected.execution,
                            [field]: event.target.value
                              ? Number(event.target.value)
                              : undefined,
                          },
                        } as AgentWorkflowNode)
                      }
                    />
                  </label>
                ))}
              </details>
            )}
          </aside>
        </div>
      )}
      {view === "graph" && (
        <AgentWorkflowGraph
          definition={definition}
          selectedNodeId={selected.id}
          onSelectNode={(nodeId) => {
            originCardRef.current = null;
            setSelectedId(nodeId);
            setInspectorOpen(true);
            setView("build");
          }}
        />
      )}
      {view === "json" && (
        <section className="agent-workflow-json">
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
