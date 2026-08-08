import { useMemo, useState, type ReactElement } from "react";
import type { WorkflowTemplate, WorkflowTemplateDefinition } from "../../../shared/workflowSchemas.js";
import {
  defaultV2Definition,
  definitionJson,
  graphEdges,
  roleTemplate,
  v2Cards,
  validateJsonDraft,
  withRole,
  workflowRoleTemplates,
  type WorkflowRole,
} from "../../workflows/workflowV2.js";

type View = "build" | "graph" | "json";

function fromTemplate(template?: WorkflowTemplate): WorkflowTemplateDefinition {
  if (!template) return defaultV2Definition();
  const { id: _id, createdAtMs: _created, updatedAtMs: _updated, ...definition } = template;
  return definition;
}

/**
 * Canonical v2 workflow editor. Build is the only visual editing surface;
 * Graph is an accessible derived projection and JSON is an explicit safe draft.
 */
export function WorkflowV2Builder(props: {
  initialTemplate?: WorkflowTemplate;
  onSave(definition: WorkflowTemplateDefinition, templateId?: string): Promise<void> | void;
  onCancel(): void;
}): ReactElement {
  const [definition, setDefinition] = useState(() => fromTemplate(props.initialTemplate));
  const [view, setView] = useState<View>("build");
  const [selectedStepId, setSelectedStepId] = useState(() => definition.steps[0]?.id);
  const [jsonDraft, setJsonDraft] = useState(() => definitionJson(definition));
  const [jsonError, setJsonError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const selected = definition.steps.find((step) => step.id === selectedStepId) ?? definition.steps[0];
  const edges = useMemo(() => graphEdges(definition), [definition]);
  const update = (next: WorkflowTemplateDefinition) => {
    setDefinition(next);
    setJsonDraft(definitionJson(next));
    setJsonError(undefined);
  };
  const updateSelected = (patch: Partial<typeof selected>) => {
    if (!selected) return;
    update({ ...definition, steps: definition.steps.map((step) => step.id === selected.id ? { ...step, ...patch } : step) });
  };
  const applyJson = () => {
    const result = validateJsonDraft(jsonDraft);
    if (!result.definition) { setJsonError(result.error); return; }
    update(result.definition);
    setSelectedStepId(result.definition.steps[0]?.id);
  };
  const save = async () => {
    setSaving(true); setSaveError(undefined);
    try { await props.onSave(definition, props.initialTemplate?.id); }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };

  return <div className="workflow-v2-builder">
    <header className="workflow-page-heading">
      <div><button type="button" className="workflow-back-button" onClick={props.onCancel}>← Agent Workflows</button><h2>{props.initialTemplate ? "Edit agent workflow" : "New agent workflow"}</h2><p>Build orchestration with focused cards. Graph and JSON always reflect the same draft.</p></div>
      <div className="workflow-heading-actions"><button type="button" className="workflow-secondary-button" onClick={props.onCancel}>Cancel</button><button type="button" className="workflow-primary-button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save workflow"}</button></div>
    </header>
    <div className="workflow-v2-tabs" role="tablist" aria-label="Workflow views">
      {(["build", "graph", "json"] as View[]).map((item) => <button key={item} type="button" role="tab" aria-selected={view === item} className={view === item ? "is-active" : ""} onClick={() => setView(item)}>{item === "json" ? "JSON" : item[0]!.toUpperCase() + item.slice(1)}</button>)}
    </div>
    {view === "build" ? <div className="workflow-v2-build">
      <section className="workflow-v2-cards" aria-label="Workflow steps">
        <label className="workflow-field"><span>Workflow name</span><input value={definition.name} onChange={(event) => update({ ...definition, name: event.target.value })} /></label>
        {v2Cards(definition).map(({ step, role }, index) => <button type="button" key={step.id} className={`workflow-v2-step-card ${selected?.id === step.id ? "is-selected" : ""}`} aria-pressed={selected?.id === step.id} onClick={() => setSelectedStepId(step.id)}><span>Step {index + 1} · {roleTemplate(role).label}</span><strong>{step.name}</strong><small>{step.promptParts.find((part) => part.type === "text")?.text || "No instructions"}</small></button>)}
      </section>
      {selected ? <aside className="workflow-v2-inspector" aria-label="Selected step inspector"><h3>Step inspector</h3><label className="workflow-field"><span>Name</span><input value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} /></label><fieldset><legend>Role template</legend><div className="workflow-v2-roles">{workflowRoleTemplates.map((role) => <button key={role.id} type="button" aria-pressed={role.id === (v2Cards(definition).find((card) => card.step.id === selected.id)?.role)} onClick={() => updateSelected(withRole(selected, role.id as WorkflowRole))}>{role.label}</button>)}</div></fieldset><label className="workflow-field"><span>Instructions</span><textarea rows={10} value={selected.promptParts.find((part) => part.type === "text")?.text ?? ""} onChange={(event) => updateSelected({ promptParts: [{ type: "text", text: event.target.value }] })} /></label></aside> : null}
    </div> : null}
    {view === "graph" ? <section className="workflow-v2-graph" aria-label="Read-only workflow graph"><h3>Workflow graph</h3><p>This derived graph is read-only. Edit steps in Build.</p><ul>{definition.steps.map((step) => { const outgoing = edges.filter((edge) => edge.from === step.id); return <li key={step.id}><strong>{step.name}</strong><ul>{outgoing.length === 0 ? <li>No downstream step</li> : outgoing.map((edge) => <li key={`${edge.from}-${edge.to}-${edge.label}`}>{edge.label} → {definition.steps.find((item) => item.id === edge.to)?.name ?? edge.to}</li>)}</ul></li>; })}</ul></section> : null}
    {view === "json" ? <section className="workflow-v2-json"><h3>JSON draft</h3><p>Changes are not applied until validation succeeds.</p><textarea aria-label="Workflow JSON draft" rows={22} value={jsonDraft} onChange={(event) => { setJsonDraft(event.target.value); setJsonError(undefined); }} /><div className="workflow-form-actions"><button type="button" className="workflow-secondary-button" onClick={() => setJsonDraft(definitionJson(definition))}>Reset draft</button><button type="button" className="workflow-primary-button" onClick={applyJson}>Validate and apply</button></div>{jsonError ? <p className="workflow-error" role="alert">{jsonError}</p> : null}</section> : null}
    {saveError ? <p className="workflow-error" role="alert">{saveError}</p> : null}
  </div>;
}
