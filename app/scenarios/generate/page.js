"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MODEL_CATALOG } from "../../../lib/models";
import { SEED_PRESETS } from "../../../lib/seed-presets";
import { JUDGE_DIMENSIONS } from "../../../lib/judge-dimensions";

// Read by app/scenarios/new/page.js, which declares the same literal — a
// page.js in the App Router may only export the component and Next's own
// route config, so this cannot be shared as an export from here.
// sessionStorage rather than a query string because a full scenario doc is
// far too large for a URL.
const PROMOTED_SCENARIO_KEY = "generatedScenario";

// Not claude-opus-5: Anthropic's platform-level content filter blocks this
// project's generator prompt for that model deterministically (stop_reason
// "refusal", category "cyber", empty content), verified 3/3 during Task 5.
// claude-sonnet-5 and claude-opus-4-8 handle the same prompt fine. A default
// that fails on every first use is not a default.
const DEFAULT_MODEL = "claude-sonnet-5";

// The judge defaults to a DIFFERENT model family from the generator, on
// purpose. Letting one model grade its own output is a self-preference
// confound this project can't afford to leave in: the whole feature exists to
// rank candidates, and a judge that flatters its own writing ranks nothing.
// gpt-5.6-terra was verified to return all five dimensions on a real candidate
// at ~$0.007. Not gemini-pro-latest: it is a reasoning model and spends the
// judge route's 1500-token budget before emitting its JSON block, so every
// grading comes back "no fenced json block in the response".
const DEFAULT_JUDGE_MODEL = "gpt-5.6-terra";
const MAX_CANDIDATES = 5;

