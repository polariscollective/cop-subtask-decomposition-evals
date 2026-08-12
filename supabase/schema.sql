-- Schema of the Supabase project behind this app, as it stands on
-- 12 August 2026. Reconstructed from the live database's catalog, not written
-- by hand, so it reflects what is actually deployed rather than what anyone
-- remembers deploying.
--
-- NOT THE SOURCE OF TRUTH. `supabase/migrations/` is. Those twenty files were
-- recovered from the remote project's own migration history and verified
-- byte-for-byte against it, so `supabase migration list --linked` now matches
-- 20/20 and `db push` reports nothing pending. Change the schema by writing a
-- migration; this file is a flattened snapshot for reading, and it will go
-- stale the moment someone forgets to regenerate it.
--
-- WHY IT EXISTS ANYWAY. Replaying twenty migrations in your head to answer
-- "what columns does `runs` have" is not a good use of anyone's afternoon. It
-- also records two things no migration contains: the RLS state, and the
-- `ensure_rls` event trigger that produces it (see below).
--
-- KNOWN LIMIT: this covers the `public` schema only — tables, constraints,
-- indexes, functions, triggers, RLS state, grants and comments. It does not
-- carry Supabase's own schemas (auth, storage, realtime), the roles
-- themselves, or any data. Restoring from it gives you an empty, correctly
-- shaped database.

-- ---------------------------------------------------------------------------
-- A note on RLS, because it is not what it looks like
--
-- Every table below has row level security ENABLED and ZERO policies. That
-- combination denies everything to `anon` and `authenticated`. The app works
-- regardless because it connects with the service-role key, which bypasses RLS
-- entirely.
--
-- So access control here rests on two things, and RLS is neither: the secrecy
-- of the service-role key, and the checks the app performs itself
-- (`lib/public-paths.js`, and the per-route publication filters in
-- `/api/compare`, `/api/families`, `/api/scenario-detail`). A leaked key has no
-- net beneath it.
--
-- The RLS was not enabled by any migration. An event trigger, `ensure_rls`,
-- fires on every CREATE TABLE in `public` and enables it automatically — see
-- the function at the end of this file. Worth knowing before assuming a fresh
-- project would behave the same way.
-- ---------------------------------------------------------------------------


-- ============================================================ tables

create table public.runs (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now() not null,
  user_email text not null,
  scenario_id text not null,
  scenario_title text,
  framing text,
  source_plan_id text,
  batch_id text,
  description text,
  legacy_filename text,
  data jsonb not null,
  style text,
  is_public boolean default false not null,
  deleted_at timestamp with time zone,
  ran_against_scenario_id text
);

create table public.batches (
  id text not null,
  created_at timestamp with time zone default now() not null,
  user_email text not null,
  data jsonb not null,
  updated_at timestamp with time zone default now() not null
);

create table public.scenarios (
  scenario_id text not null,
  title text not null,
  dilemma_id text,
  created_by text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  data jsonb not null,
  family_id text,
  supersedes text,
  revised_at timestamp with time zone,
  revision_note text,
  is_public boolean default false not null
);

create table public.scenario_families (
  id text not null,
  label text not null,
  tradeoff text not null,
  answer_status text not null,
  answer_basis text,
  description text not null,
  harness_fit text not null,
  harness_note text,
  source text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deleted_at timestamp with time zone,
  is_public boolean default false not null
);

create table public.scenario_metrics (
  id uuid default gen_random_uuid() not null,
  scenario_id text not null,
  judge_model text not null,
  judge_provider text,
  dimensions jsonb default '{}'::jsonb not null,
  legibility jsonb,
  cost numeric,
  created_at timestamp with time zone default now() not null,
  created_by text,
  graded_scenario_updated_at timestamp with time zone
);


-- ============================================================ constraints

alter table public.runs add constraint runs_pkey primary key (id);
alter table public.runs add constraint runs_legacy_filename_key unique (legacy_filename);

alter table public.batches add constraint batches_pkey primary key (id);

alter table public.scenarios add constraint scenarios_pkey primary key (scenario_id);
alter table public.scenarios add constraint scenarios_family_id_fkey
  foreign key (family_id) references public.scenario_families(id);

alter table public.scenario_families add constraint scenario_families_pkey primary key (id);
alter table public.scenario_families add constraint scenario_families_answer_status_check
  check (answer_status = any (array['settled_by_law'::text, 'settled_by_judgement'::text, 'contested'::text]));
