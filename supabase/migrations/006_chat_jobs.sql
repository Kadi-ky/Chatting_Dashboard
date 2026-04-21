-- ============================================================
-- chat_jobs — Postgres-native queue for chat processing work
--
-- Producers:  chat-inbound (kind='respond')
-- Consumers:  chat-worker  (FOR UPDATE SKIP LOCKED)
--
-- Future kinds (not used in Phase 1): 'summarize', 'extract_facts', 'send'
-- ============================================================
create table if not exists public.chat_jobs (
  id            bigint generated always as identity primary key,
  kind          text        not null,
  payload       jsonb       not null default '{}'::jsonb,
  run_after     timestamptz not null default now(),
  locked_until  timestamptz,
  attempts      integer     not null default 0,
  status        text        not null default 'pending',  -- 'pending' | 'done' | 'failed'
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Partial index — workers only scan pending rows
create index if not exists idx_chat_jobs_pending
  on public.chat_jobs (run_after)
  where status = 'pending';

alter table public.chat_jobs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_jobs'
      and policyname = 'anon_read_chat_jobs'
  ) then
    create policy "anon_read_chat_jobs"
      on public.chat_jobs
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;
