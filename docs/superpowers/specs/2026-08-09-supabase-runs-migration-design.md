# Runs storage: local JSON files → Supabase — design

## Purpose

Saved runs (`runs/*.json`, `runs/batches/*.json`) currently live only on the
local filesystem. That works while the app runs on a laptop, but the app is
deployed on Vercel, whose filesystem is ephemeral and not shared across
invocations — nothing written by one request is guaranteed to be readable by
the next. Moving runs to a real datastore is what actually makes "browse
saved runs" work as a deployed feature, not just a local dev tool.

This also adds a requirement that didn't exist before: every run must record
*who* ran it, so runs can eventually be filtered by author.

## Approach: Supabase (Postgres), not a GCS bucket

Considered and rejected: a GCS bucket, provisioned through Terraform per
`polaris-tf/README.md` (this repo's `CLAUDE.md` requires infra decisions to
go through Terraform). Rejected because:
- Filtering by author is a query need, not a blob-storage need — Postgres
  gives it for free (`WHERE user_email = ...`); GCS would mean listing every
  object and filtering in application code, same as today's file-scan but
  over the network.
- Access from Vercel would need either a service-account JSON key (against
  the "no JSON keys anywhere" principle stated in the Terraform README) or a
  Vercel↔GCP OIDC federation setup — meaningfully more setup than a single
  Supabase API key in a server-only env var.
- This app is already outside the Terraform-managed GCP/Cloud Run set (see
  `docs/superpowers/specs/2026-08-06-google-login-allowlist-design.md`,
  which made the same call for the Google OAuth client). Supabase isn't GCP
  infrastructure, so it doesn't fall under the Terraform-first mandate
  either — consistent with that existing precedent, not an exception to it.

Run sizes today (89 files, 8.2M total, largest ~200KB) fit comfortably in a
Postgres `jsonb` column, so there's no need for a separate blob store
alongside the database — one system, not two.

## Schema

Two tables, created via Supabase migrations (not hand-run SQL):

```sql
create table runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_email text not null,
  scenario_id text not null,
  scenario_title text,
  framing text,
  source_plan_id text,      -- chain linkage: which plan this execution continues
  batch_id text,
  description text,
  legacy_filename text unique,  -- original runs/*.json filename, migrated rows only
  data jsonb not null       -- { direct_result, plan_result, steps } — same shape as today's file body
);
create index runs_user_email_idx on runs (user_email);
create index runs_batch_id_idx on runs (batch_id);
create index runs_source_plan_id_idx on runs (source_plan_id);

create table batches (
  id text primary key,      -- today's batch_id / filename stem
  created_at timestamptz not null default now(),
  user_email text not null,
  data jsonb not null
);
```

Only the columns actually needed for filtering/joining are promoted out of
the JSON; everything else (`model`, `argument_style`, `cost`, `accepted`,
step bookkeeping) stays inside `data` exactly as it's shaped today, and
`/api/runs`'s existing derivation logic (leaf detection, chain grouping,
step outcome) runs unchanged after fetching rows — no duplicating that logic
into SQL.

## Writers: how `user_email` gets set

- **Web app** (`/api/save-run`): pulled from the Auth.js session
  (`await auth()`), never trusted from the client. Every interactive save is
  already behind login (see the Google-login design doc), so this is always
  available.
- **Batch scripts** (`scripts/batch/*`, run from a developer's machine, no
  Auth.js session): a new required env var, `RUN_AUTHOR_EMAIL`, read at
  startup. The script fails fast with a clear error if it's unset — no
  silent "unknown" author.

## Components touched

- **New**: `lib/supabase.js` — a Supabase client built from
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (server-only env vars, no
  `NEXT_PUBLIC_` prefix, same secrecy discipline as the existing
  `ANTHROPIC_API_KEY`). Used by both Next.js routes and standalone Node
  scripts — it's a plain npm package, nothing Next-specific.
- `app/api/save-run/route.js` — insert a row instead of `fs.writeFileSync`.
- `app/api/runs/route.js` — `select * from runs` (optionally filtered by
  `user_email` query param) instead of `fs.readdirSync` + per-file read;
  everything downstream of that (summary computation) is unchanged.
- `app/api/compare/route.js` — same swap, reads instead of file-walking.
- `scripts/batch/{runfile,chained-runfile,linear-runfile,steps-runfile}.js`
  — write via the Supabase client instead of `fs.writeFileSync`.
- `scripts/batch/{state,chained-state,linear-state,steps-state}.js` — read
  via the Supabase client instead of `fs.readFileSync`/`readdirSync`.
- Any other `scripts/batch/*` reading `RUNS_DIR` directly (e.g. `cost.js`,
  `report.js`) — full enumeration happens during planning, not here.
- `.env.example` — add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `RUN_AUTHOR_EMAIL`.
- `package.json` — add `@supabase/supabase-js`.

No dual-write fallback to local files: once cut over, Supabase is the only
source of truth. A write failure (network, auth) surfaces as a clear error
rather than silently falling back — matching how the rest of this app
already treats its API keys as required, not optional.

## Migration of existing local runs

One-off script, `scripts/migrate-runs-to-supabase.js`:
- Reads every `runs/*.json` (89 files) and `runs/batches/*.json` (9 files).
- Inserts each into `runs` / `batches` with `user_email =
  'sam@polariscollective.org'`, `created_at` taken from the file's
  `saved_at`, and `legacy_filename` set to the original filename.
- The `unique` constraint on `legacy_filename` makes the script safe to
  re-run: a second pass skips rows already migrated instead of duplicating
  them.
- `runs_backup_20260807_002806/` is a separate manual backup and is out of
  scope — left untouched on disk.
- `runs/` is already gitignored, so nothing here touches git history.

After migration is verified (row counts match file counts, a few rows
spot-checked against their source file), the local `runs/*.json` files are
left in place as a cold backup rather than deleted — cheap insurance, no
reason to remove them immediately.

## Out of scope

- A UI control for filtering the runs list by author — this design makes
  filtering *possible* (`user_email` is a real column, `/api/runs` accepts a
  query param for it) but doesn't add the dropdown/filter UI in
  `app/runs/page.js`. Follow-up.
- Row-level security / per-user access control in Supabase — the service
  role key already bypasses RLS, and access to the app itself is gated by
  the existing Google-login allowlist, so this isn't adding a new exposure.
- Deleting or archiving the local `runs/` directory.

## Testing plan

Manual, matching this project's existing practice (no automated suite):
1. Run the migration script against the new Supabase project; confirm row
   counts match `ls runs | wc -l` / `ls runs/batches | wc -l`.
2. Locally: save a new run through the UI, confirm it appears in
   `/api/runs` and in the "Browse saved runs" page, with the signed-in
   user's email attached.
3. Run one batch script (e.g. `scripts/batch-eval-linear.js`) against
   Supabase with `RUN_AUTHOR_EMAIL` set; confirm the resulting rows show up
   alongside the migrated ones.
4. Unset `RUN_AUTHOR_EMAIL` and confirm the batch script fails fast with a
   clear error instead of writing an unattributed row.
5. Deploy to Vercel with `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` set;
   confirm the deployed app can save and browse runs.
