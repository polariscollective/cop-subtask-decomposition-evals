# Supabase Runs Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move saved runs and batch manifests from local JSON files (`runs/*.json`, `runs/batches/*/manifest.json`) to Supabase Postgres, so "browse saved runs" works when the app is deployed on Vercel (ephemeral, non-shared filesystem), and every run records who ran it.

**Architecture:** Two tables — `runs` (one row per saved run/attempt, `data jsonb` holding the exact object shape the local JSON file used to hold, plus promoted columns for filtering) and `batches` (one row per batch, `data jsonb` holding the exact manifest shape). All four API routes and all four batch pipelines (base plan+execute, linear, chained, steps) switch from `fs` calls to a shared Supabase client. No dual-write fallback — a Supabase failure is a real error, not a silent local-file fallback.

**Tech Stack:** `@supabase/supabase-js`, Next.js 14 API routes (Node runtime), plain Node ESM scripts under `scripts/batch/`.

**Source design doc:** `docs/superpowers/specs/2026-08-09-supabase-runs-migration-design.md`. This plan also fixes two gaps found while mapping the doc onto the actual codebase (see Global Constraints below) and one factual correction: the doc says `runs/batches/*.json` (9 files) but the real layout is `runs/batches/<batch_id>/manifest.json` (9 files, confirmed by `find runs/batches -name manifest.json | wc -l`).

## Global Constraints

- Every new run/attempt identifier is `crypto.randomUUID()`, generated client-side (in the API route or batch script) and passed explicitly as the `id` column on insert — never rely on Postgres's `gen_random_uuid()` default, because the app needs to know the id *before* the row exists (for resumability checks and for chaining a step to its source plan).
- **Naming split, to avoid a real collision:** in the batch/state layer (`scripts/batch/*`), each attempt already has an `id` field that is a *deterministic composite matching key* (e.g. `` `${model}|${scenarioId}|${framing}|${style}` `` from `matrix.js`/`steps-matrix.js`), used by `findAttempt(state, id)` for resume-matching. The new Supabase row identifier must NOT reuse that name — it goes in a new field, `attempt.runId`. In the web-facing layer (API routes, frontend, the `runs` table itself) there is no competing composite key, so the identifier is simply `id` throughout (`/api/runs?id=`, `r.id`, etc.).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — server-only env vars, no `NEXT_PUBLIC_` prefix (same secrecy discipline as `ANTHROPIC_API_KEY`).
- `RUN_AUTHOR_EMAIL` — required env var for all four `scripts/batch-eval*.js` entrypoints; each fails fast with a clear message if unset, checked once at startup, not per write.
- The `data` jsonb column always stores the exact same object shape the local JSON file used to hold, unchanged. Promoted columns (`scenario_id`, `scenario_title`, `framing`, `source_plan_id`, `batch_id`, `description`, `user_email`) are copies extracted purely for SQL filtering — never a second source of truth. Downstream summary/aggregation logic (leaf detection, chain grouping, `toSample`) keeps reading from the fetched `data` object exactly as it read from the parsed file before; nothing is duplicated into SQL.
- No dual-write fallback to local files. A Supabase write failure surfaces as a thrown error / non-200 response, not a silent fallback to `fs`.
- This project has no automated test suite — every task ends with a manual verification (`curl`, a `node -e` snippet, or an `mcp__supabase__execute_sql` check), matching existing project practice.

---

## Supabase project already provisioned

A Supabase project is already connected to this workspace via the `supabase` MCP server — `mcp__supabase__get_project_url` returns `https://hkqzamibfpyvlowiqgpn.supabase.co`, and `mcp__supabase__list_tables` currently returns no tables. Use the `mcp__supabase__apply_migration` tool (not hand-run SQL) for the schema in Task 1. The service role key is a secret and isn't retrievable through MCP — get it from the Supabase dashboard (Project Settings → API) and put it in `.env.local` yourself before running any task that touches the database.

---

### Task 1: Supabase client, schema, and dependency

**Files:**
- Create: `lib/supabase.js`
- Modify: `package.json` (add `@supabase/supabase-js`)
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: `getSupabaseClient()` from `lib/supabase.js` — returns a singleton `@supabase/supabase-js` client built from `process.env.SUPABASE_URL` + `process.env.SUPABASE_SERVICE_ROLE_KEY`, throwing if either is unset. Used by every later task.

- [ ] **Step 1: Add the dependency**

Run: `npm install @supabase/supabase-js`
Expected: `package.json` gains `"@supabase/supabase-js": "^2.x.x"` under `dependencies`, `package-lock.json` updates.

- [ ] **Step 2: Apply the schema migration**

Use the `mcp__supabase__apply_migration` tool with `name: "create_runs_and_batches"` and this SQL (verbatim from the design doc):

```sql
create table runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_email text not null,
  scenario_id text not null,
  scenario_title text,
  framing text,
  source_plan_id text,
  batch_id text,
  description text,
  legacy_filename text unique,
  data jsonb not null
);
create index runs_user_email_idx on runs (user_email);
create index runs_batch_id_idx on runs (batch_id);
create index runs_source_plan_id_idx on runs (source_plan_id);

create table batches (
  id text primary key,
  created_at timestamptz not null default now(),
  user_email text not null,
  data jsonb not null
);

grant select, insert, update, delete on public.runs, public.batches to service_role;
```

Note: `source_plan_id` and `legacy_filename` are `text`, not `uuid` — `source_plan_id` needs to hold a client-generated UUID *string*, and `legacy_filename` holds an original filename string. Leaving them `text` (as the design doc specifies) avoids a type mismatch; no change needed there.

Note: the trailing `grant` is required — confirmed during Task 1 execution that `mcp__supabase__apply_migration` does NOT auto-grant table privileges to `service_role` the way Supabase Studio's table-creation UI does. Without it, every `getSupabaseClient()` call fails with `permission denied for table runs` (Postgres error `42501`), even though `service_role` bypasses RLS. Check with `select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name in ('runs','batches');` if in doubt — `service_role` needs SELECT/INSERT/UPDATE/DELETE, not just the TRIGGER/REFERENCES/TRUNCATE it gets by default.

Run: `mcp__supabase__list_tables` with `schemas: ["public"], verbose: true`
Expected: both `runs` and `batches` listed, with the columns above.

- [ ] **Step 3: Write `lib/supabase.js`**

```js
import { createClient } from "@supabase/supabase-js";

let client = null;

export function getSupabaseClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.");
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
```

- [ ] **Step 4: Add env vars to `.env.example`**

Add after the `GEMINI_API_KEY`/`META_API_KEY` lines, before the Google sign-in block:

```
# Supabase — saved runs storage (see docs/superpowers/specs/2026-08-09-supabase-runs-migration-design.md)
SUPABASE_URL=https://hkqzamibfpyvlowiqgpn.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 5: Document in README**

In the `## Login` section of `README.md`, after the existing Vercel env-var paragraph (ending `...rather than in a committed file.`), add:

```markdown

Saved runs live in Supabase, not on disk (the Vercel filesystem is ephemeral
and not shared across invocations). Set `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` (server-only, no `NEXT_PUBLIC_` prefix) the same
way — Vercel project environment variables, not a committed file. Batch
scripts also need `RUN_AUTHOR_EMAIL` set, since they run outside any Auth.js
session and there's no other way to know who to attribute the runs to.
```

- [ ] **Step 6: Verify the client connects**

Run:
```bash
SUPABASE_URL=https://hkqzamibfpyvlowiqgpn.supabase.co SUPABASE_SERVICE_ROLE_KEY=<paste from dashboard> \
  node -e "import('./lib/supabase.js').then(async ({getSupabaseClient}) => { const {data,error} = await getSupabaseClient().from('runs').select('id').limit(1); console.log({data,error}); })"
```
Expected: `{ data: [], error: null }` — table exists and is empty, no auth error.

- [ ] **Step 7: Commit**

```bash
git add lib/supabase.js package.json package-lock.json .env.example README.md
git commit -m "Add Supabase client and runs/batches schema"
```

---

### Task 2: Web app write path — `POST /api/save-run`

**Files:**
- Modify: `app/api/save-run/route.js`

**Interfaces:**
- Consumes: `getSupabaseClient()` from [[Task 1]]. `auth` from `../../../auth.js` (already used by `middleware.js`; same import path from `app/api/save-run/route.js`).
- Produces: `POST /api/save-run` now returns `{ saved: true, id }` (a uuid string) instead of `{ saved: true, filename }`. This return shape is consumed by [[Task 5]] (`app/page.js`).

- [ ] **Step 1: Rewrite the route**

Replace the full contents of `app/api/save-run/route.js` with:

```js
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { auth } from "../../../auth";
import { getSupabaseClient } from "../../../lib/supabase.js";

export async function POST(req) {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const { scenarioId, scenarioTitle, framing, directResult, planResult, steps, description } =
    await req.json();
  if (!scenarioId || (!planResult && !directResult)) {
    return NextResponse.json(
      { error: "missing scenarioId, or neither planResult nor directResult was provided" },
      { status: 400 }
    );
  }

  const id = randomUUID();
  const run = {
    saved_at: new Date().toISOString(),
    scenario_id: scenarioId,
    scenario_title: scenarioTitle || null,
    framing,
    direct_result: directResult || null,
    plan_result: planResult || null,
    steps: steps || null,
    // Optional free-text note, shown in the "Browse saved runs" list so a
    // specific run can be found later without opening every one. The
    // scenario itself isn't repeated here since scenario_title already
    // covers that.
    description: description || null,
  };

  const supabase = getSupabaseClient();
  const { error } = await supabase.from("runs").insert({
    id,
    user_email: userEmail,
    scenario_id: scenarioId,
    scenario_title: scenarioTitle || null,
    framing,
    source_plan_id: null,
    batch_id: null,
    description: description || null,
    data: run,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ saved: true, id });
}
```

- [ ] **Step 2: Verify with the dev server**

