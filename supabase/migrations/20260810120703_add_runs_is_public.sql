alter table public.runs
  add column is_public boolean not null default false;

comment on column public.runs.is_public is
  'Published to the signed-out /compare view. Set by hand in the Supabase table editor; no application code ever writes this column.';
