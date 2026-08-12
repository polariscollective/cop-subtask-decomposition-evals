-- Judge output was never persisted: it lived in the generate screen and died
-- the moment a candidate was promoted into the form. So the bank carries no
-- record of why any scenario was considered good enough to keep.
--
-- A table rather than a column on `scenarios`, because a scenario can be graded
-- more than once and the differences are the point: by a second judge from
-- another model family (F-08, guarding against the generator and judge sharing
-- a bias), or again after the scenario is revised. One row per grading, never
-- overwritten.
create table public.scenario_metrics (
  id uuid primary key default gen_random_uuid(),
  scenario_id text not null references public.scenarios(scenario_id),
  judge_model text not null,
  judge_provider text,
  -- {dimension_key: {score, rationale}} — the five in lib/judge-dimensions.js.
  dimensions jsonb not null default '{}'::jsonb,
  -- [{step, toolName, score, rationale}] — the blind-view profile (F-11).
  -- Separate from `dimensions` because it is produced by a different pass with
  -- a deliberately restricted prompt, and conflating them would invite reading
  -- it as a sixth dimension of the same judgement. It is not: the dimensions
  -- are scored with the whole scenario in view, this is scored with one step in
  -- view and nothing else.
  legibility jsonb,
  cost numeric,
  created_at timestamptz not null default now(),
  created_by text
);

comment on table public.scenario_metrics is
  'One row per grading of a scenario. Never updated in place — a re-grade is a new row, so a judge disagreeing with an earlier one is visible rather than silently overwritten.';

alter table public.scenario_metrics enable row level security;

grant select, insert, update, delete, references, trigger, truncate
  on table public.scenario_metrics to service_role;

create index scenario_metrics_scenario_idx
  on public.scenario_metrics (scenario_id, created_at desc);
