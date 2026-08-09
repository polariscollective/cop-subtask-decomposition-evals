# Compare view: creator/batch filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hard, server-side exclusion of non-human (QA/test) accounts from `/compare`, plus a client-side creator + batch filter for real contributors, so the model-comparison matrix never shows test noise and can isolate a single batch/re-sample.

**Architecture:** `/api/compare` gains a shared `isAllowedEmail` check (extracted from `auth.js`) that drops non-human rows before they're ever aggregated, and threads `user_email`/`batch_id` onto every sample it returns. `/compare`'s page component adds creator/batch selection state and re-runs the exact same best-of-N aggregation math (extracted into a shared `lib/compare-aggregate.js` used by both the server route and the client) over whatever subset of samples the active filter leaves — so the grid, footer stats, "hide empty" toggles, and the bottom table all read from one filtered, re-aggregated array instead of the raw server response.

**Tech Stack:** Next.js 14 (App Router), React (client components, hooks), Supabase (`@supabase/supabase-js`), plain CSS (`app/globals.css`, no CSS framework). No test framework is installed in this project — verification is inline Node assertion scripts for pure logic, and manual dev-server/browser checks for routes and UI, matching the existing convention (see `docs/superpowers/specs/2026-08-06-google-login-allowlist-design.md`'s own testing plan).

## Global Constraints

- Reuse `ALLOWED_EMAILS` / `ALLOWED_DOMAINS` env vars as the sole "is this a real person" source — no new env var, no hardcoded email list (per spec's "Server: exclude non-human accounts").
- The non-human exclusion is a hard server-side filter, never a client-side toggle — excluded rows must never reach the browser (per spec).
- No new dependencies. No test framework introduced.
- Every place that currently reads the raw `rows` state in `app/compare/page.js` for anything data-driven (grid, footer stats, empty-style/model detection, bottom table) must read the new `filteredRows` instead, so creator/batch filtering is consistent everywhere (per spec's "Client: filtered re-aggregation").

---

## Task 1: Shared `isAllowedEmail` helper, wired into `auth.js`

**Files:**
- Create: `lib/allowed-email.js`
- Modify: `auth.js` (repo root)

**Interfaces:**
- Produces: `isAllowedEmail(email: string | null | undefined): boolean` — exported from `lib/allowed-email.js`. Case-insensitive; true if `email` exactly matches an entry in `ALLOWED_EMAILS`, or its domain matches an entry in `ALLOWED_DOMAINS`. False for empty/nullish input. Consumed by Task 3.

- [ ] **Step 1: Confirm the module doesn't exist yet (expected failure)**

Run:
```bash
node --input-type=module -e 'import { isAllowedEmail } from "./lib/allowed-email.js"; console.log("loaded");'
```
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (or similar "Cannot find module" error).

- [ ] **Step 2: Create `lib/allowed-email.js`**

This is a straight extraction of the existing allow-list check in `auth.js`'s `signIn` callback — same `parseList` helper, same two module-level lists, same two-step check (exact email, then domain), just exported as a standalone function instead of inlined in the NextAuth config.

```js
// Shared "is this a real, allowed person" check. auth.js's Google sign-in
// gate uses this directly; app/api/compare/route.js uses it too, to keep
// QA/test accounts (e.g. reviewer-verify@example.com) out of the
// model-comparison view without a second definition of "allowed" to drift
// out of sync with the login gate.
function parseList(envVar) {
  return (envVar || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const allowedEmails = parseList(process.env.ALLOWED_EMAILS);
const allowedDomains = parseList(process.env.ALLOWED_DOMAINS);

export function isAllowedEmail(email) {
  const normalized = (email || "").toLowerCase();
  if (!normalized) return false;
  if (allowedEmails.includes(normalized)) return true;
  const domain = normalized.split("@")[1];
  return Boolean(domain && allowedDomains.includes(domain));
}
```

- [ ] **Step 3: Verify the new module's behavior**

Run (uses this repo's real `.env.local` values — `ALLOWED_EMAILS=verboomensamuel@gmail.com`, `ALLOWED_DOMAINS=polariscollective.org` — so the assertions below match what's actually configured):

```bash
set -a; source .env.local; set +a
node --input-type=module -e '
import assert from "node:assert";
import { isAllowedEmail } from "./lib/allowed-email.js";
assert.strictEqual(isAllowedEmail("verboomensamuel@gmail.com"), true, "exact ALLOWED_EMAILS match");
assert.strictEqual(isAllowedEmail("VERBOOMENSAMUEL@GMAIL.COM"), true, "case-insensitive");
assert.strictEqual(isAllowedEmail("sam@polariscollective.org"), true, "ALLOWED_DOMAINS match");
assert.strictEqual(isAllowedEmail("reviewer-verify@example.com"), false, "unlisted email/domain rejected");
assert.strictEqual(isAllowedEmail(""), false, "empty email rejected");
assert.strictEqual(isAllowedEmail(undefined), false, "undefined email rejected");
assert.strictEqual(isAllowedEmail(null), false, "null email rejected");
console.log("all isAllowedEmail assertions passed");
'
```
Expected: `all isAllowedEmail assertions passed`, exit code 0.

- [ ] **Step 4: Wire `auth.js` to use it, removing the duplicated logic**

In `auth.js`, replace:

```js
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

function parseList(envVar) {
  return (envVar || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const allowedEmails = parseList(process.env.ALLOWED_EMAILS);
const allowedDomains = parseList(process.env.ALLOWED_DOMAINS);

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  providers: [Google],
  callbacks: {
    async signIn({ user }) {
      const email = (user.email || "").toLowerCase();
      if (!email) return false;
      if (allowedEmails.includes(email)) return true;
      const domain = email.split("@")[1];
      return Boolean(domain && allowedDomains.includes(domain));
    },
  },
});
```

with:

```js
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedEmail } from "./lib/allowed-email.js";

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  providers: [Google],
  callbacks: {
    async signIn({ user }) {
      return isAllowedEmail(user.email);
    },
  },
});
```

Leave the rest of `auth.js` (the `getSessionEmail` export and its comment) untouched.

- [ ] **Step 5: Verify `auth.js` still compiles and the app still boots**

Run:
```bash
(npm run dev -- -p 3091 > /tmp/plan-task1.log 2>&1 &) && sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3091/ && cat /tmp/plan-task1.log
```
Expected: `200`, and the log shows `✓ Ready` / `✓ Compiled /middleware` with no errors (dev mode skips real auth per `middleware.js`, so `200` here just confirms nothing broke on import/compile — it does not exercise the Google OAuth flow itself).

Then stop the scratch server:
```bash
lsof -ti:3091 | xargs -r kill
```

- [ ] **Step 6: Commit**

```bash
git add lib/allowed-email.js auth.js
git commit -m "$(cat <<'EOF'
Extract isAllowedEmail from auth.js into a shared lib module

Lets app/api/compare/route.js reuse the same allow-list check to exclude
QA/test accounts, instead of a second definition that could drift.
EOF
)"
```

---

## Task 2: Shared `aggregateSamples` helper

**Files:**
- Create: `lib/compare-aggregate.js`

**Interfaces:**
- Produces: `aggregateSamples(samples: Array<Sample>): Combo | null` — exported from `lib/compare-aggregate.js`. `Sample` is the shape `toSample()` in `app/api/compare/route.js` produces (must include at least `id, pipeline, model, scenario, scenario_title, style, depth, fullSteps, completed, planAccepted, planFraming, turnsUsed, saved_at, inProgress`). Returns `null` for an empty/nullish input array; otherwise returns one aggregate object with the deepest sample as `best`, plus `sampleCount`, `completedCount`, `anyRunning`, and every input sample under `samples` (sorted by `saved_at` ascending). Consumed by Task 3 (server) and Task 4 (client).

- [ ] **Step 1: Confirm the module doesn't exist yet (expected failure)**

Run:
```bash
node --input-type=module -e 'import { aggregateSamples } from "./lib/compare-aggregate.js"; console.log("loaded");'
```
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 2: Create `lib/compare-aggregate.js`**

This is a direct extraction of the combo-building reduce currently inline in `app/api/compare/route.js`'s `GET()` — same fields, same "deepest sample wins" rule — turned into a standalone function so the compare page can re-run identical math client-side after filtering.

```js
// Folds a group of same-combo samples (same pipeline/model/scenario/style)
// into one aggregate: the deepest attempt wins as "best", with counts
// carried alongside so a caller can show every attempt, not just the
// winner. Shared between /api/compare's server-side grouping and
// app/compare/page.js's client-side re-aggregation after a creator/batch
// filter narrows which samples are in play — same math, one definition.
export function aggregateSamples(samples) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => (a.saved_at || "").localeCompare(b.saved_at || ""));
  const best = sorted.reduce((a, b) => (b.depth > a.depth ? b : a));
  const completedCount = sorted.filter((s) => s.completed).length;
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
    sampleCount: sorted.length,
    completedCount,
    anyRunning: sorted.some((s) => s.inProgress),
    samples: sorted,
  };
}
```

- [ ] **Step 3: Verify the new module's behavior**

Run:
```bash
node --input-type=module -e '
import assert from "node:assert";
import { aggregateSamples } from "./lib/compare-aggregate.js";

assert.strictEqual(aggregateSamples([]), null, "empty array returns null");
assert.strictEqual(aggregateSamples(null), null, "null returns null");

const shared = { pipeline: "linear", model: "m1", scenario: "s1", scenario_title: "S1", style: "ethical", fullSteps: 4, planAccepted: true, inProgress: false };
const samples = [
  { ...shared, id: "a", depth: 2, completed: false, planFraming: "real", turnsUsed: 3, saved_at: "2026-08-01T00:00:00Z" },
  { ...shared, id: "b", depth: 4, completed: true, planFraming: "test", turnsUsed: 5, saved_at: "2026-08-02T00:00:00Z" },
];
const agg = aggregateSamples(samples);
assert.strictEqual(agg.depth, 4, "best sample is the deepest");
assert.strictEqual(agg.id, "b", "best sample id carried through");
assert.strictEqual(agg.sampleCount, 2, "sampleCount reflects every sample");
assert.strictEqual(agg.completedCount, 1, "completedCount counts only completed samples");
assert.strictEqual(agg.samples.length, 2, "every sample retained under .samples");
assert.strictEqual(agg.anyRunning, false, "anyRunning false when no sample is inProgress");
console.log("all aggregateSamples assertions passed");
'
```
Expected: `all aggregateSamples assertions passed`, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add lib/compare-aggregate.js
git commit -m "$(cat <<'EOF'
Add shared aggregateSamples helper for the compare view

Extracted from the inline combo-building reduce in /api/compare so the
compare page can re-run identical best-of-N math client-side after a
creator/batch filter narrows the sample set (next task).
EOF
)"
```

---

## Task 3: Wire `/api/compare` to exclude non-human accounts and expose creator/batch

**Files:**
- Modify: `app/api/compare/route.js`

**Interfaces:**
- Consumes: `isAllowedEmail(email)` from Task 1 (`lib/allowed-email.js`); `aggregateSamples(samples)` from Task 2 (`lib/compare-aggregate.js`).
- Produces: `/api/compare`'s JSON response — same top-level shape as today (array of combo objects), but (a) never includes a row whose `user_email` fails `isAllowedEmail`, and (b) every object in each combo's `samples[]` array now additionally carries `user_email` and `batch_id`. Consumed by Task 4.

- [ ] **Step 1: Add the two new imports**

In `app/api/compare/route.js`, the current imports are:

```js
import { NextResponse } from "next/server";
import { getSupabaseClient } from "../../../lib/supabase.js";
```

Change to:

```js
import { NextResponse } from "next/server";
import { getSupabaseClient } from "../../../lib/supabase.js";
import { isAllowedEmail } from "../../../lib/allowed-email.js";
import { aggregateSamples } from "../../../lib/compare-aggregate.js";
```

- [ ] **Step 2: Thread `user_email` and `batch_id` through `toSample()`**

Replace the current `toSample` signature and its `base` object:

```js
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
```

with:

```js
function toSample(row, attemptStatus) {
  const { id, data: content, user_email: userEmail, batch_id: batchId } = row;
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
  };
```

(The rest of `toSample` — the `if (content.run_kind === "linear")` branch and the `dr` branch below it — is unchanged; both already `return { ...base, ... }`, so they automatically pick up the two new fields.)

- [ ] **Step 3: Update the `relevant` filter to also require an allowed email, and the `toSample` call site**

Replace:

```js
  const relevant = (rows || []).filter((r) => r.data?.run_kind === "linear" || r.data?.run_kind === "chained");
```

with:

```js
  const relevant = (rows || []).filter(
    (r) => (r.data?.run_kind === "linear" || r.data?.run_kind === "chained") && isAllowedEmail(r.user_email)
  );
```

And replace:

```js
  const samples = relevant.map((r) => toSample(r.id, r.data, attemptStatus));
```

with:

```js
  const samples = relevant.map((r) => toSample(r, attemptStatus));
```

- [ ] **Step 4: Select `user_email` from Supabase**

Replace:

```js
  const { data: rows, error } = await supabase.from("runs").select("id, data, batch_id");
```

with:

```js
  const { data: rows, error } = await supabase.from("runs").select("id, data, batch_id, user_email");
```

- [ ] **Step 5: Replace the inline combo-building reduce with `aggregateSamples`**

Replace:

```js
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
```

with:

```js
  const combos = [...byCombo.values()].map((group) => aggregateSamples(group)).filter(Boolean);
```

- [ ] **Step 6: Verify against the live database**

Run:
```bash
(npm run dev -- -p 3092 > /tmp/plan-task3.log 2>&1 &) && sleep 4 && curl -s http://localhost:3092/api/compare -o /tmp/task3-compare.json -w "%{http_code}\n"
```
Expected: `200`.

Then:
```bash
python3 -c "
import json
data = json.load(open('/tmp/task3-compare.json'))
non_human = {'reviewer-verify@example.com', 'e2e-test@example.com', 'docker-test@example.com', 'local-dev-test@example.com'}
emails_seen = set()
for combo in data:
    for s in combo['samples']:
        assert 'user_email' in s, 'sample missing user_email'
        assert 'batch_id' in s, 'sample missing batch_id'
        emails_seen.add(s['user_email'])
leaked = emails_seen & non_human
assert not leaked, f'non-human accounts leaked into /api/compare: {leaked}'
print('OK —', len(data), 'combos, creators present:', sorted(emails_seen))
"
```
Expected: prints `OK — <N> combos, creators present: ['sam@polariscollective.org']` (no `AssertionError`).

Then stop the scratch server:
```bash
lsof -ti:3092 | xargs -r kill
```

- [ ] **Step 7: Commit**

```bash
git add app/api/compare/route.js
git commit -m "$(cat <<'EOF'
Exclude non-human accounts from /api/compare, expose creator + batch

QA/test accounts (reviewer-verify@, e2e-test@, docker-test@,
local-dev-test@example.com) are filtered out server-side before
aggregation, never reaching the client. Every sample now also carries
user_email/batch_id so the compare page can filter and re-aggregate by
creator/batch (next task).
EOF
)"
```

---

## Task 4: Creator + batch filter UI on `/compare`

**Files:**
- Modify: `app/compare/page.js`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `aggregateSamples(samples)` from Task 2; `/api/compare`'s response shape from Task 3 (each `combo.samples[i]` has `user_email` and `batch_id`).
- Produces: no exports (leaf UI component); internal `filteredRows`, `availableCreators`, `availableBatches` derived state feed the existing grid/table/stats rendering in the same file.

- [ ] **Step 1: Import the shared aggregation helper**

In `app/compare/page.js`, the current imports are:

```js
import RunTranscriptModal from "../components/RunTranscriptModal";
import ScenarioDetailModal from "../components/ScenarioDetailModal";
import { MODEL_CATALOG } from "../../lib/models";
```

Add a fourth line:

```js
import RunTranscriptModal from "../components/RunTranscriptModal";
import ScenarioDetailModal from "../components/ScenarioDetailModal";
import { MODEL_CATALOG } from "../../lib/models";
import { aggregateSamples } from "../../lib/compare-aggregate.js";
```

- [ ] **Step 2: Add creator/batch selection state**

Find:

```js
  const [hideEmptyStyles, setHideEmptyStyles] = useState(true);
  const [hideEmptyModels, setHideEmptyModels] = useState(true);
```

Add two more state declarations right after:

```js
  const [hideEmptyStyles, setHideEmptyStyles] = useState(true);
  const [hideEmptyModels, setHideEmptyModels] = useState(true);
  // Empty set = "everyone" / "every batch" (the default) — never a
  // fallback-to-everyone safety net like the style/model hide toggles
  // have; an explicit empty-result selection must show an empty grid.
  const [selectedCreators, setSelectedCreators] = useState(new Set());
  const [selectedBatches, setSelectedBatches] = useState(new Set());
```

- [ ] **Step 3: Add toggle handlers**

Find the `cellData` helper:

```js
  function cellData(pipeline, model, scenario, style) {
    return index.get([pipeline, model, scenario, style].join("|")) || null;
  }
```

Add two functions right after it:

```js
  function cellData(pipeline, model, scenario, style) {
    return index.get([pipeline, model, scenario, style].join("|")) || null;
  }

  // Changing which creators are in scope invalidates any specific batch
  // selection made under the old scope, so it resets to "all batches"
  // rather than silently keeping ids that may no longer apply.
  function toggleCreator(email) {
    setSelectedCreators((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
    setSelectedBatches(new Set());
  }

  function toggleBatch(batchId) {
    setSelectedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }
```

- [ ] **Step 4: Add `filteredRows`/`availableCreators`/`availableBatches`, and repoint `index`/`stats`/`emptyStyles`/`emptyModels` at `filteredRows`**

Replace this whole block:

```js
  const index = useMemo(() => {
    const m = new Map();
    for (const r of rows || []) m.set([r.pipeline, r.model, r.scenario, r.style].join("|"), r);
    return m;
  }, [rows]);

  const stats = useMemo(() => {
    if (!rows) return null;
    const withData = rows.filter((r) => r.model);
    const completed = withData.filter((r) => r.completed).length;
    const anyProgress = withData.filter((r) => r.depth > 0).length;
    return { total: withData.length, completed, anyProgress };
  }, [rows]);

  function cellData(pipeline, model, scenario, style) {
    return index.get([pipeline, model, scenario, style].join("|")) || null;
  }

  // Changing which creators are in scope invalidates any specific batch
  // selection made under the old scope, so it resets to "all batches"
  // rather than silently keeping ids that may no longer apply.
  function toggleCreator(email) {
    setSelectedCreators((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
    setSelectedBatches(new Set());
  }

  function toggleBatch(batchId) {
    setSelectedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }

  // "Empty" = not a single run anywhere (any pipeline, any scenario, any
  // model/style) — computed across the whole dataset, not per scenario
  // section, so a style hidden here is truly untouched everywhere.
  const emptyStyles = useMemo(() => {
    const present = new Set((rows || []).map((r) => r.style));
    return new Set(STYLES.filter((s) => !present.has(s)));
  }, [rows]);
  const emptyModels = useMemo(() => {
    const present = new Set((rows || []).map((r) => r.model));
    return new Set(ALL_MODELS.filter((m) => !present.has(m)));
  }, [rows]);
```

with:

```js
  // Every creator/batch that appears anywhere in the (already
  // human-only, per Task 3) dataset — used to render the filter
  // controls. Batches are scoped to whichever creators are currently
  // selected (all of them, by default).
  const availableCreators = useMemo(() => {
    const set = new Set();
    for (const r of rows || []) for (const s of r.samples) if (s.user_email) set.add(s.user_email);
    return [...set].sort();
  }, [rows]);

  const availableBatches = useMemo(() => {
    const set = new Set();
    for (const r of rows || []) {
      for (const s of r.samples) {
        if (selectedCreators.size === 0 || selectedCreators.has(s.user_email)) set.add(s.batch_id);
      }
    }
    return [...set].sort();
  }, [rows, selectedCreators]);

  // Re-aggregates every combo's samples down to just the active
  // creator/batch selection (empty selection = everyone / every batch),
  // using the exact same best-of-N math the API applies server-side —
  // see lib/compare-aggregate.js. A combo with zero matching samples
  // after filtering drops out entirely (its cell goes back to "n/a").
  // Every other derived value below (index, stats, empty-style/model
  // detection, the bottom table) reads this instead of raw `rows`, so
  // the whole page stays consistent under the active filter.
  const filteredRows = useMemo(() => {
    if (!rows) return rows;
    return rows
      .map((combo) => {
        const samples = combo.samples.filter(
          (s) =>
            (selectedCreators.size === 0 || selectedCreators.has(s.user_email)) &&
            (selectedBatches.size === 0 || selectedBatches.has(s.batch_id))
        );
        return aggregateSamples(samples);
      })
      .filter(Boolean);
  }, [rows, selectedCreators, selectedBatches]);

  const index = useMemo(() => {
    const m = new Map();
    for (const r of filteredRows || []) m.set([r.pipeline, r.model, r.scenario, r.style].join("|"), r);
    return m;
  }, [filteredRows]);

  const stats = useMemo(() => {
    if (!filteredRows) return null;
    const withData = filteredRows.filter((r) => r.model);
    const completed = withData.filter((r) => r.completed).length;
    const anyProgress = withData.filter((r) => r.depth > 0).length;
    return { total: withData.length, completed, anyProgress };
  }, [filteredRows]);

  function cellData(pipeline, model, scenario, style) {
    return index.get([pipeline, model, scenario, style].join("|")) || null;
  }

  // Changing which creators are in scope invalidates any specific batch
  // selection made under the old scope, so it resets to "all batches"
  // rather than silently keeping ids that may no longer apply.
  function toggleCreator(email) {
    setSelectedCreators((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
    setSelectedBatches(new Set());
  }

  function toggleBatch(batchId) {
    setSelectedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }

  // "Empty" = not a single run anywhere (any pipeline, any scenario, any
  // model/style) in the currently filtered data — computed across the
  // whole dataset, not per scenario section, so a style hidden here is
  // truly untouched everywhere within the active creator/batch scope.
  const emptyStyles = useMemo(() => {
    const present = new Set((filteredRows || []).map((r) => r.style));
    return new Set(STYLES.filter((s) => !present.has(s)));
  }, [filteredRows]);
  const emptyModels = useMemo(() => {
    const present = new Set((filteredRows || []).map((r) => r.model));
    return new Set(ALL_MODELS.filter((m) => !present.has(m)));
  }, [filteredRows]);
```

- [ ] **Step 5: Repoint the bottom "View as a table" list at `filteredRows`**

Find:

```js
                  {[...rows]
                    .sort((a, b) => a.scenario.localeCompare(b.scenario) || a.pipeline.localeCompare(b.pipeline) || (a.model || "").localeCompare(b.model || ""))
```

Replace with:

```js
                  {[...filteredRows]
                    .sort((a, b) => a.scenario.localeCompare(b.scenario) || a.pipeline.localeCompare(b.pipeline) || (a.model || "").localeCompare(b.model || ""))
```

(Leave the surrounding `{rows && (...)}` gate and everything else in that `<section>` unchanged — `rows` still correctly means "the fetch finished successfully"; only the data actually listed changes to the filtered set.)

- [ ] **Step 6: Add the creator/batch controls to the legend**

Find:

```js
            <label className="cmp-legend-group cmp-toggle">
              <input type="checkbox" checked={hideEmptyStyles} onChange={(e) => setHideEmptyStyles(e.target.checked)} />
              Hide styles with no data ({emptyStyles.size})
            </label>
            <label className="cmp-legend-group cmp-toggle">
              <input type="checkbox" checked={hideEmptyModels} onChange={(e) => setHideEmptyModels(e.target.checked)} />
              Hide models with no data ({emptyModels.size})
            </label>
            <div className="cmp-stats">
```

Replace with:

```js
            <label className="cmp-legend-group cmp-toggle">
              <input type="checkbox" checked={hideEmptyStyles} onChange={(e) => setHideEmptyStyles(e.target.checked)} />
              Hide styles with no data ({emptyStyles.size})
            </label>
            <label className="cmp-legend-group cmp-toggle">
              <input type="checkbox" checked={hideEmptyModels} onChange={(e) => setHideEmptyModels(e.target.checked)} />
              Hide models with no data ({emptyModels.size})
            </label>
            {availableCreators.length > 0 && (
              <div className="cmp-legend-group">
                <span>Creator</span>
                {availableCreators.map((email) => (
                  <button
                    key={email}
                    type="button"
                    className={`cmp-creator-pill${selectedCreators.has(email) ? " active" : ""}`}
                    onClick={() => toggleCreator(email)}
                  >
                    {email}
                  </button>
                ))}
              </div>
            )}
            {availableBatches.length > 0 && (
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
            <div className="cmp-stats">
```

- [ ] **Step 7: Add CSS for the new controls**

In `app/globals.css`, find:

```css
.cmp-toggle { cursor: pointer; user-select: none; }
.cmp-toggle input { cursor: pointer; }
```

Add right after it:

```css
.cmp-creator-pill {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
}
.cmp-creator-pill.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}
.cmp-batch-details summary {
  cursor: pointer;
  user-select: none;
}
.cmp-batch-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  margin-top: 8px;
  padding-left: 4px;
}
.cmp-batch-list label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
```

- [ ] **Step 8: Verify the page compiles and the API contract still lines up**

Run:
```bash
(npm run dev -- -p 3093 > /tmp/plan-task4.log 2>&1 &) && sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3093/compare && cat /tmp/plan-task4.log
```
Expected: `200`, log shows `✓ Compiled /compare` with no errors.

Then stop the scratch server:
```bash
lsof -ti:3093 | xargs -r kill
```

- [ ] **Step 9: Manual browser verification (do this yourself — cannot be scripted)**

Open `/compare` in a browser against the dev server and confirm, per the design doc's testing plan:
1. A "Creator" pill row appears, showing `sam@polariscollective.org` (no `@example.com` accounts).
2. Clicking a creator pill narrows the grid/footer stats/bottom table together; clicking it again returns to "all".
3. Opening the "Batch" details and checking a single batch narrows the matrix to that batch's coverage only — cells outside its scope go back to `n/a`.
4. Clicking a different creator pill while a batch is checked resets the batch selection back to "all" (the "Batch (all of N)" label reflects this).

- [ ] **Step 10: Commit**

```bash
git add app/compare/page.js app/globals.css
git commit -m "$(cat <<'EOF'
Add creator + batch filter to the compare view

Selecting one or more creators, and optionally specific batches within
them, re-aggregates the matrix (grid, footer stats, hide-empty toggles,
bottom table) using only the matching samples — via the shared
aggregateSamples helper, same math the API uses server-side.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Server exclusion (Task 1+3), sample fields (Task 3), UI controls + defaults + reset-on-creator-change (Task 4 Step 3/6), shared re-aggregation (Task 2, used in Task 3 Step 5 and Task 4 Step 4), `filteredRows` feeding grid/stats/empty-detection/bottom-table (Task 4 Step 4-5), edge case "no fallback for creator/batch selection" (documented inline in Task 4 Step 2's comment and structurally true — `filteredRows` has no `: STYLES`-style fallback), testing plan (Task 3 Step 6 covers the DB-level exclusion check; Task 4 Step 9 covers the interactive checks) — all covered.
- **Placeholder scan:** none found — every step has complete, exact code.
- **Type/name consistency:** `aggregateSamples`, `isAllowedEmail`, `filteredRows`, `availableCreators`, `availableBatches`, `selectedCreators`, `selectedBatches`, `toggleCreator`, `toggleBatch` are spelled identically everywhere they're introduced and consumed across Tasks 1-4.