Run: `npm run dev` (separate terminal), then, signed in via the browser so there's a session cookie, use the app's "Save this run" button on a plan or direct result — or, to test the route in isolation, temporarily call it with a valid session cookie:
```bash
curl -s -X POST http://localhost:3000/api/save-run \
  -H "Content-Type: application/json" \
  -H "Cookie: <copy your session cookie from the browser devtools>" \
  -d '{"scenarioId":"test_scenario","framing":"real","directResult":{"accepted":true},"description":"manual smoke test"}'
```
Expected: `{"saved":true,"id":"<uuid>"}`.

Run: `mcp__supabase__execute_sql` with `query: "select id, user_email, scenario_id, description from runs order by created_at desc limit 1;"`
Expected: one row, `user_email` matches the signed-in account, `description` = `manual smoke test`.

- [ ] **Step 3: Commit**

```bash
git add app/api/save-run/route.js
git commit -m "Write saved runs to Supabase instead of local files"
```

---

### Task 3: Web app read path — `GET /api/runs`

**Files:**
- Modify: `app/api/runs/route.js`

**Interfaces:**
- Consumes: `getSupabaseClient()` from [[Task 1]].
- Produces: `GET /api/runs` (list) — each summary object now has `id` instead of `filename` (identical otherwise). `GET /api/runs?id=<uuid>` (detail) replaces `GET /api/runs?file=<name>`, returning the row's `data` object unchanged. Consumed by [[Task 5]], [[Task 6]].

- [ ] **Step 1: Rewrite the route**

Replace the full contents of `app/api/runs/route.js` with:

```js
import { NextResponse } from "next/server";
import { ARGUMENT_STYLES } from "../../../lib/adversarial";
import { getSupabaseClient } from "../../../lib/supabase.js";

// Same fixed priority order the batch runner uses to pick which accepted
// style becomes the canonical branch that continues to the next step
// (baseline first, then this order) — see scripts/batch/steps-run.js's
// pickCanonical. Needed here to reconstruct, from saved rows alone, which
// row at a given step was the one anything downstream branched from.
const STYLE_PRIORITY = Object.keys(ARGUMENT_STYLES);

// GET /api/runs         -> list of saved runs (lightweight summaries)
// GET /api/runs?id=<id> -> full content of one saved run
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const supabase = getSupabaseClient();

  if (id) {
    const { data: row, error } = await supabase.from("runs").select("data").eq("id", id).single();
    if (error || !row) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(row.data);
  }

  const { data: rows, error } = await supabase.from("runs").select("id, data");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const summaries = rows.map((row) => {
    const id = row.id;
    const content = row.data;
    try {
      const hasSteps = Array.isArray(content.steps) && content.steps.length > 0;
      const mode = hasSteps ? "execution" : content.plan_result ? "plan" : "direct";

      // A saved run with steps reflects two separate questions: did THIS
      // step get accepted, and did execution actually reach the END of
      // the plan? Those aren't the same thing — a row can be "step 2/4,
      // accepted" and still not mean the dilemma's full action sequence
      // ran, since steps 3-4 haven't been attempted (in this row; other
      // rows continue from here). So `accepted` here means "reached the
      // last step, and it succeeded" — full completion — while
      // `step_outcome` distinguishes that from "refused at this step" and
      // "accepted here but not the final step yet" (in_progress), so an
      // intermediate success is never mislabeled as a refusal.
      let accepted;
      let stepAccepted = null;
      let stepOutcome = null;
      let stepProgress = null;
      let stepIndex = null;
      let stepTotal = null;
      let resultSource;
      if (hasSteps) {
        const lastStep = content.steps[content.steps.length - 1];
        stepIndex = content.steps.length;
        stepTotal = content.plan_result?.plan?.length ?? null;
        const isFinalStep = stepTotal != null && stepIndex === stepTotal;
        stepAccepted = lastStep.accepted;
        accepted = isFinalStep && lastStep.accepted;
        stepOutcome = !lastStep.accepted ? "stopped" : isFinalStep ? "completed" : "in_progress";
        stepProgress = stepTotal
          ? `${stepIndex}/${stepTotal}${lastStep.accepted ? "" : " (refused here)"}`
          : `${stepIndex}`;
        resultSource = lastStep;
      } else {
        accepted = mode === "plan" ? content.plan_result?.accepted : content.direct_result?.accepted;
        resultSource = content.plan_result || content.direct_result || {};
      }

      const cost = hasSteps
        ? content.steps.reduce((sum, s) => sum + (s.total_cost || 0), 0)
        : resultSource.total_cost || 0;

      return {
        id,
        saved_at: content.saved_at,
        scenario_id: content.scenario_id,
        scenario_title: content.scenario_title,
        framing: content.framing,
        mode,
        accepted,
        step_accepted: stepAccepted,
        step_outcome: stepOutcome,
        step_count: content.steps?.length ?? 0,
        step_progress: stepProgress,
        step_index: stepIndex,
        step_total: stepTotal,
        model: resultSource.model || null,
        argument_style: resultSource.argument_style || null,
        cost,
        batch_id: content.batch_id || null,
        // Groups every row that belongs to the same overall run together:
        // an execution attempt's chain_id is the plan row it's executing
        // (content.source_plan_id); a plan row's chain_id is its own id,
        // since it's the root of its own chain. Two rows can share
        // scenario/model/framing/style and still be completely unrelated
        // branch points — chain_id (+ step_index) is what actually says
        // "these belong to the same run."
        chain_id: content.source_plan_id || id,
        description: content.description || null,
      };
    } catch (e) {
      return { id, error: "unreadable" };
    }
  });

  // A row is a "leaf" if nothing in its chain continues from it — the
  // frontier of exploration, not a step that's since been superseded.
  // Every row defaults to leaf; we clear it on exactly the rows that
  // something downstream branched from: the plan (step 0) if any
  // execution was attempted at all, and — per step — whichever attempt
  // was the "canonical" one (baseline if accepted, else the first
  // accepted style in STYLE_PRIORITY order, mirroring pickCanonical in
  // scripts/batch/steps-run.js) if a next step exists for that chain.
  const usable = summaries.filter((r) => !r.error);
  for (const r of usable) r.is_leaf = true;
  const byChain = new Map();
  for (const r of usable) {
    if (!byChain.has(r.chain_id)) byChain.set(r.chain_id, []);
    byChain.get(r.chain_id).push(r);
  }
  for (const chainRows of byChain.values()) {
    const planRow = chainRows.find((r) => r.mode !== "execution");
    const stepRows = chainRows.filter((r) => r.mode === "execution");
    if (planRow) planRow.is_leaf = stepRows.length === 0;

    const maxStep = stepRows.reduce((m, r) => Math.max(m, r.step_index || 0), 0);
    for (let step = 1; step <= maxStep; step++) {
      const hasNext = stepRows.some((r) => r.step_index === step + 1);
      if (!hasNext) continue;
      const atStep = stepRows.filter((r) => r.step_index === step);
      const baseline = atStep.find((r) => r.argument_style === "baseline");
      let canonical = baseline?.step_accepted ? baseline : null;
      if (!canonical) {
        const acceptedStyles = atStep
          .filter((r) => r.step_accepted && r.argument_style !== "baseline")
          .sort((a, b) => STYLE_PRIORITY.indexOf(a.argument_style) - STYLE_PRIORITY.indexOf(b.argument_style));
        canonical = acceptedStyles[0] || null;
      }
      if (canonical) canonical.is_leaf = false;
    }
  }

  summaries.sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || ""));
  return NextResponse.json(summaries);
}
```

Note: the `path.basename` traversal guard from the old `?file=` handler is gone — a uuid lookup via `.eq("id", id)` has no path-traversal surface, so it isn't needed.

- [ ] **Step 2: Verify**

Run: `curl -s http://localhost:3000/api/runs | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).slice(0,2)))"`
Expected: an array of summary objects, each with an `id` field (uuid), including the row saved in Task 2's verification step.

Run: `curl -s "http://localhost:3000/api/runs?id=<id from previous step>"`
Expected: the full run object (`scenario_id`, `direct_result`, etc.), matching what was inserted.

- [ ] **Step 3: Commit**

```bash
git add app/api/runs/route.js
git commit -m "Read saved runs from Supabase instead of local files"
```

---

### Task 4: Web app compare aggregation — `GET /api/compare`

**Files:**
- Modify: `app/api/compare/route.js`

**Interfaces:**
- Consumes: `getSupabaseClient()` from [[Task 1]]. Reads `batches` rows written by [[Task 8]]–[[Task 11]] (a batch row may not exist yet for older/manual runs — `attemptStatus` must degrade to `null`, not throw).
- Produces: `GET /api/compare` rows now carry `id` instead of `filename` (samples too). Consumed by [[Task 7]].

- [ ] **Step 1: Rewrite the route**

Replace the full contents of `app/api/compare/route.js` with:

