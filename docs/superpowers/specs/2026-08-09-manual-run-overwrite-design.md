# Manual run save: overwrite instead of duplicate — design

## Purpose

On `/` (the manual scenario runner — plan flow and direct-ask flow), clicking
"Save" always inserts a brand new row into `runs`, even when the user is
mid-way through iterating on the same plan (asked, saved, continued, saved
again). Every save spawns a new UUID and a new row — there is no way to
update a run in place. This is a real gap relative to how the rest of the
project has settled on treating a "run": one linear thread of work, one row,
never a branch (mirrors the same simplification already applied to
`source_plan_id` in the batch pipelines — see
`docs/superpowers/specs/2026-08-09-supabase-runs-migration-design.md`).

This project fixes that: continuing and re-saving a manual run overwrites
the same row instead of creating a new one, while a genuinely fresh "Ask"
still starts a new run as expected.

## Scope

- Both manual flows on `/`: the **plan flow** (`askToPlan`/`continuePlan`/
  `runNextStep`/`saveRun`) and the **direct-ask flow** (`askDirect`/
  `continueDirect`/`saveDirectRun`). They are independent — each tracks its
  own "run in progress" identity.
- Does **not** touch the batch pipelines (linear/chained/steps) or their own
  `runs` rows — those already save correctly (one row per attempt, no manual
  continue/re-save loop).
- Does **not** touch or extend the `source_plan_id`/`chain_id`/`is_leaf`
  branching logic already in `GET /api/runs` — nothing sets `source_plan_id`
  today (confirmed: it's always `null`), so that logic is already dead code
  operating over a no-op case. Out of scope to clean up here.

## Run identity: what counts as "the same run"

A run's identity starts at a fresh **`askToPlan()`** or **`askDirect()`**
call (the "Ask..." button, not "Continue") and persists through any number
of `continuePlan()`/`continueDirect()`/`runNextStep()` calls, until either:

- the user clicks "Ask..." again (always starts a new run), or
- the user loads a different previously-saved run via "Load" (adopts that
  run's identity instead).

Within that identity:

- **Model is locked.** No code change needed — `continuePlan()`/
  `continueDirect()` already hardcode the model/provider from the run's
  first call (`planResult.model`/`directResult.model`), never the live
  selector. A user can spin the model dropdown all they want between
  continues; it has no effect until the next fresh "Ask...".
- **Framing is not locked.** The `framing` radio can be flipped between
  "Ask...”/"Continue" calls (e.g. try real framing, then switch to test) —
  this is existing behavior, unchanged. The saved row's top-level `framing`
  column reflects whatever framing was active at save time (the last one
  used), matching how the batch pipelines already treat real→test as one
  continuous chain, not two runs.
- **Style is not locked, but gets recorded as `"hybrid"` if it varies.** See
  below.

## Client-side implementation

### Tracked state (per flow)

Two new pieces of state, one per flow:

```js
const [planRunId, setPlanRunId] = useState(null);
const [planStylesUsed, setPlanStylesUsed] = useState(new Set());

const [directRunId, setDirectRunId] = useState(null);
const [directStylesUsed, setDirectStylesUsed] = useState(new Set());
```

- `askToPlan()` resets `planRunId` to `null` and `planStylesUsed` to a fresh
  `Set([argumentStyle])` (the style used for this fresh call).
- `continuePlan()`/`runNextStep()` do **not** touch `planRunId`, and add the
  call's `argumentStyle` to `planStylesUsed` (`Set.add`, no-op if already
  present).
- `loadRun(id)` (the existing "Load" handler) sets `planRunId = id` (and,
  symmetrically, `directRunId = id` if the loaded run is a direct-ask run —
  a saved row is one or the other, never both, matching current save
  behavior) and seeds `planStylesUsed`/`directStylesUsed` from the loaded
  row's own style field (single-value `Set` from `data.style`, or `Set` of
  every distinct `argument_style` found across `plan_result`/`steps` if
  `data.style === "hybrid"` — doesn't need to be exact since it only feeds
  future hybrid-detection, not display).
- Exactly the same shape applies to `askDirect()`/`continueDirect()`/
  `directRunId`/`directStylesUsed`.

### Save call

`saveRun()`/`saveDirectRun()` compute the style to send:

```js
const style = planStylesUsed.size > 1 ? "hybrid" : [...planStylesUsed][0];
```

and include both `runId: planRunId` (or `null`) and `style` in the POST
body. On a successful save, `setPlanRunId(data.id)` (so a second save in a
row — even without an intervening continue — still targets the same id;
today's behavior of allowing repeated saves without a continue in between is
unchanged, it just now converges on one row instead of stacking).

## Backend: `POST /api/save-run`

