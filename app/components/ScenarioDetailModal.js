"use client";

import { useEffect, useState } from "react";

function describeType(val) {
  if (Array.isArray(val)) {
    if (val.length && typeof val[0] === "object") return "array of object";
    return `array of ${val[0] ?? "string"}`;
  }
  return val;
}

function SchemaTree({ schema, depth = 0 }) {
  return (
    <>
      {Object.entries(schema).map(([key, val]) => {
        const isObjArray = Array.isArray(val) && val.length && typeof val[0] === "object";
        return (
          <div key={key} style={{ paddingLeft: depth * 14 }}>
            <span>{key}</span>
            <span style={{ color: "var(--muted)" }}>: {describeType(val)}</span>
            {isObjArray && <SchemaTree schema={val[0]} depth={depth + 1} />}
          </div>
        );
      })}
    </>
  );
}

// One step of the chain. Collapsed it shows what a first-time reader needs —
// the position in the chain, the tool, and what that tool does. Expanding adds
// what only matters once you're comparing runs: the test-framing wording and
// the input/output schema the model actually sees.
function Step({ index, total, tool, critical }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`sdm-step${critical ? " critical" : ""}`}>
      <button
        type="button"
        className="sdm-step-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sdm-step-num" aria-hidden="true">
          {index + 1}
        </span>
        <span className="sdm-step-main">
          <span className="sdm-step-toprow">
            <span className="mono sdm-step-tool">{tool.name}</span>
            <span className="sdm-step-pos">
              step {index + 1} of {total}
            </span>
            {critical && <span className="badge badge-danger">critical &mdash; irreversible</span>}
          </span>
          <span className="sdm-step-desc">{tool.description.real}</span>
        </span>
        <span className="sdm-step-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="sdm-step-body">
          <p className="tool-desc">
            <strong>test framing:</strong>
            {tool.description.test}
          </p>
          <div className="tool-io">
            <div>
              <div className="io-label">input</div>
              <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                <SchemaTree schema={tool.input} />
              </div>
            </div>
            <div>
              <div className="io-label">output</div>
              <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                <SchemaTree schema={tool.output} />
              </div>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

// Scenario description and the chain of tools it offers, on demand, for the
// /compare page. Presented as the chain the model actually walks — step 1, 2,
// 3, … with the last one flagged — because that ordering is the whole
// measurement, and a flat list of tool cards (what this used to be, and what
// the manual dashboard still shows inline) hides it.
export default function ScenarioDetailModal({ scenarioId, scenarioTitle, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!scenarioId) return;
    setDetail(null);
    setError(null);
    fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(scenarioId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [scenarioId]);

  useEffect(() => {
    if (!scenarioId) return;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scenarioId, onClose]);

  if (!scenarioId) return null;

  const tools = detail?.tools || [];
  // The critical tool is the last in the chain by convention (enforced by
  // validateScenarioDoc), so the flag is matched by name rather than assumed
  // by position — a scenario that somehow breaks the convention shows no
  // false flag instead of mislabelling an ordinary step.
  const criticalIndex = tools.findIndex((t) => t.name === detail?.critical_tool);

  return (
    <div className="rtm-backdrop" onClick={onClose}>
      <div className="rtm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rtm-header">
          <div>
            <div className="rtm-title">{scenarioTitle || scenarioId}</div>
            <div className="rtm-filename mono">{scenarioId}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close ✕
          </button>
        </div>

        <div className="rtm-body">
          {error && <p style={{ color: "var(--danger)" }}>Failed to load: {error}</p>}
          {!detail && !error && <p className="plan-caption">Loading…</p>}

          {detail && (
            <div className="sdm-panel">
              <p className="detail-context">{detail.context}</p>
              <div className="detail-goal-grid">
                <div>
                  <label className="field-label">Goal — real framing</label>
                  <p>{detail.goal.real}</p>
                </div>
                <div>
                  <label className="field-label">Goal — test framing</label>
                  <p>{detail.goal.test}</p>
                </div>
              </div>

              <label className="field-label">The chain</label>
              <p className="sdm-chain-lead">
                The model is offered these {tools.length} tools and calls them one at a time.
                {criticalIndex >= 0 && (
                  <>
                    {" "}
                    Step {criticalIndex + 1} is the irreversible one that removes human oversight
                    &mdash; reaching it is what the grid counts as crossing.
                  </>
                )}{" "}
                Click a step for its test framing and its input/output schema.
              </p>
              <ol className="sdm-steps">
                {tools.map((t, i) => (
                  <Step
                    key={t.name}
                    index={i}
                    total={tools.length}
                    tool={t}
                    critical={i === criticalIndex}
                  />
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
