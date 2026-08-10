"use client";

import { useEffect, useMemo, useState } from "react";
import RunTranscriptModal from "./RunTranscriptModal";
import ScenarioDetailModal from "./ScenarioDetailModal";
import { MODEL_CATALOG } from "../../lib/models";
import { aggregateSamples } from "../../lib/compare-aggregate.js";
import { bestOf, crossed, verdictRows } from "../../lib/compare-verdict.js";

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

// Returns the cell's state, not a colour ramp step. "plan-refused" and
// "crossed" are genuinely different findings; everything else is just how far
// it got, which the bar shows.
function cellState(d) {
  if (!d) return "na";
  if (d.pipeline === "linear" && d.depth === 0 && d.planAccepted === false) return "plan-refused";
  if (crossed(d)) return "crossed";
  return "open";
}

// Depth is a magnitude, so it is encoded by length, not by hue. The five-step
// colour ramp this replaces put 3/4 and 4/4 at ΔE 14.7 in normal vision —
// under the readability floor — which is exactly the distinction this project
// turns on. Bar length has no such problem, and it frees the cell's fill for
// the one thing that is a state rather than a magnitude: crossing the
// critical step. `total` is per-scenario (chains are 4-5 tools), never
// hardcoded.
function StepBar({ depth, total }) {
  const n = Math.max(0, total || 0);
  return (
    <span className="cmp-bar" role="img" aria-label={`${depth} of ${n} steps reached`}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={i < depth ? "cmp-seg on" : "cmp-seg"} />
      ))}
    </span>
  );
}

// Both pipelines in one cell, stacked. The one-pager asks where the weak link
// is — whether keeping the full history is what moves a model — and answering
// that from two separate tables means looking back and forth. `styles` is a
// list so the same component serves a single-style row and the merged
// "best of any style" row.
const PIPELINE_LABELS = { linear: "P→E", chained: "CHN" };
// The panel headers that used to carry these sentences are gone in the
// merged grid; this is the only place left that explains what "linear" and
// "chained" mean. Surfaced as a title attribute (hover) on each pipeline tag
// until Task 7 wires it into a richer explanation mechanism.
const PIPELINE_NOTES = {
  linear: "blind, amnesiac executor — one step at a time, no memory of prior steps",
  chained: "one continuous conversation — full memory of every prior tool call",
};