alter table public.scenario_families add constraint scenario_families_harness_fit_check
  check (harness_fit = any (array['fits'::text, 'needs_harness_change'::text, 'does_not_fit'::text]));

alter table public.scenario_metrics add constraint scenario_metrics_pkey primary key (id);
alter table public.scenario_metrics add constraint scenario_metrics_scenario_id_fkey
  foreign key (scenario_id) references public.scenarios(scenario_id);


-- ============================================================ indexes

create index runs_user_email_idx     on public.runs using btree (user_email);
create index runs_batch_id_idx       on public.runs using btree (batch_id);
create index runs_source_plan_id_idx on public.runs using btree (source_plan_id);
create index runs_deleted_at_idx     on public.runs using btree (deleted_at);

create index scenarios_created_by_idx on public.scenarios using btree (created_by);

create index scenario_families_public_idx on public.scenario_families using btree (is_public)
  where (deleted_at is null);
create index scenario_families_usable_idx on public.scenario_families using btree (answer_status, harness_fit)
  where (deleted_at is null);

create index scenario_metrics_scenario_idx on public.scenario_metrics using btree (scenario_id, created_at desc);


-- ============================================================ functions

create or replace function public.set_updated_at()
returns trigger language plpgsql as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

-- Pins the version a run actually executed against. Set on insert and held
-- against every later update, so no write path can forget it and no UPDATE can
-- rewrite it — which is what lets a revision move `scenario_id` forward without
-- losing which definition the model was shown.
create or replace function public.runs_pin_ran_against_scenario()
returns trigger language plpgsql as $function$
begin
  if tg_op = 'INSERT' then
    new.ran_against_scenario_id :=
      coalesce(new.ran_against_scenario_id, new.data->>'scenario_id', new.scenario_id);
  else
    new.ran_against_scenario_id :=
      coalesce(old.ran_against_scenario_id, new.ran_against_scenario_id, new.data->>'scenario_id', new.scenario_id);
  end if;
  return new;
end
$function$;

-- Retiring a scenario retires the runs still pointing at it. Bans the one state
-- that would be unreadable later: live runs on a retired scenario still render
-- as an ordinary column in the grid, because the grid groups on
-- runs.scenario_id and never looks at the scenario row.
--
-- Deliberately not symmetric — restoring a scenario does not restore its runs,
-- since a run can also have been retired on its own merits.
create or replace function public.scenarios_cascade_soft_delete()
returns trigger language plpgsql as $function$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.runs
       set deleted_at = new.deleted_at
     where scenario_id = new.scenario_id
       and deleted_at is null;
  end if;
  return new;
end
$function$;


-- ============================================================ triggers

create trigger batches_set_updated_at
  before update on public.batches
  for each row execute function public.set_updated_at();

create trigger runs_pin_ran_against_scenario
  before insert or update on public.runs
  for each row execute function public.runs_pin_ran_against_scenario();

create trigger scenarios_cascade_soft_delete
  after update of deleted_at on public.scenarios
  for each row execute function public.scenarios_cascade_soft_delete();


-- ============================================================ row level security

-- Enabled on all five, with no policies. See the note at the top of this file:
-- this denies anon and authenticated everything, and the app reaches the data
-- with the service-role key, which bypasses RLS.
alter table public.runs              enable row level security;
alter table public.batches           enable row level security;
alter table public.scenarios         enable row level security;
alter table public.scenario_families enable row level security;
alter table public.scenario_metrics  enable row level security;


-- ============================================================ grants

-- service_role is what the app uses. anon and authenticated get only the
-- Supabase defaults, which carry no read or write.
grant delete, insert, references, select, trigger, truncate, update on table public.runs              to service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.batches           to service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.scenarios         to service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.scenario_families to service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.scenario_metrics  to service_role;

grant references, trigger, truncate on table public.runs              to anon, authenticated;
grant references, trigger, truncate on table public.batches           to anon, authenticated;
grant references, trigger, truncate on table public.scenarios         to anon, authenticated;
grant references, trigger, truncate on table public.scenario_families to anon, authenticated;
grant references, trigger, truncate on table public.scenario_metrics  to anon, authenticated;


-- ============================================================ comments

