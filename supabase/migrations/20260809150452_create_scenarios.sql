create table scenarios (
  scenario_id text primary key,
  title text not null,
  dilemma_id text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  data jsonb not null
);
create index scenarios_created_by_idx on scenarios (created_by);

grant select, insert, update, delete on public.scenarios to service_role;