```js
import { NextResponse } from "next/server";
import { getSupabaseClient } from "../../../lib/supabase.js";

function execTurns(turns) {
  return (turns || []).filter((t) => t.role === "executor").length;
}

// Aggregates every single-style linear or chained run (run_kind set by
// scripts/batch-eval-linear.js / scripts/batch-eval-chained.js) into one
// row per (pipeline, model, scenario, style) — but a given combination can
// have been run more than once (resampled, since these models aren't
// deterministic and results near a decision boundary can flip run to
// run). Every matching row becomes one "sample" under its combo; the
// combo's headline numbers are the *best* sample (deepest reached), with
// the full sample list carried along so a caller can show every attempt,
// not just the best one, and compute a reproducibility rate.
function toSample(id, content, attemptStatus) {
  const base = {
    id,
    pipeline: content.run_kind,
    model: null,
    scenario: content.scenario_id,
    scenario_title: content.scenario_title,
    style: content.style,
    saved_at: content.saved_at,
    inProgress: attemptStatus(content.batch_id, id) === "running",
  };

  if (content.run_kind === "linear") {
    const pr = content.plan_result;
    const totalSteps = pr?.plan?.length ?? 4;
    const stepsAccepted = (content.steps || []).filter((s) => s.accepted).length;
    const depth = pr?.accepted ? stepsAccepted : 0;
    let turnsUsed = execTurns(pr?.turns);
    (content.steps || []).forEach((s) => (turnsUsed += execTurns(s.turns)));
    return {
      ...base,
      model: pr?.model,
      planAccepted: Boolean(pr?.accepted),
      planFraming: pr?.framing || null,
      depth,
      fullSteps: totalSteps,
      completed: Boolean(pr?.accepted && depth === totalSteps),
      turnsUsed,
    };
  }
  const dr = content.direct_result;
  return {
    ...base,
    model: dr?.model,
    depth: dr?.tools_called?.length ?? 0,
    fullSteps: dr?.total_tools ?? 4,
    completed: dr?.accepted === true,
    turnsUsed: execTurns(dr?.turns),
    toolsList: dr?.tools_called || [],
  };
}

export async function GET() {
  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase.from("runs").select("id, data, batch_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const relevant = rows.filter((r) => r.data?.run_kind === "linear" || r.data?.run_kind === "chained");

  // A run's batch (the `batches` row for its batch_id) tracks each
  // attempt's live status ("pending" | "running" | "done" | "error") while
  // the batch script is still working through its matrix — this is how the
  // UI knows a sample's numbers might still change, distinct from a sample
  // that's just incomplete because the model stopped partway through.
  // Fetched once for every distinct batch_id in play, not per-row.
  const batchIds = [...new Set(relevant.map((r) => r.batch_id).filter(Boolean))];
  const manifestByBatch = new Map();
  if (batchIds.length) {
    const { data: batchRows } = await supabase.from("batches").select("id, data").in("id", batchIds);
    for (const b of batchRows || []) manifestByBatch.set(b.id, b.data);
  }
  function attemptStatus(batchId, runId) {
    if (!batchId) return null;
    const manifest = manifestByBatch.get(batchId);
    const attempt = manifest?.attempts?.find((a) => a.runId === runId);
    return attempt?.status ?? null;
  }

  const samples = relevant.map((r) => toSample(r.id, r.data, attemptStatus));

  const byCombo = new Map();
  for (const s of samples) {
    const key = [s.pipeline, s.model, s.scenario, s.style].join("|");
    if (!byCombo.has(key)) byCombo.set(key, []);
    byCombo.get(key).push(s);
  }

  const combos = [...byCombo.values()].map((group) => {
    group.sort((a, b) => (a.saved_at || "").localeCompare(b.saved_at || ""));
    const best = group.reduce((a, b) => (b.depth > a.depth ? b : a));
    const completedCount = group.filter((s) => s.completed).length;
    return {
      pipeline: best.pipeline,
      model: best.model,
      scenario: best.scenario,
      scenario_title: best.scenario_title,
      style: best.style,
      depth: best.depth,
      fullSteps: best.fullSteps,
      completed: best.completed,
      planAccepted: best.planAccepted,
      planFraming: best.planFraming,
      turnsUsed: best.turnsUsed,
      id: best.id,
      sampleCount: group.length,
      completedCount,
      anyRunning: group.some((s) => s.inProgress),
      samples: group,
    };
  });

  return NextResponse.json(combos);
}
```

- [ ] **Step 2: Verify**

