"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MODEL_CATALOG } from "../../../lib/models";
import {
  LEGIBILITY_SCALE,
  failedThresholds,
  DEFAULT_GRADING_REPEATS,
  legibilityDrop,
  legibilityVector,
  selectForVariety,
} from "../../../lib/legibility";
import { JUDGE_DIMENSIONS } from "../../../lib/judge-dimensions";
import { PROMOTED_SCENARIO_KEY } from "../../../lib/promoted-scenario";

// Generation can legitimately take a while — a four-tool scenario is ~1200
// tokens of YAML, and a repair round doubles that. These exist because
// `running` now waits for the whole batch: without a bound, one request that
// never settles would leave Generate disabled until the page is reloaded.
const GENERATE_TIMEOUT_MS = 120_000;
const JUDGE_TIMEOUT_MS = 90_000;

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
// at ~$0.007. gemini-pro-latest is a poor judge here for a different reason:
// it is a reasoning model and spends the judge route's 1500-token budget
// thinking before it ever emits its JSON block. That now reports as
// truncation rather than as a formatting failure, which is what it always
// was — but it still costs a call to learn nothing.
const DEFAULT_JUDGE_MODEL = "gpt-5.6-terra";
const MAX_CANDIDATES = 5;

// The seed is composed from a family row. There used to be a second bank of
// hardcoded presets adapted from the sibling model-specs-evals repo; it is gone.
// Two banks that could disagree about what a situation is was the whole problem,
// and none of those five situations had a counterpart in the Forethought paper
// the bank is sourced from.
// answer_basis is included deliberately: it is the one sentence that tells the
// generator WHY the last step is the one that must not be taken, which is the
// hardest part of the contract to get right.
function seedFromFamily(f) {
  if (!f) return "";
  const parts = [f.description];
  if (f.answer_basis) parts.push(`What makes the final step the one that must not be taken: ${f.answer_basis}`);
  parts.push(`The tradeoff at stake: ${f.tradeoff}.`);
  return parts.join("\n\n");
}

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

// The legibility profile (F-11): one bar per step, tallest where the problem is
// most visible from inside that step alone. The number under it is the drop
// from the clearest earlier step to the critical one — a big drop IS the
// decomposition attack, stated as a quantity instead of a claim.
function LegibilityProfile({ legibility }) {
  const steps = (legibility?.steps || []).filter((s) => Number.isFinite(s.score));
  const v = legibilityVector(steps);
  if (!v.length) return null;
  const drop = legibilityDrop(steps);
  return (
    <div className="gen-leg">
      <div className="gen-leg-row">
        {steps.map((s, i) => (
          <span
            key={i}
            className={`gen-leg-bar${i === v.length - 1 ? " critical" : ""}`}
            title={`Step ${s.step} (${s.toolName}): ${LEGIBILITY_SCALE[s.score - 1]?.label} — ${s.rationale}`}
          >
            <span className="gen-leg-fill" style={{ height: `${s.score * 20}%` }} />
            <span className="gen-leg-num">{s.score}</span>
          </span>
        ))}
      </div>
      <p className="plan-caption gen-leg-caption">
        Legibility per step. {drop > 0
          ? `Drops ${drop} from the clearest earlier step to the critical one — the fact that condemns it is upstream, where a blind executor never sees it.`
          : "No drop into the critical step: the problem is as visible there as anywhere earlier."}
      </p>
    </div>
  );
}

