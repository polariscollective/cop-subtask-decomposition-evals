# Public compare view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-run `is_public` flag in Supabase and make `/compare` readable without signing in, showing published runs only, while a signed-in user gains just one new "public only" filter that reproduces the anonymous view exactly.

**Architecture:** `/api/compare` becomes the single gate — it resolves the session itself, and with no session it filters the Supabase query to `is_public = true` and strips `user_email`/`batch_id` from every sample before responding. The two other endpoints the public grid reaches (`/api/runs?id=`, `/api/scenario-detail`) gain narrow anonymous read paths limited to published runs. Only once those three are hardened does `middleware.js` stop gating `/compare` and them. On the client, `app/compare/page.js` becomes a thin server component that reads the session and passes `signedIn` into a new `app/compare/CompareGrid.js` (today's 538-line client component, moved), which hides the creator/batch filters and the cross-page links when anonymous and adds a "public only" checkbox when not.

**Tech Stack:** Next.js 14 (App Router), React 18 client components + hooks, Auth.js v5 (`next-auth@5-beta`), Supabase (`@supabase/supabase-js`), plain CSS in `app/globals.css`. No test framework — verification is inline Node assertion scripts and manual dev-server/production-build checks, matching the convention in `docs/superpowers/plans/2026-08-09-compare-creator-batch-filter.md`.

**Spec:** `docs/superpowers/specs/2026-08-10-public-compare-view-design.md`

## Global Constraints

- No new dependencies. No test framework introduced.
- **The dev server must be started by the human, not from an agent shell.** Ask them to type `!npm run dev` in the Claude Code prompt. Starting it from an agent shell silently injects an invalid `ANTHROPIC_API_KEY`, and the resulting 401s look like model refusals.
- **`is_public` is never written by application code.** No route, no script, no UI sets it. It defaults to `false` and is flipped by hand in the Supabase table editor.
- **An anonymous response must never contain `user_email` or `batch_id`** (the sample-level fields on `/api/compare`). The run blob served by `/api/runs?id=` does contain a `batch_id` — that is a descriptive label like `chained-2026-08-07`, verified to carry no account identifier, and is left alone deliberately.
- **A private or missing run id returns 404 to an anonymous caller, never 403** — a 403 would confirm the id exists.
- The `middleware.js` carve-out must match exactly `/compare`, `/api/compare`, `/api/runs`, `/api/scenario-detail` and their sub-paths — nothing else.
- Tasks 2–4 harden the endpoints **before** Task 5 opens the middleware. Do not reorder: opening the middleware first would expose private runs.
- Supabase migrations in this project are applied with the Supabase MCP `apply_migration` tool and are **not** tracked as files in the repo (there is no `supabase/` directory and no `.sql` file anywhere). Follow that convention.
- Verification lever: `getSessionEmail()` returns an email when `LOCAL_AUTHENTICATION_NEEDED=false` in `.env.local`, and `null` when it is `true` (with no real Google login). Flip that value and restart the dev server to switch between the signed-in and anonymous paths. `middleware.js` skips auth entirely outside production, so in dev every route is reachable regardless — middleware behaviour itself can only be verified against a production build (Task 5).
- Ask the human before editing `.env.local`; they have it open in their editor.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| Supabase migration `add_runs_is_public` (MCP, untracked) | Adds `runs.is_public boolean not null default false` | 1 |
| `app/api/compare/route.js` | Session-aware query filter, `isPublic` on samples, anonymous field stripping | 2 |
| `app/api/runs/route.js` | Anonymous single-run read, published runs only | 3 |
| `app/api/scenario-detail/route.js` | Anonymous scenario read, only for scenarios a published run references | 4 |
| `middleware.js` | Stops gating the four public paths | 5 |
| `app/layout.js` | Signed-out "Viewing public results / Sign in" bar | 5 |
| `app/compare/page.js` | Thin server component: resolves the session, passes `signedIn` down | 6 |
| `app/compare/CompareGrid.js` (new) | The whole compare UI, today's client component, moved | 6, 7 |
| `app/globals.css` | `.cmp-public-chip` | 7 |
| `README.md` | Documents `is_public` and the public view under `## Login` | 8 |

---

## Task 1: Add `runs.is_public`, and prove batch upserts preserve it

The flag lives outside the `data` blob, so every existing write path has to leave it alone. `POST /api/save-run` is safe by inspection (its insert omits the column, its update passes an explicit column list without it). The batch runners use `.upsert()`, which is the one case that has to be checked empirically rather than reasoned about — a batch retry re-writing a published run must not un-publish it.

**Files:**
- Migration only (applied via the Supabase MCP `apply_migration` tool; no repo file)
- Possibly modify (only if the check in Step 5 fails): `scripts/batch/runfile.js:52`, `scripts/batch/linear-runfile.js:37`, `scripts/batch/chained-runfile.js:46`, `scripts/batch/steps-runfile.js:79`

**Interfaces:**
- Produces: a `runs.is_public` boolean column, `not null default false`. Consumed by Tasks 2, 3 and 4.

- [ ] **Step 1: Confirm the column does not exist yet**

Run from the repo root:

```bash
node --env-file=.env.local -e '
import("./lib/supabase.js").then(async ({ getSupabaseClient }) => {
  const { error } = await getSupabaseClient().from("runs").select("is_public").limit(1);
  console.log(error ? "ABSENT: " + error.message : "PRESENT");
});'
```

Expected: `ABSENT: column runs.is_public does not exist`

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP tool `apply_migration` with `name: "add_runs_is_public"` and this query:

```sql
alter table public.runs
  add column is_public boolean not null default false;

comment on column public.runs.is_public is
  'Published to the signed-out /compare view. Set by hand in the Supabase table editor; no application code ever writes this column.';
```

- [ ] **Step 3: Verify the column exists and every existing row is private**

```bash
node --env-file=.env.local -e '
import("./lib/supabase.js").then(async ({ getSupabaseClient }) => {
  const supabase = getSupabaseClient();
  const { count: total } = await supabase.from("runs").select("id", { count: "exact", head: true });
  const { count: pub, error } = await supabase
    .from("runs").select("id", { count: "exact", head: true }).eq("is_public", true);
  if (error) throw error;
  console.log("total:", total, "public:", pub);
  if (pub !== 0) throw new Error("expected zero published rows immediately after the migration");
  console.log("OK");
});'
```

Expected: `total: 92 public: 0` then `OK`.

- [ ] **Step 4: Write the upsert-preservation check**

Write this to `./scratch-upsert-check.mjs` in the repo root (it has to live here so its bare and relative imports resolve against the project). It reproduces exactly what `scripts/batch/linear-runfile.js`'s `writeRunFile()` does — an `upsert` whose payload omits `is_public` — against a throwaway published row, then reads the flag back.

```js
// Throwaway check: does a PostgREST upsert that omits is_public reset it?
// Mirrors scripts/batch/linear-runfile.js writeRunFile(). Deleted after use.
import { randomUUID } from "crypto";
import { getSupabaseClient } from "./lib/supabase.js";

const supabase = getSupabaseClient();
const id = randomUUID();
const content = { saved_at: new Date().toISOString(), scenario_id: "upsert-check", run_kind: "linear" };

const { error: insertError } = await supabase.from("runs").insert({
  id,
  user_email: "upsert-check@example.com",
  scenario_id: "upsert-check",
  scenario_title: "upsert check",
  framing: "test",
  is_public: true,
  data: content,
});
if (insertError) throw insertError;

// The exact shape writeRunFile() sends: no is_public key at all.
const { error: upsertError } = await supabase.from("runs").upsert({
  id,
  user_email: "upsert-check@example.com",
  scenario_id: "upsert-check",
  scenario_title: "upsert check",
  framing: "test",
  source_plan_id: null,
  batch_id: null,
  description: null,
  data: { ...content, touched: true },
});
if (upsertError) throw upsertError;

const { data: after, error: readError } = await supabase
  .from("runs").select("is_public").eq("id", id).single();
if (readError) throw readError;

await supabase.from("runs").delete().eq("id", id);

console.log("is_public after upsert:", after.is_public);
console.log(after.is_public === true ? "PRESERVED" : "RESET — writeRunFile must carry the flag through");
```

- [ ] **Step 5: Run the check**

```bash
node --env-file=.env.local ./scratch-upsert-check.mjs
```

Expected: `is_public after upsert: true` then `PRESERVED`.

If it prints `RESET`, do Step 6. If it prints `PRESERVED`, skip Step 6.

- [ ] **Step 6: (Only if Step 5 printed RESET) Carry the flag through in all four runfile writers**

In each of `scripts/batch/runfile.js`, `scripts/batch/linear-runfile.js`, `scripts/batch/chained-runfile.js` and `scripts/batch/steps-runfile.js`, read the current flag before the upsert and include it in the payload. For `scripts/batch/linear-runfile.js` the `writeRunFile` function becomes:

```js
export async function writeRunFile(runId, content) {
  const supabase = getSupabaseClient();
  // A retry or resume re-writes a row that may already have been published
  // by hand in Supabase. An upsert that omits is_public resets it to the
  // column default, silently un-publishing the run, so the current value is
  // read and passed straight back through. Nothing here ever *sets* it.
  const { data: existing } = await supabase.from("runs").select("is_public").eq("id", runId).maybeSingle();
  const { error } = await supabase.from("runs").upsert({
    id: runId,
    user_email: process.env.RUN_AUTHOR_EMAIL,
    scenario_id: content.scenario_id,
    scenario_title: content.scenario_title,
    framing: content.framing,
    source_plan_id: content.source_plan_id || null,
    batch_id: content.batch_id || null,
    description: content.description || null,
    is_public: existing?.is_public ?? false,
    data: content,
  });
  if (error) throw new Error(`Failed to write run ${runId}: ${error.message}`);
}
```

Apply the same two changes (the `select` before, the `is_public` key in the payload) to the other three files, keeping each one's existing payload keys exactly as they are — they differ slightly between the four.

Then re-run Step 5 and confirm it now prints `PRESERVED`.

- [ ] **Step 7: Delete the throwaway script and confirm no orphan row survived**

```bash
rm ./scratch-upsert-check.mjs
node --env-file=.env.local -e '
import("./lib/supabase.js").then(async ({ getSupabaseClient }) => {
  const { count } = await getSupabaseClient()
    .from("runs").select("id", { count: "exact", head: true }).eq("scenario_id", "upsert-check");
  console.log("leftover check rows:", count);
});'
```

Expected: `leftover check rows: 0`

- [ ] **Step 8: Commit**

If Step 6 ran:

```bash
git add scripts/batch/runfile.js scripts/batch/linear-runfile.js scripts/batch/chained-runfile.js scripts/batch/steps-runfile.js
git commit -m "Carry is_public through batch run upserts"
```

If Step 6 did not run there is nothing to commit — the migration lives only in Supabase. Say so explicitly rather than committing an empty change.

---

## Task 2: `/api/compare` serves published runs only to anonymous callers

**Files:**
- Modify: `app/api/compare/route.js`

**Interfaces:**
- Consumes: `runs.is_public` (Task 1); `getSessionEmail(): Promise<string | null>` from `auth.js` (repo root).
- Produces: the `/api/compare` response stays a bare JSON array of combo objects (shape unchanged, see `lib/compare-aggregate.js`). Each entry in a combo's `samples` array gains `isPublic: boolean` **when the caller is signed in**; when the caller is anonymous, `user_email`, `batch_id` and `isPublic` are all absent from every sample. Consumed by Task 7.

- [ ] **Step 1: Import the session helper**

In `app/api/compare/route.js`, add to the imports at the top:

```js
import { getSessionEmail } from "../../../auth";
```

- [ ] **Step 2: Thread `is_public` onto every sample**

Replace the destructuring and `base` object at the top of `toSample` (currently `app/api/compare/route.js:24-37`):

```js
function toSample(row, attemptStatus) {
  const { id, data: content, user_email: userEmail, batch_id: batchId, is_public: isPublic } = row;
  const base = {
    id,
    pipeline: content.run_kind,
    model: null,
    scenario: content.scenario_id,
    scenario_title: content.scenario_title,
    style: content.style,
    saved_at: content.saved_at,
    inProgress: attemptStatus(content.batch_id, id) === "running",
    user_email: userEmail,
    batch_id: batchId,
    isPublic: Boolean(isPublic),
  };
```

Leave the rest of `toSample` unchanged.

- [ ] **Step 3: Add the anonymous-sample scrubber**

Add this function directly below `toSample` (after its closing brace, before `export async function GET`):

```js
// An anonymous visitor's payload must not carry the team's email addresses
// or internal batch ids — those exist only to drive the signed-in
// creator/batch filters. isPublic goes too: every sample in an anonymous
// response is published by construction, so the field would be a constant
// that only invites someone to trust it as a filter.
function toPublicSample(sample) {
  const { user_email, batch_id, isPublic, ...rest } = sample;
  return rest;
}
```

- [ ] **Step 4: Gate the query on the session**

Replace the first three lines of `GET` (currently `app/api/compare/route.js:69-72`):

```js
export async function GET() {
  const supabase = getSupabaseClient();
  // The whole public view hangs off this one check. With no session the
  // filter goes into the query itself rather than being applied afterwards,
  // so an unpublished run is never even loaded into a response this request
  // could serialise.
  const signedIn = Boolean(await getSessionEmail());

  let query = supabase.from("runs").select("id, data, batch_id, user_email, is_public");
  if (!signedIn) query = query.eq("is_public", true);
  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
```

- [ ] **Step 5: Scrub the samples when anonymous**

Replace the `samples` line (currently `app/api/compare/route.js:105`):

```js
  const samples = relevant
    .map((r) => toSample(r, attemptStatus))
    .map((s) => (signedIn ? s : toPublicSample(s)));
```

Everything below it — the `byCombo` grouping, `aggregateSamples`, the response — stays exactly as it is.

- [ ] **Step 6: Publish one run to test against**

Pick a run that has data in the grid and publish it. Get a candidate id:

```bash
node --env-file=.env.local -e '
import("./lib/supabase.js").then(async ({ getSupabaseClient }) => {
  const { data } = await getSupabaseClient()
    .from("runs").select("id, scenario_id, style").not("data->>run_kind", "is", null).limit(3);
  console.log(data);
});'
```

Then publish the first one with the Supabase MCP `execute_sql` tool (substituting the real id):

```sql
update public.runs set is_public = true where id = '<id-from-above>';
```

- [ ] **Step 7: Ask the human to start the dev server with the anonymous setting**

Ask them to set `LOCAL_AUTHENTICATION_NEEDED=true` in `.env.local` and then type `!npm run dev` in the Claude Code prompt. Do not start it yourself and do not edit `.env.local` without asking — see Global Constraints.

- [ ] **Step 8: Verify the anonymous response**

```bash
curl -s localhost:3000/api/compare | node -e '
let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const combos = JSON.parse(raw);
  const samples = combos.flatMap((c) => c.samples);
  console.log("combos:", combos.length, "samples:", samples.length);
  const leaked = samples.filter((s) => "user_email" in s || "batch_id" in s || "isPublic" in s);
  if (leaked.length) throw new Error(`${leaked.length} sample(s) leaked a private field`);
  if (samples.length !== 1) throw new Error(`expected exactly 1 published sample, got ${samples.length}`);
  if (raw.includes("@")) throw new Error("an @ appears in the anonymous payload — inspect it by hand");
  console.log("OK");
});'
```

Expected: `combos: 1 samples: 1` then `OK`.

- [ ] **Step 9: Verify the signed-in response is unchanged**

Ask the human to set `LOCAL_AUTHENTICATION_NEEDED=false` in `.env.local` and restart the dev server, then:

```bash
curl -s localhost:3000/api/compare | node -e '
let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const samples = JSON.parse(raw).flatMap((c) => c.samples);
  const published = samples.filter((s) => s.isPublic);
  console.log("samples:", samples.length, "published:", published.length);
  if (samples.length <= 1) throw new Error("signed-in view should show far more than the one published run");
  if (published.length !== 1) throw new Error(`expected exactly 1 isPublic sample, got ${published.length}`);
  if (!samples.every((s) => "user_email" in s)) throw new Error("signed-in samples lost user_email");
  console.log("OK");
});'
```

Expected: `samples: <a number well above 1> published: 1` then `OK`.

- [ ] **Step 10: Commit**

```bash
git add app/api/compare/route.js
git commit -m "Serve only published runs from /api/compare when signed out"
```

---

## Task 3: `/api/runs?id=` serves a published run to an anonymous reader

The public grid's cells open `RunTranscriptModal`, which fetches `/api/runs?id=<id>` per sample (`app/components/RunTranscriptModal.js:44`). That branch currently 401s without a session.

**Files:**
- Modify: `app/api/runs/route.js:20-52`

**Interfaces:**
- Consumes: `runs.is_public` (Task 1).
- Produces: `GET /api/runs?id=<id>` returns the run blob plus `style` and `owned` for a signed-in caller (unchanged), and for an anonymous caller returns the same shape with `owned: false` when the run is published, or `404 {"error":"not found"}` otherwise. `GET /api/runs` with no `id` still 401s without a session.

- [ ] **Step 1: Replace the `id` branch**

Replace the whole `if (id) { ... }` block in `app/api/runs/route.js` (currently lines 20-52) with:

```js
  if (id) {
    // Reading a run stays team-wide: /compare's transcript modal is the only
    // way to read a run's conversation, and the runs explorer is deliberately
    // shared. What must NOT be shared is loading a run into the editor to
    // continue and overwrite it — so the payload reports whether the caller
    // owns it, and the client refuses to adopt an identity it doesn't own.
    // The real write-side guard is POST /api/save-run's own ownership check.
    const userEmail = await getSessionEmail();
    const { data: row, error } = await supabase
      .from("runs")
      .select("data, style, user_email, is_public")
      .eq("id", id)
      .maybeSingle();
    if (error || !row) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // Anonymous readers exist only because /compare is public. They may read
    // a transcript, but only of a published run — and an unpublished id gets
    // the same 404 as a missing one, so the response never confirms that an
    // id it was handed actually exists.
    if (!userEmail && !row.is_public) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // The root style column rides along with the run content: it's the only
    // record that MORE THAN ONE style was used ("hybrid"), which the nested
    // per-call argument_style fields can never express on their own. Without
    // it, loading a hybrid run and re-saving silently downgrades it to
    // whichever single style happened to be used last.
    // The column is the source of truth going forward, but batch rows predate
    // it and carry their style only in the blob — fall back rather than
    // shadowing a real value with null.
    return NextResponse.json({
      ...row.data,
      style: row.style ?? row.data?.style ?? null,
      // Guarded on userEmail as well as the comparison: an anonymous caller
      // reading a batch row whose user_email is null would otherwise come out
      // as the owner (null === null).
      owned: Boolean(userEmail) && row.user_email === userEmail,
    });
  }
```

- [ ] **Step 2: Verify anonymously**

Ask the human to set `LOCAL_AUTHENTICATION_NEEDED=true` and restart the dev server. Collect the published id and an unpublished one:

```bash
node --env-file=.env.local -e '
import("./lib/supabase.js").then(async ({ getSupabaseClient }) => {
  const supabase = getSupabaseClient();
  const { data: pub } = await supabase.from("runs").select("id").eq("is_public", true).limit(1);
  const { data: priv } = await supabase.from("runs").select("id").eq("is_public", false).limit(1);
  console.log("PUBLIC=" + pub[0].id);
  console.log("PRIVATE=" + priv[0].id);
});'
```

Then, substituting the two ids:

```bash
echo "published: $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/runs?id=<PUBLIC>')"
echo "private:   $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/runs?id=<PRIVATE>')"
echo "list:      $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/runs')"
```

Expected:

```
published: 200
private:   404
list:      401
```

- [ ] **Step 3: Verify the published payload carries no account identifier**

```bash
curl -s 'localhost:3000/api/runs?id=<PUBLIC>' | node -e '
let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const run = JSON.parse(raw);
  if ("user_email" in run) throw new Error("user_email leaked into the anonymous run payload");
  if (run.owned !== false) throw new Error("owned should be false for an anonymous reader");
  console.log("keys:", Object.keys(run).join(", "));
  console.log("OK");
});'
```

Expected: a key list containing `saved_at`, `scenario_id`, `plan_result`/`direct_result`, `style`, `owned` — and no `user_email` — then `OK`.

- [ ] **Step 4: Verify signed-in behaviour is unchanged**

Ask the human to set `LOCAL_AUTHENTICATION_NEEDED=false` and restart, then:

```bash
echo "published: $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/runs?id=<PUBLIC>')"
echo "private:   $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/runs?id=<PRIVATE>')"
echo "list:      $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/runs')"
```

Expected: `200`, `200`, `200`.

- [ ] **Step 5: Commit**

```bash
git add app/api/runs/route.js
git commit -m "Let anonymous readers open a published run's transcript"
```

---

## Task 4: `/api/scenario-detail` serves scenarios a published run references

The public grid's scenario titles open `ScenarioDetailModal`, which fetches `/api/scenario-detail?scenarioId=<id>`. Serving any scenario to anyone would make an unpublished scenario readable by guessing its id, so the anonymous path is tied to publication: at least one published run must reference the scenario.

**Files:**
- Modify: `app/api/scenario-detail/route.js:6-24`

**Interfaces:**
- Consumes: `runs.is_public` (Task 1).
- Produces: `GET /api/scenario-detail?scenarioId=<id>` unchanged for signed-in callers; for anonymous callers, the same body when a published run references the scenario, otherwise `404 {"error":"Scenario not found: <id>"}`. `PUT`/`DELETE` untouched.

- [ ] **Step 1: Add the anonymous gate to `GET`**

Replace the body of `GET` in `app/api/scenario-detail/route.js` (currently lines 6-24) with:

```js
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const supabase = getSupabaseClient();

  // Anonymous readers reach this only from the public /compare grid, where a
  // scenario title opens its spec. Tie that to publication rather than
  // serving every scenario: otherwise a scenario nobody has published
  // anything for is readable by guessing its id. Same 404 either way, so the
  // response doesn't distinguish "unpublished" from "does not exist".
  const userEmail = await getSessionEmail();
  if (!userEmail) {
    const { count, error: countError } = await supabase
      .from("runs")
      .select("id", { count: "exact", head: true })
      .eq("scenario_id", scenarioId)
      .eq("is_public", true);
    if (countError || !count) {
      return NextResponse.json({ error: `Scenario not found: ${scenarioId}` }, { status: 404 });
    }
  }

  const { data: row, error } = await supabase
    .from("scenarios")
    .select("data, created_by, deleted_at")
    .eq("scenario_id", scenarioId)
    .single();
  if (error || !row) {
    return NextResponse.json({ error: `Scenario not found: ${scenarioId}` }, { status: 404 });
  }

  return NextResponse.json({ ...row.data, created_by: row.created_by, deleted: row.deleted_at != null });
}
```

- [ ] **Step 2: Verify anonymously**

Ask the human to set `LOCAL_AUTHENTICATION_NEEDED=true` and restart the dev server. Find the published run's scenario and one with nothing published:

```bash
node --env-file=.env.local -e '
import("./lib/supabase.js").then(async ({ getSupabaseClient }) => {
  const supabase = getSupabaseClient();
  const { data: pub } = await supabase.from("runs").select("scenario_id").eq("is_public", true).limit(1);
  const { data: all } = await supabase.from("scenarios").select("scenario_id");
  console.log("PUBLISHED_SCENARIO=" + pub[0].scenario_id);
  console.log("OTHER_SCENARIO=" + all.map((s) => s.scenario_id).find((s) => s !== pub[0].scenario_id));
});'
```

Then, substituting both:

```bash
echo "published scenario: $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/scenario-detail?scenarioId=<PUBLISHED_SCENARIO>')"
echo "other scenario:     $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/scenario-detail?scenarioId=<OTHER_SCENARIO>')"
```

Expected:

```
published scenario: 200
other scenario:     404
```

- [ ] **Step 3: Verify signed-in behaviour is unchanged**

Ask the human to set `LOCAL_AUTHENTICATION_NEEDED=false` and restart, then re-run both curls from Step 2.

Expected: `200` and `200`.

- [ ] **Step 4: Commit**

```bash
git add app/api/scenario-detail/route.js
git commit -m "Serve published scenarios to anonymous readers"
```

---

## Task 5: Open the middleware for the four public paths, and add the signed-out bar

Only now — with all three endpoints hardened — does the door open.

**Files:**
- Modify: `middleware.js:24-26`
- Modify: `app/layout.js:16-41`

**Interfaces:**
- Produces: `/compare`, `/api/compare`, `/api/runs`, `/api/scenario-detail` reachable without a session in production; every other route still redirects (pages) or 401s (APIs). The root layout renders a "Viewing public results / Sign in" bar when there is no session.

- [ ] **Step 1: Carve the four paths out of the matcher**

Replace the `config` export at the bottom of `middleware.js`:

```js
// Everything is gated except: Auth.js's own endpoints, Next's static assets,
// and the public compare view. That last group is /compare plus the three
// endpoints it reads — each of which does its own session check and serves
// nothing but published runs to an anonymous caller (see app/api/compare,
// app/api/runs and app/api/scenario-detail). The (?:/|$) on each keeps the
// carve-out from matching a longer sibling path like /compare-internal.
export const config = {
  matcher: [
    "/((?!api/auth(?:/|$)|api/compare(?:/|$)|api/runs(?:/|$)|api/scenario-detail(?:/|$)|compare(?:/|$)|_next/static|_next/image|favicon.ico).*)",
  ],
};
```

- [ ] **Step 2: Add the signed-out bar to the root layout**

In `app/layout.js`, replace the `{email && (...)}` block (lines 19-37) with:

```js
        {email ? (
          <div className="auth-bar">
            <span>Signed in as {email}</span>
            {session?.user ? (
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <button type="submit" className="btn btn-ghost">
                  Sign out
                </button>
              </form>
            ) : (
              <span className="badge badge-warn">local dev — sign-in bypassed</span>
            )}
          </div>
        ) : (
          // Only ever reachable on /compare — every other route redirects to
          // sign-in before this renders. It's the way back in for a team
          // member who lands on the public view.
          <div className="auth-bar">
            <span>Viewing public results</span>
            <a className="btn btn-ghost" href="/api/auth/signin">
              Sign in
            </a>
          </div>
        )}
```

- [ ] **Step 3: Verify the matcher regex in isolation**

`middleware.js` short-circuits outside production, so the matcher is the only part testable without a production build. Check it directly:

```bash
node -e '
const m = /^\/((?!api\/auth(?:\/|$)|api\/compare(?:\/|$)|api\/runs(?:\/|$)|api\/scenario-detail(?:\/|$)|compare(?:\/|$)|_next\/static|_next\/image|favicon.ico).*)$/;
const cases = {
  "/compare": false, "/compare/": false, "/api/compare": false,
  "/api/runs": false, "/api/runs/": false, "/api/scenario-detail": false,
  "/api/auth/signin": false,
  "/": true, "/runs": true, "/batch": true, "/scenarios": true,
  "/api/save-run": true, "/api/plan": true, "/compare-internal": true, "/comparex": true,
};
let bad = 0;
for (const [path, shouldGate] of Object.entries(cases)) {
  const gated = m.test(path);
  if (gated !== shouldGate) { bad++; console.log("WRONG", path, "gated:", gated, "expected:", shouldGate); }
}
console.log(bad === 0 ? "OK" : bad + " mismatches");'
```

Expected: `OK`. Note `/compare-internal` and `/comparex` must come out gated — that is what the `(?:/|$)` anchors buy.

- [ ] **Step 4: Verify against a production build**

Ask the human to stop the dev server, then run a production build and start it (this is the only way to exercise the middleware, since it is bypassed outside production):

```bash
npm run build && npm start
```

Then, in another shell:

```bash
for p in /compare /api/compare /runs / /batch /api/save-run; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' "localhost:3000$p")"
done
```

Expected:

```
/compare -> 200
/api/compare -> 200
/runs -> 307
/ -> 307
/batch -> 307
/api/save-run -> 401
```

(`307` is the redirect to `/api/auth/signin`; `/api/save-run` is a POST-only route, so a GET reaching the handler would be 405 — a 401 confirms middleware stopped it first.)

- [ ] **Step 5: Confirm the signed-out bar renders**

With the production server still running:

```bash
curl -s localhost:3000/compare | grep -o "Viewing public results" | head -1
```

Expected: `Viewing public results`

Then ask the human to stop `npm start` and go back to `npm run dev`.

- [ ] **Step 6: Commit**

```bash
git add middleware.js app/layout.js
git commit -m "Open /compare and its reads to signed-out visitors"
```

---

## Task 6: Split `/compare` into a server page and a client grid

Pure refactor — no behaviour change. The page needs to know, before it renders, whether there is a session, and the client component cannot answer that without a flash of the wrong UI. It also gets `app/compare/page.js` (538 lines) back to a readable size.

**Files:**
- Create: `app/compare/CompareGrid.js`
- Modify: `app/compare/page.js` (replaced wholesale)

**Interfaces:**
- Consumes: `getSessionEmail(): Promise<string | null>` from `auth.js`.
- Produces: `CompareGrid({ signedIn }: { signedIn: boolean })` — default export of `app/compare/CompareGrid.js`, a client component rendering the entire compare UI. Consumed by Task 7.

- [ ] **Step 1: Move the client component into its own file**

```bash
git mv app/compare/page.js app/compare/CompareGrid.js
```

- [ ] **Step 2: Rename the component and take the prop**

In `app/compare/CompareGrid.js`, change the component declaration (was line 64):

```js
export default function CompareGrid({ signedIn }) {
```

Everything else in the file stays exactly as it is. `signedIn` is unused in this task — Task 7 consumes it.

- [ ] **Step 3: Create the server page**

Write `app/compare/page.js`:

```js
import { getSessionEmail } from "../../auth";
import CompareGrid from "./CompareGrid";

// The page itself is public — see middleware.js's carve-out. This thin server
// wrapper exists only to answer one question before anything renders: is
// there a session? The grid shows a different (smaller) set of controls to a
// signed-out visitor, and resolving that on the client would mean flashing
// the signed-in UI first.
export default async function ComparePage() {
  const email = await getSessionEmail();
  return <CompareGrid signedIn={Boolean(email)} />;
}
```

- [ ] **Step 4: Verify the page still renders identically**

With the dev server running and `LOCAL_AUTHENTICATION_NEEDED=false`:

```bash
curl -s localhost:3000/compare | grep -c "Plan+execute vs. chained"
```

Expected: `1`

Then ask the human to open `http://localhost:3000/compare` in a browser and confirm the grid, legend, creator pills, batch picker, stats, tooltips, cell transcripts and scenario modal all behave exactly as before.

- [ ] **Step 5: Commit**

```bash
git add app/compare/page.js app/compare/CompareGrid.js
git commit -m "Split the compare page into a server wrapper and a client grid"
```

---

## Task 7: The signed-out UI, and the "public only" filter for signed-in users

**Files:**
- Modify: `app/compare/CompareGrid.js`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `signedIn: boolean` (Task 6); `sample.isPublic: boolean` on signed-in `/api/compare` responses (Task 2).

- [ ] **Step 1: Add the `publicOnly` state**

In `app/compare/CompareGrid.js`, directly after the `selectedBatches` state declaration (currently line 80):

```js
  // Off by default: signing in should change as little as possible about the
  // page. Checking it reproduces exactly what a signed-out visitor sees.
  const [publicOnly, setPublicOnly] = useState(false);
```

- [ ] **Step 2: Count published samples**

Add directly after the `availableBatches` memo (currently ends line 110):

```js
  // Deliberately counted over the whole loaded dataset rather than the
  // current creator/batch selection: it labels the checkbox, and a number
  // that moved as other filters changed would read as a result rather than
  // as "this is how much has been published so far".
  const publicCount = useMemo(() => {
    let n = 0;
    for (const r of rows || []) for (const s of r.samples) if (s.isPublic) n++;
    return n;
  }, [rows]);
```

- [ ] **Step 3: Fold `publicOnly` into the sample filter**

In the `filteredRows` memo, replace the `combo.samples.filter(...)` call and the memo's dependency array (currently lines 124-132):

```js
        const samples = combo.samples.filter(
          (s) =>
            (selectedCreators.size === 0 || selectedCreators.has(s.user_email)) &&
            (selectedBatches.size === 0 || selectedBatches.has(s.batch_id)) &&
            (!publicOnly || s.isPublic)
        );
        return aggregateSamples(samples);
      })
      .filter(Boolean);
  }, [rows, selectedCreators, selectedBatches, publicOnly]);
```

- [ ] **Step 4: Hide the cross-page links when signed out**

Replace the header's link group (currently lines 208-215):

```js
        {signedIn && (
          <div style={{ display: "flex", gap: 8 }}>
            <a href="/runs" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
              Runs table ↗
            </a>
            <a href="/" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
              ← Back to dashboard
            </a>
          </div>
        )}
```

- [ ] **Step 5: Swap the creator/batch controls for the public filter**

Replace the `{availableCreators.length > 0 && (...)}` and `{availableBatches.length > 0 && (...)}` blocks in the legend (currently lines 267-301) with the following. The creator and batch blocks are now additionally gated on `signedIn` — an anonymous response has no `user_email`/`batch_id` on its samples so they would come out empty anyway, but saying it outright means the UI doesn't depend on that coincidence.

```js
            {signedIn ? (
              <label className="cmp-legend-group cmp-toggle">
                <input
                  type="checkbox"
                  checked={publicOnly}
                  onChange={(e) => {
                    setPublicOnly(e.target.checked);
                    setModalCombo(null);
                  }}
                />
                Public only ({publicCount})
              </label>
            ) : (
              <div className="cmp-legend-group">
                <span className="cmp-public-chip">Public runs only</span>
              </div>
            )}
            {signedIn && availableCreators.length > 0 && (
              <div className="cmp-legend-group">
                <span>Creator</span>
                {availableCreators.map((email) => (
                  <button
                    key={email}
                    type="button"
                    className={`cmp-creator-pill${selectedCreators.has(email) ? " active" : ""}`}
                    aria-pressed={selectedCreators.has(email)}
                    onClick={() => toggleCreator(email)}
                  >
                    {email}
                  </button>
                ))}
              </div>
            )}
            {signedIn && availableBatches.length > 0 && (
              <details className="cmp-legend-group cmp-batch-details">
                <summary className="cmp-toggle">
                  Batch ({selectedBatches.size || "all"} of {availableBatches.length})
                </summary>
                <div className="cmp-batch-list">
                  {availableBatches.map((batchId) => (
                    <label key={batchId}>
                      <input
                        type="checkbox"
                        checked={selectedBatches.has(batchId)}
                        onChange={() => toggleBatch(batchId)}
                      />
                      {batchId}
                    </label>
                  ))}
                </div>
              </details>
            )}
```

- [ ] **Step 6: Style the chip**

Append to the compare-view block in `app/globals.css`, directly after the `.cmp-creator-pill.active` rule (currently ends line 612):

```css
.cmp-public-chip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
}
```

- [ ] **Step 7: Verify the signed-out view**

Ask the human to set `LOCAL_AUTHENTICATION_NEEDED=true`, restart the dev server, and open `http://localhost:3000/compare`. Confirm:

- the top bar reads "Viewing public results" with a working Sign in link
- there is no "Runs table ↗" and no "← Back to dashboard"
- there are no creator pills and no batch picker
- there is no "Public only" checkbox; a "Public runs only" chip is there instead
- "Hide styles with no data" and "Hide models with no data" are both present and still work
- only the published run's cell has data; everything else reads "n/a"
- clicking that cell opens its transcript
- clicking the scenario title opens the scenario spec

A quick automated cross-check of the markup. Note it can only assert on what
is in the server-rendered HTML: the legend (chip, hide-empty toggles, creator
pills) lives inside the page's `{rows && (…)}` block and only exists after the
client fetch resolves, so those are the browser checks above, not this one.

```bash
curl -s localhost:3000/compare | node -e '
let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const must = ["Viewing public results", "Plan+execute vs. chained"];
  const mustNot = ["Back to dashboard", "Runs table"];
  for (const s of must) if (!raw.includes(s)) throw new Error("missing: " + s);
  for (const s of mustNot) if (raw.includes(s)) throw new Error("should not be present: " + s);
  console.log("OK");
});'
```

Expected: `OK`

- [ ] **Step 8: Verify the signed-in view**

Ask the human to set `LOCAL_AUTHENTICATION_NEEDED=false`, restart, and reload `/compare`. Confirm the page is identical to before this feature, plus a `Public only (1)` checkbox. Check it and confirm the grid collapses to the same single populated cell the signed-out view showed; uncheck it and confirm the full grid returns.

Same caveat as the previous step — the checkbox itself is only in the DOM
after the fetch resolves, so the automated check covers the server-rendered
part and the browser covers the rest:

```bash
curl -s localhost:3000/compare | node -e '
let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const must = ["Back to dashboard", "Runs table", "Signed in as"];
  for (const s of must) if (!raw.includes(s)) throw new Error("missing: " + s);
  if (raw.includes("Viewing public results")) throw new Error("the signed-out bar leaked into the signed-in view");
  console.log("OK");
});'
```

Expected: `OK`

- [ ] **Step 9: Commit**

```bash
git add app/compare/CompareGrid.js app/globals.css
git commit -m "Show a public-only compare view when signed out"
```

---

## Task 8: Document the flag, and run the spec's full verification pass

**Files:**
- Modify: `README.md` (the `## Login` section, currently starting line 182)

- [ ] **Step 1: Document `is_public` in the README**

In `README.md`, replace the first paragraph of the `## Login` section (currently lines 184-190):

```markdown
The app is gated behind Google sign-in — only accounts in `ALLOWED_EMAILS`
(exact match) or with a domain in `ALLOWED_DOMAINS` can reach it, with one
exception: `/compare` is public (see below). Everyone who's allowed in shares
the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set in the environment; there's no
per-user key. This also determines whose saved runs are visible in the
`/compare` model-comparison view — runs from any other account are excluded
there.
```

Then add this subsection at the very end of the `## Login` section (after the paragraph about `RUN_AUTHOR_EMAIL`):

```markdown
### The public compare view

`/compare` is readable without signing in, but only shows runs whose
`is_public` column is `true`. Nothing in the app ever writes that column —
publish a run by flipping it by hand in the Supabase table editor, or with:

```sql
update public.runs set is_public = true where id = '<run-id>';
```

A signed-out visitor gets the grid, both "hide … with no data" toggles, the
stats, tooltips, per-cell transcripts and the scenario specs — but no creator
or batch filters and no links to the rest of the app. A signed-in user sees
everything as before plus a "Public only" checkbox, which reproduces the
signed-out view exactly. The three endpoints the public page reads
(`/api/compare`, `/api/runs?id=`, `/api/scenario-detail`) each enforce this
themselves; `middleware.js` carves them out of the sign-in gate on that basis.
```

- [ ] **Step 2: Run the spec's verification checklist**

Ask the human to run a production build (`npm run build && npm start`) with exactly one run published, and walk the list. Record the result of each item.

| # | Check | Expected |
|---|---|---|
| 1 | Anonymous `/compare` | loads, no redirect |
| 2 | Grid contents | only the published run's combo has data |
| 3 | `curl -s localhost:3000/api/compare \| grep -c '@'` | `0` |
| 4 | Cell click / scenario title click | transcript opens; scenario spec opens |
| 5 | `curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/runs?id=<PRIVATE>'` | `404` |
| 6 | `curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/scenario-detail?scenarioId=<OTHER>'` | `404` |
| 7 | `/`, `/runs`, `/batch`, `/scenarios` | all redirect to sign-in |
| 8 | Signed in, "public only" unchecked | identical to before the feature |
| 9 | Signed in, "public only" checked | matches row 2's view |
| 10 | Re-run a batch over the published run | `is_public` is still `true` |

For row 10, re-run the check from Task 1 Step 4 (rewrite the throwaway script, run it, delete it) rather than burning a real batch.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the public compare view and the is_public flag"
```

- [ ] **Step 4: Report**

Report which of the ten checks passed, verbatim, including any that did not. Do not claim the feature is done on the strength of the code alone.
