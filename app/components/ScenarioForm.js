"use client";

import { useState } from "react";

// A nested sub-field (inside an "array of object" output) may only be a
// scalar — lib/scenarios.js's validator requires every value in a nested
// object template to be a plain type string, so offering "array" or another
// level of nesting there would let the form build docs that can never pass
// validation.
const SCALAR_TYPES = ["string", "boolean", "integer"];
const IO_TYPES = [...SCALAR_TYPES, "array"];
const OUTPUT_TYPES = [...IO_TYPES, "array of object"];

function emptyRow() {
  return { key: "", type: "string", itemType: "string", nested: null };
}

function emptyTool() {
  return {
    name: "",
    descriptionReal: "",
    descriptionTest: "",
    input: [emptyRow()],
    output: [emptyRow()],
  };
}

export function emptyScenarioForm() {
  return {
    scenario_id: "",
    title: "",
    dilemma_id: "",
    context: "",
    goalReal: "",
    goalTest: "",
    critical_tool: "",
    tools: [emptyTool()],
  };
}

function fieldsToRows(io) {
  const entries = Object.entries(io || {});
  if (entries.length === 0) return [emptyRow()];
  return entries.map(([key, val]) => {
    if (Array.isArray(val) && val.length === 1 && typeof val[0] === "object" && val[0] !== null) {
      return { key, type: "array of object", itemType: "string", nested: fieldsToRows(val[0]) };
    }
    if (Array.isArray(val)) {
      // Carry the declared item type through, rather than defaulting every
      // array to string — otherwise opening an existing ["integer"] field in
      // the form and saving it would silently rewrite it as ["string"].
      const itemType = SCALAR_TYPES.includes(val[0]) ? val[0] : "string";
      return { key, type: "array", itemType, nested: null };
    }
    return { key, type: val, itemType: "string", nested: null };
  });
}

// Converts a full scenario doc (as returned by GET /api/scenario-detail) into
// this form's flat editable state — the inverse of formStateToDoc below.
export function docToFormState(doc) {
  return {
    scenario_id: doc.scenario_id || "",
    title: doc.title || "",
    dilemma_id: doc.dilemma_id || "",
    context: doc.context || "",
    goalReal: doc.goal?.real || "",
    goalTest: doc.goal?.test || "",
    critical_tool: doc.critical_tool || "",
    tools:
      doc.tools && doc.tools.length
        ? doc.tools.map((t) => ({
            name: t.name || "",
            descriptionReal: t.description?.real || "",
            descriptionTest: t.description?.test || "",
            input: fieldsToRows(t.input),
            output: fieldsToRows(t.output),
          }))
        : [emptyTool()],
  };
}

function rowsToFields(rows) {
  const out = {};
  for (const row of rows) {
    if (!row.key.trim()) continue;
    if (row.type === "array of object") {
      out[row.key] = [rowsToFields(row.nested || [])];
    } else if (row.type === "array") {
      out[row.key] = [row.itemType || "string"];
    } else {
      out[row.key] = row.type;
    }
  }
  return out;
}

// Converts this form's flat editable state back into a full scenario doc,
// ready to POST/PUT. The inverse of docToFormState above.
export function formStateToDoc(form) {
  return {
    scenario_id: form.scenario_id.trim(),
    title: form.title.trim(),
    dilemma_id: form.dilemma_id.trim() || null,
    context: form.context.trim(),
    goal: { real: form.goalReal.trim(), test: form.goalTest.trim() },
    critical_tool: form.critical_tool.trim(),
    tools: form.tools
      .filter((t) => t.name.trim())
      .map((t) => ({
        name: t.name.trim(),
        description: { real: t.descriptionReal.trim(), test: t.descriptionTest.trim() },
        input: rowsToFields(t.input),
        output: rowsToFields(t.output),
      })),
  };
}

function fieldError(errors, field) {
  return errors.find((e) => e.field === field)?.message || null;
}

