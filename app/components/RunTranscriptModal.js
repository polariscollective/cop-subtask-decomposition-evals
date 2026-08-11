"use client";

import { useEffect, useState } from "react";
import { PromptViewer, TurnBody, turnsCost } from "./ConversationView";
import CopyId from "./CopyId";
import StepBar from "./StepBar";

// One stage's full conversation: system prompt, initial message, then the
// turn-by-turn exchange, always expanded (the whole point of opening the
// modal is to read it, not to click through another collapse toggle).
function Stage({ label, sub, result }) {
  if (!result) return null;
  return (
    <div className="rtm-stage">
      <div className="rtm-stage-head">
        <span className="rtm-stage-label">{label}</span>
        {sub && <span className="rtm-stage-sub">{sub}</span>}
        <span className={`badge ${result.accepted ? "badge-ok" : "badge-danger"}`}>
          {result.accepted ? "accepted" : "refused"}
        </span>
        <span className="turn-cost">${turnsCost(result.turns).toFixed(4)}</span>
      </div>
      <PromptViewer
        systemPrompt={result.system_prompt}
        userMessage={result.initial_user_message}
        tools={result.tools}
      />
      <div className="section-gap">
        <TurnBody turns={result.turns} startExpanded />
      </div>
    </div>
  );
}

function formatSavedAt(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// One sample's transcript: fetches its full content on demand (collapsed
// by default when there's more than one sample, so opening a combo with
// several resamples doesn't dump every conversation at once).
function SampleBlock({ sample, index, total, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || content || error) return;
    fetch(`/api/runs?id=${encodeURIComponent(sample.id)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setContent)
      .catch((e) => setError(e.message));
  }, [open, content, error, sample.id]);

  const depthLabel =
    sample.pipeline === "linear" && sample.depth === 0 && !sample.planAccepted
      ? "plan refused"
      : `reached ${sample.depth}/${sample.fullSteps}`;

  return (
    <div className="rtm-sample">
      {/* The copy control sits beside the toggle rather than inside it: a
          button cannot nest inside another button, and clicking "copy" must
          not also collapse the sample you were reading. */}
      <div className="rtm-sample-headrow">
        <button className="rtm-sample-head" onClick={() => setOpen((v) => !v)}>
          <span>{open ? "▾" : "▸"}</span>
          <span className="rtm-sample-title">
            {total > 1 ? `Sample ${index + 1}/${total}` : "Run"} — {depthLabel}{" "}
            {sample.fullSteps > 0 && <StepBar depth={sample.depth} total={sample.fullSteps} />}
            {sample.inProgress && <span className="cmp-running-mark"> *</span>}
          </span>
          <span className={`badge ${sample.completed ? "badge-ok" : "badge-neutral"}`}>
            {sample.completed ? "fully completed" : "not completed"}
          </span>
          <span className="rtm-sample-date mono">{formatSavedAt(sample.saved_at)}</span>
        </button>
        <CopyId id={sample.id} />
      </div>
      {open && (
        <div className="rtm-sample-body">
          {error && <p style={{ color: "var(--danger)" }}>Failed to load: {error}</p>}
          {!content && !error && <p className="plan-caption">Loading…</p>}

          {/* A scenario is replaced rather than edited, and its runs are
              carried over to the new row when the revision left the stimulus
              intact — so the spec linked from this grid can be a later
              version than the one this conversation was recorded against.
              Whoever compares the tool schemas below with that page needs
              telling, or the mismatch reads as a bug. */}
          {content && content.ran_against_scenario_id && content.ran_against_scenario_id !== content.scenario_id && (
            <p className="plan-caption" style={{ borderLeft: "3px solid var(--border)", paddingLeft: 10 }}>
              Recorded against <span className="mono">{content.ran_against_scenario_id}</span>, an
              earlier version of this scenario. The tools below are the ones it was actually shown.
            </p>
          )}

          {content && content.run_kind === "chained" && (
            <Stage label="Whole conversation" sub="one continuous thread, full memory throughout" result={content.direct_result} />
          )}

          {content && content.run_kind === "linear" && (
            <>
              <p className="plan-caption" style={{ marginBottom: 16 }}>
                Each stage below is a <em>separate</em> conversation — the executor is blind
                between steps, it only sees this step's arguments and the previous step's
                (fabricated) output, not the earlier conversation.
              </p>
              {content.plan_result_real_attempt && (
                <Stage
                  label="Stage 0a — Plan"
                  sub="framing: real (exhausted, refused — fell back to test framing below)"
                  result={content.plan_result_real_attempt}
                />
              )}
              <Stage
                label={content.plan_result_real_attempt ? "Stage 0b — Plan" : "Stage 0 — Plan"}
                sub={`framing: ${content.plan_result?.framing}`}
                result={content.plan_result}
              />
              {(content.steps || []).map((s, i) => (
                <Stage key={i} label={`Step ${i + 1}`} sub={s.tool} result={s} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Renders every sample (resample run) for one (pipeline, model, scenario,
// style) combo. `combo` is a row from /api/compare — its `samples` array
// carries one lightweight entry per run; each is fetched and rendered on
// demand when expanded, not all at once.
// One argument style's runs, with the style's own rate above them. A plain
// mean here, never a mean of means: within a style there is nothing left to
// average over but its own attempts.
function StyleGroup({ combo, showHeading }) {
  const samples = combo.samples || [];
  const hits = samples.filter((s) => s.depth === s.fullSteps && s.fullSteps > 0).length;
  return (
    <div className="rtm-style-group">
      {showHeading && (
        <div className="rtm-style-head">
          <span className="rtm-style-name">{(combo.style || "—").replace(/_/g, " ")}</span>
          <span className="mono rtm-style-rate">
            {Math.round((hits / (samples.length || 1)) * 100)}% &mdash; {hits}/{samples.length} reached the critical
            step
          </span>
        </div>
      )}
      {samples.map((s, i) => (
        <SampleBlock
          key={s.id}
          sample={s}
          index={i}
          total={samples.length}
          defaultOpen={!showHeading && samples.length === 1}
        />
      ))}
    </div>
  );
}

export default function RunTranscriptModal({ combo, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!combo) return null;
  // The grid hands over every style folded into the cell that was clicked, so
  // a row labelled "All styles" opens all of them rather than silently showing
  // whichever one happened to go deepest.
  const combos = combo.combos || [combo];
  const best = combo.best || combo;
  const stats = combo.stats;
  const merged = combos.length > 1;

  return (
    <div className="rtm-backdrop" onClick={onClose}>
      <div className="rtm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rtm-header">
          <div>
            <div className="rtm-title">
              {best.model} · {best.pipeline} · {merged ? "all styles" : best.style} ·{" "}
              {best.scenario_title || best.scenario}
            </div>
            <div className="mono rtm-filename">
              {stats
                ? `${Math.round(stats.rate * 100)}% reached the critical step — ${stats.hits}/${stats.attempts} attempts${
                    merged ? `, mean of ${stats.styleCount} argument styles` : ""
                  }`
                : `${(best.samples || []).length} sample${(best.samples || []).length === 1 ? "" : "s"}`}
              {combos.some((c) => c.anyRunning) && <span className="cmp-running-mark"> *</span>}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close ✕
          </button>
        </div>

        <div className="rtm-body">
          {combos.map((c) => (
            <StyleGroup key={c.id || c.style} combo={c} showHeading={merged} />
          ))}
        </div>
      </div>
    </div>
  );
}
