# Public compare view — design

Date: 2026-08-10

## Problem

`/compare` is the one page worth showing to people outside the team, but the
whole app sits behind a Google sign-in gate with an email allowlist. There is
also no way to say "this particular run may be shown publicly" — visibility is
all-or-nothing, per account.

Two things are needed:

1. A per-run `is_public` flag, controlled outside the app.
2. `/compare` reachable without signing in, showing public runs only, with the
   sign-in-only affordances stripped out.

A signed-in user's experience must change as little as possible: one extra
filter, "public only", which reproduces the anonymous view exactly.

## Non-goals

- No UI for setting `is_public`. The flag is flipped by hand in the Supabase
  table editor. No app surface writes it.
- No change to any other page. `/`, `/runs`, `/batch`, `/scenarios` stay fully
  gated.
- No change to how runs are produced, aggregated, or scored.

## Data

```sql
alter table public.runs
  add column is_public boolean not null default false;
```

All existing rows land at `false`. Publishing is a manual `update` in Supabase.

**Preservation risk.** The flag lives outside the `data` blob, so every write
path has to leave it alone:

- `POST /api/save-run` — both branches are safe as written. The insert omits
  `is_public` (takes the default); the update passes an explicit column list
  that does not include it.
- `scripts/batch/*-runfile.js` `writeRunFile()` — uses `.upsert()`. A batch
  retry or resume re-writes an existing row. PostgREST builds its
  `on conflict do update set` list from the payload's keys, so an omitted
  column should be left alone, but this must be **verified against the real
  table** before the feature is trusted. If an upsert does reset the column,
  `writeRunFile` reads the existing `is_public` first and passes it through.

## Server

### `/api/compare` — the single gate

`GET` resolves the session with `getSessionEmail()` and branches on it:

- **No session:** the Supabase query adds `.eq("is_public", true)`. Every
  sample is then stripped of `user_email` and `batch_id` before it is
  serialised — otherwise the anonymous page's JSON payload carries the team's
  email addresses and internal batch ids.
- **Session:** the query is unchanged. Each sample gains an `isPublic` boolean
  so the client-side "public only" checkbox can filter without a second
  request.

The existing `isAllowedEmail(r.user_email)` filter stays, ANDed with the public
check: a run must be both published and authored by a recognised account to
appear. The `batches` lookup that computes `anyRunning` is unaffected — it
keys off `batch_id`, which is still read server-side even when it is stripped
from the response.

The response shape stays a bare array of combos. The client learns whether it
is signed in from the server component, not from this payload.

### `/api/runs?id=<id>`

The list branch (`GET /api/runs` with no `id`) keeps its 401 — it is only used
by signed-in surfaces.

The single-run branch gains an anonymous path: with no session, the row is
returned only when `is_public` is true, and a private or missing id yields the
same **404** (never 403 — a 403 would confirm the id exists). The `owned` field
is `false` for anonymous callers, which is already what the transcript modal
expects.

### `/api/scenario-detail`

`GET` with no session serves a scenario only if at least one **public** run
references its `scenario_id`; otherwise 404. With a session, unchanged.
`PUT`/`DELETE` are untouched — `requireOwnedScenario()` already 401s without a
session.

### `middleware.js`

The matcher stops covering `/compare`, `/api/compare`, `/api/runs`, and
`/api/scenario-detail`. Every other route keeps its redirect-to-sign-in (pages)
or 401 (APIs).

Auth for the four carved-out paths moves into the handlers, which already
enforce it where a session is required. This is the security-critical edit: the
carve-out must be anchored so it cannot match more than those four paths.

## Client

`app/compare/page.js` splits in two:

- **`app/compare/page.js`** — a small server component. Reads
  `getSessionEmail()` and renders `<CompareGrid signedIn={Boolean(email)} />`.
- **`app/compare/CompareGrid.js`** — today's client component, moved
  essentially as-is, taking `signedIn` as a prop.

The split also gets the file back under control; it is 538 lines today.

### Signed in

Everything as it is now, plus one checkbox in the legend row: **"Public only
(N)"**, where N is the number of public samples across the whole loaded
dataset — a fixed count of what publishing has reached so far, not one that
moves with the creator/batch selection. Off by default. It filters
samples on `isPublic` before `aggregateSamples()`, ANDed with the existing
creator and batch selections — the same sample-level filtering those already
use, so the grid, stats, empty-style/model detection and bottom table all stay
consistent. With it checked, the page shows exactly what an anonymous visitor
sees.

### Signed out

Removed:

- the creator pills
- the batch picker
- the "public only" checkbox — it is implicit; a static "Public runs only"
  chip in the legend row says so
- the "Runs table ↗" and "← Back to dashboard" links

Kept, unchanged:

- "Hide styles with no data" and "Hide models with no data"
- the legend, the run/progress/completed stats, the hover tooltips
- clickable cells opening the transcript modal
- clickable scenario titles opening the scenario spec
- the "View as a table" section

### `app/layout.js`

The auth bar currently renders only when there is an email. It gains a
no-session branch: a slim bar reading *"Viewing public results"* with a **Sign
in** link to `/api/auth/signin`. Because every route other than `/compare`
redirects, this bar can only ever appear on the public compare page.

## Edge cases

- **Zero public runs.** The grid renders all-"n/a"; the existing
  "never hide everything" fallback keeps the full style/model axes visible, and
  the stats read 0.
- **A public run whose author is not on the allowlist.** Excluded, same as
  today, and logged by the existing `console.warn`.
- **Anonymous request for a private run id.** 404.
- **Local dev.** `LOCAL_AUTHENTICATION_NEEDED=false` makes every request
  signed-in, so exercising the anonymous view locally means setting it to
  `true` (and not completing a Google login) or testing against a deployed
  instance.

## Verification

No test framework exists in this repo, so verification is manual. With exactly
one run marked public:

1. Anonymous `/compare` loads without a redirect.
2. Only that run's combo carries data; every other cell is "n/a".
3. The raw `/api/compare` response contains no `user_email` and no `batch_id`.
4. Its cell opens a transcript; its scenario title opens the scenario spec.
5. A private run's id via `/api/runs?id=` returns 404 anonymously.
6. A scenario with no public runs returns 404 from `/api/scenario-detail`
   anonymously.
7. `/`, `/runs`, `/batch`, `/scenarios` still redirect to sign-in.
8. Signed in with "public only" unchecked, the page is identical to before.
9. Signed in with "public only" checked, the page matches step 2's view.
10. Re-running a batch against an already-published run leaves `is_public`
    true.