Accepts two new optional fields in the body: `runId`, `style`.

```js
const { scenarioId, scenarioTitle, framing, directResult, planResult, steps, description, runId, style } =
  await req.json();
```

If `runId` is present, update instead of insert:

```js
if (runId) {
  const { error } = await supabase
    .from("runs")
    .update({ scenario_id: scenarioId, scenario_title: scenarioTitle || null, framing, style: style || null, description: description || null, data: run })
    .eq("id", runId)
    .eq("user_email", userEmail);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ saved: true, id: runId });
}
```

The `.eq("user_email", userEmail)` guard is defense-in-depth, not a UX path
that needs graceful handling: since `GET /api/runs?mine=true` (below) only
ever returns the caller's own runs to load in the first place, a client
should never be able to construct a `runId` belonging to someone else
through normal use of the page. If it somehow doesn't match (0 rows
affected), Supabase reports success with no error and no rows changed — no
special handling needed, this is an unreachable path through the UI, not
worth building copy/fork semantics for.

Without `runId`, insert as today, now additionally writing `style`:

```js
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
```

## Schema change: `runs.style`

```sql
alter table runs add column style text;
```

Applied via `mcp__supabase__apply_migration`, no checked-in `.sql` file —
matches this project's established convention (every prior schema change
this session was done the same way, documented in its plan/spec rather than
as a migration file in the repo).

Nullable, no default: existing rows (all migrated pre-this-feature) get
`null`, meaning "unknown/not tracked" — distinct from a genuine single style
value or `"hybrid"`. `GET /api/runs`'s existing `resultSource.argument_style`
fallback (nested data) stays as a secondary source for old rows that
predate this column; the display logic below prefers the new column when
present.

## `GET /api/runs`: scope to the caller's own runs

New query param, `mine`:

```js
const mine = searchParams.get("mine") === "true";
const supabase = getSupabaseClient();
let query = supabase.from("runs").select("id, data");
if (mine) {
  const userEmail = await getSessionEmail();
  if (!userEmail) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  query = query.eq("user_email", userEmail);
}
const { data: rows, error } = await query;
```

- `/` page's "Browse saved runs" widget calls `fetch("/api/runs?mine=true")`
  — only the signed-in user's own runs are listed/loadable there, matching
  the fact that this is the surface used to continue-and-overwrite a run
  in place.
- `/runs` (the standalone full explorer page) and `/compare` are
  **unchanged** — team-wide visibility stays exactly as it is today; neither
  passes `mine`, so behavior is identical to the current unfiltered query.

Each summary object gains a `style` field, read straight from the new
top-level column:

```js
style: row.style ?? null,
```

Pre-migration rows (saved before this column existed) get `null` here —
displayed as "—" (see below) — since nothing ever wrote a top-level style
for them. Their nested per-call `argument_style` fields are untouched and
still shown correctly by other detail views (e.g. the full run detail
page), which read `data` directly rather than this summary endpoint.

## `/` page: "Browse saved runs" row display

Add the style value next to the existing `scenario_title — framing — mode`
line:

```jsx
{r.scenario_title} — {r.framing} — {r.style || "—"} — {r.mode}
```

## Out of scope

- Any change to `/runs` or `/compare`'s visibility model.
- Cleaning up the dead `source_plan_id`/`chain_id`/`is_leaf` logic in
  `GET /api/runs`.
- Any change to how the batch pipelines (linear/chained/steps) save their
  own runs — they already save once per attempt, no continue/re-save loop
  exists there.
- A "duplicate as new run" / fork action — deliberately not built; the
  simplified own-runs-only visibility model removes the scenario that would
  have motivated it.

## Testing plan

Manual, matching this project's practice:
1. Ask a plan, save it, note the id. Continue the plan (more turns), save
   again — confirm same id, row content updated (via a `select` on that id),
   no second row created.
2. Load a previously-saved run (own), continue it, save — confirm it
   overwrites the loaded run's row, not a new one.
3. Ask a fresh plan (new "Ask...", not continue) — confirm this starts a
   new id on next save, independent of whatever was tracked before.
4. Flip the framing radio between an initial "Ask" and a "Continue" call,
   save — confirm the row's `framing` reflects the last one used, and it's
   still the same row id as before the flip (not a new row).
5. Change argument style between an "Ask" and a "Continue" call, save —
   confirm the row's `style` column reads `"hybrid"`. Keep style constant
   across a whole run — confirm it reads that single style, not `"hybrid"`.
6. Confirm `/` shows only the signed-in user's own runs in "Browse saved
   runs" (verify against a second test account or by checking the Supabase
   query directly), while `/runs` and `/compare` still show every user's
   runs unchanged.