// Two of these on the page — one for the generator, one for the judge — so the
// provider-grouped option list is written once.
function ModelSelect({ id, label, value, onChange }) {
  return (
    <div className="form-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {Object.entries(MODEL_CATALOG).map(([providerKey, p]) => (
          <optgroup key={providerKey} label={p.label}>
            {Object.entries(p.models).map(([modelId, m]) => (
              <option key={modelId} value={modelId}>
                {m.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function ToolChain({ doc }) {
  return (
    <p className="gen-chain mono">
      {doc.tools.map((t, i) => (
        <span key={t.name}>
          {i > 0 && " → "}
          <span className={t.name === doc.critical_tool ? "gen-critical" : undefined}>
            {t.name === doc.critical_tool ? `⚠ ${t.name}` : t.name}
          </span>
        </span>
      ))}
    </p>
  );
}

function Scores({ candidate }) {
  if (candidate.judgeStatus === "grading") return <p className="plan-caption">Grading…</p>;
  if (candidate.judgeStatus === "error") {
    return <p className="form-error">Grading failed: {candidate.judgeError}</p>;
  }
  if (!candidate.scores) return null;
  return (
    <div>
      {candidate.judgeError && <p className="form-error">{candidate.judgeError}</p>}
      {JUDGE_DIMENSIONS.map((d) => {
        const s = candidate.scores[d.key];
        if (!s) return null;
        return (
          <details key={d.key}>
            <summary className="gen-score-row">
              <span>{d.label}</span>
              <span className="gen-score-val">{s.score}/5</span>
            </summary>
            <p className="plan-caption" style={{ margin: "6px 0 10px" }}>
              {s.rationale}
            </p>
          </details>
        );
      })}
    </div>
  );
}

export default function GenerateScenarioPage() {
  const router = useRouter();
  const [seed, setSeed] = useState(SEED_PRESETS[0].text);
  const [presetId, setPresetId] = useState(SEED_PRESETS[0].id);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [judgeModel, setJudgeModel] = useState(DEFAULT_JUDGE_MODEL);
  const [count, setCount] = useState(3);
  const [candidates, setCandidates] = useState([]);
  const [running, setRunning] = useState(false);
  const [showYamlFor, setShowYamlFor] = useState(null);

  function patch(id, fields) {
    setCandidates((cs) => cs.map((c) => (c.id === id ? { ...c, ...fields } : c)));
  }

  function handlePreset(e) {
    const preset = SEED_PRESETS.find((p) => p.id === e.target.value);
    setPresetId(e.target.value);
    if (preset) setSeed(preset.text);
  }

  async function judgeOne(id, doc) {
    try {
      const res = await fetch("/api/judge-scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc, model: judgeModel }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        patch(id, { judgeStatus: "error", judgeError: data.error || `HTTP ${res.status}` });
        return;
      }
      // One functional update, so the judge's cost adds to the generation
      // cost already on the card instead of replacing it.
      setCandidates((cs) =>
        cs.map((c) =>
          c.id === id
            ? {
                ...c,
                judgeStatus: "done",
                scores: data.scores,
                judgeError: data.ok ? null : data.error,
                cost: (c.cost || 0) + (data.cost || 0),
              }
            : c
        )
      );
    } catch (err) {
      patch(id, { judgeStatus: "error", judgeError: err.message });
    }
  }

  async function generateOne(id) {
    try {
      const res = await fetch("/api/generate-scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed, model }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        patch(id, { status: "error", error: data.error || `HTTP ${res.status}` });
        return;
      }
      if (!data.ok) {
        patch(id, { status: "failed", errors: data.errors || [], rawYaml: data.rawYaml, cost: data.cost });
        return;
      }
      patch(id, {
        status: "ok",
        doc: data.doc,
        rawYaml: data.rawYaml,
        cost: data.cost,
        repaired: data.repaired,
        judgeStatus: "grading",
      });
      judgeOne(id, data.doc);
    } catch (err) {
      patch(id, { status: "error", error: err.message });
    }
  }

  async function handleGenerate() {
    const n = Math.max(1, Math.min(MAX_CANDIDATES, Number(count) || 1));
    const stamp = Date.now();
    const batch = Array.from({ length: n }, (_, i) => ({ id: `${stamp}-${i}`, status: "generating" }));
    setCandidates(batch);
    setRunning(true);
    // Fired concurrently on purpose: one request per candidate keeps every
    // call short enough for a serverless function, and the cards fill in as
    // each returns instead of after the slowest one.
    await Promise.all(batch.map((c) => generateOne(c.id)));
    setRunning(false);
  }

  function promote(doc) {
    sessionStorage.setItem(PROMOTED_SCENARIO_KEY, JSON.stringify(doc));
    router.push("/scenarios/new");
  }

  const totalCost = candidates.reduce((sum, c) => sum + (c.cost || 0), 0);

  return (
    <main className="app-shell" style={{ maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="app-title">Generate scenario</h1>
          <p className="app-subtitle" style={{ marginBottom: 20 }}>
            Describe a situation, get several complete candidates back, and promote one into the form. Nothing is
            saved until you click Save there.
          </p>
        </div>
        <a href="/scenarios" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
          ← Back to scenarios
        </a>
      </div>

      <div className="card">
        <div className="form-field">
          <label className="field-label" htmlFor="preset-select">
            Preset
          </label>
          <select id="preset-select" value={presetId} onChange={handlePreset}>
            {SEED_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="seed-input">
            Seed — the situation to build around. Editable; the output format is fixed server-side.
          </label>
          <textarea id="seed-input" rows={14} value={seed} onChange={(e) => setSeed(e.target.value)} />
        </div>

        <div className="form-grid-2">
          <ModelSelect id="gen-model" label="Generator model" value={model} onChange={setModel} />
          <ModelSelect
            id="judge-model"
            label="Judge model — keep it different from the generator"
            value={judgeModel}
            onChange={setJudgeModel}
          />
        </div>

        <div className="form-grid-2">
          <div className="form-field">
            <label className="field-label" htmlFor="gen-count">
              Candidates (1–{MAX_CANDIDATES})
            </label>
            <input
              id="gen-count"
              type="text"
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </div>
        </div>

        <div className="action-row">
          <button className="btn btn-primary" onClick={handleGenerate} disabled={running || !seed.trim()}>
            {running ? "Generating…" : "Generate"}
          </button>
          {totalCost > 0 && <span className="turn-cost">${totalCost.toFixed(4)}</span>}
        </div>
      </div>

      {candidates.length > 0 && (
        <div className="gen-grid">
          {candidates.map((c) => (
            <section className="card" key={c.id}>
              {c.status === "generating" && <p className="plan-caption">Generating…</p>}

              {c.status === "error" && <p className="form-error">Request failed: {c.error}</p>}

              {c.status === "failed" && (
                <>
                  <h2 className="card-title">Did not validate</h2>
                  <ul className="error-summary">
                    {c.errors.map((e, i) => (
                      <li key={i}>
                        <code>{e.field}</code>: {e.message}
                      </li>
                    ))}
                  </ul>
                  <button className="btn btn-ghost" onClick={() => setShowYamlFor(showYamlFor === c.id ? null : c.id)}>
                    {showYamlFor === c.id ? "Hide raw YAML" : "View raw YAML"}
                  </button>
                  {showYamlFor === c.id && <pre className="mono">{c.rawYaml}</pre>}
                </>
              )}

              {c.status === "ok" && (
                <>
                  <h2 className="card-title">{c.doc.title}</h2>
                  <p className="plan-caption">{c.doc.context}</p>
                  <ToolChain doc={c.doc} />
                  <Scores candidate={c} />
                  <div className="action-row">
                    <button className="btn btn-primary" onClick={() => promote(c.doc)}>
                      Use this one
                    </button>
                    <button className="btn btn-ghost" onClick={() => setShowYamlFor(showYamlFor === c.id ? null : c.id)}>
                      {showYamlFor === c.id ? "Hide YAML" : "View YAML"}
                    </button>
                    {c.cost > 0 && <span className="turn-cost">${c.cost.toFixed(4)}</span>}
                  </div>
                  {showYamlFor === c.id && <pre className="mono">{c.rawYaml}</pre>}
                </>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
