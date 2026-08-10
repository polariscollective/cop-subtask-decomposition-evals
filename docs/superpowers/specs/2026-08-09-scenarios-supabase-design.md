# Scenarios: local YAML files → Supabase, with a create/edit/copy UI — design

## Purpose

Scenarios (`scenarios/*.yaml`) are currently local files, loaded by
`lib/scenarios.js` via `fs`/`js-yaml`. That means creating or editing a
scenario requires editing a file and redeploying — no path for someone to
add a scenario through the app itself, and (same underlying problem the
`runs`/`batches` migration solved) local files don't survive on Vercel's
ephemeral, non-shared filesystem, so any in-app write path would need a real
datastore anyway.

This adds:
- A `scenarios` Supabase table, replacing the YAML files as the source of
  truth (same pattern as `runs`/`batches`).
- A `/scenarios` page to create, edit, copy, and soft-delete scenarios
  through the UI.
- A YAML upload path that pre-fills the same create form, so a hand-written
  YAML can still be the starting point without being the storage format.

## Approach: Supabase `jsonb`, not a normalized relational schema

Considered and rejected: separate `tools`/`metrics` tables with foreign keys
to `scenarios`. Rejected because a scenario is always read and written as a
whole (there is no query like "all tools where X" across scenarios) — an
`id`/`data jsonb` table exactly like `runs`/`batches` avoids joins for no
benefit, and keeps the same shape the app already knows how to work with
(`scenario.tools`, `scenario.goal.real`, etc., unchanged from today's parsed
YAML).

This isn't a new infrastructure decision requiring Terraform sign-off: it's
a new table in the Supabase project already provisioned for `runs`/`batches`
(`docs/superpowers/specs/2026-08-09-supabase-runs-migration-design.md`),
which itself established that Supabase falls outside this repo's
Terraform-managed GCP/Cloud Run set. Adding a table to an already-approved
database is an application-schema change, not new cloud infrastructure.

## Access pattern: server-only, no direct client access, no RLS

The browser never talks to Supabase directly — only to Next.js API routes,
which use `getSupabaseClient()` (`lib/supabase.js`, already exists) built
from `SUPABASE_SERVICE_ROLE_KEY` (server-only, bypasses RLS). All
authentication and authorization (signed in? are you the creator?) is
enforced in the API route code, not in Postgres policies — matching how
`runs`/`batches` already work. No RLS policies are added for this table:
they'd have no effect against the service-role key, and would be a second,
redundant place to keep permission logic in sync with the route code.

## Schema

```sql
create table scenarios (
  scenario_id text primary key,      -- user-chosen, e.g. "corporate_log_consolidation_v0"
  title text not null,
  dilemma_id text,
  created_by text not null,          -- user_email of whoever created THIS row
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,            -- soft delete: non-null = hidden from the picker/list
  data jsonb not null                -- full scenario doc, same shape as today's parsed YAML:
                                      -- { scenario_id, dilemma_id, title, context,
                                      --   goal: {real, test}, critical_tool, tools: [...] }
);
create index scenarios_created_by_idx on scenarios (created_by);

grant select, insert, update, delete on public.scenarios to service_role;
```

`scenario_id` is the primary key (not a separate uuid) because it's already
the identifier used everywhere else in the app (`runs.scenario_id`, batch
attempt matrices, `/api/scenario-detail?scenarioId=`) — keeping it as the
key avoids introducing a second id that would need mapping. It's user-typed
at creation and validated unique; it cannot be changed once a scenario
exists (see Editing, below), since changing it would silently orphan every
run that already references the old id.

