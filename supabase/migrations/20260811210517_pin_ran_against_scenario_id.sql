-- ran_against_scenario_id is provenance: it must be set on every insert and
-- must never move afterwards. Leaving that to the five write paths that
-- create runs (POST /api/save-run and the four scripts/batch/*-runfile.js)
-- would mean a sixth one silently writing null, and a stray UPDATE quietly
-- rewriting history. Both are database invariants, so they live here.
--
-- The batch runners upsert, so the UPDATE branch matters: a resumed attempt
-- re-writes its row many times and must keep the id it first ran against.
-- To correct the column deliberately (a data migration, say), disable this
-- trigger for the statement rather than working around it.
create or replace function public.runs_pin_ran_against_scenario()
returns trigger
language plpgsql
as $$
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
$$;

drop trigger if exists runs_pin_ran_against_scenario on public.runs;
create trigger runs_pin_ran_against_scenario
before insert or update on public.runs
for each row execute function public.runs_pin_ran_against_scenario();
