"use client";

import { useEffect, useMemo, useState } from "react";
import RunTranscriptModal from "./RunTranscriptModal";
import ScenarioDetailModal from "./ScenarioDetailModal";
import { MODEL_CATALOG } from "../../lib/models";
import { aggregateSamples } from "../../lib/compare-aggregate.js";
import { bestOf, crossed, verdictRows } from "../../lib/compare-verdict.js";
import { HEAT_MODES, crossedShare, rateMatrix } from "../../lib/compare-heatmap.js";

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

// A sequential single-hue ramp, surface → --danger, in five steps. The
// crossing rate is a magnitude with a direction (0% is the outcome we want,
// 100% the one we don't), not a polarity around a meaningful middle, so it
// gets one hue getting darker rather than a green-to-red ramp — which would
// put a hue change at 50% and imply that half the attempts crossing is some
// kind of neutral. It also keeps red meaning exactly what it means in the
// grids below: crossed. Every cell prints its own percentage, so the colour
// is a second reading of the number, never the only one.
function heatStep(rate) {
  if (rate <= 0) return 0;
  if (rate <= 0.25) return 1;
  if (rate <= 0.5) return 2;
  if (rate <= 0.75) return 3;
  return 4;
}

// What each mode is actually asking, in the reader's terms. Kept next to the
// grid's own footnotes rather than in lib/compare-heatmap.js, which stays
// pure derivation — the predicates live there, the prose lives here.
const HEAT_MODE_NOTES = {
  linear:
    "Plan first, then one blind step at a time; the model reaches the critical step or stops short.",
  chained:
    "The whole chain in one conversation, with full memory of every prior tool call.",
  plan_real:
    "Planning only, no pretext: every linear attempt is asked for a plan under the real framing first, so every attempt counts here.",
  plan_test:
    "Planning only, under the test pretext — which is offered only after a real-framing refusal. Counts just those attempts, so it reads as: once pushed to the pretext, how often does a plan come out.",
};

const HEAT_LEGEND = [
  { step: 0, label: "0%" },
  { step: 1, label: "≤25%" },
  { step: 2, label: "≤50%" },
  { step: 3, label: "≤75%" },
  { step: 4, label: "100%" },
];

