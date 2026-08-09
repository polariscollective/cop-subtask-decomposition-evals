"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import yaml from "js-yaml";
import ScenarioForm, { emptyScenarioForm, docToFormState } from "../../components/ScenarioForm";

export default function NewScenarioPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const copyFrom = searchParams.get("copyFrom");

  const [initial, setInitial] = useState(copyFrom ? null : emptyScenarioForm());
  const [loadError, setLoadError] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [formKey, setFormKey] = useState(0);

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = yaml.load(reader.result);
        setInitial(docToFormState(doc));
        setFormKey((k) => k + 1);
      } catch (err) {
        setUploadError(`Failed to parse YAML: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  useEffect(() => {
    if (!copyFrom) return;
    fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(copyFrom)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((doc) => {
        const form = docToFormState(doc);
        setInitial({ ...form, scenario_id: "", title: `${form.title} (copy)` });
      })
      .catch((e) => setLoadError(e.message));
  }, [copyFrom]);

  async function handleSubmit(doc) {
    const res = await fetch("/api/scenarios", {
      method: "POST",
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
          <h1 className="app-title">{copyFrom ? "Copy scenario" : "Create scenario"}</h1>
          <p className="app-subtitle" style={{ marginBottom: 20 }}>
            {copyFrom
              ? `Pre-filled from "${copyFrom}" — give it a new scenario_id before saving.`
              : "Fill in the form below."}
          </p>
        </div>
        <a href="/scenarios" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
          ← Back to scenarios
        </a>
      </div>

      {loadError && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>
            Failed to load "{copyFrom}": {loadError}
          </p>
        </div>
      )}

      {initial && (
        <div className="card">
          <div className="form-field">
            <label className="field-label" htmlFor="yaml-upload">
              Upload YAML (optional — pre-fills the form below, nothing is saved until you click Save)
            </label>
            <input id="yaml-upload" type="file" accept=".yaml,.yml" onChange={handleFileChange} />
            {uploadError && <div className="form-error">{uploadError}</div>}
          </div>

          <ScenarioForm key={formKey} initial={initial} scenarioIdLocked={false} onSubmit={handleSubmit} submitLabel="Save" />
        </div>
      )}

      {!initial && !loadError && <p className="plan-caption">Loading…</p>}
    </main>
  );
}
