-- ============================================================
-- Long-term conversation memory (L2 summaries + L3 structured facts)
--
-- L1 (verbatim recent) lives in chat_messages.
-- L2 (rolling summary)  — one row per (creator, fan).
-- L3 (structured facts) — N rows per (creator, fan), with supersession.
-- ============================================================

-- ── L2: rolling summary per thread ─────────────────────────
create table if not exists public.conversation_summaries (
  id              bigint generated always as identity primary key,
  creator_uuid    text not null,
  fan_id          bigint not null,
  summary         text not null,
  last_message_id bigint references public.chat_messages(id),
  message_count_at_summary integer default 0,
  tokens_estimate integer,
  model_used      text,
  updated_at      timestamptz not null default now(),

  constraint conversation_summaries_thread_key unique (creator_uuid, fan_id)
);

create index if not exists idx_conv_summary_thread
  on public.conversation_summaries (creator_uuid, fan_id);

alter table public.conversation_summaries enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'conversation_summaries'
      and policyname = 'anon_read_conv_summaries'
  ) then
    create policy "anon_read_conv_summaries"
      on public.conversation_summaries
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;

-- ── L3: structured facts per thread, with supersession ─────
create table if not exists public.subscriber_facts (
  id                bigint generated always as identity primary key,
  creator_uuid      text not null,
  fan_id            bigint not null,
  key               text not null,
  value             text not null,
  category          text not null,            -- 'identity' | 'preference' | 'commerce' | 'emotional'
  confidence        numeric(3,2) not null default 0.70,
  source_message_id bigint references public.chat_messages(id),
  superseded_by     bigint references public.subscriber_facts(id),
  created_at        timestamptz not null default now()
);

-- Partial index: the hot-path fact lookup only wants live (non-superseded) rows
create index if not exists idx_facts_live
  on public.subscriber_facts (creator_uuid, fan_id, category)
  where superseded_by is null;

alter table public.subscriber_facts enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'subscriber_facts'
      and policyname = 'anon_read_subscriber_facts'
  ) then
    create policy "anon_read_subscriber_facts"
      on public.subscriber_facts
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;