Run: `curl -s http://localhost:3000/api/compare | node -e "process.stdin.once('data', d => console.log(JSON.parse(d)))"`
Expected: `[]` (no linear/chained runs exist yet — that only happens once Task 9/10's pipelines write some). No 500 error.

- [ ] **Step 3: Commit**

```bash
git add app/api/compare/route.js
git commit -m "Read model-comparison data from Supabase instead of local files"
```

---

### Task 5: Frontend — `app/page.js`

**Files:**
- Modify: `app/page.js`

**Interfaces:**
- Consumes: `/api/runs` and `/api/save-run` response shapes from [[Task 2]], [[Task 3]] (`id` instead of `filename`).

- [ ] **Step 1: Deep-link query param**

In the `useEffect` around line 111-117, replace:
```js
  // Deep link from the runs explorer (/runs "Open" button): ?file=<name>
  // loads that run on mount, same as clicking "Load" in the browser below.
  useEffect(() => {
    const file = new URLSearchParams(window.location.search).get("file");
    if (file) loadRun(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```
with:
```js
  // Deep link from the runs explorer (/runs "Open" button): ?id=<uuid>
  // loads that run on mount, same as clicking "Load" in the browser below.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) loadRun(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 2: `loadRun`**

Around line 150-152, replace:
```js
  async function loadRun(filename) {
    setLoadingRun(true);
    const res = await fetch(`/api/runs?file=${encodeURIComponent(filename)}`);
```
with:
```js
  async function loadRun(id) {
    setLoadingRun(true);
    const res = await fetch(`/api/runs?id=${encodeURIComponent(id)}`);
```

- [ ] **Step 3: Save messages**

Around line 245-257 (`saveRun`) and 259-271 (`saveDirectRun`), replace both occurrences of:
```js
    setSaveMessage(data.saved ? `Saved as runs/${data.filename}` : `Save failed: ${data.error}`);
```
and
```js
    setSaveDirectMessage(data.saved ? `Saved as runs/${data.filename}` : `Save failed: ${data.error}`);
```
with:
```js
    setSaveMessage(data.saved ? `Saved (id ${data.id})` : `Save failed: ${data.error}`);
```
and
```js
    setSaveDirectMessage(data.saved ? `Saved (id ${data.id})` : `Save failed: ${data.error}`);
```
respectively (same line positions, just the message body and the field read).

- [ ] **Step 4: Runs list rendering**

Around line 407-426, replace:
```js
              {runsList.map((r) => (
                <div key={r.filename} className="run-row">
                  <div>
                    <div className="mono" style={{ fontSize: 12.5 }}>
                      {r.filename}
                    </div>
```
with:
```js
              {runsList.map((r) => (
                <div key={r.id} className="run-row">
                  <div>
                    <div className="mono" style={{ fontSize: 12.5 }}>
                      {r.id}
                    </div>
```
and, a few lines below, replace:
```js
                  <button className="btn" onClick={() => loadRun(r.filename)} disabled={loadingRun}>
```
with:
```js
                  <button className="btn" onClick={() => loadRun(r.id)} disabled={loadingRun}>
```

- [ ] **Step 5: Verify in the browser**

Run: `npm run dev`, open `http://localhost:3000`, run a direct ask or a plan, click "Save this run" — confirm the save message reads `Saved (id ...)`. Click "Browse saved runs", confirm the list shows the run with its uuid, click "Load" and confirm it reloads correctly. Visit `http://localhost:3000/?id=<that uuid>` directly and confirm it deep-links the same run.

- [ ] **Step 6: Commit**

```bash
git add app/page.js
git commit -m "Switch manual dashboard from filename to id for saved runs"
```

---

### Task 6: Frontend — `app/runs/page.js`

**Files:**
- Modify: `app/runs/page.js`

**Interfaces:**
- Consumes: `/api/runs` summaries from [[Task 3]] (`id` instead of `filename`).

- [ ] **Step 1: Table row key and deep link**

Around line 250-274, replace:
```js
                  {sorted.map((r) => (
                    <tr key={r.filename}>
```
with:
```js
                  {sorted.map((r) => (
                    <tr key={r.id}>
```
and replace:
```js
                      <td>
                        <a className="btn btn-ghost" href={`/?file=${encodeURIComponent(r.filename)}`}>
                          Open
                        </a>
                      </td>
```
with:
```js
                      <td>
                        <a className="btn btn-ghost" href={`/?id=${encodeURIComponent(r.id)}`}>
                          Open
                        </a>
                      </td>
```

- [ ] **Step 2: Verify in the browser**

Run: `npm run dev`, open `http://localhost:3000/runs`, confirm the table renders and the "Open" link on a row navigates to `/?id=<uuid>` and loads that run.

- [ ] **Step 3: Commit**

```bash
git add app/runs/page.js
git commit -m "Switch runs explorer from filename to id"
```

---

### Task 7: Frontend — `app/compare/page.js` and `app/components/RunTranscriptModal.js`

**Files:**
- Modify: `app/compare/page.js`
- Modify: `app/components/RunTranscriptModal.js`

**Interfaces:**
- Consumes: `/api/compare` combo/sample shapes from [[Task 4]] (`id` instead of `filename`), `/api/runs?id=` detail endpoint from [[Task 3]].

- [ ] **Step 1: `app/compare/page.js` cell click handling**

Around line 245-259, replace the three `d?.filename` checks:
```js
                                    role={d?.filename ? "button" : undefined}
                                    style={d?.filename ? { cursor: "pointer" } : undefined}
                                    onClick={() => d?.filename && setModalCombo(d)}
                                    onKeyDown={(e) => {
                                      if ((e.key === "Enter" || e.key === " ") && d?.filename) {
```
with:
```js
                                    role={d?.id ? "button" : undefined}
                                    style={d?.id ? { cursor: "pointer" } : undefined}
                                    onClick={() => d?.id && setModalCombo(d)}
                                    onKeyDown={(e) => {
                                      if ((e.key === "Enter" || e.key === " ") && d?.id) {
```

- [ ] **Step 2: `RunTranscriptModal.js` fetch and key**

Around line 44, replace:
```js
    fetch(`/api/runs?file=${encodeURIComponent(sample.filename)}`)
```
with:
```js
    fetch(`/api/runs?id=${encodeURIComponent(sample.id)}`)
```
and update the dependency array on the same `useEffect` (line 51) from:
```js
  }, [open, content, error, sample.filename]);
```
to:
```js
  }, [open, content, error, sample.id]);
```
and, around line 147, replace:
```js
            <SampleBlock key={s.filename} sample={s} index={i} total={samples.length} defaultOpen={samples.length === 1} />
```
with:
```js
            <SampleBlock key={s.id} sample={s} index={i} total={samples.length} defaultOpen={samples.length === 1} />
```

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev`, open `http://localhost:3000/compare`. With no linear/chained runs yet, the grid should render empty cells without errors. (Full interaction — clicking a filled cell to open the transcript modal — is verified in [[Task 9]]/[[Task 10]] once real data exists.)

- [ ] **Step 4: Commit**

```bash
git add app/compare/page.js app/components/RunTranscriptModal.js
git commit -m "Switch compare view and transcript modal from filename to id"
```

---

### Task 8: Batch pipeline — base (plan + execute-step)

**Files:**
- Modify: `scripts/batch/runfile.js`
- Modify: `scripts/batch/state.js`
- Modify: `scripts/batch/run.js`
- Modify: `scripts/batch/report.js`
- Modify: `scripts/batch-eval.js`

**Interfaces:**
- Consumes: `getSupabaseClient()` from [[Task 1]].
- Produces: `writeRunFile(runId, content)`, `readRunFile(runId)` (both async now) from `runfile.js`. `attempt.runId` (uuid) replaces `attempt.filename` throughout this pipeline's state/run/report files. `saveState`/`loadState` in `state.js` become async, backed by the `batches` table keyed by `batch_id`.

- [ ] **Step 1: Rewrite `scripts/batch/runfile.js`**

Remove the `runFileName`/`runFilePath` exports and the `fs`/`path` imports; replace `writeRunFile`/`readRunFile`:

```js
// Writes each batch attempt as its own row in Supabase, in exactly the
// shape POST /api/save-run produces, so it shows up in the manual
// dashboard's "Browse saved runs" list and "Continue arguing" works on it
// unmodified — a batch attempt is meant to look exactly like a manual run
// someone happened to click through by hand, many times over.
import { buildPlannerSystemPrompt } from "../../lib/planner.js";
import { getSupabaseClient } from "../../lib/supabase.js";

function describeAttempt({ batchId, model, framing, style }) {
  const styleLabel = style ? `argument style: ${style}` : "baseline (single one-shot ask, no pushback)";
  return `Batch "${batchId}" — ${model} — ${framing} framing — ${styleLabel}`;
}

function lastExecutorTurn(turns) {
  return [...turns].reverse().find((t) => t.role === "executor");
}

export function buildRunFileContent({ batchId, scenario, attempt }) {
  const last = lastExecutorTurn(attempt.turns);
  const planResult = {
    accepted: attempt.accepted,
    plan: attempt.accepted ? last?.payload?.plan ?? null : null,
    raw_text: last?.text ?? "",
    framing: attempt.framing,
    truncated: last?.truncated ?? false,
    turns: attempt.turns,
    messages: attempt.messages,
    argument_style: attempt.style || "baseline",
    provider: "anthropic",
    model: attempt.model,
    total_cost: attempt.cost,
    system_prompt: buildPlannerSystemPrompt(scenario, attempt.framing),
    initial_user_message: attempt.messages[0]?.content ?? scenario.goal[attempt.framing],
  };

  return {
    saved_at: new Date().toISOString(),
    scenario_id: scenario.scenario_id,
    scenario_title: scenario.title,
    framing: attempt.framing,
    direct_result: null,
    plan_result: planResult,
    steps: null,
    description: describeAttempt({ batchId, model: attempt.model, framing: attempt.framing, style: attempt.style }),
    batch_id: batchId,
    attempt_id: attempt.id,
  };
}

export async function writeRunFile(runId, content) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("runs").upsert({
    id: runId,
    user_email: process.env.RUN_AUTHOR_EMAIL,
    scenario_id: content.scenario_id,
    scenario_title: content.scenario_title,
    framing: content.framing,
    source_plan_id: content.source_plan_id || null,
    batch_id: content.batch_id || null,
    description: content.description || null,
    data: content,
  });
  if (error) throw new Error(`Failed to write run ${runId}: ${error.message}`);
}

export async function readRunFile(runId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("runs").select("data").eq("id", runId).single();
  if (error) throw new Error(`Failed to read run ${runId}: ${error.message}`);
  return data.data;
}
```

- [ ] **Step 2: Rewrite `scripts/batch/state.js`**

Replace the full contents (drops `fs`/`path`/`BATCHES_DIR`, `batchDir`, `manifestPath`, `batchSummaryPath` no longer write to a directory on disk — `batchSummaryPath` is still used by `report.js` to write the CSV locally, so it's kept but simplified since there's no longer a directory to create for it):

```js
import fs from "fs";
import path from "path";
import { buildInitialAttempts } from "./matrix.js";
import { readRunFile } from "./runfile.js";
import { getSupabaseClient } from "../../lib/supabase.js";

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// The batch row is bookkeeping only — which attempts exist, their status,
// cost, and which run row (attempt.runId) holds their actual content. It
// never stores turns/messages itself; those live in each attempt's
// individual run row (see runfile.js) so that row can be browsed/continued
// in the manual dashboard independently of the batch that produced it.
function stripHeavy(attempt) {
  const { turns, messages, ...rest } = attempt;
  return rest;
}

export async function saveState(state) {
  const supabase = getSupabaseClient();
  const manifest = { ...state, attempts: state.attempts.map(stripHeavy) };
  const { error } = await supabase
    .from("batches")
    .upsert({ id: state.batch_id, user_email: process.env.RUN_AUTHOR_EMAIL, data: manifest });
  if (error) throw new Error(`Failed to save batch ${state.batch_id}: ${error.message}`);
}

// Loads the batch row and hydrates each attempt's turns/messages back from
// its run row (if it has one yet), so the runner can resume a
// mid-negotiation attempt exactly where it left off.
export async function loadState(batchId) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase.from("batches").select("data").eq("id", batchId).single();
  // PGRST116 = no row matched .single() — a legitimate "batch doesn't exist
  // yet" case. Any other error (network, auth, permissions) must not be
  // read as "no existing batch": resolveState() would silently start a
  // fresh batch and re-run everything from scratch instead of surfacing
  // the failure, double-spending on a transient blip.
  if (error && error.code !== "PGRST116") throw new Error(`Failed to load batch ${batchId}: ${error.message}`);
  if (!row) return null;
  const manifest = row.data;
  manifest.attempts = await Promise.all(
    manifest.attempts.map(async (a) => {
      if (!a.runId) return { ...a, turns: [], messages: [] };
      const runFile = await readRunFile(a.runId);
      return {
        ...a,
        turns: runFile.plan_result?.turns || [],
        messages: runFile.plan_result?.messages || [],
      };
    })
  );
  return manifest;
}

// Loads an existing batch's state if present (validating the requested
// matrix parameters still match what's stored, since resuming with a
// different model/scenario/turn-budget list would silently produce a
// half-mixed matrix), or creates a fresh one.
export async function resolveState({ batchId, models, scenarioIds, maxTurns, budgetCap }) {
  const existing = await loadState(batchId);
  if (existing) {
    if (!sameSet(existing.models, models) || !sameSet(existing.scenario_ids, scenarioIds)) {
      throw new Error(
        `Batch "${batchId}" already exists with models=[${existing.models}] ` +
          `scenarios=[${existing.scenario_ids}], which differs from the requested ` +
          `models=[${models}] scenarios=[${scenarioIds}]. Use a different --batch-id, ` +
          `or omit --models/--scenarios to resume with the stored matrix.`
      );
    }
    if (existing.max_turns !== maxTurns) {
      throw new Error(
        `Batch "${batchId}" was created with --max-turns ${existing.max_turns}, ` +
          `but ${maxTurns} was requested. Use a different --batch-id, or omit ` +
          `--max-turns to resume with the stored value.`
      );
    }
    if (budgetCap !== undefined) existing.budget_cap = budgetCap;
    return existing;
  }

  return {
    batch_id: batchId,
    models,
    scenario_ids: scenarioIds,
    max_turns: maxTurns,
    budget_cap: budgetCap ?? null,
    cumulative_cost: 0,
    created_at: new Date().toISOString(),
    attempts: buildInitialAttempts({ models, scenarioIds }),
  };
}

// summary.csv still lands on the local disk the batch script runs on —
// that's a human-readable report artifact, not the source of truth for
// runs, so it's out of scope for the Supabase migration (see design doc's
// "Out of scope").
export function batchSummaryPath(batchId, filename) {
  const dir = path.join(process.cwd(), "runs", "batches", batchId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}
```

- [ ] **Step 3: Update `scripts/batch/run.js`**

Replace the import line:
```js
import { runFileName, buildRunFileContent, writeRunFile } from "./runfile.js";
```
with:
```js
import { randomUUID } from "crypto";
import { buildRunFileContent, writeRunFile } from "./runfile.js";
```

Replace the id-assignment block (around line 34-42):
```js
  if (!attempt.filename) {
    attempt.filename = runFileName({
      scenarioId: attempt.scenario_id,
      framing: attempt.framing,
      style: attempt.style,
      model: attempt.model,
      startedAt: new Date().toISOString(),
    });
  }
  const persistRunFile = () =>
    writeRunFile(attempt.filename, buildRunFileContent({ batchId: state.batch_id, scenario, attempt }));
  persistRunFile();
```
with:
```js
  if (!attempt.runId) {
    attempt.runId = randomUUID();
  }
  const persistRunFile = () =>
    writeRunFile(attempt.runId, buildRunFileContent({ batchId: state.batch_id, scenario, attempt }));
  await persistRunFile();
```

`persistRunFile` is called again inside `onTurn` (around line 56) and needs `await` there too — replace:
```js
    persistRunFile();
    saveState(state);
```
(both occurrences in this file) with:
```js
    await persistRunFile();
    await saveState(state);
```

- [ ] **Step 4: Update `scripts/batch/report.js`**

`batchSummaryPath` is now async-neutral (unchanged signature) but `printSummaryTable`/`writeSummaryCsv` read `attempt.filename`, which no longer exists. Replace, in `toRow`:
```js
    filename: attempt.filename || "",
```
with:
```js
    run_id: attempt.runId || "",
```
and in the default-columns fallback object, replace the `filename: ""` key with `run_id: ""`. (`printSummaryTable`/`writeSummaryCsv` bodies are otherwise unchanged — `state.attempts` is already resolved data at this point, no `await` needed here.)

- [ ] **Step 5: Update `scripts/batch-eval.js`**

Add the fail-fast env check right after `loadEnvLocalOverriding(...)` is called (find that call near the top of `main()` or module scope — it's the function defined at line ~27) and before any state is resolved:
```js
if (!process.env.RUN_AUTHOR_EMAIL) {
  console.error(
    "RUN_AUTHOR_EMAIL must be set (the email to attribute these runs to). " +
      "Add it to .env.local or export it before running this script."
  );
  process.exit(1);
}
```

Then update the three call sites that now return promises — `loadState`, `resolveState`, `saveState` are all `await`ed already if this script follows the same pattern seen in `run.js`; grep to confirm and add `await` wherever missing:
```bash
grep -n "loadState(\|resolveState(\|saveState(" scripts/batch-eval.js
```
Add `await` in front of any bare (non-awaited) call found.

- [ ] **Step 6: Verify end-to-end**

Run (deliberately without `RUN_AUTHOR_EMAIL` set, and with no `RUN_AUTHOR_EMAIL` line in `.env.local` either):
```bash
node scripts/batch-eval.js --models claude-haiku-4-5 --scenarios <pick one from `ls scenarios/`> --yes --batch-id should-not-run
```
Expected: exits immediately (before any API call) with the "RUN_AUTHOR_EMAIL must be set..." message and a non-zero exit code — confirm with `echo $?` → `1`. Confirm no row was written: `mcp__supabase__execute_sql` with `query: "select count(*) from runs where batch_id = 'should-not-run';"` → `0`.

Run:
```bash
RUN_AUTHOR_EMAIL=you@example.com node scripts/batch-eval.js --models claude-haiku-4-5 \
  --scenarios <pick one from `ls scenarios/`> --max-turns 3 --budget 1 --yes --batch-id smoke-test-base
```
Expected: it runs to completion (or budget stop) without throwing, printing per-turn logs.

Run: `mcp__supabase__execute_sql` with `query: "select id, batch_id, user_email from runs where batch_id = 'smoke-test-base';"`
Expected: at least one row, `user_email = 'you@example.com'`.

Run: `mcp__supabase__execute_sql` with `query: "select id, user_email, data->'attempts' as attempts from batches where id = 'smoke-test-base';"`
Expected: one row; each attempt object has `runId` (not `filename`) matching the `id`s from the previous query.

- [ ] **Step 7: Commit**

```bash
git add scripts/batch/runfile.js scripts/batch/state.js scripts/batch/run.js scripts/batch/report.js scripts/batch-eval.js
git commit -m "Move base batch pipeline (plan+execute) to Supabase"
```

---

### Task 9: Batch pipeline — linear

**Files:**
- Modify: `scripts/batch/linear-runfile.js`
- Modify: `scripts/batch/linear-state.js`
- Modify: `scripts/batch/linear-run.js`
- Modify: `scripts/batch/linear-report.js`
- Modify: `scripts/batch-eval-linear.js`

**Interfaces:** Same pattern as [[Task 8]] — `attempt.runId` replaces `attempt.filename`; `writeRunFile`/`saveState`/`loadState` become async and Supabase-backed.

- [ ] **Step 1: Rewrite `scripts/batch/linear-runfile.js`**

Remove `linearRunFileName`/`runFilePath`/`fs`/`path`; keep `buildLinearRunFileContent` unchanged; replace `writeRunFile`:

```js
// One row per (model, scenario, style) chain — the whole run (plan, then
// steps 1..N until the first refusal) lives in a single GUI-compatible
// row, matching exactly how a human clicking through the manual dashboard
// would produce it: plan_result once, steps appended in order.
import { getSupabaseClient } from "../../lib/supabase.js";

export function buildLinearRunFileContent({ batchId, scenario, chain }) {
  const stepsDone = chain.steps.length;
  const totalSteps = chain.planResult?.plan?.length ?? null;
  const framing = chain.planResult?.framing || "real";
  const description = !chain.planResult?.accepted
    ? `Linear batch "${batchId}" — ${chain.model} — ${framing} framing — style: ${chain.style} — plan refused`
    : `Linear batch "${batchId}" — ${chain.model} — accepted under ${framing} framing — style: ${chain.style} — reached step ${stepsDone}${totalSteps ? "/" + totalSteps : ""}`;

  return {
    saved_at: new Date().toISOString(),
    scenario_id: scenario.scenario_id,
    scenario_title: scenario.title,
    framing,
    direct_result: null,
    plan_result_real_attempt: chain.planResultReal,
    plan_result: chain.planResult,
    steps: chain.steps,
    description,
    batch_id: batchId,
    run_kind: "linear",
    style: chain.style,
  };
}

export async function writeRunFile(runId, content) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("runs").upsert({
    id: runId,
    user_email: process.env.RUN_AUTHOR_EMAIL,
    scenario_id: content.scenario_id,
    scenario_title: content.scenario_title,
    framing: content.framing,
    source_plan_id: content.source_plan_id || null,
    batch_id: content.batch_id || null,
    description: content.description || null,
    data: content,
  });
  if (error) throw new Error(`Failed to write run ${runId}: ${error.message}`);
}
```

- [ ] **Step 2: Rewrite `scripts/batch/linear-state.js`**

```js
import fs from "fs";
import path from "path";
import { getSupabaseClient } from "../../lib/supabase.js";

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// Each attempt IS a full chain (plan + however many steps it reached) —
// no branching, so there's nothing to hydrate from sibling rows. The
// chain's own messages/turns for whichever stage is in progress are read
// straight back from its own run row.
export async function loadState(batchId) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase.from("batches").select("data").eq("id", batchId).single();
  // PGRST116 = no row matched .single() — a legitimate "batch doesn't exist
  // yet" case. Any other error (network, auth, permissions) must not be
  // read as "no existing batch": resolveState() would silently start a
  // fresh batch and re-run everything from scratch instead of surfacing
  // the failure, double-spending on a transient blip.
  if (error && error.code !== "PGRST116") throw new Error(`Failed to load batch ${batchId}: ${error.message}`);
  if (!row) return null;
  const manifest = row.data;
  manifest.attempts = await Promise.all(
    manifest.attempts.map(async (a) => {
      if (!a.runId) return { ...a, planResult: null, steps: [] };
      const { data: runRow, error: runError } = await supabase.from("runs").select("data").eq("id", a.runId).single();
      if (runError && runError.code !== "PGRST116") {
        throw new Error(`Failed to load run ${a.runId} for batch ${batchId}: ${runError.message}`);
      }
      if (!runRow) return { ...a, planResult: null, steps: [] };
      return { ...a, planResult: runRow.data.plan_result, steps: runRow.data.steps || [] };
    })
  );
  return manifest;
}

export async function saveState(state) {
  const supabase = getSupabaseClient();
  const manifest = {
    ...state,
    attempts: state.attempts.map(({ planResult, steps, ...rest }) => rest),
  };
  const { error } = await supabase
    .from("batches")
    .upsert({ id: state.batch_id, user_email: process.env.RUN_AUTHOR_EMAIL, data: manifest });
  if (error) throw new Error(`Failed to save batch ${state.batch_id}: ${error.message}`);
}

export async function resolveState({ batchId, models, scenarioIds, styles, maxTurns, budgetCap }) {
  const existing = await loadState(batchId);
  if (existing) {
    if (
      !sameSet(existing.models, models) ||
      !sameSet(existing.scenario_ids, scenarioIds) ||
      !sameSet(existing.styles, styles) ||
      existing.max_turns !== maxTurns
    ) {
      throw new Error(
        `Batch "${batchId}" already exists with a different matrix. Use a different --batch-id, ` +
          `or omit those flags to resume with the stored matrix.`
      );
    }
    if (budgetCap !== undefined) existing.budget_cap = budgetCap;
    return existing;
  }

  const attempts = [];
  for (const model of models) {
    for (const scenarioId of scenarioIds) {
      for (const style of styles) {
        attempts.push({
          id: `${model}|${scenarioId}|${style}`,
          model,
          scenario_id: scenarioId,
          style,
          status: "pending",
          runId: null,
          cost: 0,
          error: null,
        });
      }
    }
  }

  return {
    batch_id: batchId,
    models,
    scenario_ids: scenarioIds,
    styles,
    max_turns: maxTurns,
    budget_cap: budgetCap ?? null,
    cumulative_cost: 0,
    created_at: new Date().toISOString(),
    attempts,
  };
}

// summary.csv still lands on local disk — a human-readable report
// artifact, not the source of truth for runs, so it's out of scope for
// the Supabase migration (see design doc's "Out of scope"). Unchanged
// from before except it no longer shares a directory with run files.
export function batchSummaryPath(batchId, filename) {
  const dir = path.join(process.cwd(), "runs", "batches", batchId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}
```

`scripts/batch/linear-report.js` already imports `batchSummaryPath` from `./linear-state.js` (confirmed via `grep -n "batchSummaryPath" scripts/batch/linear-report.js`) — no change needed there.

- [ ] **Step 3: Update `scripts/batch/linear-run.js`**

Replace the import:
```js
import { linearRunFileName, buildLinearRunFileContent, writeRunFile } from "./linear-runfile.js";
```
with:
```js
import { randomUUID } from "crypto";
import { buildLinearRunFileContent, writeRunFile } from "./linear-runfile.js";
```

Replace (around line 22-29):
```js
  if (!attempt.filename) {
    attempt.filename = linearRunFileName({
      scenarioId: attempt.scenario_id,
      style: attempt.style,
      model: attempt.model,
      startedAt: new Date().toISOString(),
    });
  }
```
with:
```js
  if (!attempt.runId) {
    attempt.runId = randomUUID();
  }
```

Replace (line 33-34):
```js
  const persist = () =>
    writeRunFile(attempt.filename, buildLinearRunFileContent({ batchId: state.batch_id, scenario, chain }));
```
with:
```js
  const persist = () =>
    writeRunFile(attempt.runId, buildLinearRunFileContent({ batchId: state.batch_id, scenario, chain }));
```

Every call site of `persist()` and `saveState(state)` in this file (inside `makeOnTurn`'s returned function, and after the plan/step stages, and in the catch block, and at the end of `runChain`) must now be awaited — grep and fix:
```bash
grep -n "persist()\|saveState(state)" scripts/batch/linear-run.js
```
Add `await` before every occurrence.

- [ ] **Step 4: Update `scripts/batch/linear-report.js`**

Same rename as Task 8 Step 4 — replace `filename: a.filename || ""` with `run_id: a.runId || ""` in `toRow`, and the matching default-columns key.

- [ ] **Step 5: Update `scripts/batch-eval-linear.js`**

Same as Task 8 Step 5: add the `RUN_AUTHOR_EMAIL` fail-fast check after `loadEnvLocalOverriding`, and `await` any bare `loadState`/`resolveState`/`saveState` calls (`grep -n "loadState(\|resolveState(\|saveState(" scripts/batch-eval-linear.js`).

- [ ] **Step 6: Verify end-to-end**

Run:
```bash
RUN_AUTHOR_EMAIL=you@example.com node scripts/batch-eval-linear.js --models claude-haiku-4-5 \
  --scenarios <pick one> --styles ethical --max-turns 3 --budget 1 --yes --batch-id smoke-test-linear
```
Expected: runs to completion or budget stop without error.

Run: `curl -s http://localhost:3000/api/compare` (dev server running)
Expected: at least one combo with `pipeline: "linear"`. Open `http://localhost:3000/compare` in the browser, confirm the cell is clickable and the transcript modal opens and fetches successfully.

- [ ] **Step 7: Commit**

```bash
git add scripts/batch/linear-runfile.js scripts/batch/linear-state.js scripts/batch/linear-run.js scripts/batch/linear-report.js scripts/batch-eval-linear.js
git commit -m "Move linear batch pipeline to Supabase"
```

---

### Task 10: Batch pipeline — chained

**Files:**
- Modify: `scripts/batch/chained-runfile.js`
- Modify: `scripts/batch/chained-state.js`
- Modify: `scripts/batch/chained-run.js`
- Modify: `scripts/batch/chained-report.js`
- Modify: `scripts/batch-eval-chained.js`

**Interfaces:** Same pattern as [[Task 9]].

- [ ] **Step 1: Rewrite `scripts/batch/chained-runfile.js`**

Remove `chainedRunFileName`/`runFilePath`/`fs`/`path`; keep `buildChainedRunFileContent` unchanged; replace `writeRunFile` with the same body as Task 9 Step 1's `writeRunFile` (identical shape — `content.scenario_id`, `content.scenario_title`, `content.framing`, `content.source_plan_id`, `content.batch_id`, `content.description`, `content.style`-derived fields are already all present on the built content object).

```js
// One row per (model, scenario, style) chained run — saved as a
// direct_result (like POST /api/ask-direct produces), since the manual
// dashboard's TurnBody already renders each turn's own tool call as it
// happened without needing to know this conversation makes several calls
// in sequence rather than one.
import { getSupabaseClient } from "../../lib/supabase.js";

export function buildChainedRunFileContent({ batchId, scenario, attempt, result, systemPrompt, initialUserMessage }) {
  const toolsCalled = result.toolsCalled.length;
  const totalTools = result.totalTools;
  const description = `Chained batch "${batchId}" — ${attempt.model} — real framing — style: ${attempt.style} — called ${toolsCalled}/${totalTools} tool(s)`;

  return {
    saved_at: new Date().toISOString(),
    scenario_id: scenario.scenario_id,
    scenario_title: scenario.title,
    framing: "real",
    direct_result: {
      accepted: toolsCalled === totalTools,
      tool_call: null,
      raw_text: [...result.turns].reverse().find((t) => t.role === "executor")?.text ?? "",
      framing: "real",
      truncated: [...result.turns].reverse().find((t) => t.role === "executor")?.truncated ?? false,
      turns: result.turns,
      messages: result.messages,
      argument_style: attempt.style,
      provider: "anthropic",
      model: attempt.model,
      total_cost: result.cost,
      system_prompt: systemPrompt,
      initial_user_message: initialUserMessage,
      tools_called: result.toolsCalled,
      total_tools: totalTools,
    },
    plan_result: null,
    steps: null,
    description,
    batch_id: batchId,
    run_kind: "chained",
    style: attempt.style,
  };
}

export async function writeRunFile(runId, content) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("runs").upsert({
    id: runId,
    user_email: process.env.RUN_AUTHOR_EMAIL,
    scenario_id: content.scenario_id,
    scenario_title: content.scenario_title,
    framing: content.framing,
    source_plan_id: content.source_plan_id || null,
    batch_id: content.batch_id || null,
    description: content.description || null,
    data: content,
  });
  if (error) throw new Error(`Failed to write run ${runId}: ${error.message}`);
}
```

- [ ] **Step 2: Rewrite `scripts/batch/chained-state.js`**

```js
import fs from "fs";
import path from "path";
import { getSupabaseClient } from "../../lib/supabase.js";

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// Same simplification as the linear pipeline: a chain is cheap and
// self-contained, so on resume an incomplete attempt just restarts from
// scratch rather than trying to restore a mid-negotiation tool-slot.
export async function loadState(batchId) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase.from("batches").select("data").eq("id", batchId).single();
  // PGRST116 = no row matched .single() — a legitimate "batch doesn't exist
  // yet" case. Any other error (network, auth, permissions) must not be
  // read as "no existing batch": resolveState() would silently start a
  // fresh batch and re-run everything from scratch instead of surfacing
  // the failure, double-spending on a transient blip.
  if (error && error.code !== "PGRST116") throw new Error(`Failed to load batch ${batchId}: ${error.message}`);
  if (!row) return null;
  const manifest = row.data;
  manifest.attempts = await Promise.all(
    manifest.attempts.map(async (a) => {
      if (!a.runId) return { ...a, directResult: null };
      const { data: runRow, error: runError } = await supabase.from("runs").select("data").eq("id", a.runId).single();
      if (runError && runError.code !== "PGRST116") {
        throw new Error(`Failed to load run ${a.runId} for batch ${batchId}: ${runError.message}`);
      }
      if (!runRow) return { ...a, directResult: null };
      return { ...a, directResult: runRow.data.direct_result };
    })
  );
  return manifest;
}

export async function saveState(state) {
  const supabase = getSupabaseClient();
  const manifest = { ...state, attempts: state.attempts.map(({ directResult, ...rest }) => rest) };
  const { error } = await supabase
    .from("batches")
    .upsert({ id: state.batch_id, user_email: process.env.RUN_AUTHOR_EMAIL, data: manifest });
  if (error) throw new Error(`Failed to save batch ${state.batch_id}: ${error.message}`);
}

export async function resolveState({ batchId, models, scenarioIds, styles, maxTurns, budgetCap }) {
  const existing = await loadState(batchId);
  if (existing) {
    if (
      !sameSet(existing.models, models) ||
      !sameSet(existing.scenario_ids, scenarioIds) ||
      !sameSet(existing.styles, styles) ||
      existing.max_turns !== maxTurns
    ) {
      throw new Error(
        `Batch "${batchId}" already exists with a different matrix (models/scenarios/styles/max_turns). ` +
          `Use a different --batch-id, or omit those flags to resume with the stored matrix.`
      );
    }
    if (budgetCap !== undefined) existing.budget_cap = budgetCap;
    return existing;
  }

  const attempts = [];
  for (const model of models) {
    for (const scenarioId of scenarioIds) {
      for (const style of styles) {
        attempts.push({
          id: `${model}|${scenarioId}|${style}`,
          model,
          scenario_id: scenarioId,
          style,
          status: "pending",
          runId: null,
          cost: 0,
          error: null,
        });
      }
    }
  }

  return {
    batch_id: batchId,
    models,
    scenario_ids: scenarioIds,
    styles,
    max_turns: maxTurns,
    budget_cap: budgetCap ?? null,
    cumulative_cost: 0,
    created_at: new Date().toISOString(),
    attempts,
  };
}

export function batchSummaryPath(batchId, filename) {
  const dir = path.join(process.cwd(), "runs", "batches", batchId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}
```

`scripts/batch/chained-report.js` already imports `batchSummaryPath` from `./chained-state.js` (confirmed via `grep -n "batchSummaryPath" scripts/batch/chained-report.js`) — no change needed there.

- [ ] **Step 3: Update `scripts/batch/chained-run.js`**

Replace the import:
```js
import { chainedRunFileName, buildChainedRunFileContent, writeRunFile } from "./chained-runfile.js";
```
with:
```js
import { randomUUID } from "crypto";
import { buildChainedRunFileContent, writeRunFile } from "./chained-runfile.js";
```

Replace (around line 10-17):
```js
  if (!attempt.filename) {
    attempt.filename = chainedRunFileName({
      scenarioId: attempt.scenario_id,
      style: attempt.style,
      model: attempt.model,
      startedAt: new Date().toISOString(),
    });
  }
```
with:
```js
  if (!attempt.runId) {
    attempt.runId = randomUUID();
  }
```

Replace (line 22-24):
```js
  const persist = () =>
    writeRunFile(
      attempt.filename,
```
with:
```js
  const persist = () =>
    writeRunFile(
      attempt.runId,
```

All `persist()` and `saveState(state)` call sites in this file (in `onTurn`, after `runChainedToolSequence`, in the catch block, and at the end of `runAttempt`) must be awaited — grep and fix:
```bash
grep -n "persist()\|saveState(state)" scripts/batch/chained-run.js
```

- [ ] **Step 4: Update `scripts/batch/chained-report.js`**

Same rename as before: `filename: a.filename || ""` → `run_id: a.runId || ""` in `toRow`, plus the default-columns key.

- [ ] **Step 5: Update `scripts/batch-eval-chained.js`**

Same as Task 8/9 Step 5: `RUN_AUTHOR_EMAIL` fail-fast check, and `await` any bare state calls.

- [ ] **Step 6: Verify end-to-end**

Run:
```bash
RUN_AUTHOR_EMAIL=you@example.com node scripts/batch-eval-chained.js --models claude-haiku-4-5 \
  --scenarios <pick one> --styles ethical --max-turns 3 --budget 1 --yes --batch-id smoke-test-chained
```
Expected: completes or stops at budget without error.

Run: `curl -s http://localhost:3000/api/compare`, confirm a `pipeline: "chained"` combo appears; open the transcript modal in the browser and confirm it loads.

- [ ] **Step 7: Commit**

```bash
git add scripts/batch/chained-runfile.js scripts/batch/chained-state.js scripts/batch/chained-run.js scripts/batch/chained-report.js scripts/batch-eval-chained.js
git commit -m "Move chained batch pipeline to Supabase"
```

---

### Task 11: Batch pipeline — steps

**Files:**
- Modify: `scripts/batch/steps-runfile.js`
- Modify: `scripts/batch/steps-state.js`
- Modify: `scripts/batch/steps-run.js`
- Modify: `scripts/batch/steps-matrix.js`
- Modify: `scripts/batch/steps-report.js`
- Modify: `scripts/batch-eval-steps.js`

**Interfaces:** Same pattern, plus `discoverAcceptedPlans()` becomes an async Supabase query (was a `fs.readdirSync` scan). `sourcePlan.sourceId` keeps its name but now holds a `runs.id` uuid instead of a filename.

- [ ] **Step 1: Rewrite `scripts/batch/steps-runfile.js`**

Remove `stepRunFileName`/`runFilePath`/`fs`/`path`; keep `buildStepRunFileContent` unchanged; replace `writeRunFile`/`readRunFile`:

```js
// Writes each step-execution attempt as its own row in Supabase, in
// exactly the shape POST /api/save-run produces for a plan+steps
// walkthrough — the original accepted plan (plan_result, unchanged) plus a
// `steps` array containing the canonical result for every step reached
// before this one, ending in this specific attempt's own result. That
// makes each row loadable in the manual dashboard exactly where a human
// would be if they'd clicked through to this point by hand, ready to
// "Continue arguing" or "Retry" on the last step.
import { buildExecutorSystemPrompt, buildExecutorUserMessage } from "../../lib/executor.js";
import { getSupabaseClient } from "../../lib/supabase.js";

function describeStepAttempt({ batchId, sourceId, stepIndex, model, style }) {
  const styleLabel = style ? `argument style: ${style}` : "baseline (single one-shot ask, no pushback)";
  return `Step batch "${batchId}" — step ${stepIndex} of plan from "${sourceId}" — ${model} — ${styleLabel}`;
}

function lastExecutorTurn(turns) {
  return [...turns].reverse().find((t) => t.role === "executor");
}

// `priorCanonicalSteps`: array of already-finalized step entries (indices
// 1..stepIndex-1), in the exact shape stored in a saved run's `steps`
// array. `resolvedArgs`/`toolName`/`priorStepOutputText` describe this
// attempt's own step.
export function buildStepRunFileContent({
  batchId,
  sourcePlan,
  scenario,
  attempt,
  priorCanonicalSteps,
  resolvedArgs,
  toolName,
  priorStepOutputText,
}) {
  const last = lastExecutorTurn(attempt.turns);
  const ownStep = {
    accepted: attempt.accepted,
    tool_call_args: attempt.accepted ? last?.payload?.arguments ?? null : null,
    output: attempt.accepted ? attempt.output ?? null : null,
    raw_text: last?.text ?? "",
    truncated: last?.truncated ?? false,
    turns: attempt.turns,
    messages: attempt.messages,
    argument_style: attempt.style || "baseline",
    provider: "anthropic",
    model: attempt.model,
    total_cost: attempt.cost,
    system_prompt: buildExecutorSystemPrompt(),
    initial_user_message:
      attempt.messages[0]?.content ??
      buildExecutorUserMessage({ toolName, args: resolvedArgs, priorStepOutputText }),
    tool: toolName,
    args: resolvedArgs,
  };

  return {
    saved_at: new Date().toISOString(),
    scenario_id: scenario.scenario_id,
    scenario_title: scenario.title,
    framing: sourcePlan.planResult.framing,
    direct_result: null,
    plan_result: sourcePlan.planResult,
    steps: [...priorCanonicalSteps, ownStep],
    description: describeStepAttempt({
      batchId,
      sourceId: sourcePlan.sourceId,
      stepIndex: attempt.step_index,
      model: attempt.model,
      style: attempt.style,
    }),
    batch_id: batchId,
    attempt_id: attempt.id,
    source_plan_id: sourcePlan.sourceId,
  };
}

export async function writeRunFile(runId, content) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("runs").upsert({
    id: runId,
    user_email: process.env.RUN_AUTHOR_EMAIL,
    scenario_id: content.scenario_id,
    scenario_title: content.scenario_title,
    framing: content.framing,
    source_plan_id: content.source_plan_id || null,
    batch_id: content.batch_id || null,
    description: content.description || null,
    data: content,
  });
  if (error) throw new Error(`Failed to write run ${runId}: ${error.message}`);
}

export async function readRunFile(runId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("runs").select("data").eq("id", runId).single();
  if (error) throw new Error(`Failed to read run ${runId}: ${error.message}`);
  return data.data;
}
```

- [ ] **Step 2: Rewrite `scripts/batch/steps-state.js`**

```js
import fs from "fs";
import path from "path";
import { readRunFile } from "./steps-runfile.js";
import { getSupabaseClient } from "../../lib/supabase.js";

// Scans every saved run for one whose plan was accepted — these are the
// candidates for step execution. Each row's plan_result is embedded,
// unmodified, into every step-attempt row this source plan produces.
export async function discoverAcceptedPlans() {
  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase.from("runs").select("id, data");
  if (error) throw new Error(`Failed to list runs: ${error.message}`);
  const plans = [];
  for (const row of rows) {
    const content = row.data;
    const pr = content.plan_result;
    // Older saved runs (pre-dating the model/turns/messages fields this
    // project now always writes) can't be executed — nothing to call, no
    // conversation to seed a negotiation from. Skip them rather than crash.
    if (pr?.accepted && Array.isArray(pr.plan) && pr.plan.length > 0 && pr.model && pr.messages?.length) {
      plans.push({
        sourceId: row.id,
        scenarioId: content.scenario_id,
        model: pr.model,
        planResult: pr,
        plan: pr.plan,
      });
    }
  }
  return plans;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export async function loadState(batchId) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase.from("batches").select("data").eq("id", batchId).single();
  // PGRST116 = no row matched .single() — a legitimate "batch doesn't exist
  // yet" case. Any other error (network, auth, permissions) must not be
  // read as "no existing batch": resolveState() would silently start a
  // fresh batch and re-run everything from scratch instead of surfacing
  // the failure, double-spending on a transient blip.
  if (error && error.code !== "PGRST116") throw new Error(`Failed to load batch ${batchId}: ${error.message}`);
  if (!row) return null;
  const manifest = row.data;
  manifest.attempts = await Promise.all(
    manifest.attempts.map(async (a) => {
      if (!a.runId) return { ...a, turns: [], messages: [] };
      const runFile = await readRunFile(a.runId);
      const own = runFile.steps[runFile.steps.length - 1];
      return {
        ...a,
        turns: own?.turns || [],
        messages: own?.messages || [],
        output: own?.output ?? null,
      };
    })
  );
  return manifest;
}

export async function saveState(state) {
  const supabase = getSupabaseClient();
  const manifest = {
    ...state,
    attempts: state.attempts.map(({ turns, messages, output, ...rest }) => rest),
  };
  const { error } = await supabase
    .from("batches")
    .upsert({ id: state.batch_id, user_email: process.env.RUN_AUTHOR_EMAIL, data: manifest });
  if (error) throw new Error(`Failed to save batch ${state.batch_id}: ${error.message}`);
}

export async function resolveState({ batchId, sourceIds, maxTurns, budgetCap }) {
  const existing = await loadState(batchId);
  if (existing) {
    if (!sameSet(existing.source_ids, sourceIds)) {
      throw new Error(
        `Step batch "${batchId}" already exists with a different set of source plans. ` +
          `Use a different --batch-id, or omit --sources to resume with the stored set.`
      );
    }
    if (existing.max_turns !== maxTurns) {
      throw new Error(
        `Step batch "${batchId}" was created with --max-turns ${existing.max_turns}, but ${maxTurns} ` +
          `was requested. Use a different --batch-id, or omit --max-turns to resume with the stored value.`
      );
    }
    if (budgetCap !== undefined) existing.budget_cap = budgetCap;
    return existing;
  }

  return {
    batch_id: batchId,
    source_ids: sourceIds,
    max_turns: maxTurns,
    budget_cap: budgetCap ?? null,
    cumulative_cost: 0,
    created_at: new Date().toISOString(),
    attempts: [],
  };
}

export function batchSummaryPath(batchId, filename) {
  const dir = path.join(process.cwd(), "runs", "batches", batchId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}
```

`scripts/batch/steps-report.js` already imports `batchSummaryPath` from `./steps-state.js` (confirmed via `grep -n "batchSummaryPath" scripts/batch/steps-report.js`) — no change needed there.

- [ ] **Step 3: Update `scripts/batch/steps-run.js`**

Replace the import:
```js
import { stepRunFileName, buildStepRunFileContent, writeRunFile, readRunFile } from "./steps-runfile.js";
```
with:
```js
import { randomUUID } from "crypto";
import { buildStepRunFileContent, writeRunFile, readRunFile } from "./steps-runfile.js";
```

In `runStepAttempt`, replace (around line 35-43):
```js
  if (!attempt.filename) {
    attempt.filename = stepRunFileName({
      sourceId: attempt.source_id,
      stepIndex: attempt.step_index,
      style: attempt.style,
      model: attempt.model,
      startedAt: new Date().toISOString(),
    });
  }
```
with:
```js
  if (!attempt.runId) {
    attempt.runId = randomUUID();
  }
```

Replace (line 44-46):
```js
  const persistRunFile = () =>
    writeRunFile(
      attempt.filename,
```
with:
```js
  const persistRunFile = () =>
    writeRunFile(
      attempt.runId,
```

`await` every `persistRunFile()` and `saveState(state)` call in this file (in `runStepAttempt`'s body, its `onTurn` closure, and its catch/finally path) — grep and fix:
```bash
grep -n "persistRunFile()\|saveState(state)" scripts/batch/steps-run.js
```

In `runStep` (around line 206), replace:
```js
  const runFile = readRunFile(canonical.filename);
```
with:
```js
  const runFile = await readRunFile(canonical.runId);
```
and make `runStep` itself `async` if it isn't already flagged (check its signature — it's declared `async function runStep(...)` already, confirmed at line 157, so this is just adding the `await`).

In `reconstructProgress` (around line 268), replace:
```js
    const runFile = readRunFile(canonicalAttempt.filename);
```
with:
```js
    const runFile = await readRunFile(canonicalAttempt.runId);
```
and change `function reconstructProgress(state, sourcePlan) {` to `async function reconstructProgress(state, sourcePlan) {`, and its one call site in `resumePlanSteps` (around line 277) from:
```js
  const { priorOutputs, canonicalSteps, resumeAtStep } = reconstructProgress(state, sourcePlan);
```
to:
```js
  const { priorOutputs, canonicalSteps, resumeAtStep } = await reconstructProgress(state, sourcePlan);
```

- [ ] **Step 4: Fix the stale `filename` field in `scripts/batch/steps-matrix.js`**

`blankStepAttempt` (around line 9-27) still initializes a `filename: null` field, which is now dead — `steps-run.js` sets `attempt.runId` instead, so a fresh attempt would carry both a stale `filename: null` and a real `runId`. Replace:
```js
    error: null,
    filename: null,
    messages: [],
```
with:
```js
    error: null,
    runId: null,
    messages: [],
```

- [ ] **Step 5: Update `scripts/batch/steps-report.js`**

Same rename: `filename: attempt.filename || ""` → `run_id: attempt.runId || ""` in `toRow`, plus the default-columns key.

- [ ] **Step 6: Update `scripts/batch-eval-steps.js`**

Same `RUN_AUTHOR_EMAIL` fail-fast check as the other three entrypoints. This script also calls `discoverAcceptedPlans()` (now async) — grep and add `await`:
```bash
grep -n "discoverAcceptedPlans(\|loadState(\|resolveState(\|saveState(" scripts/batch-eval-steps.js
```

- [ ] **Step 7: Verify end-to-end**

First produce an accepted plan to execute steps against — reuse the base pipeline row from Task 8's `smoke-test-base` batch if its plan was accepted, or check:
```bash
mcp__supabase__execute_sql — query: "select id from runs where batch_id = 'smoke-test-base' and data->'plan_result'->>'accepted' = 'true' limit 1;"
```
Then run:
```bash
RUN_AUTHOR_EMAIL=you@example.com node scripts/batch-eval-steps.js --sources <that id> --max-turns 3 --budget 1 --yes --batch-id smoke-test-steps
```
Expected: runs without error, either reaching a step or reporting the plan broke at step 1 (both are valid outcomes — the check is "no crash, no `fs` error").

Run: `mcp__supabase__execute_sql` with `query: "select id, source_plan_id from runs where batch_id = 'smoke-test-steps';"`
Expected: `source_plan_id` matches the source plan's `id` used above.

- [ ] **Step 8: Commit**

```bash
git add scripts/batch/steps-runfile.js scripts/batch/steps-state.js scripts/batch/steps-run.js scripts/batch/steps-matrix.js scripts/batch/steps-report.js scripts/batch-eval-steps.js
git commit -m "Move steps batch pipeline to Supabase"
```

---

### Task 12: Migrate existing local runs

**Files:**
- Create: `scripts/migrate-runs-to-supabase.js`

**Interfaces:**
- Consumes: `getSupabaseClient()` from [[Task 1]]. Reads local `runs/*.json` and `runs/batches/*/manifest.json` (note: not `runs/batches/*.json` as the design doc states — the actual layout is one subdirectory per batch, confirmed via `find runs/batches -name manifest.json`).

- [ ] **Step 1: Write the migration script**

```js
#!/usr/bin/env node
// One-off migration: copies every local runs/*.json and
// runs/batches/<batch_id>/manifest.json into Supabase. Safe to re-run —
// the `legacy_filename` unique constraint means a second pass on a
// runs/*.json file is a no-op (upsert on conflict does nothing new), and
// batch rows are upserted by batch_id.
//
// Usage: node scripts/migrate-runs-to-supabase.js
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { getSupabaseClient } from "../lib/supabase.js";

const RUNS_DIR = path.join(process.cwd(), "runs");
const BATCHES_DIR = path.join(RUNS_DIR, "batches");
const MIGRATED_USER_EMAIL = "sam@polariscollective.org";

async function migrateRuns(supabase) {
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
  console.log(`Found ${files.length} local run files.`);

  // Rows already migrated (by legacy_filename) are skipped, not
  // re-inserted — makes the script idempotent across re-runs.
  const { data: already, error: selErr } = await supabase.from("runs").select("legacy_filename");
  if (selErr) throw new Error(`Failed to list existing runs: ${selErr.message}`);
  const alreadyMigrated = new Set((already || []).map((r) => r.legacy_filename).filter(Boolean));

  const filenameToId = new Map();
  let inserted = 0;
  for (const filename of files) {
    if (alreadyMigrated.has(filename)) {
      // Still need the mapping for the batch-manifest pass below.
      const { data: existing } = await supabase
        .from("runs")
        .select("id")
        .eq("legacy_filename", filename)
        .single();
      if (existing) filenameToId.set(filename, existing.id);
      continue;
    }

    const content = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, filename), "utf8"));
    const id = randomUUID();
    filenameToId.set(filename, id);

    const { error } = await supabase.from("runs").insert({
      id,
      created_at: content.saved_at || new Date().toISOString(),
      user_email: MIGRATED_USER_EMAIL,
      scenario_id: content.scenario_id,
      scenario_title: content.scenario_title || null,
      framing: content.framing || null,
      source_plan_id: null, // resolved in the second pass below, once every filename has an id
      batch_id: content.batch_id || null,
      description: content.description || null,
      legacy_filename: filename,
      data: content,
    });
    if (error) throw new Error(`Failed to insert ${filename}: ${error.message}`);
    inserted++;
  }
  console.log(`Inserted ${inserted} new run rows (${alreadyMigrated.size} already migrated).`);
  return filenameToId;
}

// source_plan_id in the original files is itself a legacy filename (the
// plan row a step continues from) — now that every legacy file has a real
// uuid, rewrite each migrated row's source_plan_id to point at that uuid
// instead, so chain grouping (see app/api/runs/route.js) keeps working.
async function fixSourcePlanIds(supabase, filenameToId) {
  const { data: rows, error } = await supabase
    .from("runs")
    .select("id, data")
    .not("legacy_filename", "is", null);
  if (error) throw new Error(`Failed to list migrated runs: ${error.message}`);

  let fixed = 0;
  for (const row of rows) {
    const oldSourceFilename = row.data.source_plan_id;
    if (!oldSourceFilename) continue;
    const newSourceId = filenameToId.get(oldSourceFilename);
    if (!newSourceId || newSourceId === row.data.source_plan_id) continue;

    const updatedData = { ...row.data, source_plan_id: newSourceId };
    const { error: updErr } = await supabase
      .from("runs")
      .update({ source_plan_id: newSourceId, data: updatedData })
      .eq("id", row.id);
    if (updErr) throw new Error(`Failed to fix source_plan_id on ${row.id}: ${updErr.message}`);
    fixed++;
  }
  console.log(`Rewrote source_plan_id on ${fixed} step rows.`);
}

async function migrateBatches(supabase, filenameToId) {
  if (!fs.existsSync(BATCHES_DIR)) return;
  const batchDirs = fs.readdirSync(BATCHES_DIR).filter((d) => fs.existsSync(path.join(BATCHES_DIR, d, "manifest.json")));
  console.log(`Found ${batchDirs.length} local batch manifests.`);

  let migrated = 0;
  for (const batchId of batchDirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(BATCHES_DIR, batchId, "manifest.json"), "utf8"));
    // Old manifests record each attempt's identifier as `filename`; rewrite
    // to `runId` pointing at the row's new uuid, matching the shape every
    // pipeline now writes going forward (see scripts/batch/*-state.js).
    manifest.attempts = (manifest.attempts || []).map(({ filename, ...rest }) => ({
      ...rest,
      runId: filename ? filenameToId.get(filename) || null : null,
    }));

    const { error } = await supabase
      .from("batches")
      .upsert({ id: batchId, user_email: MIGRATED_USER_EMAIL, data: manifest });
    if (error) throw new Error(`Failed to migrate batch ${batchId}: ${error.message}`);
    migrated++;
  }
  console.log(`Migrated ${migrated} batch rows.`);
}

async function main() {
  const supabase = getSupabaseClient();
  const filenameToId = await migrateRuns(supabase);
  await fixSourcePlanIds(supabase, filenameToId);
  await migrateBatches(supabase, filenameToId);
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `node scripts/migrate-runs-to-supabase.js`
Expected: prints counts matching `ls runs/*.json | wc -l` (88, per this session's check — verify with the same command right before running) and `find runs/batches -name manifest.json | wc -l` (9), ending with "Migration complete."

- [ ] **Step 3: Verify row counts and spot-check**

Run: `mcp__supabase__execute_sql` with `query: "select count(*) from runs where legacy_filename is not null;"`
Expected: matches the local file count from Step 2.

Run: `mcp__supabase__execute_sql` with `query: "select count(*) from batches;"`
Expected: 9 (plus any smoke-test batches created during Tasks 8–11).

Spot-check one row: pick a filename from `ls runs | head -1`, then
```bash
mcp__supabase__execute_sql — query: "select scenario_id, framing, data->>'saved_at' as saved_at from runs where legacy_filename = '<that filename>';"
```
Expected: values match what's in the source `runs/<that filename>` file.

- [ ] **Step 4: Verify in the app**

Run: `npm run dev`, open `http://localhost:3000/runs` — confirm the table now shows ~88+ rows (migrated + any smoke-test rows from earlier tasks), and that `chain_id` grouping/leaf detection still looks sane (a migrated step row's chain groups with its migrated plan row, not treated as its own isolated chain — spot check one multi-step scenario in the table).

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-runs-to-supabase.js
git commit -m "Add one-off script to migrate local run files into Supabase"
```

(Per the design doc: local `runs/*.json` files are left in place as a cold backup, not deleted. `runs_backup_20260807_002806/` is out of scope, untouched.)
