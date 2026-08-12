alter table public.scenario_families
  add column is_public boolean not null default false;

comment on column public.scenario_families.is_public is
  'Published to the signed-out /families view. Set by hand in the Supabase table editor; no application code ever writes this column. Default false because most family descriptions paraphrase an unpublished Forethought draft — publishing one republishes their unreleased work, so it is a deliberate per-family decision.';

create index scenario_families_public_idx
  on public.scenario_families (is_public)
  where deleted_at is null;
