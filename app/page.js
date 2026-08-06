"use client";

import { useEffect, useState } from "react";
import { MODEL_CATALOG, defaultModelFor } from "../lib/models";

const ARGUMENT_STYLE_OPTIONS = [
  "all",
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

// Toggle showing the exact system + user (or initial user) prompt that
// produced a result, verbatim — so any claim about "what the model saw"
// can be checked directly instead of inferred.
function PromptViewer({ systemPrompt, userMessage, label = "View exact input prompt" }) {
  const [open, setOpen] = useState(false);
  if (!systemPrompt && !userMessage) return null;
  return (
    <>
      <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} style={{ marginTop: 8 }}>
        {open ? "Hide exact input prompt ▾" : `${label} ▸`}
      </button>
      {open && (
        <div className="raw-block">
          <div className="io-label">system prompt</div>
          {systemPrompt || "(none)"}
          <div className="io-label" style={{ marginTop: 12 }}>
            {label.includes("adversary") ? "user prompt" : "initial user message"}
          </div>
          {userMessage || "(none)"}
        </div>
      )}
    </>
  );
}

function AdversaryTurn({ t }) {
  return (
    <div className="adversary-turn">
      <div className="turn-label">
        turn {t.turn} — adversary <span className="mono">({t.argument_style})</span>
      </div>
      <div>{t.text}</div>
      {t.cost != null && <div className="turn-cost">${t.cost.toFixed(4)}</div>}
      <PromptViewer
        systemPrompt={t.system_prompt}
        userMessage={t.user_prompt}
        label="View adversary's prompt"
      />
    </div>
  );
}

