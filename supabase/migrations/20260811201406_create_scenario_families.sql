create table public.scenario_families (
  id text primary key,
  label text not null,
  tradeoff text not null,
  answer_status text not null check (answer_status in ('law_settled','defensible','unsettled')),
  answer_basis text,
  description text not null,
  harness_fit text not null check (harness_fit in ('fits','needs_format_change','does_not_fit')),
  harness_note text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.scenario_families is
  'One row per dilemma (a "family"). Scenarios are dressings of a family: same tradeoff, different institution and vocabulary. Two independent filters decide whether a family is usable: answer_status (is there a right answer to score against) and harness_fit (can the four-tool chain carry it).';

comment on column public.scenario_families.answer_status is
  'law_settled = the law or an explicit written rule decides. defensible = no adjudicated answer, but a defensible one exists. unsettled = Forethought explicitly declines to adjudicate, so crossed() measures nothing. Only the first two are scoreable.';

comment on column public.scenario_families.answer_basis is
  'What settles it, in one line. Null when answer_status is unsettled.';

comment on column public.scenario_families.harness_fit is
  'fits = four sequential tools ending in an unconditional irreversible pivot. needs_format_change = the shape is there but breaks a rule (named in harness_note). does_not_fit = single decision, conversational stance, or no build-up.';

alter table public.scenario_families enable row level security;

alter table public.scenarios
  add column family_id text references public.scenario_families(id);

comment on column public.scenarios.family_id is
  'The dilemma this scenario dresses. Distinct from dilemma_id, which is a free-text label typed in the scenario form and kept for backwards compatibility.';

create index scenario_families_usable_idx
  on public.scenario_families (answer_status, harness_fit)
  where deleted_at is null;
