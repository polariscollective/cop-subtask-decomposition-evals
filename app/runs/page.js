"use client";

import { useEffect, useMemo, useState } from "react";

const COLUMNS = [
  { key: "chain_id", label: "Chain", width: 150 },
  { key: "saved_at", label: "Saved", width: 148 },
  { key: "scenario_title", label: "Scenario", width: 200 },
  { key: "model", label: "Model", width: 140 },
  { key: "framing", label: "Framing", width: 84 },
  { key: "style", label: "Style", width: 150 },
  { key: "mode", label: "Mode", width: 90 },
  { key: "step_index", label: "Progress", width: 110, numeric: true },
  { key: "accepted", label: "Result", width: 140 },
  { key: "cost", label: "Cost", width: 90, numeric: true },
  { key: "description", label: "Description", width: 260 },
];

function formatSavedAt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// chain_id is the filename of the plan a row's chain grew from — long and
// mostly redundant (scenario/model already shown in their own columns).
// The leading timestamp is enough to tell chains apart at a glance; the
// full id is still in the title tooltip and is what sorting/grouping use.
function chainLabel(chainId) {
  if (!chainId) return "—";
  return chainId.slice(0, 19);
}

function compareValues(a, b, key, numeric) {
  const av = a[key];
  const bv = b[key];
  if (av == null && bv == null) return 0;
  if (av == null) return -1;
  if (bv == null) return 1;
  if (numeric) return (av || 0) - (bv || 0);
  return String(av).localeCompare(String(bv));
}

function uniqueSorted(values) {
  return [...new Set(values.filter((v) => v != null && v !== ""))].sort();
}

// Execution rows have three real outcomes — see resultBadge in app/page.js
// for the full reasoning. Duplicated here (small, page-specific JSX) rather
// than shared, since the two tables render it slightly differently.
function resultBadge(r) {
  if (r.mode !== "execution") {
    return { className: r.accepted ? "badge-ok" : "badge-danger", label: r.accepted ? "accepted" : "refused" };
  }
  if (r.step_outcome === "completed") return { className: "badge-ok", label: "completed" };
  if (r.step_outcome === "in_progress") return { className: "badge-warn", label: "in progress" };
  return { className: "badge-danger", label: "refused here" };
}

