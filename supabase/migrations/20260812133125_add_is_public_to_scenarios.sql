-- Publication becomes a conjunction that descends: a scenario is visible to an
-- anonymous reader only if its own flag is set AND its family's is, and a run
-- only if its flag is set AND both of its scenarios are visible.
--
-- Until now a scenario had no publication of its own — a published family
-- published its whole dressing set, and a published RUN unlocked its
-- scenario's full spec from below (app/api/scenario-detail's hasPublicRun).
-- Publication therefore flowed upward, decided by whoever published a run.
-- That was survivable with five scenarios in one family. It stops being
-- survivable the moment a generation sweep inserts machine-written candidates
-- into families that are already public: every one of them would be published
-- on landing, unread.
alter table public.scenarios
  add column if not exists is_public boolean not null default false;

comment on column public.scenarios.is_public is
  'Published to the signed-out /families listing and scenario detail. Necessary but not sufficient: the scenario''s family must be public too, and a run needs both of ITS scenarios public on top of its own flag. Set by hand in the Supabase table editor; no application code ever writes this column. Default false, so a newly created scenario — in particular a generated candidate — arrives unpublished.';

-- Backfill: everything an anonymous visitor can reach TODAY stays reachable.
-- The two clauses are the two rules being retired, applied once at the moment
-- they stop being rules — the family inheritance, and the published-run unlock.
--
-- The second clause matters more than it looks. All 232 runs point at a
-- soft-deleted _v0 row through ran_against_scenario_id, and a run is published
-- under both of its scenario ids or under neither. A backfill that skipped
-- retired rows would take the entire public grid dark the moment it ran.
-- deleted_at is deliberately not consulted here for the same reason it is not
-- consulted when the spec of a superseded scenario is served: a retired row is
-- the definition an older run actually saw.
update public.scenarios s
set is_public = true
where exists (
        select 1 from public.scenario_families f
        where f.id = s.family_id and f.is_public and f.deleted_at is null
      )
   or exists (
        select 1 from public.runs r
        where r.is_public
          and r.deleted_at is null
          and (r.scenario_id = s.scenario_id or r.ran_against_scenario_id = s.scenario_id)
      );
