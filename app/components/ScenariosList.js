"use client";

import { useEffect, useState } from "react";
import ScenarioDetailModal from "./ScenarioDetailModal";

export default function ScenariosList({ userEmail }) {
  const [scenarios, setScenarios] = useState(null);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  function load() {
    fetch("/api/scenarios")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setScenarios)
      .catch((e) => setError(e.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDelete(scenarioId) {
    if (
      !window.confirm(
        `Delete scenario "${scenarioId}"? It stays visible on runs that already used it, but disappears from this list and the scenario picker.`
      )
    ) {
      return;
    }
    setDeleting(scenarioId);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(scenarioId)}`, {
        method: "DELETE",
      });
      // A 500 can come back with an empty body, so parsing has to be
      // allowed to fail without leaving the button stuck on "Deleting…".
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(data.error || `delete failed (HTTP ${res.status})`);
        return;
      }
      load();
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <main className="app-shell" style={{ maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="app-title">Scenarios</h1>
          <p className="app-subtitle" style={{ marginBottom: 20 }}>
            Create, edit, or copy the scenarios available to every pipeline.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/scenarios/generate" className="btn btn-primary" style={{ whiteSpace: "nowrap" }}>
            Generate scenario
          </a>
          <a href="/scenarios/new" className="btn btn-primary" style={{ whiteSpace: "nowrap" }}>
            Create scenario
          </a>
          <a href="/dashboard" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
            ← Back to dashboard
          </a>
        </div>
      </div>

      {error && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Failed to load scenarios: {error}</p>
        </div>
      )}
      {deleteError && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Delete failed: {deleteError}</p>
        </div>
      )}

      {!scenarios && !error && <p className="plan-caption">Loading…</p>}

      {scenarios && (
        <section className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="re-table-scroll">
            <table className="re-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>scenario_id</th>
                  <th>Dilemma</th>
                  <th>Created by</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((s) => {
                  const mine = userEmail && s.created_by === userEmail;
                  return (
                    <tr key={s.scenario_id}>
                      <td>{s.title}</td>
                      <td className="mono re-muted">{s.scenario_id}</td>
                      <td>{s.dilemma_id || "—"}</td>
                      <td className="re-muted">{s.created_by}</td>
                      <td>
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                          <button className="btn btn-ghost" onClick={() => setViewing(s)}>
                            View
                          </button>
                          <a className="btn btn-ghost" href={`/scenarios/new?copyFrom=${encodeURIComponent(s.scenario_id)}`}>
                            Copy
                          </a>
                          {mine && (
                            <a className="btn btn-ghost" href={`/scenarios/${encodeURIComponent(s.scenario_id)}/edit`}>
                              Edit
                            </a>
                          )}
                          {mine && (
                            <button
                              className="btn btn-ghost"
                              style={{ color: "var(--danger)" }}
                              disabled={deleting === s.scenario_id}
                              onClick={() => handleDelete(s.scenario_id)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {scenarios.length === 0 && (
                  <tr>
                    <td colSpan={5} className="re-muted" style={{ textAlign: "center", padding: 24 }}>
                      No scenarios yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ScenarioDetailModal scenarioId={viewing?.scenario_id} scenarioTitle={viewing?.title} onClose={() => setViewing(null)} />
    </main>
  );
}
