"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MODEL_CATALOG } from "../../lib/models";
// Data-only module on purpose — importing this from lib/adversarial.js would
// pull lib/providers.js (server-only, holds the API keys) into this client
// component's module graph.
import { ARGUMENT_STYLES } from "../../lib/argumentStyles";

const ANTHROPIC_MODELS = Object.keys(MODEL_CATALOG.anthropic.models);
const STYLE_KEYS = Object.keys(ARGUMENT_STYLES);

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_BUDGET = 15;

const POLL_INTERVAL_MS = 3000;
// The trigger route returns as soon as Cloud Run *accepts* the job — the
// container still has to boot before its first saveState() creates the
// batches row, so /api/batch/status legitimately 404s for the first few
// polls. Only past this window is a missing row a real failure.
const STARTUP_GRACE_MS = 60000;

function defaultBatchId(pipeline) {
  return `${pipeline}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

const STATUS_BADGE = {
  pending: { className: "badge-neutral", label: "pending" },
  running: { className: "badge-warn", label: "running" },
  done: { className: "badge-ok", label: "done" },
  error: { className: "badge-danger", label: "error" },
  stalled: { className: "badge-danger", label: "stalled" },
};

function BatchTracker({ batchId }) {
  const [status, setStatus] = useState(null);
  // `error` is terminal (polling has stopped); `notice` is transient — the
  // loop keeps running and the last known table stays on screen.
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const startedAt = Date.now();
    setStatus(null);
    setError(null);
    setNotice(null);

    async function poll() {
      try {
        const res = await fetch(`/api/batch/status?batchId=${encodeURIComponent(batchId)}`);
        if (cancelled) return;

        if (res.status === 404) {
          if (Date.now() - startedAt < STARTUP_GRACE_MS) {
            setNotice("Starting up — waiting for the batch container to report in…");
            timer = setTimeout(poll, POLL_INTERVAL_MS);
          } else {
            setError(
              `No status for batch "${batchId}" after ${Math.round(STARTUP_GRACE_MS / 1000)}s — the job may have failed to start.`
            );
          }
          return;
        }

        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (res.status === 400) {
          // A bad request never fixes itself by retrying.
          setError(data.error || `HTTP ${res.status}`);
          return;
        }
        if (!res.ok) {
          // Transient (5xx, proxy blip) — keep the last good table on screen
          // and keep polling on the same cadence instead of latching dead.
          setNotice(`Reconnecting… (${data.error || `HTTP ${res.status}`})`);
          timer = setTimeout(poll, POLL_INTERVAL_MS);
          return;
        }

        setNotice(null);
        setStatus(data);
        if (data.status === "running") {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (e) {
        if (cancelled) return;
        setNotice(`Reconnecting… (${e.message})`);
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [batchId]);

  if (error) return <p style={{ color: "var(--danger)" }}>Failed to load status: {error}</p>;
  if (!status) return <p className="plan-caption">{notice || "Loading…"}</p>;

  return (
    <div>
      <p className="plan-caption">
        Status: <span className={`badge ${STATUS_BADGE[status.status]?.className || "badge-neutral"}`}>{status.status}</span>
        {" — "}cumulative cost: <span className="mono">${status.cumulativeCost.toFixed(4)}</span>
      </p>
      {notice && <p className="plan-caption">{notice}</p>}
      <div className="datatable-scroll">
        <table className="datatable">
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

function BatchLauncher() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The tracked batch lives in the URL, not in component state, so a reload
  // mid-run resumes tracking instead of dropping back to an empty form.
  const trackedBatchId = searchParams.get("batchId");

  const [scenarios, setScenarios] = useState([]);
  const [scenariosError, setScenariosError] = useState(null);
  const [pipeline, setPipeline] = useState("linear");
  const [selectedScenarios, setSelectedScenarios] = useState([]);
  const [selectedModels, setSelectedModels] = useState([]);
  const [selectedStyles, setSelectedStyles] = useState([]);
  const [maxTurns, setMaxTurns] = useState(DEFAULT_MAX_TURNS);
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [batchId, setBatchId] = useState(() => defaultBatchId("linear"));
  // The last value we auto-generated. If the field still holds it, the user
  // hasn't typed their own id and it's safe to regenerate on pipeline switch.
  const [autoBatchId, setAutoBatchId] = useState(batchId);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState(null);

  useEffect(() => {
    fetch("/api/scenarios")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => setScenarios(Array.isArray(data) ? data : []))
      .catch((e) => setScenariosError(e.message));
  }, []);

  function handlePipelineChange(p) {
    setPipeline(p);
    if (batchId === autoBatchId) {
      const next = defaultBatchId(p);
      setBatchId(next);
      setAutoBatchId(next);
    }
  }

  function toggle(list, setList, value) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function handleLaunch() {
    setLaunching(true);
    setLaunchError(null);
    try {
      const res = await fetch("/api/batch/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline,
          models: selectedModels,
          scenarios: selectedScenarios,
          styles: selectedStyles,
          // Both fall back to the form's own defaults when the field is
          // cleared — an empty Budget must not become "abort on turn one".
          maxTurns: Number(maxTurns) || DEFAULT_MAX_TURNS,
          budget: Number(budget) || DEFAULT_BUDGET,
          batchId: batchId.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLaunchError(data.error || `HTTP ${res.status}`);
        return;
      }
      router.replace(`/batch?batchId=${encodeURIComponent(batchId.trim())}`);
    } catch (e) {
      setLaunchError(e.message);
    } finally {
      setLaunching(false);
    }
  }

  const canLaunch =
    !launching &&
    batchId.trim().length > 0 &&
    selectedScenarios.length > 0 &&
    selectedModels.length > 0 &&
    selectedStyles.length > 0;

  if (trackedBatchId) {
    return (
      <main className="app-shell">
        <h1>Batch</h1>
        <p className="plan-caption">
          Batch ID: <span className="mono">{trackedBatchId}</span>
        </p>
        <BatchTracker batchId={trackedBatchId} />
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

      {scenariosError && <p style={{ color: "var(--danger)" }}>Failed to load scenarios: {scenariosError}</p>}

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
        renderLabel={(key) => <span title={ARGUMENT_STYLES[key]}>{key}</span>}
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

export default function BatchPage() {
  // useSearchParams() needs a Suspense boundary to keep the rest of the
  // route from opting the whole page out of static rendering at build time.
  return (
    <Suspense fallback={<main className="app-shell"><p className="plan-caption">Loading…</p></main>}>
      <BatchLauncher />
    </Suspense>
  );
}
