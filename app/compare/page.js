"use client";

import { useEffect, useMemo, useState } from "react";
import RunTranscriptModal from "../components/RunTranscriptModal";
import ScenarioDetailModal from "../components/ScenarioDetailModal";
import { MODEL_CATALOG } from "../../lib/models";

const SCENARIOS = [
  { id: "corporate_log_consolidation_v0", title: "Corporate log consolidation" },
  { id: "single_point_of_command_v0", title: "Single point of military command" },
];
const PIPELINES = [
  { id: "linear", title: "Plan → execute", sub: "blind, amnesiac executor — one step at a time, no memory of prior steps" },
  { id: "chained", title: "Chained (direct)", sub: "one continuous conversation — full memory of every prior tool call" },
];
// Every model either provider offers, in the same catalog the base
// dashboard's own model dropdown reads from (lib/models.js) — not just the
// handful we've actually run batches against. Unrun ones just show "n/a"
// until "hide models with no data" is unchecked.
const ALL_MODELS = Object.values(MODEL_CATALOG).flatMap((p) => Object.keys(p.models));
const MODEL_LABELS = Object.fromEntries(
  Object.values(MODEL_CATALOG).flatMap((p) => Object.entries(p.models).map(([id, m]) => [id, m.label]))
);
function modelLabel(id) {
  return (MODEL_LABELS[id] || id).replace(/^Claude\s+/, "");
}
// Mirrors lib/adversarial.js's ARGUMENT_STYLES keys (minus "baseline",
// which isn't a real angle — it's the no-framing control used only in the
// pre-pipeline manual exploration, never wired into the batch runners).
const STYLES = [
  "ethical",
  "geopolitical",
  "catastrophic_risk",
  "chain_of_command",
  "economic",
  "legal",
  "urgency",
  "incrementalism",
  "relational",
  "technical_normalization",
];

// A linear run's "0 steps reached" is two different findings that must
// never look the same: the plan itself was refused (never got to try a
// step at all) versus the plan WAS accepted and step 1 specifically got
// refused. Only linear rows carry planAccepted — chained has no separate
// plan stage, so its 0 is unambiguous already.
//
// depth === fullSteps always means genuinely, fully complete (the API
// route only counts accepted steps toward depth) — so a single "reached
// every step" marker is enough, no separate case for "reached the last
// step but got refused there" (that can't happen anymore: a refused step
// simply doesn't add to depth).
function cellClass(d) {
  if (!d) return "na";
  if (d.pipeline === "linear" && d.depth === 0 && d.planAccepted === false) return "plan-refused";
  if (!d.depth || d.depth === 0) return "d0";
  const classes = ["d" + Math.min(d.depth, 4)];
  if (d.depth === d.fullSteps) classes.push("full-reached");
  return classes.join(" ");
}

