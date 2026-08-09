"use client";

import { useEffect, useState } from "react";
import { MODEL_CATALOG } from "../../lib/models";
import { ARGUMENT_STYLES } from "../../lib/adversarial";

const ANTHROPIC_MODELS = Object.keys(MODEL_CATALOG.anthropic.models);
const STYLE_KEYS = Object.keys(ARGUMENT_STYLES);

function defaultBatchId(pipeline) {
  return `${pipeline}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

const STATUS_BADGE = {
  pending: { className: "badge-neutral", label: "pending" },
  running: { className: "badge-warn", label: "running" },
  done: { className: "badge-ok", label: "done" },
  error: { className: "badge-danger", label: "error" },
};

function BatchTracker({ batchId }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer;

    async function poll() {
      try {
        const res = await fetch(`/api/batch/status?batchId=${encodeURIComponent(batchId)}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || `HTTP ${res.status}`);
          return;
        }
        setStatus(data);
        if (data.status === "running") {
          timer = setTimeout(poll, 3000);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [batchId]);

  if (error) return <p style={{ color: "var(--danger)" }}>Failed to load status: {error}</p>;
  if (!status) return <p className="plan-caption">Loading…</p>;

  return (
    <div>
      <p className="plan-caption">
        Status: <span className={`badge ${STATUS_BADGE[status.status]?.className || "badge-neutral"}`}>{status.status}</span>
        {" — "}cumulative cost: <span className="mono">${status.cumulativeCost.toFixed(4)}</span>
      </p>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Scenario</th>
            <th>Style</th>
            <th>Status</th>
            <th>Accepted</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {status.attempts.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.model}</td>
              <td>{a.scenario}</td>
              <td>{a.style}</td>
              <td>
                <span className={`badge ${STATUS_BADGE[a.status]?.className || "badge-neutral"}`}>{a.status}</span>
              </td>
              <td>{a.accepted === null ? "—" : a.accepted ? "yes" : "no"}</td>
              <td className="mono">${a.cost.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CheckboxGroup({ label, options, selected, onToggle, renderLabel }) {
  return (
    <div className="form-field">
      <label>{label}</label>
      <div className="checkbox-group">
        {options.map((opt) => (
          <label key={opt} className="checkbox-item">
            <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(opt)} />
            {renderLabel ? renderLabel(opt) : opt}
          </label>
        ))}
      </div>
    </div>
  );
}

export default function BatchLauncher() {
  const [scenarios, setScenarios] = useState([]);
  const [pipeline, setPipeline] = useState("linear");
  const [selectedScenarios, setSelectedScenarios] = useState([]);
  const [selectedModels, setSelectedModels] = useState([]);
  const [selectedStyles, setSelectedStyles] = useState([]);
  const [maxTurns, setMaxTurns] = useState(10);
  const [budget, setBudget] = useState(15);
  const [batchId, setBatchId] = useState(defaultBatchId("linear"));
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState(null);
  const [launchedBatchId, setLaunchedBatchId] = useState(null);

  useEffect(() => {
    fetch("/api/scenarios")
      .then((r) => r.json())
      .then(setScenarios);
  }, []);

  function handlePipelineChange(p) {
    setPipeline(p);
    setBatchId(defaultBatchId(p));
  }

  function toggle(list, setList, value) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function handleLaunch() {
    setLaunching(true);
    setLaunchError(null);
    const res = await fetch("/api/batch/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline,
        models: selectedModels,
        scenarios: selectedScenarios,
        styles: selectedStyles,
        maxTurns: Number(maxTurns),
        budget: Number(budget),
        batchId,
      }),
    });
    const data = await res.json();
    setLaunching(false);
    if (!res.ok) {
      setLaunchError(data.error || `HTTP ${res.status}`);
      return;
    }
    setLaunchedBatchId(batchId);
  }

  const canLaunch =
    !launching && selectedScenarios.length > 0 && selectedModels.length > 0 && selectedStyles.length > 0;

  if (launchedBatchId) {
    return (
      <main className="app-shell">
        <h1>Batch launched</h1>
        <p className="plan-caption">
          Batch ID: <span className="mono">{launchedBatchId}</span>
        </p>
        <BatchTracker batchId={launchedBatchId} />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <h1>Launch a batch</h1>

      <div className="form-field">
        <label>Pipeline</label>
        <div className="checkbox-group">
          {["linear", "chained"].map((p) => (
            <label key={p} className="checkbox-item">
              <input type="radio" name="pipeline" checked={pipeline === p} onChange={() => handlePipelineChange(p)} />
              {p}
            </label>
          ))}
        </div>
      </div>

      <CheckboxGroup
        label="Scenarios"
        options={scenarios.map((s) => s.scenario_id)}
        selected={selectedScenarios}
        onToggle={(v) => toggle(selectedScenarios, setSelectedScenarios, v)}
        renderLabel={(id) => scenarios.find((s) => s.scenario_id === id)?.title || id}
      />

      <CheckboxGroup
        label="Models"
        options={ANTHROPIC_MODELS}
        selected={selectedModels}
        onToggle={(v) => toggle(selectedModels, setSelectedModels, v)}
      />

      <CheckboxGroup
        label="Argument styles"
        options={STYLE_KEYS}
        selected={selectedStyles}
        onToggle={(v) => toggle(selectedStyles, setSelectedStyles, v)}
      />

      <div className="form-field">
        <label>Max turns</label>
        <input type="number" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} min={1} />
      </div>

      <div className="form-field">
        <label>Budget (USD)</label>
        <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} min={0} step={0.5} />
      </div>

      <div className="form-field">
        <label>Batch ID</label>
        <input type="text" value={batchId} onChange={(e) => setBatchId(e.target.value)} />
      </div>

      {launchError && <p style={{ color: "var(--danger)" }}>Launch failed: {launchError}</p>}

      <button className="btn" disabled={!canLaunch} onClick={handleLaunch}>
        {launching ? "Launching..." : "Launch batch"}
      </button>
    </main>
  );
}