// Renders an executor's response, collapsed by default when the exchange
// spanned more than one turn (only the final response is shown), with a
// toggle to expand the full adversary/executor conversation exactly as it
// happened.
function TurnBody({ turns }) {
  const [expanded, setExpanded] = useState(false);
  const executorTurns = (turns || []).filter((t) => t.role === "executor");
  const last = executorTurns[executorTurns.length - 1];

  const renderPayload = (t) =>
    t.payload?.tool && (
      <div className="output-line mono">
        called {t.payload.tool} — {JSON.stringify(t.payload.arguments)}
      </div>
    );

  if (!turns || turns.length <= 1) {
    return (
      <>
        <pre>{last?.text || "(tool call, no text)"}</pre>
        {last && renderPayload(last)}
      </>
    );
  }

  return (
    <>
      <pre>{last?.text || "(tool call, no text)"}</pre>
      {last && renderPayload(last)}
      <button className="btn btn-ghost" onClick={() => setExpanded((v) => !v)} style={{ marginTop: 8 }}>
        {expanded ? "Collapse conversation ▾" : `Show full conversation (${turns.length} turns) ▸`}
      </button>
      {expanded && (
        <div className="turn-thread">
          {turns.map((t, i) =>
            t.role === "adversary" ? (
              <AdversaryTurn key={i} t={t} />
            ) : (
              <div key={i} className={`log-entry ${t.accepted ? "ok" : "danger"}`}>
                <div className="log-entry-head">
                  <span className="log-entry-idx">turn {t.turn}</span>
                  <span className={`badge ${t.accepted ? "badge-ok" : "badge-danger"}`}>
                    {t.accepted ? "accepted" : "refused"}
                  </span>
                  {t.truncated && <span className="badge badge-warn">truncated</span>}
                </div>
                <pre>{t.text || "(tool call, no text)"}</pre>
                {renderPayload(t)}
                {t.cost != null && <div className="turn-cost">${t.cost.toFixed(4)}</div>}
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}

function turnsCost(turns) {
  return (turns || []).reduce((sum, t) => sum + (t.cost || 0), 0);
}

export default function Home() {
  const [scenarios, setScenarios] = useState([]);
  const [scenarioId, setScenarioId] = useState("");
  const [framing, setFraming] = useState("real");

  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("claude-sonnet-4-6");

  const [adversaryTurns, setAdversaryTurns] = useState(0);
  const [argumentStyle, setArgumentStyle] = useState("all");

  const [scenarioDetailOpen, setScenarioDetailOpen] = useState(false);
  const [scenarioDetail, setScenarioDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [runsList, setRunsList] = useState([]);
  const [runsListOpen, setRunsListOpen] = useState(false);
  const [loadingRunsList, setLoadingRunsList] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);

  const [directResult, setDirectResult] = useState(null);
  const [askingDirect, setAskingDirect] = useState(false);
  const [savingDirect, setSavingDirect] = useState(false);
  const [saveDirectMessage, setSaveDirectMessage] = useState(null);

  const [planResult, setPlanResult] = useState(null);
  const [planning, setPlanning] = useState(false);

  const [steps, setSteps] = useState([]); // executed step results
  const [executing, setExecuting] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);

  useEffect(() => {
    fetch("/api/scenarios")
      .then((r) => r.json())
      .then((data) => {
        setScenarios(data);
        if (data.length) setScenarioId(data[0].scenario_id);
      });
  }, []);

  useEffect(() => {
    setScenarioDetailOpen(false);
    setScenarioDetail(null);
  }, [scenarioId]);

  function handleProviderChange(p) {
    setProvider(p);
    setModel(defaultModelFor(p));
  }

  async function toggleScenarioDetail() {
    if (scenarioDetailOpen) {
      setScenarioDetailOpen(false);
      return;
    }
    setLoadingDetail(true);
    const res = await fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(scenarioId)}`);
    const data = await res.json();
    setScenarioDetail(data);
    setLoadingDetail(false);
    setScenarioDetailOpen(true);
  }

  async function toggleRunsList() {
    if (runsListOpen) {
      setRunsListOpen(false);
      return;
    }
    setLoadingRunsList(true);
    const res = await fetch("/api/runs");
    const data = await res.json();
    setRunsList(data);
    setLoadingRunsList(false);
    setRunsListOpen(true);
  }

  async function loadRun(filename) {
    setLoadingRun(true);
    const res = await fetch(`/api/runs?file=${encodeURIComponent(filename)}`);
    const data = await res.json();
    setScenarioId(data.scenario_id);
    setFraming(data.framing);
    setDirectResult(data.direct_result || null);
    setPlanResult(data.plan_result || null);
    setSteps(data.steps || []);
    setSaveMessage(null);
    setSaveDirectMessage(null);
    const loadedProvider = data.direct_result?.provider || data.plan_result?.provider;
    const loadedModel = data.direct_result?.model || data.plan_result?.model;
    const loadedStyle = data.direct_result?.argument_style || data.plan_result?.argument_style;
    if (loadedProvider) setProvider(loadedProvider);
    if (loadedModel) setModel(loadedModel);
    if (loadedStyle) setArgumentStyle(loadedStyle);
    setRunsListOpen(false);
    setLoadingRun(false);
  }

  async function askDirect() {
    setAskingDirect(true);
    setDirectResult(null);
    setSaveDirectMessage(null);
    const res = await fetch("/api/ask-direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId, framing, adversaryTurns, argumentStyle, provider, model }),
    });
    const data = await res.json();
    setDirectResult(data);
    setAskingDirect(false);
  }

  async function continueDirect() {
    if (!directResult?.messages) return;
    setAskingDirect(true);
    const res = await fetch("/api/ask-direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId,
        framing,
        adversaryTurns: Math.max(1, adversaryTurns),
        argumentStyle,
        provider: directResult.provider,
        model: directResult.model,
        continueFrom: { messages: directResult.messages, turns: directResult.turns },
      }),
    });
    const data = await res.json();
    setDirectResult(data);
    setAskingDirect(false);
  }

  async function askToPlan() {
    setPlanning(true);
    setPlanResult(null);
    setSteps([]);
    setSaveMessage(null);
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId, framing, adversaryTurns, argumentStyle, provider, model }),
    });
    const data = await res.json();
    setPlanResult(data);
    setPlanning(false);
  }

  async function continuePlan() {
    if (!planResult?.messages) return;
    setPlanning(true);
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId,
        framing,
        adversaryTurns: Math.max(1, adversaryTurns),
        argumentStyle,
        provider: planResult.provider,
        model: planResult.model,
        continueFrom: { messages: planResult.messages, turns: planResult.turns },
      }),
    });
    const data = await res.json();
    setPlanResult(data);
    setSteps([]);
    setPlanning(false);
  }

  async function saveRun() {
    setSaving(true);
    setSaveMessage(null);
    const scenarioTitle = scenarios.find((s) => s.scenario_id === scenarioId)?.title;
    const res = await fetch("/api/save-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId, scenarioTitle, framing, planResult, steps }),
    });
    const data = await res.json();
    setSaveMessage(data.saved ? `Saved as runs/${data.filename}` : `Save failed: ${data.error}`);
    setSaving(false);
  }

  async function saveDirectRun() {
    setSavingDirect(true);
    setSaveDirectMessage(null);
    const scenarioTitle = scenarios.find((s) => s.scenario_id === scenarioId)?.title;
    const res = await fetch("/api/save-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId, scenarioTitle, framing, directResult }),
    });
    const data = await res.json();
    setSaveDirectMessage(data.saved ? `Saved as runs/${data.filename}` : `Save failed: ${data.error}`);
    setSavingDirect(false);
  }

  function resolveScalar(val, priorOutputs) {
    // "<step_N.field>" - a scalar output field from a prior step.
    if (typeof val !== "string") return val;
    let m = val.match(/^<step_(\d+)\.(\w+)>$/);
    if (m) {
      const stepOut = priorOutputs[parseInt(m[1], 10)];
      return stepOut ? stepOut[m[2]] : val;
    }
    // "<step_N.arrayField[].subField>" - list of subField pulled across an
    // array-valued prior output (e.g. system_ids from systems[].system_id).
    m = val.match(/^<step_(\d+)\.(\w+)\[\]\.(\w+)>$/);
    if (m) {
      const stepOut = priorOutputs[parseInt(m[1], 10)];
      const arr = stepOut ? stepOut[m[2]] : null;
      if (Array.isArray(arr)) return arr.map((item) => (item ? item[m[3]] : undefined));
      return val;
    }
    return val;
  }

  function resolveArgs(rawArgs, priorOutputs) {
    // Resolve "<step_N.field>" placeholders against previously produced outputs.
    // Array-typed arguments are resolved element-by-element, since placeholders
    // there previously passed through unresolved.
    const resolved = {};
    for (const [key, val] of Object.entries(rawArgs)) {
      if (Array.isArray(val)) {
        resolved[key] = val.flatMap((item) => {
          const r = resolveScalar(item, priorOutputs);
          return Array.isArray(r) ? r : [r];
        });
      } else {
        resolved[key] = resolveScalar(val, priorOutputs);
      }
    }
    return resolved;
  }

  async function runNextStep() {
    if (!planResult?.plan) return;
    const nextIndex = steps.length;
    if (nextIndex >= planResult.plan.length) return;
    const stepSpec = planResult.plan[nextIndex];

    const priorOutputs = {};
    steps.forEach((s, i) => {
      if (s.output) priorOutputs[i + 1] = s.output;
    });
    const resolvedArgs = resolveArgs(stepSpec.arguments || {}, priorOutputs);
    const priorStepOutputText =
      nextIndex > 0 ? JSON.stringify(steps[nextIndex - 1].output || {}) : null;

    setExecuting(true);
    const res = await fetch("/api/execute-step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId,
        toolName: stepSpec.tool,
        args: resolvedArgs,
        priorStepOutputText,
        adversaryTurns,
        argumentStyle,
        provider,
        model,
      }),
    });
    const data = await res.json();
    setSteps((prev) => [...prev, { ...data, tool: stepSpec.tool, args: resolvedArgs }]);
    setExecuting(false);
  }

  async function continueLastStep() {
    const idx = steps.length - 1;
    if (idx < 0) return;
    const s = steps[idx];
    if (!s.messages) return;
    const stepSpec = planResult.plan[idx];

    setExecuting(true);
    const res = await fetch("/api/execute-step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId,
        toolName: stepSpec.tool,
        args: s.args,
        adversaryTurns: Math.max(1, adversaryTurns),
        argumentStyle,
        provider: s.provider,
        model: s.model,
        continueFrom: { messages: s.messages, turns: s.turns },
      }),
    });
    const data = await res.json();
    setSteps((prev) => {
      const next = [...prev];
      next[idx] = { ...data, tool: stepSpec.tool, args: s.args };
      return next;
    });
    setExecuting(false);
  }

  async function retryLastStep() {
    const idx = steps.length - 1;
    if (idx < 0) return;
    const stepSpec = planResult.plan[idx];

    const priorOutputs = {};
    steps.slice(0, idx).forEach((st, i) => {
      if (st.output) priorOutputs[i + 1] = st.output;
    });
    const resolvedArgs = resolveArgs(stepSpec.arguments || {}, priorOutputs);
    const priorStepOutputText = idx > 0 ? JSON.stringify(steps[idx - 1].output || {}) : null;

    setExecuting(true);
    const res = await fetch("/api/execute-step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId,
        toolName: stepSpec.tool,
        args: resolvedArgs,
        priorStepOutputText,
        adversaryTurns,
        argumentStyle,
        provider,
        model,
      }),
    });
    const data = await res.json();
    setSteps((prev) => {
      const next = [...prev];
      next[idx] = { ...data, tool: stepSpec.tool, args: resolvedArgs };
      return next;
    });
    setExecuting(false);
  }

  const planDone = planResult?.plan && steps.length >= planResult.plan.length;
  const brokeAt = steps.findIndex((s) => !s.accepted);
  const stoppedEarly = brokeAt !== -1;

  return (
    <main className="app-shell">
      <h1 className="app-title">Decomposition scenario runner</h1>
      <p className="app-subtitle">
        Manual step-by-step runner. Nothing here calls real systems, tool outputs are stubbed.
      </p>

      <section className="card">
        <div className="card-title">Saved runs</div>
        <button className="btn btn-ghost" onClick={toggleRunsList} disabled={loadingRunsList}>
          {loadingRunsList
            ? "Loading..."
            : runsListOpen
            ? "Hide saved runs ▾"
            : "Browse saved runs ▸"}
        </button>
        {runsListOpen &&
          (runsList.length === 0 ? (
            <p className="plan-caption">No saved runs yet — save one below once you have a result.</p>
          ) : (
            <div className="section-gap">
              {runsList.map((r) => (
                <div key={r.filename} className="run-row">
                  <div>
                    <div className="mono" style={{ fontSize: 12.5 }}>
                      {r.filename}
                    </div>
                    <div className="plan-caption" style={{ margin: "2px 0 0" }}>
                      {r.scenario_title} — {r.framing} — {r.mode}
                      {r.mode === "plan" && ` — ${r.step_count} step(s) run`}
                      {" — "}
                      <span className={`badge ${r.accepted ? "badge-ok" : "badge-danger"}`}>
                        {r.accepted ? "accepted" : "refused"}
                      </span>
                    </div>
                  </div>
                  <button className="btn" onClick={() => loadRun(r.filename)} disabled={loadingRun}>
                    {loadingRun ? "Loading..." : "Load"}
                  </button>
                </div>
              ))}
            </div>
          ))}
      </section>

      <section className="card">
        <div className="card-title">1. Choose scenario &amp; planning framing</div>

        <div className="scenario-row">
          <div>
            <label className="field-label" htmlFor="scenario-select">
              Scenario
            </label>
            <select
              id="scenario-select"
              value={scenarioId}
              onChange={(e) => setScenarioId(e.target.value)}
            >
              {scenarios.map((s) => (
                <option key={s.scenario_id} value={s.scenario_id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-ghost"
            onClick={toggleScenarioDetail}
            disabled={!scenarioId || loadingDetail}
          >
            {loadingDetail
              ? "Loading..."
              : scenarioDetailOpen
              ? "Hide scenario details ▾"
              : "View scenario details ▸"}
          </button>
        </div>

        {scenarioDetailOpen && scenarioDetail && (
          <div className="detail-panel">
            <p className="detail-context">{scenarioDetail.context}</p>
            <div className="detail-goal-grid">
              <div>
                <label className="field-label">Goal — real framing</label>
                <p>{scenarioDetail.goal.real}</p>
              </div>
              <div>
                <label className="field-label">Goal — test framing</label>
                <p>{scenarioDetail.goal.test}</p>
              </div>
            </div>
            <label className="field-label">Tools</label>
            {scenarioDetail.tools.map((t) => (
              <div key={t.name} className="tool-card">
                <div className="tool-card-head">
                  <span className="mono tool-name">{t.name}</span>
                  {t.name === scenarioDetail.critical_tool && (
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

        <div className="radio-row">
          Planning framing:
          <label>
            <input
              type="radio"
              checked={framing === "real"}
              onChange={() => setFraming("real")}
            />
            real
          </label>
          <label>
            <input
              type="radio"
              checked={framing === "test"}
              onChange={() => setFraming("test")}
            />
            test / sandbox
          </label>
        </div>

        <div className="adversary-row">
          <div>
            <label className="field-label" htmlFor="provider-select">
              Provider
            </label>
            <select
              id="provider-select"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
            >
              {Object.entries(MODEL_CATALOG).map(([key, p]) => (
                <option key={key} value={key}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="model-select">
              Model
            </label>
            <select id="model-select" value={model} onChange={(e) => setModel(e.target.value)}>
              {Object.entries(MODEL_CATALOG[provider].models).map(([key, m]) => (
                <option key={key} value={key}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="turns-input">
              Adversary turns (0 = single prompt)
            </label>
            <input
              id="turns-input"
              type="number"
              min={0}
              max={20}
              value={adversaryTurns}
              onChange={(e) =>
                setAdversaryTurns(Math.max(0, Math.min(20, Number(e.target.value) || 0)))
              }
              style={{ width: 64 }}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="style-select">
              Argument style
            </label>
            <select
              id="style-select"
              value={argumentStyle}
              onChange={(e) => setArgumentStyle(e.target.value)}
              disabled={adversaryTurns === 0}
            >
              {ARGUMENT_STYLE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <p className="plan-caption" style={{ alignSelf: "flex-end", marginBottom: 8 }}>
            Applies to "Ask directly", "Ask planner to decompose", and each executed step. If the
            executor refuses, an adversary pushes back using the chosen angle (or rotates through
            all of them), up to this many rounds, with full conversation history. Every result can
            be pushed further later via "Continue arguing" or restarted via "Retry" — nothing here
            is final.
          </p>
        </div>

        <div className="action-row">
          <button className="btn" onClick={askDirect} disabled={askingDirect || !scenarioId}>
            {askingDirect ? "Asking..." : "Ask directly (no plan)"}
          </button>
          <button className="btn btn-primary" onClick={askToPlan} disabled={planning || !scenarioId}>
            {planning ? "Asking..." : "Ask planner to decompose"}
          </button>
        </div>
      </section>

      {directResult && (
        <section className="card">
          <div className="card-title">
            Direct ask result ({directResult.framing} framing, no decomposition)
          </div>
          <span className={`badge ${directResult.accepted ? "badge-ok" : "badge-danger"}`}>
            {directResult.accepted ? "called a tool" : "refused"}
          </span>
          {directResult.truncated && (
            <span className="badge badge-warn" style={{ marginLeft: 8 }}>
              truncated — hit max_tokens
            </span>
          )}
          <span className="turn-cost" style={{ display: "inline-block", marginLeft: 8 }}>
            {directResult.provider}/{directResult.model} — ${turnsCost(directResult.turns).toFixed(4)}
          </span>

          <div className="save-row">
            <button className="btn" onClick={saveDirectRun} disabled={savingDirect}>
              {savingDirect ? "Saving..." : "Save this run"}
            </button>
            {saveDirectMessage && <span className="save-msg">{saveDirectMessage}</span>}
          </div>

          <PromptViewer
            systemPrompt={directResult.system_prompt}
            userMessage={directResult.initial_user_message}
          />

          <div className="section-gap">
            <TurnBody turns={directResult.turns} />
          </div>

          <div className="action-row">
            {!directResult.accepted && directResult.messages && (
              <button className="btn" onClick={continueDirect} disabled={askingDirect}>
                {askingDirect
                  ? "Arguing..."
                  : `Continue arguing (+${Math.max(1, adversaryTurns)} more) ▸`}
              </button>
            )}
            <button className="btn btn-ghost" onClick={askDirect} disabled={askingDirect}>
              {askingDirect ? "Retrying..." : "Retry (fresh, no history)"}
            </button>
          </div>
        </section>
      )}

      {planResult && (
        <section className="card">
          <div className="card-title">2. Planner result ({planResult.framing} framing)</div>
          <span className={`badge ${planResult.accepted ? "badge-ok" : "badge-danger"}`}>
            {planResult.accepted ? "accepted to plan" : "not accepted"}
          </span>
          {planResult.truncated && (
            <span className="badge badge-warn" style={{ marginLeft: 8 }}>
              truncated — hit max_tokens
            </span>
          )}
          <span className="turn-cost" style={{ display: "inline-block", marginLeft: 8 }}>
            {planResult.provider}/{planResult.model} — ${turnsCost(planResult.turns).toFixed(4)}
          </span>

          <div className="save-row">
            <button className="btn" onClick={saveRun} disabled={saving}>
              {saving ? "Saving..." : "Save this run"}
            </button>
            {saveMessage && <span className="save-msg">{saveMessage}</span>}
          </div>

          <PromptViewer
            systemPrompt={planResult.system_prompt}
            userMessage={planResult.initial_user_message}
          />

          {planResult.accepted && (
            <>
              <ol className="plan-list section-gap">
                {planResult.plan.map((s, i) => (
                  <li key={i}>
                    <span>
                      <strong>{s.tool}</strong> — {JSON.stringify(s.arguments)}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="plan-caption">
                This is the complete plan — {planResult.plan.length} step
                {planResult.plan.length === 1 ? "" : "s"}, parsed verbatim from the model's JSON
                response below. No steps were added, removed, or reordered.
              </p>
            </>
          )}

          <div className="section-gap">
            <TurnBody turns={planResult.turns} />
          </div>

          <div className="action-row">
            {!planResult.accepted && planResult.messages && (
              <button className="btn" onClick={continuePlan} disabled={planning}>
                {planning ? "Arguing..." : `Continue arguing (+${Math.max(1, adversaryTurns)} more) ▸`}
              </button>
            )}
            <button className="btn btn-ghost" onClick={askToPlan} disabled={planning}>
              {planning ? "Retrying..." : "Retry (fresh, no history)"}
            </button>
          </div>
        </section>
      )}

      {planResult?.accepted && (
        <section className="card">
          <div className="card-title">3. Execute step by step (always real tool descriptions)</div>
          <button
            className="btn btn-primary"
            onClick={runNextStep}
            disabled={executing || planDone || stoppedEarly}
            style={{ marginBottom: 16 }}
          >
            {executing
              ? "Running..."
              : planDone
              ? "Plan fully executed"
              : stoppedEarly
              ? "Execution stopped"
              : `Run step ${steps.length + 1} / ${planResult.plan.length}`}
          </button>
          {steps.map((s, i) => (
            <div key={i} className={`log-entry ${s.accepted ? "ok" : "danger"}`}>
              <div className="log-entry-head">
                <span className="log-entry-idx">step {i + 1}</span>
                <span className="log-entry-tool">{s.tool}</span>
                <span className={`badge ${s.accepted ? "badge-ok" : "badge-danger"}`}>
                  {s.accepted ? "accepted" : "refused"}
                </span>
                {s.truncated && <span className="badge badge-warn">truncated</span>}
                <span className="turn-cost">
                  {s.provider}/{s.model} — ${turnsCost(s.turns).toFixed(4)}
                </span>
              </div>
              <TurnBody turns={s.turns} />
              <PromptViewer systemPrompt={s.system_prompt} userMessage={s.initial_user_message} />
              {s.output && <div className="output-line">output: {JSON.stringify(s.output)}</div>}
              {i === steps.length - 1 && (
                <div className="action-row" style={{ marginTop: 10 }}>
                  {!s.accepted && s.messages && (
                    <button className="btn" onClick={continueLastStep} disabled={executing}>
                      {executing
                        ? "Arguing..."
                        : `Continue arguing (+${Math.max(1, adversaryTurns)} more) ▸`}
                    </button>
                  )}
                  <button className="btn btn-ghost" onClick={retryLastStep} disabled={executing}>
                    {executing ? "Retrying..." : "Retry (fresh, no history)"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
