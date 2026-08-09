# Manual Run Overwrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/`, continuing and re-saving a manual run overwrites the same `runs` row instead of inserting a duplicate, and records a root-level `style` (`"hybrid"` when the style changed mid-run).

**Architecture:** The client tracks a "run in progress" id per flow (plan / direct-ask), reset only by a fresh "Ask...", preserved across every "Continue"/step action, and adopted when loading an existing run. `POST /api/save-run` updates when given a `runId`, inserts otherwise. `GET /api/runs` gains a `?mine=true` scoping flag used only by the `/` page's "Browse saved runs" widget.

**Tech Stack:** Next.js 14 (App Router, `"use client"` page), Supabase Postgres via `service_role`, NextAuth (Google OAuth) for session email.

**Spec:** `docs/superpowers/specs/2026-08-09-manual-run-overwrite-design.md` (committed at `382c793`)

## Global Constraints

- **No test framework exists in this project.** Verification is manual/live against the running dev server and real Supabase, per established project convention. Every task below ends with concrete verification commands, not test files. Do not add a test framework.
- **Schema changes go through `mcp__supabase__apply_migration`, never a checked-in `.sql` file.** This is the established convention across every prior schema change in this project.
- **`runs`/`batches` have RLS enabled with zero policies.** All access is server-side via `service_role` (`lib/supabase.js`'s `getSupabaseClient()`). Never add a browser-side Supabase client.
- **Never trust the client for identity.** `user_email` always comes from `getSessionEmail()` (`auth.js`) server-side, never from the request body. Same principle already applied by `POST /api/save-run` and `app/api/scenarios/route.js`.
- **Local auth bypass for verification:** `auth.js`'s `getSessionEmail()` returns `process.env.LOCAL_AUTHENTICATION_EMAIL` when `NODE_ENV !== "production"` AND `LOCAL_AUTHENTICATION_NEEDED === "false"`. Both are set in the gitignored `.env.local`. This is what makes `curl` against authenticated routes possible — use it, don't add new bypasses.
- **`"all"` is a real style value, distinct from `"hybrid"`.** `"all"` means "rotate through every style, one per adversary round" (`styleForRound` in `lib/adversarial.js:24-28`) — a deliberate single selection. `"hybrid"` means the user *changed the selector* between calls within one run. Never map `"all"` to `"hybrid"`.
- **The working tree is clean as of this plan's writing.** If `git status` shows unrelated modified files when you start, do NOT sweep them into your commits — stage only the files your task names explicitly (`git add <exact paths>`, never `git add -A` or `git add .`).

---

### Task 1: Supabase — `style` column on `runs`

**Files:**
- No repo files. Schema-only change applied through the Supabase MCP tool.

**Interfaces:**
- Consumes: nothing.
- Produces: `runs.style` — `text`, nullable, no default. Read by Task 3 (`GET /api/runs` summaries), written by Task 2 (`POST /api/save-run`).

- [ ] **Step 1: Confirm the column does not already exist**

Run: `mcp__supabase__execute_sql` with query:

```sql
select column_name from information_schema.columns where table_name = 'runs' and column_name = 'style';
```

Expected: `[]` (empty result). If it returns a row, the column already exists — stop and report that this task is already done rather than re-applying.

- [ ] **Step 2: Apply the migration**

Run: `mcp__supabase__apply_migration` with name `add_runs_style` and query:

```sql
alter table runs add column style text;
```

Nullable with no default is deliberate: every pre-existing row gets `null`, meaning "not tracked" — distinct from a genuine style value or `"hybrid"`.

- [ ] **Step 3: Verify the column exists and every existing row is null**

Run: `mcp__supabase__execute_sql` with query:

```sql
select count(*) as total, count(style) as with_style from runs;
```

Expected: `with_style` is `0`, `total` is whatever the current row count is (non-zero). This confirms the column was added without disturbing existing data.

- [ ] **Step 4: No commit** — this task changes no repo files. Report the migration was applied and verified.

---

### Task 2: `POST /api/save-run` — update-or-insert

**Files:**
- Modify: `app/api/save-run/route.js` (whole file is 54 lines; you are changing the destructure on line 12-13 and the insert block on lines 37-51)

**Interfaces:**
- Consumes: `runs.style` column from Task 1.
- Produces: `POST /api/save-run` accepts two new optional body fields — `runId` (string uuid or null/absent) and `style` (string or null/absent). Response shape is unchanged: `{ saved: true, id }` on success, `{ error }` with a non-200 status on failure. When `runId` is given, `id` in the response echoes that same `runId`. Task 4's client relies on both of these.

- [ ] **Step 1: Add `runId` and `style` to the destructured body**

In `app/api/save-run/route.js`, replace:

```js
  const { scenarioId, scenarioTitle, framing, directResult, planResult, steps, description } =
    await req.json();
```

with:

```js
  const { scenarioId, scenarioTitle, framing, directResult, planResult, steps, description, runId, style } =
    await req.json();
```

- [ ] **Step 2: Branch to an update when `runId` is present**

Still in `app/api/save-run/route.js`, find this block (currently lines 37-51, immediately after the `const run = {...}` object literal):

```js
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
```

and replace it with:

```js
  const supabase = getSupabaseClient();

  // Continuing a run and re-saving overwrites the row being iterated on
  // rather than branching into a duplicate — a run is one linear thread,
  // one row. The user_email guard is defense-in-depth: the only surface
  // that hands out a runId to save against is GET /api/runs?mine=true,
  // which already returns nothing but the caller's own runs.
  if (runId) {
    const { error: updateError } = await supabase
      .from("runs")
      .update({
        scenario_id: scenarioId,
        scenario_title: scenarioTitle || null,
        framing,
        style: style || null,
        description: description || null,
        data: run,
      })
      .eq("id", runId)
      .eq("user_email", userEmail);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    return NextResponse.json({ saved: true, id: runId });
  }

  const { error } = await supabase.from("runs").insert({
    id,
    user_email: userEmail,
    scenario_id: scenarioId,
    scenario_title: scenarioTitle || null,
    framing,
    style: style || null,
    source_plan_id: null,
    batch_id: null,
    description: description || null,
    data: run,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ saved: true, id });
```

Note the `id` (from `randomUUID()` higher in the file) is now only used on the insert path — that is correct and intentional, leave the `const id = randomUUID();` line where it is.

- [ ] **Step 3: Start the dev server if it is not already running**

Run: `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/runs?id=nonexistent"`

Expected: `404` if the server is up. If you instead get a connection error, start it with `npm run dev` in the background (`nohup npm run dev > /tmp/nextdev.log 2>&1 &`), wait ~5s, and re-check. Do not start a second server if one is already listening.

- [ ] **Step 4: Verify the insert path still works and now writes `style`**

Run:

```bash
curl -s -X POST http://localhost:3000/api/save-run \
  -H "Content-Type: application/json" \
  -d '{"scenarioId":"zzz_plan_test","scenarioTitle":"ZZZ Plan Test","framing":"real","style":"ethical","description":"task2 insert check","planResult":{"accepted":true,"plan":[],"total_cost":0.01,"argument_style":"ethical","model":"claude-sonnet-5"}}'
```

Expected: `{"saved":true,"id":"<some-uuid>"}`. Record that uuid — call it `$ID` for the next steps.

Then confirm the row landed with the style column set, via `mcp__supabase__execute_sql`:

```sql
select id, style, framing, description from runs where scenario_id = 'zzz_plan_test';
```

Expected: exactly one row, `style` = `ethical`, `description` = `task2 insert check`.

- [ ] **Step 5: Verify the update path overwrites instead of inserting**

Using the `$ID` from Step 4, run (substitute the real uuid):

```bash
curl -s -X POST http://localhost:3000/api/save-run \
  -H "Content-Type: application/json" \
  -d '{"runId":"<PASTE-$ID-HERE>","scenarioId":"zzz_plan_test","scenarioTitle":"ZZZ Plan Test","framing":"test","style":"hybrid","description":"task2 update check","planResult":{"accepted":false,"plan":[],"total_cost":0.02,"argument_style":"authority","model":"claude-sonnet-5"}}'
```

Expected: `{"saved":true,"id":"<the same $ID>"}` — the same uuid you passed in, not a new one.

Then confirm via `mcp__supabase__execute_sql`:

```sql
select count(*) as row_count from runs where scenario_id = 'zzz_plan_test';
```

Expected: `row_count` is `1` — still one row, not two. This is the core assertion of this task.

```sql
select id, style, framing, description, data->'plan_result'->>'total_cost' as cost from runs where scenario_id = 'zzz_plan_test';
```

Expected: same `id` as `$ID`, `style` = `hybrid`, `framing` = `test`, `description` = `task2 update check`, `cost` = `0.02` — i.e. every field was overwritten, including the nested `data` blob.

- [ ] **Step 6: Verify the ownership guard silently no-ops on someone else's run**

Insert a row owned by a different email via `mcp__supabase__execute_sql`:

```sql
insert into runs (id, user_email, scenario_id, framing, data)
values ('11111111-2222-3333-4444-555555555555', 'someone-else@example.com', 'zzz_owner_test', 'real', '{"scenario_id":"zzz_owner_test","framing":"real"}'::jsonb)
returning id;
```

Then attempt to overwrite it through the route:

```bash
curl -s -X POST http://localhost:3000/api/save-run \
  -H "Content-Type: application/json" \
  -d '{"runId":"11111111-2222-3333-4444-555555555555","scenarioId":"zzz_owner_test","framing":"test","style":"ethical","description":"SHOULD NOT APPEAR","planResult":{"accepted":true,"plan":[],"total_cost":0.99}}'
```

Expected: `{"saved":true,"id":"11111111-2222-3333-4444-555555555555"}` — Supabase reports success with zero rows matched; there is no error to surface. Confirm nothing actually changed:

```sql
select framing, description, style from runs where id = '11111111-2222-3333-4444-555555555555';
```

Expected: `framing` is still `real`, `description` is `null`, `style` is `null` — the other user's row was NOT modified.

- [ ] **Step 7: Clean up all test rows**

Run: `mcp__supabase__execute_sql` with query:

```sql
delete from runs where scenario_id in ('zzz_plan_test', 'zzz_owner_test') returning id;
```

Expected: 2 ids returned. Then confirm the table is clean:

```sql
select count(*) as leftover from runs where scenario_id like 'zzz%';
```

Expected: `leftover` is `0`.

- [ ] **Step 8: Commit**

```bash
git add app/api/save-run/route.js
git commit -m "Overwrite the existing run when save-run is given a runId"
```

---

### Task 3: `GET /api/runs` — `?mine=true` scoping and `style` in summaries

**Files:**
- Modify: `app/api/runs/route.js` (adding an import, a query-param branch, and one field to the summary object)

**Interfaces:**
- Consumes: `runs.style` column from Task 1.
- Produces: `GET /api/runs?mine=true` returns only the signed-in user's runs (401 `{ error: "not signed in" }` if there is no session). Every summary object in the list response gains a `style` field (string or `null`). Task 4's client relies on both. `GET /api/runs` without `mine`, and `GET /api/runs?id=<id>`, are unchanged.

- [ ] **Step 1: Import `getSessionEmail`**

In `app/api/runs/route.js`, the imports currently read:

```js
import { NextResponse } from "next/server";
import { ARGUMENT_STYLES } from "../../../lib/adversarial";
import { getSupabaseClient } from "../../../lib/supabase.js";
```

Add the `getSessionEmail` import so they read:

```js
import { NextResponse } from "next/server";
import { ARGUMENT_STYLES } from "../../../lib/adversarial";
import { getSupabaseClient } from "../../../lib/supabase.js";
import { getSessionEmail } from "../../../auth";
```

- [ ] **Step 2: Select the `style` column and scope the query when `mine=true`**

Still in `app/api/runs/route.js`, find this block (it sits just after the `if (id) { ... }` single-run branch):

```js
  const { data: rows, error } = await supabase.from("runs").select("id, data");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
```

and replace it with:

```js
  // The / page's "Browse saved runs" widget passes mine=true: it's the
  // surface you load a run from to continue and overwrite it, so it must
  // only ever offer runs the caller actually owns. /runs and /compare
  // pass nothing and keep their existing team-wide visibility.
  let query = supabase.from("runs").select("id, style, data");
  if (searchParams.get("mine") === "true") {
    const userEmail = await getSessionEmail();
    if (!userEmail) {
      return NextResponse.json({ error: "not signed in" }, { status: 401 });
    }
    query = query.eq("user_email", userEmail);
  }
  const { data: rows, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
```

Note `searchParams` is already destructured at the top of `GET()` (`const { searchParams } = new URL(req.url);`) — do not re-declare it.

- [ ] **Step 3: Add `style` to each summary object**

Still in `app/api/runs/route.js`, inside the `rows.map((row) => { ... })` callback, find the `return { ... }` object. It currently begins:

```js
      return {
        id,
        saved_at: content.saved_at,
        scenario_id: content.scenario_id,
        scenario_title: content.scenario_title,
        framing: content.framing,
        mode,
```

Insert a `style` field immediately after `framing`, so it reads:

```js
      return {
        id,
        saved_at: content.saved_at,
        scenario_id: content.scenario_id,
        scenario_title: content.scenario_title,
        framing: content.framing,
        // Root-level style recorded at save time: a single style key, "all"
        // (rotate every round), or "hybrid" (the style changed mid-run).
        // Null for rows saved before this column existed — their per-call
        // argument_style values still live in `data` and are shown by the
        // detail views that read it directly.
        style: row.style ?? null,
        mode,
```

Leave the existing `argument_style: resultSource.argument_style || null,` field further down exactly as it is — it is a different thing (the style of the last call, derived from nested data) and other code depends on it, including the `STYLE_PRIORITY` canonical-branch logic in this same file.

- [ ] **Step 4: Verify the unscoped list still works and now carries `style`**

Ensure the dev server is running (see Task 2 Step 3 if not). Run:

```bash
curl -s "http://localhost:3000/api/runs" | head -c 400
```

Expected: a JSON array of summary objects, each containing a `"style":` key (value `null` for existing rows). Confirm the response is still the full team-wide list:

```bash
curl -s "http://localhost:3000/api/runs" | python3 -c "import json,sys; d=json.load(sys.stdin); print('rows:', len(d)); print('has style key:', all('style' in r or 'error' in r for r in d))"
```

Expected: `rows:` a non-zero count matching the table, and `has style key: True`.

- [ ] **Step 5: Verify `mine=true` scopes to the signed-in user**

First find out which email the local bypass is using and what the true counts are, via `mcp__supabase__execute_sql`:

```sql
select user_email, count(*) from runs group by user_email order by count(*) desc;
```

Then run:

```bash
curl -s "http://localhost:3000/api/runs?mine=true" | python3 -c "import json,sys; d=json.load(sys.stdin); print('rows:', len(d) if isinstance(d,list) else d)"
```

Expected: the row count exactly matches the count for the bypass email (`LOCAL_AUTHENTICATION_EMAIL` in `.env.local`, which per this project's convention is `sam@polariscollective.org`) from the SQL above — and is strictly less than the unscoped count from Step 4 if any runs belong to other emails. If every run in the table happens to belong to that one email, note that in your report and additionally verify by temporarily inserting a throwaway row under a different `user_email`, re-running both curls to confirm only the unscoped count goes up, then deleting it.

- [ ] **Step 6: Verify the single-run branch is untouched**

Pick any real id from the Step 4 output and run:

```bash
curl -s "http://localhost:3000/api/runs?id=<PASTE-A-REAL-ID>" | head -c 200
```

Expected: the full run `data` object (not a summary, not an array) — confirming the `id` branch still returns early and was not affected by the query changes.

- [ ] **Step 7: Commit**

```bash
git add app/api/runs/route.js
git commit -m "Scope the runs list to the caller with mine=true, expose root style"
```

---

### Task 4: `/` page — track run identity and style across continues

**Files:**
- Modify: `app/page.js` (client component; adding 4 state variables, touching 9 functions, and one display line)

**Interfaces:**
- Consumes: `POST /api/save-run`'s `runId`/`style` body fields and echoed `id` (Task 2); `GET /api/runs?mine=true` and the `style` field on summaries (Task 3).
- Produces: nothing downstream — this is the last task.

- [ ] **Step 1: Add the run-identity state**

In `app/page.js`, find this existing state block (around lines 92-95):

```js
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);
  const [description, setDescription] = useState("");
  const [directDescription, setDirectDescription] = useState("");
```

Add four new state variables immediately after it:

```js
  // Identity of the run currently being iterated on, per flow. Null means
  // "not saved yet / fresh" — the next save inserts. Non-null means the
  // next save overwrites that row. Reset only by a fresh "Ask...", never
  // by a "Continue"; adopted wholesale when loading an existing run.
  const [planRunId, setPlanRunId] = useState(null);
  const [directRunId, setDirectRunId] = useState(null);
  // Every distinct argument style used since this run began. More than one
  // means the user changed the selector mid-run, which saves as "hybrid".
  // Note "all" is a single legitimate value (rotate every round), not hybrid.
  const [planStylesUsed, setPlanStylesUsed] = useState([]);
  const [directStylesUsed, setDirectStylesUsed] = useState([]);
```

Arrays, not `Set`s: React state updates must produce a new reference to trigger a re-render, and arrays keep that obvious. Order does not matter; duplicates are avoided by the helper in Step 2.

- [ ] **Step 2: Add a style-accumulator helper**

In `app/page.js`, immediately after the state block you just extended (still inside the `Home` component, before the first `useEffect`), add:

```js
  // Appends a style to a used-styles list without duplicating it.
  function addStyle(setter) {
    setter((prev) => (prev.includes(argumentStyle) ? prev : [...prev, argumentStyle]));
  }

  // What to store in the row's root-level style column: the single style if
  // only one was ever used, "hybrid" if the user switched mid-run.
  function styleForSave(stylesUsed) {
    if (stylesUsed.length === 0) return null;
    return stylesUsed.length > 1 ? "hybrid" : stylesUsed[0];
  }
```

- [ ] **Step 3: Reset identity on a fresh "Ask to plan"**

In `app/page.js`, find `askToPlan()` (around line 208). It currently begins:

```js
  async function askToPlan() {
    setPlanning(true);
    setPlanResult(null);
    setSteps([]);
    setSaveMessage(null);
```

Add the two resets so it reads:

```js
  async function askToPlan() {
    setPlanning(true);
    setPlanResult(null);
    setSteps([]);
    setSaveMessage(null);
    // A fresh ask is a new run — next save inserts a new row.
    setPlanRunId(null);
    setPlanStylesUsed([argumentStyle]);
```

- [ ] **Step 4: Reset identity on a fresh "Ask directly"**

In `app/page.js`, find `askDirect()` (around line 173). It currently begins:

```js
  async function askDirect() {
    setAskingDirect(true);
    setDirectResult(null);
    setSaveDirectMessage(null);
```

Add the two resets so it reads:

```js
  async function askDirect() {
    setAskingDirect(true);
    setDirectResult(null);
    setSaveDirectMessage(null);
    // A fresh ask is a new run — next save inserts a new row.
    setDirectRunId(null);
    setDirectStylesUsed([argumentStyle]);
```

- [ ] **Step 5: Accumulate the style on every plan-flow continue/step action**

In `app/page.js`, add exactly one line — `addStyle(setPlanStylesUsed);` — as the first statement inside each of these four functions. Do NOT touch `planRunId` in any of them; preserving it across these calls is the whole point.

`continuePlan()` (around line 223) currently begins:

```js
  async function continuePlan() {
    if (!planResult?.messages) return;
    setPlanning(true);
```

becomes:

```js
  async function continuePlan() {
    if (!planResult?.messages) return;
    addStyle(setPlanStylesUsed);
    setPlanning(true);
```

`runNextStep()` (around line 273) currently begins:

```js
  async function runNextStep() {
    if (!planResult?.plan) return;
    const nextIndex = steps.length;
```

becomes:

```js
  async function runNextStep() {
    if (!planResult?.plan) return;
    addStyle(setPlanStylesUsed);
    const nextIndex = steps.length;
```

`continueLastStep()` (around line 307) currently begins:

```js
  async function continueLastStep() {
    const idx = steps.length - 1;
    if (idx < 0) return;
    const s = steps[idx];
    if (!s.messages) return;
```

becomes:

```js
  async function continueLastStep() {
    const idx = steps.length - 1;
    if (idx < 0) return;
    const s = steps[idx];
    if (!s.messages) return;
    addStyle(setPlanStylesUsed);
```

`retryLastStep()` (around line 338) currently begins:

```js
  async function retryLastStep() {
    const idx = steps.length - 1;
    if (idx < 0) return;
    const stepSpec = planResult.plan[idx];
```

becomes:

```js
  async function retryLastStep() {
    const idx = steps.length - 1;
    if (idx < 0) return;
    addStyle(setPlanStylesUsed);
    const stepSpec = planResult.plan[idx];
```

- [ ] **Step 6: Accumulate the style on the direct-flow continue**

In `app/page.js`, find `continueDirect()` (around line 187). It currently begins:

```js
  async function continueDirect() {
    if (!directResult?.messages) return;
    setAskingDirect(true);
```

becomes:

```js
  async function continueDirect() {
    if (!directResult?.messages) return;
    addStyle(setDirectStylesUsed);
    setAskingDirect(true);
```

- [ ] **Step 7: Adopt the loaded run's identity in `loadRun`**

In `app/page.js`, find `loadRun(id)` (around line 150). It currently reads, in part:

```js
    setDescription(data.description || "");
    setDirectDescription(data.description || "");
    const loadedProvider = data.direct_result?.provider || data.plan_result?.provider;
```

Insert the identity adoption between those lines, so it reads:

```js
    setDescription(data.description || "");
    setDirectDescription(data.description || "");
    // Adopt this run's identity so continuing it and re-saving overwrites
    // it rather than branching. A saved row is a plan run or a direct run,
    // never both, so only the matching flow's id is set.
    setPlanRunId(data.plan_result ? id : null);
    setDirectRunId(data.direct_result ? id : null);
    const loadedStyleUsed = data.plan_result?.argument_style || data.direct_result?.argument_style || null;
    const seededStyles = loadedStyleUsed ? [loadedStyleUsed] : [];
    setPlanStylesUsed(data.plan_result ? seededStyles : []);
    setDirectStylesUsed(data.direct_result ? seededStyles : []);
    const loadedProvider = data.direct_result?.provider || data.plan_result?.provider;
```

Seeding from the nested `argument_style` (rather than the root `style` column) is deliberate: it works for rows saved before Task 1's column existed, and the value only feeds future hybrid detection — if the user continues with a different style it correctly becomes `"hybrid"` either way.

- [ ] **Step 8: Send `runId` and `style` from `saveRun`, and remember the id**

In `app/page.js`, find `saveRun()` (around line 245). Replace the whole function:

```js
  async function saveRun() {
    setSaving(true);
    setSaveMessage(null);
    const scenarioTitle = scenarios.find((s) => s.scenario_id === scenarioId)?.title;
    const res = await fetch("/api/save-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId, scenarioTitle, framing, planResult, steps, description }),
    });
    const data = await res.json();
    setSaveMessage(data.saved ? `Saved (id ${data.id})` : `Save failed: ${data.error}`);
    setSaving(false);
  }
```

with:

```js
  async function saveRun() {
    setSaving(true);
    setSaveMessage(null);
    const scenarioTitle = scenarios.find((s) => s.scenario_id === scenarioId)?.title;
    const res = await fetch("/api/save-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId,
        scenarioTitle,
        framing,
        planResult,
        steps,
        description,
        runId: planRunId,
        style: styleForSave(planStylesUsed),
      }),
    });
    const data = await res.json();
    if (data.saved) {
      // Hold onto the id so a second save — with or without a continue in
      // between — updates this same row instead of stacking duplicates.
      setPlanRunId(data.id);
      setSaveMessage(`Saved (id ${data.id})`);
    } else {
      setSaveMessage(`Save failed: ${data.error}`);
    }
    setSaving(false);
  }
```

- [ ] **Step 9: Send `runId` and `style` from `saveDirectRun`, and remember the id**

In `app/page.js`, find `saveDirectRun()` (around line 259). Replace the whole function:

```js
  async function saveDirectRun() {
    setSavingDirect(true);
    setSaveDirectMessage(null);
    const scenarioTitle = scenarios.find((s) => s.scenario_id === scenarioId)?.title;
    const res = await fetch("/api/save-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId, scenarioTitle, framing, directResult, description: directDescription }),
    });
    const data = await res.json();
    setSaveDirectMessage(data.saved ? `Saved (id ${data.id})` : `Save failed: ${data.error}`);
    setSavingDirect(false);
  }
```

with:

```js
  async function saveDirectRun() {
    setSavingDirect(true);
    setSaveDirectMessage(null);
    const scenarioTitle = scenarios.find((s) => s.scenario_id === scenarioId)?.title;
    const res = await fetch("/api/save-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId,
        scenarioTitle,
        framing,
        directResult,
        description: directDescription,
        runId: directRunId,
        style: styleForSave(directStylesUsed),
      }),
    });
    const data = await res.json();
    if (data.saved) {
      setDirectRunId(data.id);
      setSaveDirectMessage(`Saved (id ${data.id})`);
    } else {
      setSaveDirectMessage(`Save failed: ${data.error}`);
    }
    setSavingDirect(false);
  }
```

- [ ] **Step 10: Scope the "Browse saved runs" widget to the caller's own runs**

In `app/page.js`, find `toggleRunsList()` (around line 137) and change only the fetch URL:

```js
    const res = await fetch("/api/runs");
```

becomes:

```js
    const res = await fetch("/api/runs?mine=true");
```

Do NOT change the `loadRun` fetch (`/api/runs?id=...`) — that branch is unscoped by design and unchanged by Task 3.

- [ ] **Step 11: Show the style in the saved-runs list**

In `app/page.js`, find this line in the runs-list render (around line 420):

```jsx
                      {r.scenario_title} — {r.framing} — {r.mode}
```

and change it to:

```jsx
                      {r.scenario_title} — {r.framing} — {r.style || "—"} — {r.mode}
```

- [ ] **Step 12: Verify the page compiles and the widget is scoped**

Ensure the dev server is running (see Task 2 Step 3 if not). Run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```

Expected: `200`. Then check the dev server log for compile errors:

```bash
tail -20 /tmp/nextdev.log
```

Expected: no "Failed to compile", no "Error:" lines referencing `app/page.js`.

- [ ] **Step 13: Verify the overwrite behavior end-to-end in a browser**

Open `http://localhost:3000/` in a real browser (the local auth bypass means no Google login is required). Then:

1. Pick any scenario, set **Adversary turns** to `1` and **Argument style** to `ethical`, click **Ask to plan**, wait for the result.
2. Click **Save**. Note the id shown in the "Saved (id ...)" message — call it `$RUNID`.
3. Change **Argument style** to `authority`, click **Continue** (the plan-flow continue), wait.
4. Click **Save** again. Expected: the message shows **the same** `$RUNID`, not a new one.

Then confirm in the database via `mcp__supabase__execute_sql` (substitute your scenario id):

```sql
select id, style, framing, created_at from runs where scenario_id = '<your scenario id>' order by created_at desc limit 5;
```

Expected: exactly one row for this session's work, with `id` = `$RUNID` and `style` = `hybrid` (because two different styles were used). If you see two rows from this session, the overwrite is broken — stop and report.

- [ ] **Step 14: Verify a fresh "Ask" starts a new run, and single-style saves are not hybrid**

Continuing in the same browser session:

1. Set **Argument style** back to `ethical`.
2. Click **Ask to plan** again (a fresh ask, not continue), wait.
3. Click **Save**. Expected: a **different** id from `$RUNID`.

Confirm via `mcp__supabase__execute_sql`:

```sql
select id, style from runs where scenario_id = '<your scenario id>' order by created_at desc limit 5;
```

Expected: now two rows from this session — the original with `style` = `hybrid`, and a new one with `style` = `ethical` (single style, correctly not hybrid).

- [ ] **Step 15: Verify loading an existing run adopts its identity**

Still in the browser:

1. Click **Browse saved runs**, confirm the list shows the style column (values like `hybrid`, `ethical`, or `—` for older rows).
2. Click **Load** on the `$RUNID` run from Step 13.
3. Click **Continue**, wait, then click **Save**.
4. Expected: the message shows `$RUNID` again — the loaded run was overwritten, not duplicated.

Confirm the row count for this scenario did not grow:

```sql
select count(*) as row_count from runs where scenario_id = '<your scenario id>';
```

Expected: still `2` (from Steps 13-14), not `3`.

- [ ] **Step 16: Clean up the runs created during verification**

Delete only the rows you created in Steps 13-15 via `mcp__supabase__execute_sql`, using their exact ids (do NOT delete by scenario_id alone — real runs for that scenario may already exist):

```sql
delete from runs where id in ('<$RUNID>', '<the id from step 14>') returning id;
```

Expected: 2 ids returned. Then confirm you did not remove anything else:

```sql
select count(*) as total from runs;
```

Compare against the count you saw during Task 3 Step 5 — it should be back to that number.

- [ ] **Step 17: Commit**

```bash
git add app/page.js
git commit -m "Overwrite the run being iterated on, and record hybrid styles"
```

---

## Verification checklist (whole feature)

After all four tasks, these should all hold:

- Ask → Save → Continue → Save produces **one** row, not two.
- Ask → Save → Ask (fresh) → Save produces **two** rows.
- Load an own run → Continue → Save overwrites that run's row.
- A run using one style saves that style; a run where the selector changed saves `"hybrid"`; a run using `"all"` saves `"all"` (never `"hybrid"`).
- `/` "Browse saved runs" lists only the signed-in user's runs and shows the style.
- `/runs` and `/compare` still show every user's runs, unchanged.
