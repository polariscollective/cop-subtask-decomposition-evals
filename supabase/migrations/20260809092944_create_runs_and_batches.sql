create table runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_email text not null,
  scenario_id text not null,
  scenario_title text,
  framing text,
  source_plan_id text,
  batch_id text,
  description text,
  legacy_filename text unique,
  data jsonb not null
);
create index runs_user_email_idx on runs (user_email);
create index runs_batch_id_idx on runs (batch_id);
create index runs_source_plan_id_idx on runs (source_plan_id);

create table batches (
  id text primary key,
  created_at timestamptz not null default now(),
  user_email text not null,
  data jsonb not null
);
