alter table public.scenarios
  add column if not exists supersedes text,
  add column if not exists revised_at timestamptz,
  add column if not exists revision_note text;

comment on column public.scenarios.supersedes is
  'scenario_id of the row this one replaces. A revision never edits a scenario in place: it inserts a new row pointing back here and soft-deletes the old one, so the lineage is the chain of these pointers. Null for an original.';
comment on column public.scenarios.revised_at is
  'When this row superseded the one named in supersedes. Human-readable lineage only — never used to attribute a run to a version; runs.ran_against_scenario_id does that, because a batch can straddle a revision and a resumed run can span two.';
comment on column public.scenarios.revision_note is
  'What changed and, decisively, whether the earlier runs were carried over. They may be only when the revision leaves the stimulus intact (removing an unused opt-out). If the critical tool''s description changed, the model read something different: the old row stays live with its own runs instead of being superseded.';

alter table public.runs
  add column if not exists ran_against_scenario_id text;

comment on column public.runs.ran_against_scenario_id is
  'The scenario row this run actually executed against, set once and never changed. scenario_id moves to the live row when a revision carries runs over; this stays put. It indexes a fact the run already records — data.scenario_id, and the verbatim tool schemas in steps[].tools / direct_result.tools — rather than adding new information.';

update public.runs
set ran_against_scenario_id = coalesce(data->>'scenario_id', scenario_id)
where ran_against_scenario_id is null;