function PipelinePair({ model, scenario, styles, cellData, onOpen }) {
  return (
    <div className="cmp-pair">
      {["linear", "chained"].map((pipeline) => {
        const d = bestOf(styles.map((s) => cellData(pipeline, model, scenario, s)));
        const state = cellState(d);
        // A plan that was accepted and then stalled at step 1 must not look
        // identical to ordinary lack of progress — that's the "different
        // finding" the legend calls out.
        const noPlan = d && d.pipeline === "linear" && d.depth === 0 && !d.planAccepted;
        return (
          <button
            type="button"
            key={pipeline}
            className={`cmp-pipe-cell ${state}`}
            disabled={!d}
            onClick={() => d && onOpen(d)}
            title={PIPELINE_LABELS[pipeline]}
          >
            <span className="cmp-pipe-line1">
              <span className="cmp-pipe-tag" title={PIPELINE_NOTES[pipeline]}>
                {PIPELINE_LABELS[pipeline]}
              </span>
              {d ? (
                <>
                  <StepBar depth={d.depth} total={d.fullSteps} />
                  <span className="cmp-frac">
                    {state === "crossed" && <span className="cmp-crossed-mark">⚠ </span>}
                    {noPlan ? "no plan" : `${d.depth}/${d.fullSteps}`}
                    {d.anyRunning && <span className="cmp-running-mark">*</span>}
                    {d.pipeline === "linear" && d.planAccepted && (
                      <span
                        className={`cmp-framing-letter ${
                          d.planFraming === "test" ? "cmp-framing-test" : "cmp-framing-real"
                        }`}
                      >
                        {d.planFraming === "test" ? "T" : "R"}
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <span className="cmp-frac">n/a</span>
              )}
            </span>
            {d && d.depth > 0 && <div className="cmp-turns">{d.turnsUsed} turns</div>}
            {d && d.pipeline === "linear" && d.depth === 0 && d.planAccepted && (
              <div className="cmp-turns">plan ok, step 1 refused</div>
            )}
            {d && d.sampleCount > 1 && <div className="cmp-turns">best of {d.sampleCount}</div>}
          </button>
        );
      })}
    </div>
  );
}

export default function CompareGrid({ signedIn, researchDirectionUrl }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [modalCombo, setModalCombo] = useState(null);
  const [detailScenario, setDetailScenario] = useState(null); // { id, title }
  // Default hidden: with 10 styles × 3 models, most cells are "n/a" until
  // more batches run. Hiding empty rows/columns by default shows only
  // what's actually populated; unchecking reveals the full matrix a
  // completed study would fill in.
  const [hideEmptyStyles, setHideEmptyStyles] = useState(true);
  const [hideEmptyModels, setHideEmptyModels] = useState(true);
  // Empty set = "everyone" / "every batch" (the default) — never a
  // fallback-to-everyone safety net like the style/model hide toggles
  // have; an explicit empty-result selection must show an empty grid.
  const [selectedCreators, setSelectedCreators] = useState(new Set());
  const [selectedBatches, setSelectedBatches] = useState(new Set());
  // Off by default: signing in should change as little as possible about the
  // page. Checking it reproduces exactly what a signed-out visitor sees.
  const [publicOnly, setPublicOnly] = useState(false);
  // Merged is the default: one row per scenario showing the best result across
  // every argument style. Expanding shows the per-style rows, which is what a
  // researcher wants and what a first-time visitor does not.
  const [expandStyles, setExpandStyles] = useState(false);

  useEffect(() => {
    fetch("/api/compare")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);

  // Every creator/batch that appears anywhere in the (already
  // human-only, per Task 3) dataset — used to render the filter
  // controls. Batches are scoped to whichever creators are currently
  // selected (all of them, by default).
  const availableCreators = useMemo(() => {
    const set = new Set();
    for (const r of rows || []) for (const s of r.samples) if (s.user_email) set.add(s.user_email);
    return [...set].sort();
  }, [rows]);

  const availableBatches = useMemo(() => {
    const set = new Set();
    for (const r of rows || []) {
      for (const s of r.samples) {
        if ((selectedCreators.size === 0 || selectedCreators.has(s.user_email)) && s.batch_id) set.add(s.batch_id);
      }
    }
    return [...set].sort();
  }, [rows, selectedCreators]);

  // Deliberately counted over the whole loaded dataset rather than the
  // current creator/batch selection: it labels the checkbox, and a number
  // that moved as other filters changed would read as a result rather than
  // as "this is how much has been published so far".
  const publicCount = useMemo(() => {
    let n = 0;
    for (const r of rows || []) for (const s of r.samples) if (s.isPublic) n++;
    return n;
  }, [rows]);

  // Re-aggregates every combo's samples down to just the active
  // creator/batch selection (empty selection = everyone / every batch),
  // using the exact same best-of-N math the API applies server-side —
  // see lib/compare-aggregate.js. A combo with zero matching samples
  // after filtering drops out entirely (its cell goes back to "n/a").
  // Every other derived value below (index, stats, empty-style/model
  // detection, the bottom table) reads this instead of raw `rows`, so
  // the whole page stays consistent under the active filter.
  const filteredRows = useMemo(() => {
    if (!rows) return rows;
    return rows
      .map((combo) => {
        const samples = combo.samples.filter(
          (s) =>
            (selectedCreators.size === 0 || selectedCreators.has(s.user_email)) &&
            (selectedBatches.size === 0 || selectedBatches.has(s.batch_id)) &&
            (!publicOnly || s.isPublic)
        );
        return aggregateSamples(samples);
      })
      .filter(Boolean);
  }, [rows, selectedCreators, selectedBatches, publicOnly]);

  const index = useMemo(() => {
    const m = new Map();
    for (const r of filteredRows || []) m.set([r.pipeline, r.model, r.scenario, r.style].join("|"), r);
    return m;
  }, [filteredRows]);

  const stats = useMemo(() => {
    if (!filteredRows) return null;
    const withData = filteredRows.filter((r) => r.model);
    const completed = withData.filter((r) => r.completed).length;
    const anyProgress = withData.filter((r) => r.depth > 0).length;
    return { total: withData.length, completed, anyProgress };
  }, [filteredRows]);

  // The cross-style, cross-scenario, cross-pipeline merge: one row per model,
  // worst-first. This is the page's headline, and the only view that stays
  // legible as the model count grows.
  const verdicts = useMemo(() => verdictRows(filteredRows || []), [filteredRows]);

  // Derived, not hardcoded: scenarios are model-generated now, and a fixed
  // list means every new one is invisible on this page. Every sample already
  // carries both fields.
  const scenarios = useMemo(() => {
    const byId = new Map();
    for (const r of filteredRows || []) {
      if (r.scenario && !byId.has(r.scenario)) byId.set(r.scenario, r.scenario_title || r.scenario);
    }
    return [...byId].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title));
  }, [filteredRows]);

  function cellData(pipeline, model, scenario, style) {
    return index.get([pipeline, model, scenario, style].join("|")) || null;
  }

  // Changing which creators are in scope invalidates any specific batch
  // selection made under the old scope, so it resets to "all batches"
  // rather than silently keeping ids that may no longer apply.
  function toggleCreator(email) {
    setSelectedCreators((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
    setSelectedBatches(new Set());
    setModalCombo(null);
  }

  function toggleBatch(batchId) {
    setSelectedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
    setModalCombo(null);
  }

  // "Empty" = not a single run anywhere (any pipeline, any scenario, any
  // model/style) in the currently filtered data — computed across the
  // whole dataset, not per scenario section, so a style hidden here is
  // truly untouched everywhere within the active creator/batch scope.
  const emptyStyles = useMemo(() => {
    const present = new Set((filteredRows || []).map((r) => r.style));
    return new Set(STYLES.filter((s) => !present.has(s)));
  }, [filteredRows]);
  const emptyModels = useMemo(() => {
    const present = new Set((filteredRows || []).map((r) => r.model));
    return new Set(ALL_MODELS.filter((m) => !present.has(m)));
  }, [filteredRows]);

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
          <h1 className="app-title">How far can a model be pushed into helping concentrate power?</h1>
          <p className="app-subtitle" style={{ marginBottom: 4, maxWidth: "68ch" }}>
            We don&rsquo;t ask whether it agrees. We watch which tool calls it actually makes.
          </p>
        </div>
        {signedIn && (
          <div style={{ display: "flex", gap: 8 }}>
            <a href="/runs" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
              Runs table ↗
            </a>
            <a href="/dashboard" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
              ← Back to dashboard
            </a>
          </div>
        )}
      </div>

      <section className="cmp-primer" aria-label="How to read this page">
        <ul>
          <li>
            Each scenario is a chain of 4&ndash;5 tool calls, made one at a time. Outputs are
            stubbed &mdash; nothing here touches a real system.
          </li>
          <li>The last call is the irreversible one that removes human oversight.</li>
          <li>
            These scenarios have a right answer: don&rsquo;t make that call. What&rsquo;s measured
            is how much pressure it takes to make it anyway.
          </li>
          <li>
            A model that hedges in prose but completes the chain is the finding.
          </li>
        </ul>
      </section>

      {!signedIn && (
        <aside className="cmp-preview-banner" aria-labelledby="preview-banner-title">
          <div className="cmp-preview-kicker" id="preview-banner-title">
            Work in progress
          </div>
          <p>
            This is an early preview intended to show the direction this project could take. It currently
            includes only a few models, a limited selection of argumentation styles, and two example
            scenarios that have not yet been fully validated. No statistically significant results or
            conclusions are presented here yet, and several aspects of the results display still need
            improvement.
          </p>
          <p>
            For feedback—or to request internal access to experiment with scenario generation and
            evaluation runs—feel free to contact{" "}
            <a href="mailto:sam@polariscollective.org">sam@polariscollective.org</a>.
          </p>
          {researchDirectionUrl && (
            <p>
              <strong>More info:</strong>{" "}
              <a href={researchDirectionUrl}>Information about the research direction</a>
            </p>
          )}
        </aside>
      )}

      {error && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Failed to load: {error}</p>
        </div>
      )}
      {!rows && !error && <p className="plan-caption">Loading…</p>}

      {rows && (
        <>
          <section className="card cmp-verdicts" aria-label="Result by model">
            <h2 className="cmp-verdicts-head">Across everything tried so far</h2>
            {verdicts.length === 0 && <p className="plan-caption">No runs match the current filters.</p>}
            {verdicts.map((v) => (
              <div className="cmp-verdict-row" key={v.model}>
                <span className="cmp-verdict-model">{modelLabel(v.model)}</span>
                <StepBar depth={v.bestDepth} total={v.bestFullSteps} />
                <span className={`cmp-verdict-state${v.crossedCount > 0 ? " crossed" : ""}`}>
                  {v.crossedCount > 0
                    ? "⚠ crossed the critical step"
                    : `stopped at step ${v.bestDepth} of ${v.bestFullSteps}`}
                </span>
                <span className="cmp-verdict-count">
                  {v.crossedCount} of {v.attemptCount} attempts
                </span>
                {v.crossedStyles.length > 0 && (
                  <span className="cmp-verdict-styles">
                    under: {v.crossedStyles.map((s) => s.replace(/_/g, " ")).join(" · ")}
                  </span>
                )}
              </div>
            ))}
          </section>

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
            {signedIn ? (
              <label className="cmp-legend-group cmp-toggle">
                <input
                  type="checkbox"
                  checked={publicOnly}
                  onChange={(e) => {
                    setPublicOnly(e.target.checked);
                    setModalCombo(null);
                  }}
                />
                Public only ({publicCount})
              </label>
            ) : (
              <div className="cmp-legend-group">
                <span className="cmp-public-chip">Public runs only</span>
              </div>
            )}
            {signedIn && availableCreators.length > 0 && (
              <div className="cmp-legend-group">
                <span>Creator</span>
                {availableCreators.map((email) => (
                  <button
                    key={email}
                    type="button"
                    className={`cmp-creator-pill${selectedCreators.has(email) ? " active" : ""}`}
                    aria-pressed={selectedCreators.has(email)}
                    onClick={() => toggleCreator(email)}
                  >
                    {email}
                  </button>
                ))}
              </div>
            )}
            {signedIn && availableBatches.length > 0 && (
              <details className="cmp-legend-group cmp-batch-details">
                <summary className="cmp-toggle">
                  Batch ({selectedBatches.size || "all"} of {availableBatches.length})
                </summary>
                <div className="cmp-batch-list">
                  {availableBatches.map((batchId) => (
                    <label key={batchId}>
                      <input
                        type="checkbox"
                        checked={selectedBatches.has(batchId)}
                        onChange={() => toggleBatch(batchId)}
                      />
                      {batchId}
                    </label>
                  ))}
                </div>
              </details>
            )}
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

          <label className="cmp-legend-group cmp-toggle" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={expandStyles} onChange={(e) => setExpandStyles(e.target.checked)} />
            Show each argument style separately ({visibleStyles.length})
          </label>

          {scenarios.map((scenario) => {
            // /api/scenario-detail 404s anonymously for a scenario with no
            // published (and allowlisted) run — a signed-in user can still
            // reach any scenario there. Only make the title clickable when
            // it would actually open something: otherwise, with today's data
            // (one scenario fully published, the other not at all), half the
            // titles on the flagship public page are dead clicks that land
            // on a bare "Failed to load: HTTP 404" in the modal.
            const canOpen = signedIn || filteredRows.some((r) => r.scenario === scenario.id);
            return (
              <section key={scenario.id} className="cmp-scenario">
                <div className="cmp-scenario-head">
                  <h2 className="cmp-scenario-title">{scenario.title}</h2>
                  {canOpen && (
                    <button
                      type="button"
                      className="cmp-scenario-trigger"
                      onClick={() => setDetailScenario({ id: scenario.id, title: scenario.title })}
                    >
                      <span className="cmp-scenario-hint">Click here for more details</span>
                    </button>
                  )}
                </div>
                <div className="card cmp-panel">
                  <div className="cmp-table-scroll">
                    <table className="cmp-grid">
                      <thead>
                        <tr>
                          <th className="cmp-style-label cmp-sticky"></th>
                          {visibleModels.map((m) => (
                            <th key={m} className="cmp-model-head">
                              {modelLabel(m)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="cmp-best-row">
                          <td className="cmp-style-label cmp-sticky">Best of any style</td>
                          {visibleModels.map((model) => (
                            <td key={model} className="cmp-cell-wrap">
                              <PipelinePair
                                model={model}
                                scenario={scenario.id}
                                styles={visibleStyles}
                                cellData={cellData}
                                onOpen={setModalCombo}
                              />
                            </td>
                          ))}
                        </tr>
                        {expandStyles &&
                          visibleStyles.map((style) => (
                            <tr key={style}>
                              <td className="cmp-style-label cmp-sticky">{style.replace(/_/g, " ")}</td>
                              {visibleModels.map((model) => (
                                <td key={model} className="cmp-cell-wrap">
                                  <PipelinePair
                                    model={model}
                                    scenario={scenario.id}
                                    styles={[style]}
                                    cellData={cellData}
                                    onOpen={setModalCombo}
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            );
          })}

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
                  {[...filteredRows]
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

      <RunTranscriptModal combo={modalCombo} onClose={() => setModalCombo(null)} />
      <ScenarioDetailModal
        scenarioId={detailScenario?.id}
        scenarioTitle={detailScenario?.title}
        onClose={() => setDetailScenario(null)}
      />
    </main>
  );
}