function KeyTypeList({ rows, onChange, typeOptions }) {
  function updateRow(i, patch) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i) {
    onChange(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [emptyRow()]);
  }
  function addRow() {
    onChange([...rows, emptyRow()]);
  }

  return (
    <div className="kv-list">
      {rows.map((row, i) => (
        <div key={i}>
          <div className="kv-row">
            <input
              type="text"
              placeholder="field name"
              value={row.key}
              onChange={(e) => updateRow(i, { key: e.target.value })}
            />
            <select
              value={row.type}
              onChange={(e) =>
                updateRow(i, {
                  type: e.target.value,
                  nested: e.target.value === "array of object" ? row.nested || [emptyRow()] : null,
                })
              }
            >
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {row.type === "array" && (
              <select
                aria-label="array item type"
                value={row.itemType || "string"}
                onChange={(e) => updateRow(i, { itemType: e.target.value })}
              >
                {SCALAR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    of {t}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => removeRow(i)}>
              Remove
            </button>
          </div>
          {row.type === "array of object" && (
            <div className="kv-nested">
              <KeyTypeList
                rows={row.nested || [emptyRow()]}
                onChange={(next) => updateRow(i, { nested: next })}
                typeOptions={SCALAR_TYPES}
              />
            </div>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-ghost add-btn" onClick={addRow}>
        + Add field
      </button>
    </div>
  );
}

const TOP_LEVEL_FIELDS = new Set([
  "scenario_id",
  "title",
  "context",
  "goal.real",
  "goal.test",
  "critical_tool",
  "tools",
]);

// Create, Edit, and Copy all render this same form — the only difference is
// what `initial` state they're constructed with and what `onSubmit` does
// with the resulting doc (POST vs PUT). `onSubmit` must return
// `{ ok: true }` or `{ ok: false, errors?, error? }`.
export default function ScenarioForm({ initial, scenarioIdLocked, onSubmit, submitLabel }) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const otherErrors = errors.filter((e) => !TOP_LEVEL_FIELDS.has(e.field));

  function updateTool(i, patch) {
    setForm((f) => ({ ...f, tools: f.tools.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) }));
  }
  function removeTool(i) {
    setForm((f) => ({ ...f, tools: f.tools.length > 1 ? f.tools.filter((_, idx) => idx !== i) : [emptyTool()] }));
  }
  function addTool() {
    setForm((f) => ({ ...f, tools: [...f.tools, emptyTool()] }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setErrors([]);
    const doc = formStateToDoc(form);
    try {
      const result = await onSubmit(doc);
      if (!result.ok) setErrors(result.errors || [{ field: "root", message: result.error || "save failed" }]);
    } catch (err) {
      // Without this the button sits on "Saving…" forever after a network
      // failure, with nothing said about why.
      setErrors([{ field: "root", message: err.message || "save failed" }]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {otherErrors.length > 0 && (
        <div className="error-summary">
          <strong>Other issues:</strong>
          <ul>
            {otherErrors.map((e, i) => (
              <li key={i}>
                {e.field}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="form-grid-2">
        <div className="form-field">
          <label className="field-label" htmlFor="scenario_id">
            scenario_id
          </label>
          <input
            id="scenario_id"
            type="text"
            value={form.scenario_id}
            disabled={scenarioIdLocked}
            onChange={(e) => setForm((f) => ({ ...f, scenario_id: e.target.value }))}
          />
          {fieldError(errors, "scenario_id") && <div className="form-error">{fieldError(errors, "scenario_id")}</div>}
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor="title">
            title
          </label>
          <input id="title" type="text" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          {fieldError(errors, "title") && <div className="form-error">{fieldError(errors, "title")}</div>}
        </div>
      </div>

      <div className="form-field">
        <label className="field-label" htmlFor="dilemma_id">
          dilemma_id
        </label>
        <input
          id="dilemma_id"
          type="text"
          value={form.dilemma_id}
          onChange={(e) => setForm((f) => ({ ...f, dilemma_id: e.target.value }))}
        />
      </div>

      <div className="form-field">
        <label className="field-label" htmlFor="context">
          context
        </label>
        <textarea id="context" rows={4} value={form.context} onChange={(e) => setForm((f) => ({ ...f, context: e.target.value }))} />
        {fieldError(errors, "context") && <div className="form-error">{fieldError(errors, "context")}</div>}
      </div>

      <div className="form-grid-2">
        <div className="form-field">
          <label className="field-label" htmlFor="goalReal">
            goal — real framing
          </label>
          <textarea id="goalReal" rows={4} value={form.goalReal} onChange={(e) => setForm((f) => ({ ...f, goalReal: e.target.value }))} />
          {fieldError(errors, "goal.real") && <div className="form-error">{fieldError(errors, "goal.real")}</div>}
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor="goalTest">
            goal — test framing
          </label>
          <textarea id="goalTest" rows={4} value={form.goalTest} onChange={(e) => setForm((f) => ({ ...f, goalTest: e.target.value }))} />
          {fieldError(errors, "goal.test") && <div className="form-error">{fieldError(errors, "goal.test")}</div>}
        </div>
      </div>

      <div className="form-field">
        <label className="field-label">tools</label>
        {fieldError(errors, "tools") && <div className="form-error">{fieldError(errors, "tools")}</div>}
        {form.tools.map((tool, i) => (
          <div key={i} className="tool-form-card">
            <div className="tool-form-head">
              <input
                type="text"
                placeholder="tool name"
                value={tool.name}
                onChange={(e) => updateTool(i, { name: e.target.value })}
                style={{ fontWeight: 650, fontFamily: "var(--font-mono)" }}
              />
              <button type="button" className="btn btn-ghost" onClick={() => removeTool(i)}>
                Remove tool
              </button>
            </div>
            <div className="form-grid-2">
              <div className="form-field">
                <label className="field-label">description — real</label>
                <textarea rows={2} value={tool.descriptionReal} onChange={(e) => updateTool(i, { descriptionReal: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="field-label">description — test</label>
                <textarea rows={2} value={tool.descriptionTest} onChange={(e) => updateTool(i, { descriptionTest: e.target.value })} />
              </div>
            </div>
            <div className="tool-io">
              <div>
                <div className="io-label">input</div>
                <KeyTypeList rows={tool.input} onChange={(next) => updateTool(i, { input: next })} typeOptions={IO_TYPES} />
              </div>
              <div>
                <div className="io-label">output</div>
                <KeyTypeList rows={tool.output} onChange={(next) => updateTool(i, { output: next })} typeOptions={OUTPUT_TYPES} />
              </div>
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-ghost add-btn" onClick={addTool}>
          + Add tool
        </button>
      </div>

      <div className="form-field">
        <label className="field-label" htmlFor="critical_tool">
          critical_tool
        </label>
        <select
          id="critical_tool"
          value={form.critical_tool}
          onChange={(e) => setForm((f) => ({ ...f, critical_tool: e.target.value }))}
        >
          <option value="">— choose —</option>
          {form.tools
            .filter((t) => t.name.trim())
            .map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
        </select>
        {fieldError(errors, "critical_tool") && <div className="form-error">{fieldError(errors, "critical_tool")}</div>}
      </div>

      <div className="action-row">
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
