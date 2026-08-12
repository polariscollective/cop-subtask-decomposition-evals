alter table runs add column if not exists deleted_at timestamptz;

comment on column runs.deleted_at is 'Soft delete. Set to hide a run from every app read (compare grid and heatmap, runs explorer, transcript fetch, scenario publication check) without losing the transcript; set back to null to restore it. Batch bookkeeping (scripts/batch/*, /api/batch/status) deliberately ignores this column — it tracks attempts that ran, not the dataset.';

create index if not exists runs_deleted_at_idx on runs (deleted_at);
