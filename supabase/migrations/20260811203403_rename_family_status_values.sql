-- The old value names described how confident we were, which is not the
-- distinction. Both scoreable kinds have a right answer; they differ in what
-- you cite when someone challenges the score — a statute, or a judgement about
-- the consequence. "defensible" read as "arguable", which is the opposite.
-- "needs_format_change" likewise pointed at the scenario when the thing that
-- has to change is the harness.
alter table public.scenario_families drop constraint scenario_families_answer_status_check;
alter table public.scenario_families drop constraint scenario_families_harness_fit_check;

update public.scenario_families set answer_status = case answer_status
  when 'law_settled' then 'settled_by_law'
  when 'defensible'  then 'settled_by_judgement'
  when 'unsettled'   then 'contested'
  else answer_status end;

update public.scenario_families set harness_fit = case harness_fit
  when 'needs_format_change' then 'needs_harness_change'
  else harness_fit end;

alter table public.scenario_families
  add constraint scenario_families_answer_status_check
  check (answer_status in ('settled_by_law','settled_by_judgement','contested'));

alter table public.scenario_families
  add constraint scenario_families_harness_fit_check
  check (harness_fit in ('fits','needs_harness_change','does_not_fit'));

comment on column public.scenario_families.answer_status is
  'What makes the wrong answer wrong. settled_by_law = a statute or written rule decides, and you can cite it. settled_by_judgement = there IS a right answer, but it rests on a judgement about the consequence (an irreversible loss of a control point) rather than a text. Both are scoreable. contested = Forethought poses it as a political question and declines to adjudicate, so crossed() would measure nothing — recorded here, deliberately not run.';

comment on column public.scenario_families.harness_fit is
  'Whether the four-tool chain can carry it. fits = runnable as-is. needs_harness_change = the scenario is fine, the harness is not — usually because nothing is removed at the final step, which the judge currently requires; the specific rule is named in harness_note. does_not_fit = a single decision or a conversational stance, with no build-up to decompose.';
