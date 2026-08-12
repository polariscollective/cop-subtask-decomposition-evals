-- A grading is of a text, not of an id. Scenarios are replaced rather than
-- edited once runs exist against them, but before that they are edited freely
-- — and a grading taken before an edit describes wording that no longer
-- exists. Without this column, folding several gradings into a median would
-- silently mix verdicts on different texts, which is worse than one noisy
-- verdict.
--
-- Stale rows are kept: a grading of an earlier wording is still the record of
-- what that wording scored. Readers fold only the rows matching the scenario's
-- current updated_at.
alter table public.scenario_metrics
  add column if not exists graded_scenario_updated_at timestamptz;

comment on column public.scenario_metrics.graded_scenario_updated_at is
  'scenarios.updated_at at the moment this grading was taken. Rows whose value differs from the scenario''s current updated_at graded wording that has since changed, and must be excluded from the median rather than deleted.';

-- Backfill is deliberately NOT attempted: the existing rows predate the column
-- and predate the last rewrite, so any value invented here would be a guess
-- that reads as fact. Null means "unknown text", and readers treat it as stale.