The `grant` line is required — confirmed necessary for `runs`/`batches`
(`apply_migration` doesn't auto-grant table privileges the way Supabase
Studio's UI does; without it every `getSupabaseClient()` call 42501s).

Top-level promoted columns (`title`, `dilemma_id`, `created_by`,
`created_at`) exist purely so the `/scenarios` list and the existing
scenario picker can be rendered without parsing `data` — `data` remains the
single source of truth for everything else, same discipline as `runs`.

## Validation

One function, `validateScenarioDoc(doc)` in `lib/scenarios.js`, used by
every write path (`POST`, `PUT`, and the one-off migration script) — never
duplicated client-side as a second source of truth. Returns
`{ ok: true }` or `{ ok: false, errors: [{ field, message }] }`.

Rules:
- `scenario_id`, `title`, `context`, `goal.real`, `goal.test`,
  `critical_tool`: non-empty strings.
- `tools`: non-empty array. Each tool has a non-empty `name` (unique within
  the scenario), non-empty `description.real`/`description.test`, an
  `input` object (key → type, type ∈ `string | boolean | integer | array`,
  matching what `toolToAnthropicSchema` already accepts), and an `output`
  object (same key → type rules, plus one optional level of nesting — a
  field can be `"array of object"`, in which case it carries its own flat
  set of scalar sub-fields, matching the one level of nesting seen in both
  existing scenarios' `output.systems[]`-style shapes). No deeper nesting is
  supported by the form or validated beyond that level.
- `critical_tool` must equal the `name` of one of `tools`.
  (A `metrics` field was specified here originally and then dropped before
  this design shipped — nothing in the app ever read it, and the comparison
  numbers come from run data, not from the scenario doc. Stored docs that
  still carry the key are accepted; the write path strips it.)
- `scenario_id` uniqueness is checked against the table (not part of
  `validateScenarioDoc` itself, since it needs a database round trip) by the
  `POST` route before insert.

`toolToAnthropicSchema` (turns a tool's `input` into an Anthropic tool
schema) is unchanged — it's a pure function over an already-loaded scenario
object, unrelated to where that object came from.

## API routes

- `GET /api/scenarios` — list, `select scenario_id, title, dilemma_id,
  created_by, created_at where deleted_at is null`. Feeds both the existing
  scenario picker (`app/page.js`) and the new `/scenarios` list.
- `POST /api/scenarios` — create. Requires a session (`auth()`, same as
  `/api/save-run`); 401 if signed out. Runs `validateScenarioDoc`, checks
  `scenario_id` uniqueness, inserts with `created_by = session.user.email`.
  Returns `{ ok: true }` or `{ ok: false, errors }` (400).
- `GET /api/scenario-detail?scenarioId=` — unchanged response shape, now
  reads Supabase instead of parsing YAML. Also returns `created_by` (so the
  frontend can compute whether the current user may edit/delete) and
  `deleted` (boolean). Does **not** filter out soft-deleted scenarios — a
  historical run's "view scenario" must still work after its scenario is
  deleted.
- `PUT /api/scenario-detail?scenarioId=` — edit. 401 if signed out, 403 if
  `session.user.email !== created_by`. `scenario_id` in the body is ignored
  if present (immutable). Runs `validateScenarioDoc`, updates `data` +
  promoted columns + `updated_at`.
- `DELETE /api/scenario-detail?scenarioId=` — soft delete (`deleted_at =
  now()`). Same permission check as `PUT`.

No separate YAML-upload endpoint — parsing happens client-side (see below),
and the only save path is `POST`/`PUT`, already fully validated.

## Frontend

**`/scenarios`** (new page, same family as `/runs`, `/compare`): a table of
non-deleted scenarios (title, `dilemma_id`, creator, created date) with
per-row actions — **View**, **Copy** (anyone), **Edit** and **Delete**
(only when `session.user.email === created_by`). Page header has **Create
scenario** and **Upload YAML** buttons.

**`ScenarioForm`** — one component behind Create, Edit, and Copy, so there's
exactly one place that renders/validates the scenario shape in the UI:
- Top-level fields: `scenario_id` (disabled when editing), `title`,
  `dilemma_id`, `context`, `goal.real`, `goal.test`, `critical_tool` (a
  `<select>` populated from the tool names already entered below).
- `tools`: repeatable cards (add/remove). Each has `name`,
  `description.real`, `description.test`, and two repeatable key→type lists
  for `input` and `output` (the `output` list's type dropdown includes
  "array of object", which reveals a nested repeatable key→type list for
  that field's sub-fields — one level, matching validation above).
- **Save** calls `POST` (create/copy) or `PUT` (edit). Server-side errors
  (`errors[].field`) render inline next to the matching field/row.

**Upload YAML**: a file input parsed in the browser with `js-yaml` (already
a dependency — pure JS, works client-side). A parse error shows immediately,
no round trip. On success, opens `ScenarioForm` in Create mode pre-filled
from the parsed object; nothing is saved until the user reviews and clicks
Save, which goes through the same validated `POST` as manual creation.

**Copy**: fetches the full scenario via `GET /api/scenario-detail`, opens
`ScenarioForm` in Create mode pre-filled with everything except
`scenario_id` (cleared — must be re-entered) and `title` (suffixed with
" (copy)" as a hint). `created_by` on the resulting row is whoever clicks
Save, per the copy semantics decided for this feature — never the original
creator.

**Unchanged**: the scenario `<select>` on `app/page.js` and
`ScenarioDetailModal` (used from `/compare`) keep their current shape;
they're just backed by Supabase instead of the filesystem underneath
`/api/scenarios` and `/api/scenario-detail`.

## Migration and cutover

1. Apply the `scenarios` table migration (`mcp__supabase__apply_migration`).
2. One-off script `scripts/migrate-scenarios-to-supabase.js` (same shape as
   the existing `scripts/migrate-runs-to-supabase.js`): reads the 2 files in
   `scenarios/*.yaml`, runs them through `validateScenarioDoc`, inserts with
   `created_by = process.env.RUN_AUTHOR_EMAIL` (existing env var, no new one
   needed). Safe to re-run (skips ids already present, same
   already-migrated-lookup pattern as the runs migration script).
3. Rewrite `lib/scenarios.js`: `listScenarios`/`loadScenario` become `async`
   and query Supabase instead of `fs`/`js-yaml`; update every caller
   (`app/api/scenarios/route.js`, `app/api/scenario-detail/route.js`, and
   anywhere in `scripts/batch/*` / `scripts/batch-eval*.js` that loads a
   scenario by id) to `await` them.
4. Delete `scenarios/*.yaml` from the repo once the migration is verified
   (`mcp__supabase__execute_sql` shows both rows).
5. No new environment variables — `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
   already exist from the runs migration.

No dual-write fallback: once cut over, Supabase is the only source of truth
for scenarios, same discipline as `runs`/`batches`.

## Permissions summary

| Action | Who |
|---|---|
| View a scenario (list or detail, not deleted) | Any signed-in user |
| View a deleted scenario's detail (e.g. from an old run) | Any signed-in user |
| Create (manual, YAML upload, or copy) | Any signed-in user; becomes `created_by` |
| Edit | Only `created_by` |
| Soft delete | Only `created_by` |

## Out of scope

- Hard delete (only soft delete, per the decision that old runs must keep
  referencing their scenario).
- Deeper than one level of nesting in a tool's `output` schema — the 2
  existing scenarios don't need it; a future scenario that does would need
  the form extended or a raw-JSON fallback added.
- Scenario versioning/history (edits overwrite `data` in place; no audit
  trail beyond `updated_at`).
- Any change to `dilemma_id` semantics — it stays a free-text field, exactly
  as it is in the current YAML files.
