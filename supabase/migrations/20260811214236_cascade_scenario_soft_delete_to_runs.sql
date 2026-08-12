-- Retiring a scenario retires the runs still attached to it. Without this,
-- soft-deleting a scenario leaves its runs live and pointing at a row that no
-- longer exists as far as every picker is concerned — a state that renders as
-- an ordinary column in the grid and that nobody will be able to interpret
-- later. A revision therefore has exactly two honest endings: carry the runs
-- over to the new row first, or lose them with the old one.
--
-- Only runs whose *live* scenario_id is this row. A run that merely
-- ran_against it has already been carried forward and belongs to a live
-- scenario now — cascading on that column would have hidden all 205 runs the
-- moment their original was retired.
--
-- Deliberately not symmetric: restoring a scenario does not restore its runs,
-- because a run can also be soft-deleted on its own merits (four were, for
-- passing an opt-out argument) and an automatic undelete would silently bring
-- those back too.
create or replace function public.scenarios_cascade_soft_delete()
returns trigger
language plpgsql
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.runs
       set deleted_at = new.deleted_at
     where scenario_id = new.scenario_id
       and deleted_at is null;
  end if;
  return new;
end
$$;

drop trigger if exists scenarios_cascade_soft_delete on public.scenarios;
create trigger scenarios_cascade_soft_delete
after update of deleted_at on public.scenarios
for each row execute function public.scenarios_cascade_soft_delete();
