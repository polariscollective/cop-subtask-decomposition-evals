# Batch Launcher UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/batch` page where a user configures and launches a linear/chained batch, then watches it run — built on top of the already-deployed trigger infrastructure (`POST /api/batch/trigger`, live and tested against real Cloud Run infra in dev).

**Architecture:** A new Supabase column + trigger for staleness detection, a new polling status API route, a small change to the existing trigger route (server-side author attribution), and a new page with a form + live-updating table.

**Tech Stack:** Next.js API routes, Supabase (Postgres trigger, no new tables), React (`"use client"`, `setInterval` polling — no new libraries).

**Source spec:** `docs/superpowers/specs/2026-08-09-batch-launcher-ui-design.md`.

## Global Constraints

- Pipelines: `linear` and `chained` only.
- No Supabase Realtime — polling only, through the existing server-side/`service_role` access pattern. See the spec's "Why polling, not Realtime" for the reasoning; don't revisit it mid-implementation.
- `runAuthorEmail` is never trusted from the client — the trigger route injects it server-side from the signed-in session, same principle `POST /api/save-run` already follows.
- Models offered in the form are Anthropic-only (`MODEL_CATALOG.anthropic.models`) — linear/chained batches can't run any other provider today.
- `BATCH_STALE_THRESHOLD_MINUTES` (new env var, default `30`) governs staleness detection.
- This project has no automated test suite — every task ends with a manual verification.
- Auth: every route/page here is already covered by the existing `middleware.js` matcher (`/((?!api/auth(?:/|$)|_next/static|_next/image|favicon.ico).*)`) — no new auth logic needed anywhere in this plan.

## A note on `batches.data.attempts` — no `accepted` field

Both `scripts/batch/linear-state.js` and `scripts/batch/chained-state.js`'s `saveState()` strip `planResult`/`directResult` before persisting (`attempts.map(({ planResult, steps, ...rest }) => rest)` / `attempts.map(({ directResult, ...rest }) => rest)`), so a stored attempt only ever has `{ id, model, scenario_id, style, status, runId, cost, error }` — never `accepted`. The status route (Task 2) must fetch each *done* attempt's own `runs` row (via `runId`) in a second, single batched query to learn whether it was accepted — not assume the field exists on the manifest attempt itself.

---

### Task 1: Supabase — `updated_at` column and trigger on `batches`

**Files:** None in this repo — a schema migration applied directly via the `mcp__supabase__apply_migration` tool (same pattern Task 1 of the runs-migration plan used).

**Interfaces:**
- Produces: `batches.updated_at`, auto-refreshed on every `upsert` (insert or update) — consumed by Task 2's staleness check.

- [ ] **Step 1: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "add_batches_updated_at"`:

```sql
alter table batches add column updated_at timestamptz not null default now();

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger batches_set_updated_at
  before update on batches
  for each row
  execute function set_updated_at();
```

- [ ] **Step 2: Verify the trigger fires on upsert, not just plain UPDATE**

Supabase's JS client's `.upsert()` compiles to `INSERT ... ON CONFLICT (id) DO UPDATE` — confirm Postgres treats that as a real `UPDATE` for trigger purposes (it does, but verify empirically rather than assuming):

Run (read-only-safe, uses a real existing batch id from the runs-migration work):
```bash
mcp__supabase__execute_sql — query: "select id, updated_at from batches limit 1;"
```
Note the `updated_at` value, then:
```bash
mcp__supabase__execute_sql — query: "select id, data from batches limit 1;"
```
(copy that row's `id` and `data`), then:
```bash
mcp__supabase__execute_sql — query: "update batches set data = data where id = '<that id>'; select id, updated_at from batches where id = '<that id>';"
```
Expected: `updated_at` is now more recent than the first check — confirms the trigger fires.

- [ ] **Step 3: No commit needed**

This task has no file changes in this repo (schema-only). Skip the commit step; the change is recorded live in Supabase, same as Task 1 of the runs-migration plan.

---

### Task 2: `GET /api/batch/status` route

**Files:**
- Create: `app/api/batch/status/route.js`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `getSupabaseClient()` from `lib/supabase.js`.
- Produces: `GET /api/batch/status?batchId=<id>` — response shape consumed by Task 5's polling UI:
  ```json
  {
    "batchId": "linear_...",
    "status": "running" | "done" | "stalled",
    "cumulativeCost": 0.4821,
    "attempts": [
      { "id": "...", "model": "...", "scenario": "...", "style": "...", "status": "done", "accepted": true, "cost": 0.0512 }
    ]
  }
  ```

- [ ] **Step 1: Write the route**

```js
import { NextResponse } from "next/server";
import { getSupabaseClient } from "../../../../lib/supabase.js";