export default function RunsExplorer() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  // Default sort groups every row belonging to the same run together
  // (chain_id), ordered step-by-step within each group — see the
  // "sorted" useMemo below for the secondary tiebreak that keeps steps in
  // order however the primary column is sorted.
  const [sortKey, setSortKey] = useState("chain_id");
  const [sortDir, setSortDir] = useState("desc");
  const [filters, setFilters] = useState({
    scenario_title: "all",
    model: "all",
    mode: "all",
    accepted: "all",
  });
  // On by default: a row that something downstream branched from (a plan
  // that got executed, a step that wasn't the canonical pick continuing
  // the chain) is superseded, not a real outcome — leaves are what
  // actually happened at the end of each explored path.
  const [leavesOnly, setLeavesOnly] = useState(true);

  useEffect(() => {
    fetch("/api/runs")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setRuns)
      .catch((e) => setError(e.message));
  }, []);

  const filterOptions = useMemo(() => {
    if (!runs) return { scenario_title: [], model: [], mode: [] };
    return {
      scenario_title: uniqueSorted(runs.map((r) => r.scenario_title)),
      model: uniqueSorted(runs.map((r) => r.model)),
      mode: uniqueSorted(runs.map((r) => r.mode)),
    };
  }, [runs]);

  const filtered = useMemo(() => {
    if (!runs) return [];
    return runs.filter((r) => {
      if (leavesOnly && !r.is_leaf) return false;
      if (filters.scenario_title !== "all" && r.scenario_title !== filters.scenario_title) return false;
      if (filters.model !== "all" && r.model !== filters.model) return false;
      if (filters.mode !== "all" && r.mode !== filters.mode) return false;
      if (filters.accepted !== "all") {
        const want = filters.accepted === "accepted";
        if (Boolean(r.accepted) !== want) return false;
      }
      return true;
    });
  }, [runs, filters, leavesOnly]);

  // Secondary tiebreak on step_index, always ascending regardless of the
  // primary sort direction: two rows from the same chain (same chain_id,
  // or tied on whatever column is sorted) should still read top-to-bottom
  // as step 1, 2, 3... not be scrambled by reversing the primary sort.
  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sortKey);
    const dirMul = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const primary = compareValues(a, b, sortKey, col?.numeric) * dirMul;
      if (primary !== 0) return primary;
      return (a.step_index || 0) - (b.step_index || 0);
    });
  }, [filtered, sortKey, sortDir]);

  const stats = useMemo(() => {
    const totalCost = filtered.reduce((sum, r) => sum + (r.cost || 0), 0);
    const accepted = filtered.filter((r) => r.accepted).length;
    return { count: filtered.length, totalCost, accepted };
  }, [filtered]);

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "saved_at" ? "desc" : "asc");
    }
  }

  return (
    <main className="app-shell" style={{ maxWidth: 1180 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="app-title">Runs explorer</h1>
          <p className="app-subtitle" style={{ marginBottom: 20 }}>
            Every saved run — manual or batch-produced — in one sortable table.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/compare" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
            Model comparison ↗
          </a>
          <a href="/" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
            ← Back to dashboard
          </a>
        </div>
      </div>

      {error && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Failed to load runs: {error}</p>
        </div>
      )}

      {!runs && !error && <p className="plan-caption">Loading…</p>}

      {runs && (
        <>
          <section className="card re-toolbar">
            <label className="re-filter re-leaf-toggle">
              <span className="field-label" style={{ marginBottom: 4 }}>
                Tree view
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={leavesOnly}
                  onChange={(e) => setLeavesOnly(e.target.checked)}
                />
                Leaves only (hide superseded steps)
              </span>
            </label>
            <FilterSelect
              label="Scenario"
              value={filters.scenario_title}
              options={filterOptions.scenario_title}
              onChange={(v) => setFilters((f) => ({ ...f, scenario_title: v }))}
            />
            <FilterSelect
              label="Model"
              value={filters.model}
              options={filterOptions.model}
              onChange={(v) => setFilters((f) => ({ ...f, model: v }))}
            />
            <FilterSelect
              label="Mode"
              value={filters.mode}
              options={filterOptions.mode}
              onChange={(v) => setFilters((f) => ({ ...f, mode: v }))}
            />
            <FilterSelect
              label="Result"
              value={filters.accepted}
              options={["accepted", "refused"]}
              onChange={(v) => setFilters((f) => ({ ...f, accepted: v }))}
            />
            <div className="re-stats">
              <span>
                <strong>{stats.count}</strong> run{stats.count === 1 ? "" : "s"}
              </span>
              <span>
                <strong>{stats.accepted}</strong> accepted (
                {stats.count ? Math.round((100 * stats.accepted) / stats.count) : 0}%)
              </span>
              <span>
                <strong>${stats.totalCost.toFixed(2)}</strong> total cost
              </span>
            </div>
          </section>

          <section className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div className="re-table-scroll">
              <table className="re-table">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        style={{ minWidth: c.width }}
                        onClick={() => toggleSort(c.key)}
                        className={sortKey === c.key ? "re-sorted" : ""}
                      >
                        {c.label}
                        {sortKey === c.key && <span className="re-arrow">{sortDir === "asc" ? " ▲" : " ▼"}</span>}
                      </th>
                    ))}
                    <th style={{ minWidth: 70 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.id}>
                      <td className="mono re-muted" title={r.chain_id || ""}>
                        {chainLabel(r.chain_id)}
                      </td>
                      <td className="mono re-muted">{formatSavedAt(r.saved_at)}</td>
                      <td>{r.scenario_title || r.scenario_id}</td>
                      <td className="mono">{r.model || "—"}</td>
                      <td>{r.framing || "—"}</td>
                      <td className="mono">{r.style || r.argument_style || "—"}</td>
                      <td>
                        <span className={`badge badge-neutral`}>{r.mode}</span>
                      </td>
                      <td className="mono">{r.step_progress || (r.mode === "plan" ? "plan only" : "—")}</td>
                      <td>
                        <span className={`badge ${resultBadge(r).className}`}>{resultBadge(r).label}</span>
                      </td>
                      <td className="mono">${(r.cost || 0).toFixed(4)}</td>
                      <td className="re-desc" title={r.description || ""}>
                        {r.description || <span className="re-muted">—</span>}
                      </td>
                      <td>
                        {r.owned ? (
                          <a className="btn btn-ghost" href={`/?id=${encodeURIComponent(r.id)}`}>
                            Open
                          </a>
                        ) : (
                          <span className="re-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan={COLUMNS.length + 1} className="re-muted" style={{ textAlign: "center", padding: 24 }}>
                        No runs match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function FilterSelect({ label, value, options, onChange }) {
  return (
    <label className="re-filter">
      <span className="field-label" style={{ marginBottom: 4 }}>
        {label}
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="all">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
