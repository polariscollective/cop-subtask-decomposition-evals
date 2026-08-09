"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ScenarioForm, { docToFormState } from "./ScenarioForm";

export default function EditScenarioForm({ scenarioId, userEmail }) {
  const router = useRouter();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(scenarioId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [scenarioId]);

  async function handleSubmit(doc) {
    const res = await fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(scenarioId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      router.push("/scenarios");
      return { ok: true };
    }
    return { ok: false, errors: data.errors, error: data.error };
  }

  return (
    <main className="app-shell" style={{ maxWidth: 880 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="app-title">Edit scenario</h1>
          <p className="app-subtitle" style={{ marginBottom: 20 }}>
            <span className="mono">{scenarioId}</span>
          </p>
        </div>
        <a href="/scenarios" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
          ← Back to scenarios
        </a>
      </div>

      {error && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Failed to load: {error}</p>
        </div>
      )}

      {!detail && !error && <p className="plan-caption">Loading…</p>}

      {detail && detail.created_by !== userEmail && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Only the creator ({detail.created_by}) can edit this scenario.</p>
        </div>
      )}

      {detail && detail.created_by === userEmail && (
        <div className="card">
          <ScenarioForm initial={docToFormState(detail)} scenarioIdLocked={true} onSubmit={handleSubmit} submitLabel="Save changes" />
        </div>
      )}
    </main>
  );
}