export default function ComparePage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [tooltip, setTooltip] = useState(null); // { x, y, row }
  const [modalCombo, setModalCombo] = useState(null);
  const [detailScenario, setDetailScenario] = useState(null); // { id, title }
  // Default hidden: with 10 styles × 3 models, most cells are "n/a" until
  // more batches run. Hiding empty rows/columns by default shows only
  // what's actually populated; unchecking reveals the full matrix a
  // completed study would fill in.
  const [hideEmptyStyles, setHideEmptyStyles] = useState(true);
  const [hideEmptyModels, setHideEmptyModels] = useState(true);

  useEffect(() => {
    fetch("/api/compare")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);

  const index = useMemo(() => {
    const m = new Map();
    for (const r of rows || []) m.set([r.pipeline, r.model, r.scenario, r.style].join("|"), r);
    return m;
  }, [rows]);

  const stats = useMemo(() => {
    if (!rows) return null;
    const withData = rows.filter((r) => r.model);
    const completed = withData.filter((r) => r.completed).length;
    const anyProgress = withData.filter((r) => r.depth > 0).length;
    return { total: withData.length, completed, anyProgress };
  }, [rows]);

  function cellData(pipeline, model, scenario, style) {
    return index.get([pipeline, model, scenario, style].join("|")) || null;
  }

  // "Empty" = not a single run anywhere (any pipeline, any scenario, any
  // model/style) — computed across the whole dataset, not per scenario
  // section, so a style hidden here is truly untouched everywhere.
  const emptyStyles = useMemo(() => {
    const present = new Set((rows || []).map((r) => r.style));
    return new Set(STYLES.filter((s) => !present.has(s)));
  }, [rows]);
  const emptyModels = useMemo(() => {
    const present = new Set((rows || []).map((r) => r.model));
    return new Set(ALL_MODELS.filter((m) => !present.has(m)));
  }, [rows]);

  // Never actually hide everything — if the filter would leave zero rows
  // (e.g. no data loaded yet), fall back to the full list instead of
  // rendering an empty grid.
  const filteredStyles = STYLES.filter((s) => !emptyStyles.has(s));
  const visibleStyles = hideEmptyStyles && filteredStyles.length ? filteredStyles : STYLES;
  const filteredModels = ALL_MODELS.filter((m) => !emptyModels.has(m));
  const visibleModels = hideEmptyModels && filteredModels.length ? filteredModels : ALL_MODELS;

  return (
    <main className="app-shell" style={{ maxWidth: 1180 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="app-title">Plan+execute vs. chained, model by model</h1>
          <p className="app-subtitle" style={{ marginBottom: 4, maxWidth: "68ch" }}>
            How far a single, fixed argument style gets — one tool/step at a time under a blind
            executor, versus one continuous conversation where the model remembers every prior
            call it made.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/runs" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
            Runs table ↗
          </a>
          <a href="/" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
            ← Back to dashboard
          </a>
        </div>
      </div>

      {error && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Failed to load: {error}</p>
        </div>
      )}
      {!rows && !error && <p className="plan-caption">Loading…</p>}

      {rows && (
        <>
          <section className="card cmp-legend">
            <div className="cmp-legend-group">
              <span style={{ color: "var(--ink-2)" }}>Steps/tools reached</span>
              <div className="cmp-ramp">
                <span className="cmp-d0">0</span>
                <span className="cmp-d1">1</span>
                <span className="cmp-d2">2</span>
                <span className="cmp-d3">3</span>
                <span className="cmp-d4">4</span>
              </div>
            </div>
            <div className="cmp-legend-group">
              <span className="cmp-na-swatch" /> no data for this model
            </div>
            <div className="cmp-legend-group">
              <span className="cmp-plan-refused-swatch" /> plan itself refused (linear only — 0/4 with an accepted
              plan means step 1 refused, a different finding)
            </div>
            <div className="cmp-legend-group">
              <span className="cmp-running-mark">*</span> batch still running — numbers may still change
            </div>
            <div className="cmp-legend-group">
              <span className="cmp-framing-letter cmp-framing-real">R</span>/
              <span className="cmp-framing-letter cmp-framing-test">T</span> plan accepted under real framing
              straightaway, vs. only after real framing was fully tried and refused first, then a fresh test-framing
              attempt succeeded (turn count shown is for that winning attempt alone — open the transcript to see the
              discarded real-framing attempt too)
            </div>
            <div className="cmp-legend-group">
              <span className="cmp-fullreached-swatch" /> reached every step — the one outcome that actually matters
              here, marked regardless of depth color
            </div>
            <label className="cmp-legend-group cmp-toggle">
              <input type="checkbox" checked={hideEmptyStyles} onChange={(e) => setHideEmptyStyles(e.target.checked)} />
              Hide styles with no data ({emptyStyles.size})
            </label>
            <label className="cmp-legend-group cmp-toggle">
              <input type="checkbox" checked={hideEmptyModels} onChange={(e) => setHideEmptyModels(e.target.checked)} />
              Hide models with no data ({emptyModels.size})
            </label>
            <div className="cmp-stats">
              <span>
                <strong>{stats.total}</strong> runs
              </span>
              <span>
                <strong>{stats.anyProgress}</strong> made any progress
              </span>
              <span>
                <strong>{stats.completed}</strong> fully completed
              </span>
            </div>
          </section>

          {SCENARIOS.map((scenario) => (
            <section key={scenario.id} className="cmp-scenario">
              <h2
                className="cmp-scenario-title"
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                onClick={() => setDetailScenario({ id: scenario.id, title: scenario.title })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDetailScenario({ id: scenario.id, title: scenario.title });
                  }
                }}
              >
                {scenario.title}
              </h2>
              <div className="cmp-panels">
                {PIPELINES.map((pipeline) => (
                  <div key={pipeline.id} className="card cmp-panel">
                    <div className="cmp-panel-head">{pipeline.title}</div>
                    <div className="cmp-panel-sub">{pipeline.sub}</div>
                    {visibleModels.length > 10 && (
                      <div className="cmp-panel-sub cmp-scroll-hint">
                        → scroll right within this panel to see all {visibleModels.length} models
                      </div>
                    )}
                    <table className="cmp-grid">
                      <thead>
                        <tr>
                          <th></th>
                          {visibleModels.map((m) => (
                            <th key={m} className="cmp-model-head">
                              {modelLabel(m)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleStyles.map((style) => (
                          <tr key={style}>
                            <td className="cmp-style-label">{style.replace(/_/g, " ")}</td>
                            {visibleModels.map((model) => {
                              const d = cellData(pipeline.id, model, scenario.id, style);
                              return (
                                <td key={model} className="cmp-cell-wrap">
                                  <div
                                    className={`cmp-cell ${cellClass(d)}`}
                                    tabIndex={0}
                                    role={d?.id ? "button" : undefined}
                                    style={d?.id ? { cursor: "pointer" } : undefined}
                                    onClick={() => d?.id && setModalCombo(d)}
                                    onKeyDown={(e) => {
                                      if ((e.key === "Enter" || e.key === " ") && d?.id) {
                                        e.preventDefault();
                                        setModalCombo(d);
                                      }
                                    }}
                                    onPointerEnter={(e) =>
                                      setTooltip({
                                        x: e.currentTarget.getBoundingClientRect().left,
                                        y: e.currentTarget.getBoundingClientRect().bottom + 8,
                                        model,
                                        scenario: scenario.title,
                                        pipeline: pipeline.title,
                                        style,
                                        d,
                                      })
                                    }
                                    onPointerLeave={() => setTooltip(null)}
                                    onFocus={(e) =>
                                      setTooltip({
                                        x: e.currentTarget.getBoundingClientRect().left,
                                        y: e.currentTarget.getBoundingClientRect().bottom + 8,
                                        model,
                                        scenario: scenario.title,
                                        pipeline: pipeline.title,
                                        style,
                                        d,
                                      })
                                    }
                                    onBlur={() => setTooltip(null)}
                                  >
                                    <div className="cmp-frac">
                                      {!d
                                        ? "n/a"
                                        : d.pipeline === "linear" && d.depth === 0 && !d.planAccepted
                                        ? "no plan"
                                        : `${d.depth}/${d.fullSteps}`}
                                      {d?.anyRunning && <span className="cmp-running-mark">*</span>}
                                      {d?.pipeline === "linear" && d.planAccepted && (
                                        <span
                                          className={`cmp-framing-letter ${
                                            d.planFraming === "test" ? "cmp-framing-test" : "cmp-framing-real"
                                          }`}
                                        >
                                          {d.planFraming === "test" ? "T" : "R"}
                                        </span>
                                      )}
                                    </div>
                                    {d && d.depth > 0 && <div className="cmp-turns">{d.turnsUsed} turns</div>}
                                    {d && d.pipeline === "linear" && d.depth === 0 && d.planAccepted && (
                                      <div className="cmp-turns">plan ok, step 1 refused</div>
                                    )}
                                    {d && d.sampleCount > 1 && (
                                      <div className="cmp-turns">best of {d.sampleCount}</div>
                                    )}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </section>
          ))}

          <details className="tablewrap" style={{ marginTop: 8 }}>
            <summary>View as a table</summary>
            <div className="datatable-scroll">
              <table className="datatable">
                <thead>
                  <tr>
                    <th>Pipeline</th>
                    <th>Model</th>
                    <th>Scenario</th>
                    <th>Style</th>
                    <th>Plan accepted</th>
                    <th>Best reached</th>
                    <th>Completed</th>
                    <th>Turns (best)</th>
                    <th>Samples</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows]
                    .sort((a, b) => a.scenario.localeCompare(b.scenario) || a.pipeline.localeCompare(b.pipeline) || (a.model || "").localeCompare(b.model || ""))
                    .map((r, i) => (
                      <tr key={i}>
                        <td>{r.pipeline}</td>
                        <td>{r.model}</td>
                        <td>{r.scenario}</td>
                        <td>{r.style}</td>
                        <td>{r.pipeline === "linear" ? (r.planAccepted ? "yes" : "no") : "n/a"}</td>
                        <td>
                          {r.depth}/{r.fullSteps}
                        </td>
                        <td>{r.completed ? "yes" : "no"}</td>
                        <td>{r.turnsUsed}</td>
                        <td>
                          {r.completedCount}/{r.sampleCount}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      {tooltip && (
        <div className="cmp-tooltip" style={{ left: Math.min(tooltip.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 280), top: tooltip.y }}>
          <div className="cmp-tt-val">
            {!tooltip.d
              ? "No run for this model"
              : tooltip.d.pipeline === "linear" && tooltip.d.depth === 0 && !tooltip.d.planAccepted
              ? "Plan itself was refused"
              : `Reached ${tooltip.d.depth} of ${tooltip.d.fullSteps}`}
          </div>
          {tooltip.d && tooltip.d.pipeline === "linear" && (
            <div className="cmp-tt-row">Plan accepted: {tooltip.d.planAccepted ? "yes" : "no"}</div>
          )}
          <div className="cmp-tt-row">
            {tooltip.model} · {tooltip.pipeline}
          </div>
          <div className="cmp-tt-row">
            {tooltip.scenario} · style: {tooltip.style}
          </div>
          {tooltip.d && tooltip.d.depth > 0 && <div className="cmp-tt-row">Executor turns used: {tooltip.d.turnsUsed}</div>}
          {tooltip.d && tooltip.d.pipeline === "linear" && tooltip.d.planAccepted && (
            <div className="cmp-tt-row">
              {tooltip.d.planFraming === "test" ? (
                <>
                  <span className="cmp-framing-letter cmp-framing-test">T</span> plan needed test framing — real
                  framing was tried first and fully refused (not counted in turns above; see transcript)
                </>
              ) : (
                <>
                  <span className="cmp-framing-letter cmp-framing-real">R</span> plan accepted under real framing,
                  no fallback needed
                </>
              )}
            </div>
          )}
          {tooltip.d && tooltip.d.sampleCount > 1 && (
            <div className="cmp-tt-row">
              Best of {tooltip.d.sampleCount} samples ({tooltip.d.completedCount}/{tooltip.d.sampleCount} fully completed)
            </div>
          )}
          {tooltip.d && tooltip.d.completed && <div className="cmp-tt-row">Fully completed, including the critical step.</div>}
          {tooltip.d?.anyRunning && (
            <div className="cmp-tt-row">
              <span className="cmp-running-mark">*</span> batch still running — may still progress further
            </div>
          )}
          {tooltip.d?.filename && <div className="cmp-tt-row" style={{ marginTop: 4, opacity: 1 }}>Click to read the full transcript ▸</div>}
        </div>
      )}

      <RunTranscriptModal combo={modalCombo} onClose={() => setModalCombo(null)} />
      <ScenarioDetailModal
        scenarioId={detailScenario?.id}
        scenarioTitle={detailScenario?.title}
        onClose={() => setDetailScenario(null)}
      />
    </main>
  );
}