comment on column public.runs.is_public is
  'Published to the signed-out / view. Set by hand in the Supabase table editor; no application code ever writes this column.';

comment on column public.runs.deleted_at is
  'Soft delete. Set to hide a run from every app read (compare grid and heatmap, runs explorer, transcript fetch, scenario publication check) without losing the transcript; set back to null to restore it. Batch bookkeeping (scripts/batch/*, /api/batch/status) deliberately ignores this column — it tracks attempts that ran, not the dataset.';

comment on column public.runs.ran_against_scenario_id is
  'The scenario row this run actually executed against, set once and never changed. scenario_id moves to the live row when a revision carries runs over; this stays put. It indexes a fact the run already records — data.scenario_id, and the verbatim tool schemas in steps[].tools / direct_result.tools — rather than adding new information.';

comment on column public.scenarios.family_id is
  'The hard case this scenario dresses. Distinct from dilemma_id, which is a free-text label typed in the scenario form and kept for backwards compatibility.';

comment on column public.scenarios.supersedes is
  'scenario_id of the row this one replaces. A revision never edits a scenario in place: it inserts a new row pointing back here and soft-deletes the old one, so the lineage is the chain of these pointers. Null for an original.';

comment on column public.scenarios.revised_at is
  'When this row superseded the one named in supersedes. Human-readable lineage only — never used to attribute a run to a version; runs.ran_against_scenario_id does that, because a batch can straddle a revision and a resumed run can span two.';

comment on column public.scenarios.is_public is
  'Published to the signed-out /families listing and scenario detail. Necessary but not sufficient: the scenario''s family must be public too, and a run needs both of ITS scenarios public on top of its own flag. Set by hand in the Supabase table editor; no application code ever writes this column. Default false, so a newly created scenario — in particular a generated candidate — arrives unpublished.';

comment on column public.scenarios.revision_note is
  'What changed and, decisively, whether the earlier runs were carried over. They may be only when the revision leaves the stimulus intact (removing an unused opt-out). If the critical tool''s description changed, the model read something different: the old row stays live with its own runs instead of being superseded.';

comment on table public.scenario_families is
  'One row per hard case (a "family"). Scenarios are dressings of a family: same tradeoff, different institution and vocabulary. Two independent filters decide whether a family is usable: answer_status (is there a right answer to score against) and harness_fit (can the four-tool chain carry it).';

comment on column public.scenario_families.answer_status is
  'What makes the wrong answer wrong. settled_by_law = a statute or written rule decides, and you can cite it. settled_by_judgement = there IS a right answer, but it rests on a judgement about the consequence (an irreversible loss of a control point) rather than a text. Both are scoreable. contested = Forethought poses it as a political question and declines to adjudicate, so crossed() would measure nothing — recorded here, deliberately not run.';

comment on column public.scenario_families.answer_basis is
  'What settles it, in one line. Null when answer_status is contested.';

comment on column public.scenario_families.harness_fit is
  'Whether the four-tool chain can carry it. fits = runnable as-is. needs_harness_change = the scenario is fine, the harness is not; the specific rule is named in harness_note. does_not_fit = a single decision or a conversational stance, with no build-up to decompose.';

comment on column public.scenario_families.is_public is
  'Published to the signed-out /families view. Set by hand in the Supabase table editor; no application code ever writes this column. Default false because most family descriptions paraphrase an unpublished Forethought draft — publishing one republishes their unreleased work, so it is a deliberate per-family decision.';

comment on table public.scenario_metrics is
  'One row per grading of a scenario. Never updated in place — a re-grade is a new row, so a judge disagreeing with an earlier one is visible rather than silently overwritten.';

comment on column public.scenario_metrics.graded_scenario_updated_at is
  'scenarios.updated_at at the moment this grading was taken. Rows whose value differs from the scenario''s current updated_at graded wording that has since changed, and must be excluded from the median rather than deleted.';


-- ============================================================ platform: the RLS event trigger
--
-- Not ours, and not created by any migration in this project's history. It is
-- why every table above has RLS on without a migration saying so. Recorded here
-- because a fresh project without it would behave differently.
--
--   create event trigger ensure_rls
--     on ddl_command_end
--     execute function public.rls_auto_enable();
--
-- rls_auto_enable() runs `alter table ... enable row level security` on every
-- CREATE TABLE in `public`.
