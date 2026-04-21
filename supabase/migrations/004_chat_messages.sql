-- ============================================================
-- Chat messages — full conversation history (inbound + outbound)
--
-- Written by:
--   chat-inbound  (direction='in',  status='received')
--   chat-worker   (direction='out', status='drafted')
--   chat-sender   (Phase 2: updates status → 'sent' / 'failed')
-- ============================================================
create table if not exists public.chat_messages (
  id                  bigint generated always as identity primary key,
  creator_uuid        text        not null,
  fan_id              bigint      not null,
  onlyfans_account_id text        not null,

  -- 'in'  = fan → model,   'out' = model/creator → fan
  direction           text        not null,
  -- OpenAI-style role, used directly when building the Grok message array
  role                text        not null,   -- 'user' | 'assistant' | 'system'
  content             text        not null,

  -- Lifecycle:
  --   received  = inbound saved, awaiting worker
  --   drafted   = AI reply generated, not yet sent (Phase 1 stops here)
  --   sent      = pushed to OnlyFansAPI (Phase 2)
  --   failed    = generation or send failed permanently
  --   suppressed = classifier said should_respond=false; no reply drafted
  status              text        not null,

  -- Classifier output, populated for inbound messages after the worker runs
  mood                text,
  intent              text,
  classifier_conf     numeric(3,2),

  -- Generation metadata (outbound rows only)
  model_used          text,
  prompt_tokens       integer,
  completion_tokens   integer,

  -- Send scheduling (Phase 2)
  send_after          timestamptz,
  sent_at             timestamptz,
  external_msg_id     text,      -- OnlyFansAPI message id after send

  -- Idempotency for inbound webhook replays
  external_event_id   text,

  created_at          timestamptz not null default now(),

  constraint chat_messages_event_id_key unique (external_event_id)
);

create index if not exists idx_chat_thread
  on public.chat_messages (creator_uuid, fan_id, created_at desc);

create index if not exists idx_chat_drafted
  on public.chat_messages (status, send_after)
  where status = 'drafted';

-- ── Realtime so the dashboard gets live updates ────────────
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end
$$;

-- ── RLS: anon read-only; service-role bypasses RLS for writes
alter table public.chat_messages enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_messages'
      and policyname = 'anon_read_chat_messages'
  ) then
    create policy "anon_read_chat_messages"
      on public.chat_messages
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;
