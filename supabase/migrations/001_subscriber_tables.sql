-- ============================================================
-- 1. Creator ↔ OnlyFans Account mapping
-- ============================================================
create table if not exists public.creator_onlyfans_accounts (
  id            bigint generated always as identity primary key,
  creator_uuid  text        not null,
  creator_name  text,
  onlyfans_account_id text  not null,          -- e.g. "acct_XXXXXXXXXXXXXXX"
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint creator_onlyfans_accounts_creator_uuid_key unique (creator_uuid)
);

create index if not exists idx_coa_account_id
  on public.creator_onlyfans_accounts (onlyfans_account_id);

-- ============================================================
-- 2. Current-state subscriber roster
-- ============================================================
create table if not exists public.onlyfans_subscribers (
  id               bigint generated always as identity primary key,
  creator_uuid     text        not null,
  onlyfans_account_id text     not null,
  fan_id           bigint      not null,       -- OnlyFans user id
  name             text,
  username         text,
  avatar           text,
  is_active        boolean     not null default true,
  subscribed_on    timestamptz,
  expires_at       timestamptz,
  subscribe_price  numeric(10,2),
  total_spent      numeric(10,2) default 0,
  last_seen_at     timestamptz,
  subscription_status text,                    -- e.g. "active", "expired", "Set to Expire"
  last_source      text        not null default 'reset',  -- 'reset' | 'webhook'
  last_reset_at    timestamptz,
  updated_at       timestamptz not null default now(),

  constraint onlyfans_subscribers_creator_fan_key unique (creator_uuid, fan_id)
);

create index if not exists idx_os_creator on public.onlyfans_subscribers (creator_uuid);
create index if not exists idx_os_active  on public.onlyfans_subscribers (creator_uuid, is_active);

-- ============================================================
-- 3. Sync-run audit log
-- ============================================================
create table if not exists public.onlyfans_subscriber_sync_runs (
  id            bigint generated always as identity primary key,
  creator_uuid  text        not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  fan_count     integer     default 0,
  page_count    integer     default 0,
  status        text        not null default 'running',  -- 'running' | 'success' | 'error'
  error_message text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_ossr_creator
  on public.onlyfans_subscriber_sync_runs (creator_uuid, started_at desc);

-- ============================================================
-- 4. Enable Realtime on the subscribers table
-- ============================================================
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'onlyfans_subscribers'
  ) then
    alter publication supabase_realtime add table public.onlyfans_subscribers;
  end if;
end
$$;

-- ============================================================
-- 5. RLS — browser clients can read, only service-role can write
-- ============================================================
alter table public.onlyfans_subscribers enable row level security;
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'onlyfans_subscribers'
      and policyname = 'anon_read_subscribers'
  ) then
    create policy "anon_read_subscribers"
      on public.onlyfans_subscribers
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;

-- Writes go through Edge Functions using the service_role key,
-- which bypasses RLS automatically.

alter table public.creator_onlyfans_accounts enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'creator_onlyfans_accounts'
      and policyname = 'anon_read_creator_accounts'
  ) then
    create policy "anon_read_creator_accounts"
      on public.creator_onlyfans_accounts
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;

alter table public.onlyfans_subscriber_sync_runs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'onlyfans_subscriber_sync_runs'
      and policyname = 'anon_read_sync_runs'
  ) then
    create policy "anon_read_sync_runs"
      on public.onlyfans_subscriber_sync_runs
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;

-- ============================================================
-- 6. Cron job — runs daily at midnight UTC
--    Requires pg_cron + pg_net extensions (enabled in Supabase)
--    Adjust the URL to your Edge Function URL after deployment.
-- ============================================================
-- Uncomment after deploying the Edge Function and replacing the URL:
--
-- select cron.schedule(
--   'daily-subscriber-reset',
--   '0 0 * * *',  -- midnight UTC; adjust timezone as needed
--   $$
--   select net.http_post(
--     url := 'https://afsxspzcofonavdgmeyf.supabase.co/functions/v1/subscriber-reset',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
--       'Content-Type', 'application/json'
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );
