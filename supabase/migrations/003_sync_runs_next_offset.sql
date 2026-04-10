-- ============================================================
-- Add next_offset column to support incremental/chunked sync
-- ============================================================
alter table public.onlyfans_subscriber_sync_runs
  add column if not exists next_offset integer not null default 0;

-- Index for quickly finding today's running sync per creator
create index if not exists idx_ossr_creator_status_date
  on public.onlyfans_subscriber_sync_runs (creator_uuid, status, started_at desc);