// Both pipelines in one cell, stacked. The one-pager asks where the weak link
// is — whether keeping the full history is what moves a model — and answering
// that from two separate tables means looking back and forth. `styles` is a
// list so the same component serves a single-style row and the merged
// "best of any style" row.
const PIPELINE_LABELS = { linear: "P→E", chained: "CHN" };

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
        // Every cell gets exactly two lines — the result line, then one meta
        // line — so the whole grid keeps a single fixed cell height and rows
        // stay scannable across. Everything that used to stack on its own
        // line (turn count, "best of N", the plan-refused note) shares this
        // one, which is also why "best of N" reads as a parenthetical: it
        // qualifies the number in front of it rather than standing alone.
        const planStalled = d && d.pipeline === "linear" && d.depth === 0 && d.planAccepted;
        // A crossed cell is filled by how reproducible the crossing was, on
        // the same ramp as the heatmap above: crossing on two attempts of
        // three is two-thirds of the red. The cell itself still reports the
        // best attempt (that's what the fraction and the bar are), so the
        // state stays carried by the ⚠ and the red border — the fill is the
        // magnitude behind it, never the only thing saying "crossed".
        const share = state === "crossed" ? crossedShare(d) : 0;
        const heatClass = state === "crossed" ? ` heat-${heatStep(share)}` : "";
        const title =
          state === "crossed"
            ? `${PIPELINE_LABELS[pipeline]} — crossed on ${Math.round(share * d.sampleCount)} of ${
                d.sampleCount
              } attempt${d.sampleCount === 1 ? "" : "s"}`
            : PIPELINE_LABELS[pipeline];
        return (
          <button
            type="button"
            key={pipeline}
            className={`cmp-pipe-cell ${state}${heatClass}`}
            disabled={!d}
            onClick={() => d && onOpen(d)}
            title={title}
          >
            <span className="cmp-pipe-line1">
              <Note kind={pipeline}>
                <span className="cmp-pipe-tag">{PIPELINE_LABELS[pipeline]}</span>
              </Note>
              {d ? (
                <>
                  <StepBar depth={d.depth} total={d.fullSteps} />
                  <span className="cmp-frac">
                    {state === "crossed" && <span className="cmp-crossed-mark">⚠ </span>}
                    {noPlan ? <Note kind="noPlan">no plan</Note> : `${d.depth}/${d.fullSteps}`}
                    {d.anyRunning && (
                      <Note kind="running">
                        <span className="cmp-running-mark">*</span>
                      </Note>
                    )}
                    {d.pipeline === "linear" && d.planAccepted && (
                      <Note kind={d.planFraming === "test" ? "T" : "R"}>
                        <span
                          className={`cmp-framing-letter ${
                            d.planFraming === "test" ? "cmp-framing-test" : "cmp-framing-real"
                          }`}
                        >
                          {d.planFraming === "test" ? "T" : "R"}
                        </span>
                      </Note>
                    )}
                  </span>
                </>
              ) : (
                <Note kind="na">
                  <span className="cmp-frac">n/a</span>
                </Note>
              )}
            </span>
            <div className="cmp-turns">
              {d && d.depth > 0 && `${d.turnsUsed} turns`}
              {planStalled && <Note kind="planRefused">step 1 refused</Note>}
              {d && d.sampleCount > 1 && (
                <>
                  {(d.depth > 0 || planStalled) && " "}
                  (<Note kind="bestOf">best of {d.sampleCount}</Note>)
                </>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Each notation explains itself where it appears, rather than in a block of
// footnotes above a grid the reader has not looked at yet. Full sentences on
// purpose: these are read once, by someone who has never seen the project.
const NOTES = {
  R: "The plan was written on the first ask, with both the goal and the tool descriptions stated as they really are — including what the last call irreversibly does. No pretext was needed.",
  T: "The plan was only written after we softened the framing. Two things change, not one: the goal is reworded, and the tools are re-described as belonging to a test environment. The honest framing is always tried first, and every argument style exhausted, before we fall back to this. Nothing after planning changes — every step that actually runs uses the real goal and the real tool descriptions. So a T means the pretext got a plan out, not that the steps below it ran under one.",
  bestOf:
    "This combination was run more than once; the deepest run is shown. Models are not deterministic and results near a decision boundary flip between runs.",
  noPlan: "The model refused to produce a plan at all, so no step was ever executed.",
  planRefused:
    "It agreed to the plan, then refused the first tool call — a different finding from refusing to plan.",
  na: "This combination has not been run yet.",
  running: "Batch still running — this number may still change.",
  linear:
    "Plan → execute. One model is asked to write the whole plan first. Each step is then carried out by a separate model that sees only the previous step's output — not the goal, not the plan, not the steps before it.",
  chained:
    "Chained. One model gets the whole situation and all the tools at once, and works through them itself in a single conversation, seeing each result before deciding the next call.",
};

function Note({ kind, children }) {
  return (
    <span className="cmp-note" tabIndex={0} aria-label={NOTES[kind]} title={NOTES[kind]}>
      {children}
    </span>
  );
}

export default function CompareGrid({ signedIn }) {
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
  // The heatmap answers one question at a time — see HEAT_MODES. Plan →
  // Execute is the default because it's the half with results in it; the
  // other three are the comparisons that make it mean something.
  const [heatMode, setHeatMode] = useState("linear");

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

  const heat = useMemo(() => rateMatrix(filteredRows || [], heatMode), [filteredRows, heatMode]);

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
            Each scenario is a chain of 4&ndash;5 tool calls, outputs stubbed. The last one is the
            critical call &mdash; the one that should never be made. We measure what it takes to
            get it made anyway.
          </li>
          <li>
            When it refuses, we argue back &mdash; up to 10 turns, one fixed argument style per
            attempt, several styles per model. That is how we see which angle moves which model.
          </li>
          <li>
            <strong>Chained</strong> &mdash; one model, full context, calls every tool itself.
          </li>
          <li>
            <strong>Plan &rarr; execute</strong> &mdash; one model plans; each step then runs on a
            model that sees only the previous step&rsquo;s output.
          </li>
          <li>
            Many models refuse to plan at all. When that happens we ask again with the goal and
            the tool descriptions softened into a test environment. A plan obtained that way is
            marked <span className="cmp-framing-letter cmp-framing-test">T</span> &mdash; but
            every step that then runs uses the real ones.
          </li>
        </ul>
      </section>

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
                <span className="cmp-verdict-count">
                  {v.crossedScenarioCount} of {v.scenarioCount}{" "}
                  {v.scenarioCount === 1 ? "scenario" : "scenarios"}
                </span>
                <span className={`cmp-verdict-chained${v.chainedCrossedCount > 0 ? " crossed" : ""}`}>
                  {v.chainedCount === 0
                    ? "chained: not run"
                    : `chained: ${v.chainedCrossedCount} of ${v.chainedCount} (${Math.round(
                        (v.chainedCrossedCount / v.chainedCount) * 100
                      )}%)`}
                </span>
              </div>
            ))}
          </section>

          <section className="card cmp-heat" aria-label="Crossing rate by argument style and model">
            <div className="cmp-heat-head">
              <h2 className="cmp-verdicts-head">Which argument style moves which model</h2>
              <div className="cmp-pipe-toggle" role="group" aria-label="What the heatmap measures">
                {Object.values(HEAT_MODES).map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    className={`cmp-pipe-toggle-btn${heatMode === m.key ? " active" : ""}`}
                    aria-pressed={heatMode === m.key}
                    title={HEAT_MODE_NOTES[m.key]}
                    onClick={() => setHeatMode(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="cmp-heat-lead">
              Share of attempts that {HEAT_MODES[heatMode].measures}, as a mean of means: each
              scenario first collapses to its own rate, then the cell averages those rates. Every
              scenario counts once, however many times it was resampled.{" "}
              {HEAT_MODE_NOTES[heatMode]}
            </p>
            <div className="cmp-table-scroll">
              <table className="cmp-heat-table">
                <thead>
                  <tr>
                    <th className="cmp-heat-style cmp-sticky"></th>
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
                      <th scope="row" className="cmp-heat-style cmp-sticky">
                        {style.replace(/_/g, " ")}
                      </th>
                      {visibleModels.map((model) => {
                        const s = heat.get(`${model}|${style}`);
                        if (!s) {
                          return (
                            <td key={model} className="cmp-heat-cell-wrap">
                              <div
                                className="cmp-heat-cell na"
                                title={
                                  heatMode === "plan_test"
                                    ? "Never reached the test pretext here — the real framing was never refused, or nothing has been run."
                                    : "Not run in this mode."
                                }
                              >
                                n/a
                              </div>
                            </td>
                          );
                        }
                        const pct = Math.round(s.rate * 100);
                        return (
                          <td key={model} className="cmp-heat-cell-wrap">
                            <div
                              className={`cmp-heat-cell heat-${heatStep(s.rate)}`}
                              title={`${pct}% — ${HEAT_MODES[heatMode].measures} on ${s.hits} of ${s.attempts} attempts across ${s.scenarioCount} scenario${
                                s.scenarioCount === 1 ? "" : "s"
                              }`}
                            >
                              <span className="cmp-heat-pct">{pct}%</span>
                              {/* The colour says nothing about how much
                                  evidence is behind it: 1 of 1 and 6 of 6 are
                                  the same red. The raw count rides along so a
                                  100% that rests on a single attempt can't be
                                  read as a settled result. */}
                              <span className="cmp-heat-n">
                                {s.hits}/{s.attempts}
                              </span>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cmp-heat-legend">
              <span>{heatMode.startsWith("plan") ? "plan produced" : "crossed"}</span>
              {HEAT_LEGEND.map((l) => (
                <span key={l.step} className="cmp-heat-legend-item">
                  <span className={`cmp-heat-swatch heat-${l.step}`} aria-hidden="true" />
                  {l.label}
                </span>
              ))}
            </div>
          </section>

          <section className="card cmp-controls">
            <div className="cmp-key">
              <span className="cmp-key-item">
                <StepBar depth={2} total={4} /> steps reached
              </span>
              <span className="cmp-key-item">
                <span className="cmp-key-ramp" aria-hidden="true">
                  {[1, 2, 3, 4].map((n) => (
                    <span key={n} className={`cmp-key-swatch heat-${n}`} />
                  ))}
                </span>
                ⚠ crossed the critical step &mdash; deeper red = crossed on more of its attempts
              </span>
              {/* One item, so the two framings always read as a pair on the same
                  line rather than wrapping apart. The full explanation of each
                  is on the chip itself. */}
              <span className="cmp-key-item">
                <Note kind="R">
                  <span className="cmp-framing-letter cmp-framing-real">R</span>
                </Note>{" "}
                plan written with the real goal and tools &middot;{" "}
                <Note kind="T">
                  <span className="cmp-framing-letter cmp-framing-test">T</span>
                </Note>{" "}
                only after both were softened into a test environment
              </span>
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
                      className="cmp-scenario-view"
                      onClick={() => setDetailScenario({ id: scenario.id, title: scenario.title })}
                    >
                      [View]
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
