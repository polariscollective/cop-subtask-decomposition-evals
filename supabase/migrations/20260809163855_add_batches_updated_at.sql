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
