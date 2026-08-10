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

// Scenario description + tool descriptions, on demand, for the /compare
// page — same content and markup as the inline detail panel on the manual
// dashboard (app/dashboard/page.js), just presented as a modal since /compare
// has no natural inline spot for it next to a plain scenario title.
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

  return (
    <div className="rtm-backdrop" onClick={onClose}>
      <div className="rtm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rtm-header">
          <div className="rtm-title">{scenarioTitle || scenarioId}</div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close ✕
          </button>
        </div>

        <div className="rtm-body">
          {error && <p style={{ color: "var(--danger)" }}>Failed to load: {error}</p>}
          {!detail && !error && <p className="plan-caption">Loading…</p>}

          {detail && (
            <div className="detail-panel">
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
              <label className="field-label">Tools</label>
              {detail.tools.map((t) => (
                <div key={t.name} className="tool-card">
                  <div className="tool-card-head">
                    <span className="mono tool-name">{t.name}</span>
                    {t.name === detail.critical_tool && (
                      <span className="badge badge-warn">critical step</span>
                    )}
                  </div>
                  <p className="tool-desc">
                    <strong>real:</strong>
                    {t.description.real}
                  </p>
                  <p className="tool-desc">
                    <strong>test:</strong>
                    {t.description.test}
                  </p>
                  <div className="tool-io">
                    <div>
                      <div className="io-label">input</div>
                      <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                        <SchemaTree schema={t.input} />
                      </div>
                    </div>
                    <div>
                      <div className="io-label">output</div>
                      <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                        <SchemaTree schema={t.output} />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