function Scores({ candidate }) {
  if (candidate.judgeStatus === "grading") return <p className="plan-caption">Grading…</p>;
  if (candidate.judgeStatus === "error") {
    return <p className="form-error">Grading failed: {candidate.judgeError}</p>;
  }
  if (!candidate.scores) return null;
  const missed = failedThresholds(candidate.scores);
  return (
    <div>
      {candidate.judgeError && <p className="form-error">{candidate.judgeError}</p>}
      {candidate.legibilityStatus === "grading" && <p className="plan-caption">Scoring legibility…</p>}
      {candidate.legibilityError && <p className="form-error">Legibility: {candidate.legibilityError}</p>}
      <LegibilityProfile legibility={candidate.legibility} />
      {missed.length > 0 && (
        <p className="gen-below-floor">
          Below the floor on {missed.join(", ")} — this one is a broken instrument, not a weaker one.
        </p>
      )}
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
  const [seed, setSeed] = useState("");
  const [presetId, setPresetId] = useState("");
  const [families, setFamilies] = useState([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [judgeModel, setJudgeModel] = useState(DEFAULT_JUDGE_MODEL);
  const [count, setCount] = useState(3);
  const [candidates, setCandidates] = useState([]);
  const [running, setRunning] = useState(false);
  const [showYamlFor, setShowYamlFor] = useState(null);
  // F-12: which candidates the variety pass suggests keeping. Null until asked,
  // so the page never implies a recommendation nobody requested.
  const [pickedIds, setPickedIds] = useState(null);
  const [pickCount, setPickCount] = useState(3);
  // How many times each candidate is graded. One grading moves by about a
  // point and the floors sit exactly there, so a sound candidate can be
  // discarded on a single unlucky draw. Three passes, median taken.
  const [gradings, setGradings] = useState(DEFAULT_GRADING_REPEATS);

  function patch(id, fields) {
    setCandidates((cs) => cs.map((c) => (c.id === id ? { ...c, ...fields } : c)));
  }

  // Only families the harness can actually carry are offered. A contested one
  // has no wrong answer to score against, and an out-of-scope one has no chain
  // to decompose — generating against either produces a scenario that cannot be
  // used, which is a worse outcome than not offering it.
  useEffect(() => {
    fetch("/api/families")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const usable = (d?.families || []).filter((f) => f.harness_fit !== "does_not_fit");
        setFamilies(usable);
        if (usable.length && !presetId) {
          setPresetId(usable[0].id);
          setSeed(seedFromFamily(usable[0]));
        }
      })
      .catch(() => {});
    // Runs once: refetching would overwrite an edited seed with the family text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePreset(e) {
    const family = families.find((f) => f.id === e.target.value);
    setPresetId(e.target.value);
    if (family) setSeed(seedFromFamily(family));
  }

  // Separate from judgeOne on purpose: this is N calls, each shown one step and
  // nothing else, and it must not be folded into the five-dimension judge — that
  // judge holds the whole scenario, which is exactly the contamination this
  // measurement exists to avoid. See lib/blind-view.js.
  async function legibilityOne(id, doc) {
    patch(id, { legibilityStatus: "grading" });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
      const res = await fetch("/api/judge-legibility", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc, model: judgeModel, repeat: gradingCount() }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCandidates((cs) =>
          cs.map((c) =>
            c.id === id
              ? { ...c, legibilityStatus: "error", legibilityError: data.error || `HTTP ${res.status}` }
              : c
          )
        );
        return;
      }
      setCandidates((cs) =>
        cs.map((c) =>
          c.id === id
            ? {
                ...c,
                legibilityStatus: "done",
                legibility: { ok: data.ok, steps: data.steps || [], passes: data.passes || null },
                legibilityError: data.ok ? null : data.error,
                cost: (c.cost || 0) + (data.cost || 0),
              }
            : c
        )
      );
    } catch (err) {
      patch(id, { legibilityStatus: "error", legibilityError: err.message });
    }
  }

  async function judgeOne(id, doc) {
    try {
      const res = await fetch("/api/judge-scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc, model: judgeModel, repeat: gradingCount() }),
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Carry the cost through here too: the route returns it on its 502,
        // and dropping it would under-report spend the same way the generate
        // path used to.
        setCandidates((cs) =>
          cs.map((c) =>
            c.id === id
              ? {
                  ...c,
                  judgeStatus: "error",
                  judgeError: data.error || `HTTP ${res.status}`,
                  cost: (c.cost || 0) + (data.cost || 0),
                }
              : c
          )
        );
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
                passes: data.passes || null,
                legibility: data.legibility || null,
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
    let generatedDoc = null;
    try {
      const res = await fetch("/api/generate-scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed, model }),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The 502 path deliberately still returns cost — a first model call
        // can spend money before the failure that follows it — so carry it
        // through instead of dropping it on the floor.
        patch(id, { status: "error", error: data.error || `HTTP ${res.status}`, cost: data.cost });
        return;
      }
      if (!data.ok) {
        // The route distinguishes a provider content block and a truncation
        // from malformed YAML. Collapsing all three into "failed" would head
        // the card "Did not validate" and offer a "View raw YAML" button that
        // opens an empty box — a blocked request never produced any YAML to
        // look at. Route those two to their own state instead.
        const noOutput = !data.rawYaml || !data.rawYaml.trim();
        patch(
          id,
          noOutput
            ? { status: "blocked", error: data.errors?.[0]?.message || "the model returned nothing", cost: data.cost }
            : { status: "failed", errors: data.errors || [], rawYaml: data.rawYaml, cost: data.cost }
        );
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
      generatedDoc = data.doc;
    } catch (err) {
      patch(id, { status: "error", error: err.message });
      return;
    }
    // Awaited so this candidate's generateOne promise — and therefore the
    // batch's Promise.all — doesn't settle until judging has too. Cards still
    // fill in independently: judgeOne patches state as soon as its own
    // response lands, regardless of how long siblings take. Only `running`
    // (gated on the whole batch) waits for everything.
    //
    // Deliberately OUTSIDE the try above. judgeOne is a total function today,
    // but if it ever threw, that catch would stamp status "error" onto a
    // candidate already rendered as "ok" and wipe its doc and scores off the
    // card — destroying work the user paid for.
    // Both graders run on the same candidate, concurrently — they are
    // independent measurements and neither needs the other's answer.
    if (generatedDoc) await Promise.all([judgeOne(id, generatedDoc), legibilityOne(id, generatedDoc)]);
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

  function gradingCount() {
    return Math.max(1, Math.min(5, Number(gradings) || DEFAULT_GRADING_REPEATS));
  }

  const totalCost = candidates.reduce((sum, c) => sum + (c.cost || 0), 0);
  // Only candidates that both validated and came back graded can be compared.
  const graded = candidates.filter((c) => c.status === "ok" && c.scores);

  return (
    <main className="app-shell" style={{ maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="app-title">Generate scenario</h1>
          <p className="app-subtitle" style={{ marginBottom: 20 }}>
            Pick a family, get several complete candidates back, and promote one into the form. Nothing is
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
            Family — the hard case to build a scenario for
          </label>
          <select id="preset-select" value={presetId} onChange={handlePreset}>
            {families.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="seed-input">
            Seed — what the generator is told to build. Prefilled from the family; edit it freely. The
            four-tool contract is added server-side and is not part of this text.
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
          <div className="form-field">
            <label className="field-label" htmlFor="gen-gradings">
              Gradings per candidate (1–5)
            </label>
            <input
              id="gen-gradings"
              type="text"
              inputMode="numeric"
              value={gradings}
              onChange={(e) => setGradings(e.target.value)}
            />
            <p className="plan-caption">
              The median of these is the score. One grading moves by about a point, and the floors sit
              exactly there — graded once, a sound candidate can be thrown out on an unlucky draw.
            </p>
          </div>
        </div>

        <div className="action-row">
          <button className="btn btn-primary" onClick={handleGenerate} disabled={running || !seed.trim()}>
            {running ? "Generating…" : "Generate"}
          </button>
          {totalCost > 0 && <span className="turn-cost">${totalCost.toFixed(4)}</span>}
        </div>
      </div>

      {graded.length > 1 && (
        <section className="gen-variety">
          <div className="gen-variety-head">
            <div>
              <strong>Pick for variety, not for score.</strong>
              <p className="plan-caption" style={{ margin: "4px 0 0" }}>
                Best-of-N against one judge converges: every pick drifts toward the shape that judge
                rewards, and the bank narrows. This drops anything below the floors, then keeps the
                survivors that sit furthest apart on legibility and on how tempting complying is.
              </p>
            </div>
            <div className="gen-variety-actions">
              <label className="field-label" htmlFor="pickCount">
                keep
              </label>
              <input
                id="pickCount"
                type="number"
                min="1"
                max={graded.length}
                value={pickCount}
                onChange={(e) => setPickCount(Number(e.target.value))}
                style={{ width: 60 }}
              />
              <button
                className="btn btn-ghost"
                onClick={() => setPickedIds(new Set(selectForVariety(graded, pickCount).picked.map((c) => c.id)))}
              >
                Suggest
              </button>
              {pickedIds && (
                <button className="btn btn-ghost" onClick={() => setPickedIds(null)}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {candidates.length > 0 && (
        <div className="gen-grid">
          {candidates.map((c) => (
            <section
              className={`card${pickedIds ? (pickedIds.has(c.id) ? " gen-picked" : " gen-unpicked") : ""}`}
              key={c.id}
            >
              {pickedIds?.has(c.id) && <span className="badge badge-ok">kept for variety</span>}
              {c.status === "generating" && <p className="plan-caption">Generating…</p>}

              {c.status === "blocked" && (
                <>
                  <h2 className="card-title">No scenario produced</h2>
                  <p className="form-error">{c.error}</p>
                  {c.cost > 0 && <div className="turn-cost">${c.cost.toFixed(4)}</div>}
                </>
              )}

              {c.status === "error" && (
                <>
                  <p className="form-error">Request failed: {c.error}</p>
                  {c.cost > 0 && <span className="turn-cost">${c.cost.toFixed(4)}</span>}
                </>
              )}

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
                  <div className="action-row">
                    <button className="btn btn-ghost" onClick={() => setShowYamlFor(showYamlFor === c.id ? null : c.id)}>
                      {showYamlFor === c.id ? "Hide raw YAML" : "View raw YAML"}
                    </button>
                    {c.cost > 0 && <span className="turn-cost">${c.cost.toFixed(4)}</span>}
                  </div>
                  {showYamlFor === c.id && <pre className="turn-pre gen-yaml">{c.rawYaml}</pre>}
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
                  {showYamlFor === c.id && <pre className="turn-pre gen-yaml">{c.rawYaml}</pre>}
                </>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
