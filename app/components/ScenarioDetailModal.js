"use client";

import { useEffect, useState } from "react";
import { JUDGE_DIMENSIONS } from "../../lib/judge-dimensions.js";
import { IN_REVIEW_BLURB, IN_REVIEW_LABEL } from "../../lib/families.js";
import {
  LEGIBILITY_SCALE,
  THRESHOLD_DIMENSIONS,
  DEFAULT_THRESHOLD,
  ceilingFor,
  foldGradings,
  legibilityDrop,
} from "../../lib/legibility.js";

function describeType(val) {
  if (Array.isArray(val)) {
    if (val.length && typeof val[0] === "object") return "array of object";
    return `array of ${val[0] ?? "string"}`;
  }
  return val;
}

function SchemaTree({ schema, depth = 0 }) {
  // A tool that opens the chain declares no input at all, so this renders an
  // empty (or, for a blob written before normalizeScenarioDoc backfilled it,
  // an absent) schema rather than crashing on it.
  return (
    <>
      {Object.entries(schema || {}).map(([key, val]) => {
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
function Step({ index, total, tool, critical, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
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

// The lineage, and nothing else. What a reader needs is the fact that an
// earlier definition exists and a way to open it — that is what reconciles a
// transcript's tool schemas with the chain shown here. revision_note is
// deliberately absent: it is an internal working note about what changed and
// what was carried over anyway, and /api/scenario-detail only sends it to a
// signed-in caller, so it is not something to publish under every result.
function LineageBanner({ detail, onView }) {
  // Collapsed by default. The one-line lineage is orientation and belongs in
  // front of the reader; the note behind it is a changelog that runs to several
  // paragraphs and pushed the scenario's own description off the screen. It is
  // signed-in only in the first place — /api/scenario-detail withholds
  // revision_note from anonymous callers — so this only ever folds away
  // something the reader is entitled to see, never something we are hiding.
  const [notesOpen, setNotesOpen] = useState(false);
  if (!detail.supersedes && !detail.superseded_by) return null;
  const revisedOn = detail.revised_at ? new Date(detail.revised_at).toLocaleDateString() : null;
  const target = detail.superseded_by || detail.supersedes;
  return (
    <div className="sdm-lineage">
      <p className="plan-caption sdm-lineage-line">
        {detail.superseded_by ? "An earlier version of this scenario. Current version: " : null}
        {detail.supersedes ? `Revised${revisedOn ? ` on ${revisedOn}` : ""}. Version used before that: ` : null}
        <button type="button" className="btn-link mono" onClick={() => onView(target)}>
          {target}
        </button>
      </p>
      {detail.revision_note ? (
        <>
          <button
            type="button"
            className="sdm-lineage-toggle"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen(!notesOpen)}
          >
            <span className="fam-caret" aria-hidden="true" />
            Revision notes
          </button>
          {notesOpen && <p className="sdm-lineage-note">{detail.revision_note}</p>}
        </>
      ) : null}
    </div>
  );
}


// How the scenario was graded, and by whom. Two measurements that must not be
// read as one: the five dimensions are scored with the whole scenario in view,
// the legibility profile with a single step in view and nothing else. A judge
// holding the full text cannot honestly say what a context-free executor would
// notice, which is why the second one is a separate pass (see lib/blind-view.js).
function Metrics({ metrics, openPanel }) {
  if (!metrics) return null;
  // Only gradings of the wording currently on the page. A pass taken before an
  // edit scored text that no longer exists; folding it into the median would
  // average two different scenarios.
  const current = metrics.filter((m) => !m.stale);
  const superseded = metrics.length - current.length;

  if (current.length === 0) {
    return (
      <>
        <label className="field-label">How this was graded</label>
        <p className="plan-caption">
          {superseded > 0
            ? `Not graded since it was last edited — ${superseded} earlier grading${
                superseded === 1 ? "" : "s"
              } scored wording that has since changed. `
            : "Not graded yet. "}
          <span className="mono">node scripts/grade-scenario.js --scenarios &lt;id&gt;</span>
        </p>
      </>
    );
  }

  // Repeated passes by the SAME judge are one verdict, folded to its median.
  // Different judges are never merged: two models disagreeing is information,
  // and averaging them across families would erase exactly that.
  const byJudge = new Map();
  for (const m of current) {
    if (!byJudge.has(m.judge_model)) byJudge.set(m.judge_model, []);
    byJudge.get(m.judge_model).push(m);
  }

  return (
    <>
      <label className="field-label">How this was graded</label>
      <p className="plan-caption sdm-metrics-lead">
        Five dimensions scored by a judge reading the whole scenario, plus a separate pass scoring each
        step with only that step in view. All five dimensions are <strong>floors</strong>: below{" "}
        {DEFAULT_THRESHOLD}/5 the scenario measures nothing and is discarded rather than kept as a
        weaker one. A single grading moves by about a point, so each score below is the{" "}
        <strong>median of several passes</strong>. Click any
        score for the question the judge was asked and what each pass answered.
        {byJudge.size > 1 ? " Judges are kept apart, never averaged together." : ""}
      </p>
      {[...byJudge.entries()].map(([judge, rows], i) => (
        <Grading key={judge} judge={judge} rows={rows} openPanel={i === 0 ? openPanel : null} />
      ))}
      {superseded > 0 && (
        <p className="plan-caption">
          {superseded} earlier grading{superseded === 1 ? "" : "s"} of wording that has since changed{" "}
          {superseded === 1 ? "is" : "are"} kept but not counted here.
        </p>
      )}
    </>
  );
}

function Grading({ judge, rows, openPanel = null }) {
  // One selection shared by the dimension chips and the legibility bars: they
  // explain themselves into the same panel, so opening one closes the other and
  // the block never grows two competing explanations at once.
  const [open, setOpen] = useState(openPanel);
  // What is shown is the median of this judge's passes; the passes themselves
  // are kept for the expanded panel, where the disagreement is the point.
  const m = foldGradings(rows);
  const steps = (m.legibility || []).filter((s) => Number.isFinite(s.score));
  const drop = steps.length ? legibilityDrop(steps) : null;
  const ceiling = ceilingFor(m.dimensions);

  return (
    <div className="sdm-metrics">
      <div className="sdm-metrics-head">
        <span className="mono">{judge}</span>
        <span>
          median of {m.n} pass{m.n === 1 ? "" : "es"}
          {rows[0]?.created_at ? ` · ${new Date(rows[0].created_at).toLocaleDateString()}` : null}
        </span>
      </div>

      <div className="sdm-dims">
        {JUDGE_DIMENSIONS.map((d) => {
          const v = m.dimensions?.[d.key];
          if (!v) return null;
          const isFloor = THRESHOLD_DIMENSIONS.includes(d.key);
          const belowFloor = isFloor && v.score < DEFAULT_THRESHOLD;
          const id = `dim:${d.key}`;
          return (
            <button
              type="button"
              key={d.key}
              className={`sdm-dim${open === id ? " open" : ""}${belowFloor ? " below" : ""}`}
              aria-expanded={open === id}
              onClick={() => setOpen(open === id ? null : id)}
            >
              <span className="sdm-dim-label">{d.label}</span>
              <span className="sdm-dim-score">
                {v.score}/5
                {v.min !== v.max && <span className="sdm-dim-spread"> ({v.min}–{v.max})</span>}
              </span>
            </button>
          );
        })}
      </div>

      {steps.length > 0 && (
        <div className="sdm-leg">
          {/* One row per step rather than four vertical bars. The modal is wide
              and the chain is short, so the horizontal form has room to name the
              tool — which is what a reader needs to make sense of a score, and
              which the vertical version could only put in a tooltip. Only the
              median is shown; the spread across passes is in the panel a click
              opens, where there is space to say what the passes actually said. */}
          <ol className="sdm-leg-list">
            {steps.map((st, j) => {
              const id = `step:${st.step}`;
              const critical = j === steps.length - 1;
              return (
                <li key={j}>
                  <button
                    type="button"
                    className={`sdm-leg-step${critical ? " critical" : ""}${open === id ? " open" : ""}`}
                    aria-expanded={open === id}
                    onClick={() => setOpen(open === id ? null : id)}
                  >
                    <span className="sdm-leg-idx">{st.step}</span>
                    <span className="mono sdm-leg-tool">{st.toolName}</span>
                    <span className="sdm-leg-track" aria-hidden="true">
                      <span className="sdm-leg-fill" style={{ width: `${st.score * 20}%` }} />
                    </span>
                    <span className="sdm-leg-score">{st.score}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="plan-caption sdm-leg-caption">
            Legibility per step — how much an executor seeing only that step could suspect something
            was wrong. No step may exceed {ceiling} here — the ceiling is one below how grave the
            scenario scored, so no single step may be as revealing as the whole. {drop > 0
              ? `It drops ${drop} into the critical step: the fact that condemns the chain sits upstream, where a blind executor never sees it.`
              : "It does not drop into the critical step, so nothing here is hidden from a blind executor by the decomposition itself."}
          </p>
        </div>
      )}

      {open && <Explainer open={open} m={m} steps={steps} rows={rows} />}
    </div>
  );
}

// What the judge was actually asked, verbatim, next to what it answered. The
// question strings are the same ones sent to the model — read from
// lib/judge-dimensions.js rather than re-worded here, so the page cannot
// describe a prompt that is no longer the prompt.
function Explainer({ open, m, steps, rows }) {
  if (open.startsWith("dim:")) {
    const key = open.slice(4);
    const d = JUDGE_DIMENSIONS.find((x) => x.key === key);
    const v = m.dimensions?.[key];
    if (!d) return null;
    const isFloor = THRESHOLD_DIMENSIONS.includes(key);
    return (
      <div className="sdm-explain">
        <p className="sdm-explain-role">
          {isFloor
            ? `Floor — must reach ${DEFAULT_THRESHOLD}/5, or the scenario is discarded as a broken instrument.`
            : "Scored, but not a floor."}
        </p>
        <p className="sdm-explain-label">The question the judge was given</p>
        <p className="sdm-explain-q">{d.question}</p>
        <p className="sdm-explain-label">
          What each pass answered — {v?.n ?? rows.length} run{(v?.n ?? rows.length) === 1 ? "" : "s"} of
          that same question, median {v?.score}/5
        </p>
        <ul className="sdm-passes">
          {rows.map((r, i) => {
            const pass = r.dimensions?.[key];
            if (!pass) return null;
            return (
              <li key={i}>
                <span className="sdm-pass-score">{pass.score}/5</span>
                <span className="sdm-pass-why">{pass.rationale || "no rationale given"}</span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  const st = steps.find((s) => `step:${s.step}` === open);
  if (!st) return null;
  const scale = LEGIBILITY_SCALE[st.score - 1];
  return (
    <div className="sdm-explain">
      <p className="sdm-explain-role">
        Step {st.step} — <span className="mono">{st.toolName}</span>. Scored by a grader shown only this
        step: its tool description, its arguments and the previous step&rsquo;s output. No goal, no plan,
        no other step.
      </p>
      <p className="sdm-explain-label">
        {st.score}/5 — {scale?.label}
      </p>
      <p className="sdm-explain-q">{scale?.blurb}</p>
      <p className="sdm-explain-label">
        What each pass answered — median {st.score}/5
      </p>
      <ul className="sdm-passes">
        {rows.map((r, i) => {
          const pass = (r.legibility || []).find((x) => x.step === st.step);
          if (!pass) return null;
          return (
            <li key={i}>
              <span className="sdm-pass-score">{pass.score}/5</span>
              <span className="sdm-pass-why">{pass.rationale || "no rationale given"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Scenario description and the chain of tools it offers, on demand, for the
// /compare page. Presented as the chain the model actually walks — step 1, 2,
// 3, … with the last one flagged — because that ordering is the whole
// measurement, and a flat list of tool cards (what this used to be, and what
// the manual dashboard still shows inline) hides it.
export default function ScenarioDetailModal({ scenarioId, scenarioTitle, inReview = false, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  // Which version of the lineage is on screen. Starts at whatever opened the
  // modal and moves when the banner is followed, so a reader holding a
  // transcript can step back to the definition it was recorded against and
  // return, without the grid needing to know any of it.
  const [viewingId, setViewingId] = useState(scenarioId);
  useEffect(() => setViewingId(scenarioId), [scenarioId]);

  // ?step=<n> and ?dim=<key> pre-expand one part of the spec, so a document can
  // cite a single step's schema or a single judge dimension's question instead
  // of saying "open the scenario, scroll down, click the third chip". Read once
  // — this is for arriving, not for navigating — and honoured only for the
  // version the URL actually names, so following the lineage elsewhere drops
  // the expansion rather than expanding the wrong step of the wrong document.
  const [anchor] = useState(() => {
    if (typeof window === "undefined") return {};
    const q = new URLSearchParams(window.location.search);
    return { scenario: q.get("scenario"), step: Number(q.get("step")) || null, dim: q.get("dim") };
  });
  const atAnchor = anchor.scenario && anchor.scenario === viewingId;
  const openStep = atAnchor ? anchor.step : null;
  const openDim = atAnchor ? anchor.dim : null;

  useEffect(() => {
    if (!viewingId) return;
    setDetail(null);
    setError(null);
    fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(viewingId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [viewingId]);

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
            {/* The fetched title wins over the prop: following the lineage
                changes which version is on screen, and the caller's title
                still names the one it opened. */}
            <div className="rtm-title">{detail?.title || scenarioTitle || viewingId}</div>
            <div className="rtm-filename mono">{viewingId}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close ✕
          </button>
        </div>

        <div className="rtm-body">
          {error && <p style={{ color: "var(--danger)" }}>Failed to load: {error}</p>}
          {!detail && !error && <p className="plan-caption">Loading…</p>}

          {/* Above the spec, not below it: a reader who scrolls the four tools
              and the judge scores can come away thinking the scores are
              results. They are not — they grade the instrument, and nothing has
              been measured with it yet. Shown only for the version that was
              opened, since following the lineage lands on a retired row whose
              run count this component was never told. */}
          {detail && inReview && viewingId === scenarioId && (
            <div className="sdm-review-note">
              <span className="badge badge-neutral">{IN_REVIEW_LABEL}</span>
              <p>{IN_REVIEW_BLURB}</p>
            </div>
          )}

          {detail && <LineageBanner detail={detail} onView={setViewingId} />}

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
                    defaultOpen={openStep === i + 1}
                  />
                ))}
              </ol>

              <Metrics metrics={detail.metrics} openPanel={openDim ? `dim:${openDim}` : null} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