const STALE_THRESHOLD_MINUTES = Number(process.env.BATCH_STALE_THRESHOLD_MINUTES || 30);

function isTerminal(status) {
  return status === "done" || status === "error";
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const batchId = searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json({ error: "batchId is required" }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase.from("batches").select("data, updated_at").eq("id", batchId).single();
  if (error || !row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const manifest = row.data;
  let attempts = manifest.attempts || [];

  const allTerminal = attempts.length > 0 && attempts.every((a) => isTerminal(a.status));
  const minutesSinceUpdate = (Date.now() - new Date(row.updated_at).getTime()) / 60000;
  const isStale = !allTerminal && minutesSinceUpdate > STALE_THRESHOLD_MINUTES;

  if (isStale) {
    // Correct the stored manifest too, so other consumers (e.g. /api/compare's
    // anyRunning flag, which reads this same table) stop reporting it as live —
    // not just this one response.
    attempts = attempts.map((a) =>
      isTerminal(a.status)
        ? a
        : { ...a, status: "error", error: `Stalled — no update in over ${STALE_THRESHOLD_MINUTES} minutes` }
    );
    const { error: updateError } = await supabase
      .from("batches")
      .update({ data: { ...manifest, attempts } })
      .eq("id", batchId);
    if (updateError) {
      // Don't fail the whole response over a failed correction — the
      // client-facing status below is still accurate either way.
      console.error(`Failed to correct stalled batch ${batchId}: ${updateError.message}`);
    }
  }

  // "accepted" isn't on the manifest attempt itself (see plan's Global
  // Constraints note) — fetch it in one batched query for every attempt
  // that has finished and has a runId.
  const doneRunIds = attempts.filter((a) => a.runId && a.status === "done").map((a) => a.runId);
  const acceptedByRunId = new Map();
  if (doneRunIds.length > 0) {
    const { data: runs } = await supabase.from("runs").select("id, data").in("id", doneRunIds);
    for (const r of runs || []) {
      const accepted = r.data.plan_result?.accepted ?? r.data.direct_result?.accepted ?? null;
      acceptedByRunId.set(r.id, accepted);
    }
  }

  const responseAttempts = attempts.map((a) => ({
    id: a.id,
    model: a.model,
    scenario: a.scenario_id,
    style: a.style,
    status: a.status,
    accepted: a.runId ? acceptedByRunId.get(a.runId) ?? null : null,
    cost: a.cost || 0,
  }));

  const status = isStale ? "stalled" : allTerminal ? "done" : "running";
  const cumulativeCost = responseAttempts.reduce((sum, a) => sum + a.cost, 0);

  return NextResponse.json({ batchId, status, cumulativeCost, attempts: responseAttempts });
}
```

- [ ] **Step 2: Add `BATCH_STALE_THRESHOLD_MINUTES` to `.env.example`**

Add near the `BATCH_TRIGGER_*` lines:
```
BATCH_STALE_THRESHOLD_MINUTES=30
```

- [ ] **Step 3: Verify against real data**

Use one of the real batches already in Supabase from the runs-migration/batch-infra work (e.g. `linear-2026-08-07`, or the `cloud-run-e2e-test`/`local-dev-e2e-test` batches from the batch-infra plan's verification, if still present):

Run: `npm run dev`, then:
```bash
curl -s "http://localhost:3000/api/batch/status?batchId=linear-2026-08-07"
```
Expected: JSON with `status: "done"` (all migrated batches are historical/finished), `attempts` array with real `accepted`/`cost` values matching what `mcp__supabase__execute_sql` shows directly for that batch's rows.

Run: `curl -s "http://localhost:3000/api/batch/status?batchId=does-not-exist"`
Expected: `{"error":"not found"}`, HTTP 404.

For the stale-correction path: pick a batch you don't mind mutating (or use a throwaway test batch you create via `mcp__supabase__execute_sql` insert + delete afterward — do not use a real historical batch, since the stale-correction path rewrites `data`). Manually backdate its `updated_at` via SQL (`update batches set updated_at = now() - interval '1 hour' where id = '<test id>'`) with at least one non-terminal attempt in `data.attempts`, then curl the status route and confirm `status: "stalled"` and that a follow-up `select data from batches where id = '<test id>'` shows the attempt corrected to `status: "error"`.

- [ ] **Step 4: Commit**

```bash
git add app/api/batch/status/route.js .env.example
git commit -m "Add GET /api/batch/status polling route with staleness detection"
```

---

### Task 3: Server-side `runAuthorEmail` injection in the trigger route

**Files:**
- Modify: `app/api/batch/trigger/route.js`

**Interfaces:**
- Consumes: `getSessionEmail()` from `auth.js` (already exists, already used by `app/api/scenarios/route.js`'s `POST` handler for the identical purpose).
- Produces: `POST /api/batch/trigger` now ignores any `runAuthorEmail` in the request body and injects the signed-in user's email instead. Consumed by Task 4 (the form never sends this field at all).

- [ ] **Step 1: Update the route**

Replace the full contents of `app/api/batch/trigger/route.js`:

```js
import { NextResponse } from "next/server";
import { getSessionEmail } from "../../../../auth";

export async function POST(req) {
  const userEmail = await getSessionEmail();
  if (!userEmail) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const body = await req.json();
  // Never trust the client for who this batch is attributed to — same
  // principle POST /api/save-run and POST /api/scenarios already follow.
  const forwardedBody = { ...body, runAuthorEmail: userEmail };

  const url = process.env.BATCH_TRIGGER_URL;
  const secret = process.env.BATCH_TRIGGER_SHARED_SECRET;
  if (!url || !secret) {
    return NextResponse.json({ error: "BATCH_TRIGGER_URL/BATCH_TRIGGER_SHARED_SECRET not configured" }, { status: 500 });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(forwardedBody),
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
```

- [ ] **Step 2: Verify**

Run: `npm run dev` (dev mode skips auth per `middleware.js`'s `skipAuthInDev`, so `getSessionEmail()` may return `null` locally unless `LOCAL_AUTHENTICATION_EMAIL` is set in `.env.local` — check `auth.js`'s exact fallback behavior and use whichever real path is available in your environment).

If a session is available: confirm the forwarded request to the (real, deployed) trigger proxy includes the session's email as `runAuthorEmail`, not whatever the client sent — pass a deliberately wrong `runAuthorEmail` in the curl body and confirm (via `mcp__supabase__execute_sql` on the resulting `runs` row's `user_email`) that the session email won, not the body's value.

If no session is available in this environment: confirm the route returns 401 when `getSessionEmail()` returns `null`, and read the code to confirm the injection logic is correct (can't be fully live-tested without a session, say so explicitly in the report).

- [ ] **Step 3: Commit**

```bash
git add app/api/batch/trigger/route.js
git commit -m "Inject runAuthorEmail server-side in the batch trigger route"
```

---

### Task 4: `/batch` page — form

**Files:**
- Create: `app/batch/page.js`
- Modify: `app/page.js` (add a nav link, matching the existing `/runs`/`/compare` links)

**Interfaces:**
- Consumes: `GET /api/scenarios` (existing, returns `[{scenario_id, title, ...}]`), `MODEL_CATALOG.anthropic.models` from `lib/models.js`, `ARGUMENT_STYLES` from `lib/adversarial.js`, `POST /api/batch/trigger` (Task 3's version).
- Produces: on successful trigger, sets local state (`launchedBatchId`) that Task 5 reads to switch into the tracking view — this task renders a placeholder in that state (`"Batch launched: <id> — tracking view coming in Task 5"`) so the task is independently testable before Task 5 exists.

- [ ] **Step 1: Write the page (form portion)**

```jsx
"use client";

import { useEffect, useState } from "react";
import { MODEL_CATALOG } from "../../lib/models";
import { ARGUMENT_STYLES } from "../../lib/adversarial";

const ANTHROPIC_MODELS = Object.keys(MODEL_CATALOG.anthropic.models);
const STYLE_KEYS = Object.keys(ARGUMENT_STYLES);

function defaultBatchId(pipeline) {
  return `${pipeline}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
      <main className="container">
        <h1>Batch launched</h1>
        <p className="plan-caption">
          Batch ID: <span className="mono">{launchedBatchId}</span> — tracking view coming in Task 5.
        </p>
      </main>
    );
  }

  return (
    <main className="container">
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
```

- [ ] **Step 2: Add a nav link in `app/page.js`**

Find the existing links block (near `Open full runs table ↗` / `Model comparison ↗`, around line 395-400) and add a third link in the same style:
```jsx
          <a className="btn btn-ghost" href="/batch">
            Launch a batch ↗
          </a>
```

- [ ] **Step 3: Verify `.checkbox-group`/`.checkbox-item`/`.form-field` CSS classes exist or add minimal styling**

Run: `grep -n "checkbox-group\|checkbox-item\|form-field" app/globals.css`
If `.form-field` exists already (it's referenced in existing input selectors per earlier exploration) but `.checkbox-group`/`.checkbox-item` don't, add minimal rules to `app/globals.css`:
```css
.checkbox-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.checkbox-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: normal;
}
```

- [ ] **Step 4: Verify in the browser**

Run: `npm run dev`, open `http://localhost:3000/batch`. Confirm scenarios load from `/api/scenarios`, pick a pipeline/one scenario/one model/one style, confirm the "Launch batch" button enables only once all three selections are non-empty. Click it — since this is a real trigger against live dev infrastructure, use the smallest possible selection (1/1/1) to keep it cheap. Confirm it transitions to the "Batch launched" placeholder with the right batch ID, and that a real Cloud Run execution started (`gcloud run jobs executions list --job=cop-batch-runner --region=europe-west1 --project=polaris-dev-499211 --limit=1`).

- [ ] **Step 5: Commit**

```bash
git add app/batch/page.js app/page.js app/globals.css
git commit -m "Add batch launcher form"
```

---

### Task 5: `/batch` page — live tracking table

**Files:**
- Modify: `app/batch/page.js`

**Interfaces:**
- Consumes: `GET /api/batch/status` (Task 2).
- Produces: replaces Task 4's placeholder with a real polling table.

- [ ] **Step 1: Add the tracking component and wire it in**

Add above the `BatchLauncher` component (or in the same file, doesn't need a separate file — this page is small enough to stay as one file per the plan's file structure):

```jsx
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
```

- [ ] **Step 2: Replace the Task 4 placeholder**

In `BatchLauncher`, replace:
```jsx
  if (launchedBatchId) {
    return (
      <main className="container">
        <h1>Batch launched</h1>
        <p className="plan-caption">
          Batch ID: <span className="mono">{launchedBatchId}</span> — tracking view coming in Task 5.
        </p>
      </main>
    );
  }
```
with:
```jsx
  if (launchedBatchId) {
    return (
      <main className="container">
        <h1>Batch launched</h1>
        <p className="plan-caption">
          Batch ID: <span className="mono">{launchedBatchId}</span>
        </p>
        <BatchTracker batchId={launchedBatchId} />
      </main>
    );
  }
```

- [ ] **Step 3: Verify end-to-end in the browser**

Run: `npm run dev`, open `http://localhost:3000/batch`, launch a small real batch (1 model × 1 scenario × 1 style, low `maxTurns`/`budget` to keep it cheap and fast). Confirm:
- The table appears immediately with the attempt in `pending`/`running`.
- It updates (open browser dev tools' Network tab, confirm a request to `/api/batch/status` every ~3 seconds) as the attempt progresses.
- Once the attempt reaches `done` or `error`, polling stops (no further `/api/batch/status` requests in the Network tab) and the status badge reflects the terminal state.
- Cross-check the final `accepted`/`cost` values against `mcp__supabase__execute_sql` on the resulting `runs` row directly — they should match exactly.

- [ ] **Step 4: Commit**

```bash
git add app/batch/page.js
git commit -m "Add live tracking table to the batch launcher"
```

---

### Task 6: Stale-batch end-to-end verification

**Files:** None — pure verification task, no code changes.

**Interfaces:** None new.

- [ ] **Step 1: Create a throwaway batch row that looks stuck**

```bash
mcp__supabase__execute_sql — query: "insert into batches (id, user_email, data, updated_at) values ('stale-test-batch', 'test@example.com', jsonb_build_object('attempts', jsonb_build_array(jsonb_build_object('id','test|attempt|1','model','claude-haiku-4-5','scenario_id','test_scenario','style','ethical','status','running','runId',null,'cost',0,'error',null))), now() - interval '1 hour') returning id;"
```

- [ ] **Step 2: Confirm the status route reports it as stalled and self-corrects**

Run: `curl -s "http://localhost:3000/api/batch/status?batchId=stale-test-batch"`
Expected: `"status":"stalled"`, the one attempt shows `"status":"error"` in the response.

Run: `mcp__supabase__execute_sql — query: "select data from batches where id = 'stale-test-batch';"`
Expected: the stored `data.attempts[0].status` is now `"error"` too (the route's self-correction persisted).

- [ ] **Step 3: Confirm `/api/compare` no longer reports it as running**

(This specific batch won't show up in `/compare` since its run_kind isn't linear/chained-shaped in a way `/api/compare` scans — this step is about confirming the *mechanism* generalizes, not this exact test row. If you want full confidence, instead pick one of the batch-infra plan's real leftover test batches, if any still exist with a `running` attempt, and verify the same way against real data — otherwise, reasoning through the code path in Task 2's route is sufficient since `/api/compare`'s `attemptStatus()` reads the exact same `batches.data.attempts[].status` field this route corrects.)

- [ ] **Step 4: Clean up the throwaway row**

```bash
mcp__supabase__execute_sql — query: "delete from batches where id = 'stale-test-batch';"
```

- [ ] **Step 5: No commit** — this task is verification-only.
