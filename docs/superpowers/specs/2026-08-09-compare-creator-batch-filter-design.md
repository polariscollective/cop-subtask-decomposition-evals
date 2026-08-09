# Compare view: creator/batch filter — design

## Purpose

`/compare` reads every `linear`/`chained` run from Supabase and folds them
into a model×style comparison matrix. The `runs`/`batches` tables carry a
`user_email` (from the real Auth.js session for UI saves, or
`RUN_AUTHOR_EMAIL` for batch scripts run outside a session) — but today
`/api/compare` neither reads nor exposes it. Two problems fall out of that:

1. Non-human accounts used for QA/smoke-testing this app itself
   (`reviewer-verify@example.com`, `e2e-test@example.com`,
   `docker-test@example.com`, `local-dev-test@example.com` — 4 accounts, 1
   run each today) show up mixed into the same matrix as real eval work.
2. The one real contributor so far (`sam@polariscollective.org`) already has
   9 batches, several of which are re-samples of the exact same
   model×style×scenario matrix (12 runs each) under different batch ids
   (`linear-2026-08-07-s2`, `-fallback`, `-styles2`, ...). Today's "best of
   N" silently pools every batch together — there's no way to look at one
   iteration in isolation.

This adds: a hard, server-side exclusion of non-human accounts (never a
toggle — they must never reach the browser), plus a creator/batch filter in
the UI for real contributors, once there's more than one.

## Server: exclude non-human accounts

`auth.js`'s `signIn` callback already encodes "is this a real, allowed
person" via `ALLOWED_EMAILS` / `ALLOWED_DOMAINS`. That logic moves out of
`auth.js` into a new `lib/allowed-email.js`:

```js
export function isAllowedEmail(email) { ... }
```

`auth.js` calls it from `signIn` instead of duplicating the check.
`app/api/compare/route.js` imports it directly — no NextAuth machinery
needed for a plain string check.

In `/api/compare`, the `relevant` filter (currently `run_kind === "linear" ||
"chained"`) gains a second condition: `isAllowedEmail(r.user_email)`. Rows
from non-allowed accounts are dropped before `toSample()` ever sees them —
they never appear in the JSON response, with or without any client-side
filter. This is a hard exclusion, not a default: there is no checkbox that
brings them back.

## Server: expose creator/batch on each sample

The `runs` select gains `user_email`: `.select("id, data, batch_id,
user_email")`. `toSample()`'s `base` object gains `user_email` and
`batch_id` (both already available — `batch_id` was fetched but not
threaded through, `user_email` is the new column). Every sample inside a
combo's `samples[]` array now carries both fields; the combo's own
top-level aggregate fields (`depth`, `completed`, etc.) are unchanged — they
still aggregate over every human sample, exactly as today. Filtering by
creator/batch happens client-side (see below), the same pattern
`hideEmptyStyles`/`hideEmptyModels` already use over the one fetched
payload.

## UI: creator and batch controls

Added to the `.cmp-legend` card, next to the existing "Hide styles/models
with no data" checkboxes:

- **Creator** — one clickable pill per distinct `user_email` present in the
  (already-filtered-to-humans) data. No pill selected = all creators
  (default). Selecting one or more pills restricts to just those.
- **Batch** — a collapsible `<details>` (same pattern as "View as a table")
  with one checkbox per batch id, scoped to whichever creators are
  currently in effect (all of them by default, or just the selected pills).
  No box checked = all batches in scope (default). Labels are the raw batch
  id (`linear-2026-08-07-styles2`) — already descriptive enough.

Changing the creator selection resets the batch selection back to "all"
rather than silently keeping batch ids that may no longer belong to the new
creator scope.

## Client: filtered re-aggregation

A new `filteredRows` memo, derived from `rows` + `selectedCreators` +
`selectedBatches`:

1. For each combo, filter `samples[]` to the active creators/batches.
2. Empty result → drop the combo (cell reverts to `n/a`).
3. Otherwise re-aggregate with a shared `aggregateSamples(samples)` helper
   (best = deepest `depth`, `completedCount`, `sampleCount`, `anyRunning`) —
   the same math `/api/compare/route.js` already does server-side, factored
   out once so it isn't duplicated by hand.

`filteredRows` becomes the single input for everything that currently reads
`rows`: the matrix grid (`index`/`cellData`), the footer stats (`total` /
`anyProgress` / `completed`), `emptyStyles`/`emptyModels` (so "hide empty"
keeps working correctly against the filtered set), and the "View as a
table" list at the bottom.

## Edge cases

- **No human creators in the data at all** (fresh/empty database): no
  creator pills render — nothing to filter — and the grid behaves exactly
  as it does today with zero rows.
- **A selected batch only covers one scenario/pipeline**: the other
  panels just show more `n/a` cells, identical to how an absent combo
  renders today — no new state to handle.
- **Filtering empties `filteredRows` entirely**: the existing
  fallback-to-full-list safety net (`visibleStyles`/`visibleModels` never
  go fully empty) still applies to the *style/model* axes only. It does
  **not** apply to the creator/batch selection itself — choosing "just
  this one batch" that happens to have zero matching cells must show an
  empty-looking grid, not silently fall back to showing everyone's data.

## Testing plan

Manual verification (no automated test suite exists in this project today):

1. Query Supabase directly and confirm the 4 non-human accounts' rows are
   absent from `/api/compare`'s response, with no filter applied at all.
2. In the browser: select a creator pill, confirm the grid/footer
   stats/bottom table all update together.
3. Check a single batch, confirm the matrix narrows to just that batch's
   coverage (fewer `n/a` cells replaced by real cells go away, cells outside
   its scenario/pipeline/style/model coverage go back to `n/a`).
4. Switch creator selection while a batch is checked, confirm the batch
   selection resets to "all" rather than carrying over an invalid id.

## Out of scope

- An admin UI for managing which emails/domains count as "human" — reuses
  the existing `ALLOWED_EMAILS`/`ALLOWED_DOMAINS` env vars.
- Deleting or otherwise cleaning up the non-human accounts' underlying rows
  in Supabase — they're excluded from this view, not removed from the
  database.
- Any change to `/api/runs` or the `/runs` table view — this is scoped to
  `/compare` only.
