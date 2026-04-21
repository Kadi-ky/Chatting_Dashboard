-- ============================================================
-- 1. Tips income
-- ============================================================
create table if not exists public.tips_onlyfans (
  id           bigint generated always as identity primary key,
  event_id     text not null,
  creator_uuid text not null,
  fan_user_id  text,
  fan_name     text,
  fan_username text,
  amount_gross numeric(10,2) not null default 0,
  amount_net   numeric(10,2) not null default 0,
  tipped_at    timestamptz   not null,
  inserted_at  timestamptz   not null default now(),

  constraint tips_onlyfans_event_id_key unique (event_id)
);

create index if not exists idx_tips_creator_at
  on public.tips_onlyfans (creator_uuid, tipped_at desc);

-- ============================================================
-- 2. Subscription income (new + renewed events)
-- ============================================================
create table if not exists public.subscriptions_income_onlyfans (
  id            bigint generated always as identity primary key,
  event_id      text not null,
  creator_uuid  text not null,
  event_type    text not null,   -- 'new' | 'renewed'
  sub_type      text,            -- 'new_subscriber' | 'returning_subscriber'
  fan_user_id   text,
  fan_name      text,
  fan_username  text,
  amount        numeric(10,2) not null default 0,
  subscribed_at timestamptz   not null,
  inserted_at   timestamptz   not null default now(),

  constraint subscriptions_income_event_id_key unique (event_id)
);

create index if not exists idx_subincome_creator_at
  on public.subscriptions_income_onlyfans (creator_uuid, subscribed_at desc);

-- ============================================================
-- 3. RLS — browser clients read, only service-role writes
-- ============================================================
alter table public.tips_onlyfans enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'tips_onlyfans'
      and policyname = 'anon_read_tips'
  ) then
    create policy "anon_read_tips"
      on public.tips_onlyfans
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;

alter table public.subscriptions_income_onlyfans enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'subscriptions_income_onlyfans'
      and policyname = 'anon_read_subincome'
  ) then
    create policy "anon_read_subincome"
      on public.subscriptions_income_onlyfans
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;

-- ============================================================
-- 4. Enable Realtime on both tables
-- ============================================================
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tips_onlyfans'
  ) then
    alter publication supabase_realtime add table public.tips_onlyfans;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'subscriptions_income_onlyfans'
  ) then
    alter publication supabase_realtime add table public.subscriptions_income_onlyfans;
  end if;
end
$$;
