"use client";

import { useEffect, useState } from "react";
import { PromptViewer, TurnBody, turnsCost } from "./ConversationView";

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
      <PromptViewer systemPrompt={result.system_prompt} userMessage={result.initial_user_message} />
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
      <button className="rtm-sample-head" onClick={() => setOpen((v) => !v)}>
        <span>{open ? "▾" : "▸"}</span>
        <span className="rtm-sample-title">
          {total > 1 ? `Sample ${index + 1}/${total}` : "Run"} — {depthLabel}
          {sample.inProgress && <span className="cmp-running-mark"> *</span>}
        </span>
        <span className={`badge ${sample.completed ? "badge-ok" : "badge-neutral"}`}>
          {sample.completed ? "fully completed" : "not completed"}
        </span>
        <span className="rtm-sample-date mono">{formatSavedAt(sample.saved_at)}</span>
      </button>
      {open && (
        <div className="rtm-sample-body">
          {error && <p style={{ color: "var(--danger)" }}>Failed to load: {error}</p>}
          {!content && !error && <p className="plan-caption">Loading…</p>}

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
export default function RunTranscriptModal({ combo, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!combo) return null;
  const samples = combo.samples || [];

  return (
    <div className="rtm-backdrop" onClick={onClose}>
      <div className="rtm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rtm-header">
          <div>
            <div className="rtm-title">
              {combo.model} · {combo.pipeline} · {combo.style} · {combo.scenario_title || combo.scenario}
            </div>
            <div className="mono rtm-filename">
              {samples.length} sample{samples.length === 1 ? "" : "s"} — best reached {combo.depth}/{combo.fullSteps}
              {combo.sampleCount > 1 && `, ${combo.completedCount}/${combo.sampleCount} fully completed`}
              {combo.anyRunning && <span className="cmp-running-mark"> *</span>}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close ✕
          </button>
        </div>

        <div className="rtm-body">
          {samples.map((s, i) => (
            <SampleBlock key={s.id} sample={s} index={i} total={samples.length} defaultOpen={samples.length === 1} />
          ))}
        </div>
      </div>
    </div>
  );
}
