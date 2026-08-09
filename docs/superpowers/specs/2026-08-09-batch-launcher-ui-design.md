# Batch launcher UI — design

## Purpose

Sub-project 2 of the batch-execution work (sub-project 1: `docs/superpowers/specs/2026-08-09-batch-execution-infra-design.md`, done and deployed to dev). That project built the infrastructure to trigger a linear/chained batch from an HTTP call (`POST /api/batch/trigger`, already live and tested against real Cloud Run infra). This project is the actual UI: a page to configure and launch a batch, and watch it run.

## Scope

- Pipelines: linear and chained only — matches sub-project 1's scope exactly.
- One page, two states: a form to configure and launch, then a live-updating table of the batch that was just launched. No history of past batches on this page (`/runs` and `/compare` already cover that).
- No true Supabase Realtime — see "Why polling, not Realtime" below.

## Page: `/batch`

New route, `app/batch/page.js`, alongside the existing `/runs` and `/compare` pages, same nav pattern.

### Form

- **Pipeline**: radio, `linear` | `chained`.
- **Scenarios**: checkboxes, populated from `GET /api/scenarios` (already exists, returns `[{scenario_id, title, ...}]` from the Supabase `scenarios` table — scenarios moved there since sub-project 1 was designed, this just consumes what already exists).
- **Models**: checkboxes, populated from `MODEL_CATALOG.anthropic.models` in `lib/models.js` — **only the Anthropic provider**, not the full multi-provider catalog. Linear/chained batches only ever call Anthropic models today (the pipelines hardcode `provider: "anthropic"` throughout, and the Cloud Run job's image only has `ANTHROPIC_API_KEY`, no other provider keys) — offering a non-Anthropic model in this form would produce a batch that fails immediately.
- **Styles**: checkboxes, populated from `ARGUMENT_STYLES` (`lib/adversarial.js`) — keys as values, the description text as a label/tooltip.
- **Max turns**: number input, default 10 (matches `DEFAULT_MAX_TURNS` in the CLI scripts).
- **Budget**: number input (USD), default 15.
- **Batch ID**: text input, pre-filled with an auto-generated value (`${pipeline}_${new Date().toISOString().replace(/[:.]/g, "-")}`, same convention `scripts/batch-eval.js` already uses), editable.
- No `runAuthorEmail` field — taken from the signed-in session server-side (`getSessionEmail()` from `auth.js`, the same helper `app/api/scenarios/route.js`'s `POST` already uses), never trusted from the client.

Submit → `POST /api/batch/trigger` with `{ pipeline, models, scenarios, styles, maxTurns, budget, batchId }` (the route itself adds `runAuthorEmail` server-side before forwarding to the proxy — see "Changes to the existing trigger route" below). On success, the page switches to the live-tracking view for that `batchId`.

### Live tracking view

A table, one row per attempt (model × scenario × style combination the batch is sweeping), columns: model, scenario, style, status (pending/running/done/error), accepted (yes/no/—), cost. A header line above it: cumulative cost, overall batch status, and a "stalled" badge if applicable (see below).

Polls `GET /api/batch/status?batchId=<id>` every 3 seconds while the batch's overall status is not yet terminal (`done`, `error`, or `stalled`); stops polling once it reaches one of those.

## Why polling, not Realtime

Considered and rejected: true Supabase Realtime (a direct browser-to-Supabase WebSocket subscription using the publishable/anon key). Two problems, surfaced during design:

1. **RLS blocks it as designed.** `runs`/`batches` have RLS enabled with zero policies (intentional — see the runs-migration design doc's security section: the real access boundary is this app's Google-login allowlist, not Postgres RLS, since only the server, via `service_role`, ever touches these tables). A browser-side Realtime subscription authenticates as `anon`, which currently has no SELECT grant at all — it would just see nothing.
2. **Opening it up would leak the whole row, not just status.** RLS filters rows, not columns — a SELECT policy permissive enough for Realtime to work would expose every migrated run's full `data` blob (complete negotiation transcripts) to anyone holding the publishable key, which is not secret and ends up embedded in the client bundle. That's a real regression from the access boundary this app already committed to. A narrower fix (a Postgres view exposing only `id`/`status`) is possible but adds real complexity for a feature (sub-second push latency) nothing here actually needs.
3. **No Supabase Auth user.** This app's login is Google OAuth via NextAuth, not Supabase Auth — there's no `authenticated`-role Supabase session to scope a tighter policy to even if we wanted one.

Polling every 3 seconds through a normal, already-authenticated Next.js API route sidesteps all three: it reuses the exact access pattern `/api/runs` and `/api/compare` already use (server-side `service_role`, gated by the existing middleware), no new security surface, "feels live" at a 3-second granularity which is more than adequate for a batch that takes minutes.

## New route: `GET /api/batch/status`

`app/api/batch/status/route.js`. Query param: `batchId`. Auth: covered by existing `middleware.js` (every route already gated behind the Google-login allowlist) — no new auth logic in the route itself, same pattern as every other route added in the runs-migration work.

Reads the `batches` row for that id (`select data, updated_at from batches where id = $batchId`). If the row's `data.attempts` shows every attempt in a terminal state (`done` or `error`), the batch itself is `done`. Otherwise, if `updated_at` is older than `BATCH_STALE_THRESHOLD_MINUTES` (new env var, default `30`), the batch is `stalled` — and the route additionally writes back a correction: every attempt still marked `running`/`pending` in `data.attempts` gets set to `error` (with an error message noting the stall), so that `/compare`'s `anyRunning` flag and any other consumer of this data also stop reporting it as live, not just this page. Otherwise, the batch is `running`.

Response shape:
```json
{
  "batchId": "linear_2026-08-09T...",
  "status": "running",
  "cumulativeCost": 0.4821,
  "attempts": [
    { "id": "claude-sonnet-5|scenario_x|ethical", "model": "claude-sonnet-5", "scenario": "scenario_x", "style": "ethical", "status": "done", "accepted": true, "cost": 0.0512 }
  ]
}
```

This mirrors the shape `scripts/batch/{report,linear-report,chained-report}.js`'s `toRow()` already derive from the same `state.attempts` structure — reuses the existing field semantics (`status`, `accepted`, `cost`), just served over HTTP instead of printed to a console table.

## Schema change: `batches.updated_at`

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

No application code changes needed anywhere — every pipeline's `saveState()` already does a plain `upsert` on this table; the trigger fires on the `ON CONFLICT` update path Postgres treats identically to a normal `UPDATE`, so `updated_at` refreshes automatically on every turn across all four pipelines (base/linear/chained/steps), without touching any of those already-shipped files.

## Changes to the existing trigger route

`app/api/batch/trigger/route.js` (from sub-project 1) currently forwards the client's request body as-is, including `runAuthorEmail`. That must change: the route now reads the signed-in user's email server-side (`getSessionEmail()`) and injects it into the forwarded body itself, ignoring/overwriting any `runAuthorEmail` the client sent — the same "never trust the client for who's attributing this" principle `POST /api/save-run` already follows. The form (per the design above) never sends this field at all; the route fills it in.

## Out of scope

- True Realtime / sub-second updates (see above).
- A history view of past batches on this page.
- Any pipeline other than linear/chained.
- Changing the underlying batch pipelines' own logic — this only adds a UI and a read-side status endpoint on top of what sub-project 1 already ships.

## Testing plan

Manual, matching this project's practice:
1. Launch a small real batch (1 model, 1 scenario, 1 style) from the new form; confirm `POST /api/batch/trigger` fires (already proven to work end-to-end from sub-project 1) and the page switches to the tracking view.
2. Confirm the tracking view polls and shows the attempt moving from `pending`/`running` to `done`/`error`, with cost updating.
3. Confirm polling stops once the batch reaches a terminal state (check network tab / add a console log during dev, remove before shipping).
4. Manually set a batch's `updated_at` far in the past via SQL, confirm the status route reports `stalled` and corrects the row's attempt statuses.
5. Confirm `/compare` no longer shows a manually-staled batch as `anyRunning` after the status route has corrected it.
