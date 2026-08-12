-- A table created by a migration does not pick up the grants the existing
-- tables got when they were created through the dashboard, so the app's
-- service-role client could not read it at all ("permission denied for table
-- scenario_families"). Granting exactly the set runs/scenarios/batches already
-- give service_role, and deliberately nothing to anon or authenticated —
-- neither has SELECT on any other table either. Every public read goes through
-- /api/families on the server, never straight from a browser.
grant select, insert, update, delete, references, trigger, truncate
  on table public.scenario_families to service_role;
