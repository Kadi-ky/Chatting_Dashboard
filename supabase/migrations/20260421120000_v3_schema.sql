-- ─────────────────────────────────────────────────────────────────────────────
-- v3 parallel schema for the new TypeScript backend.
-- Old public.* tables and edge functions continue to run unchanged during cutover.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists v3;
grant usage on schema v3 to postgres, anon, authenticated, service_role;
grant all on all tables in schema v3 to postgres, service_role;
alter default privileges in schema v3 grant all on tables to postgres, service_role;
alter default privileges in schema v3 grant all on sequences to postgres, service_role;

-- ─── enums ───────────────────────────────────────────────────────────────────
create type v3.phase as enum (
  'WARMUP', 'RAPPORT', 'QUALIFYING', 'MONETIZING',
  'WHALE', 'REACTIVATION', 'COLD'
);
create type v3.message_direction as enum ('inbound', 'outbound', 'system');
create type v3.message_kind as enum (
  'text', 'ppv', 'unlock', 'tip', 'subscription', 'system_event'
);
create type v3.spender_tier as enum ('never', 'low', 'mid', 'high', 'whale');
create type v3.engagement_level as enum ('lurker', 'casual', 'active', 'obsessive');
create type v3.relationship_tone as enum (
  'friend', 'romantic', 'gfe', 'dom', 'sub', 'fantasy', 'transactional'
);
create type v3.price_sensitivity as enum ('low', 'mid', 'high');
create type v3.ppv_outcome as enum ('pending', 'unlocked', 'expired', 'declined');
create type v3.transaction_kind as enum ('subscription', 'ppv_unlock', 'tip', 'other');
create type v3.campaign_status as enum (
  'draft', 'queued', 'running', 'paused', 'done', 'cancelled'
);
create type v3.campaign_send_status as enum (
  'scheduled', 'sent', 'failed', 'skipped'
);

-- ─── updated_at trigger helper ───────────────────────────────────────────────
create or replace function v3.touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ─── accounts (one row per creator) ──────────────────────────────────────────
create table v3.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  persona_version text not null default '1',
  status text not null default 'active',
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_accounts_updated before update on v3.accounts
  for each row execute function v3.touch_updated_at();

-- ─── subscribers ─────────────────────────────────────────────────────────────
create table v3.subscribers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references v3.accounts(id) on delete cascade,
  external_id text not null,
  display_name text,
  platform_metadata jsonb not null default '{}'::jsonb,
  subscribed_at timestamptz,
  expires_at timestamptz,
  is_active boolean not null default true,
  total_spend_cents bigint not null default 0,
  spend_30d_cents bigint not null default 0,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, external_id)
);
create index idx_subscribers_last_inbound
  on v3.subscribers(account_id, last_inbound_at desc);
create index idx_subscribers_active_by_account
  on v3.subscribers(account_id)
  where is_active;
create trigger trg_subscribers_updated before update on v3.subscribers
  for each row execute function v3.touch_updated_at();

-- ─── subscriber_facts (durable facts extracted from chat) ───────────────────
create table v3.subscriber_facts (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references v3.subscribers(id) on delete cascade,
  key text not null,
  value text not null,
  confidence numeric(3,2) not null default 0.8,
  source_message_id uuid,
  created_at timestamptz not null default now(),
  superseded_by uuid references v3.subscriber_facts(id)
);
create index idx_facts_current
  on v3.subscriber_facts(subscriber_id)
  where superseded_by is null;
create index idx_facts_by_key
  on v3.subscriber_facts(subscriber_id, key)
  where superseded_by is null;

-- ─── conversations (one per subscriber) ──────────────────────────────────────
create table v3.conversations (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references v3.subscribers(id) on delete cascade,
  account_id uuid not null references v3.accounts(id) on delete cascade,
  phase v3.phase not null default 'WARMUP',
  substate text,
  phase_entered_at timestamptz not null default now(),
  turns_in_phase int not null default 0,
  state_ctx jsonb not null default '{}'::jsonb,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(subscriber_id)
);
create index idx_conversations_activity
  on v3.conversations(account_id, last_activity_at desc);

-- ─── messages (append-only) ──────────────────────────────────────────────────
create table v3.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references v3.conversations(id) on delete cascade,
  direction v3.message_direction not null,
  kind v3.message_kind not null default 'text',
  text text,
  attachments jsonb not null default '[]'::jsonb,
  external_id text,
  llm_call_id uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz
);
create unique index uq_messages_external
  on v3.messages(conversation_id, external_id)
  where external_id is not null;
create index idx_messages_conv_time
  on v3.messages(conversation_id, created_at desc);

-- ─── archetypes (append-only classification history) ────────────────────────
create table v3.archetypes (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references v3.subscribers(id) on delete cascade,
  classified_at timestamptz not null default now(),
  classifier_version text not null default '1',
  spender_tier v3.spender_tier not null,
  confidence numeric(3,2) not null,
  fetish_tags text[] not null default '{}',
  engagement_level v3.engagement_level not null,
  relationship_tone v3.relationship_tone not null,
  price_sensitivity v3.price_sensitivity not null,
  objection_patterns text[] not null default '{}',
  timezone_hint text,
  pivot_signals text[] not null default '{}',
  raw jsonb
);
create index idx_archetypes_latest
  on v3.archetypes(subscriber_id, classified_at desc);

-- ─── ppv_catalog ─────────────────────────────────────────────────────────────
create table v3.ppv_catalog (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references v3.accounts(id) on delete cascade,
  title text not null,
  description text,
  media_refs jsonb not null default '[]'::jsonb,
  tags text[] not null default '{}',
  price_floor_cents bigint not null,
  price_ceiling_cents bigint not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  attempts_count bigint not null default 0,
  unlocks_count bigint not null default 0,
  revenue_cents bigint not null default 0,
  check (price_ceiling_cents >= price_floor_cents)
);
create index idx_catalog_tags on v3.ppv_catalog using gin(tags);
create index idx_catalog_live on v3.ppv_catalog(account_id) where retired_at is null;

-- ─── asset_performance (per-archetype rollups) ──────────────────────────────
create table v3.asset_performance (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references v3.ppv_catalog(id) on delete cascade,
  archetype_slice jsonb not null,
  attempts bigint not null default 0,
  unlocks bigint not null default 0,
  revenue_cents bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique(asset_id, archetype_slice)
);

-- ─── ppv_attempts ────────────────────────────────────────────────────────────
create table v3.ppv_attempts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references v3.conversations(id) on delete cascade,
  asset_id uuid not null references v3.ppv_catalog(id),
  price_cents bigint not null,
  pitched_at timestamptz not null default now(),
  unlocked_at timestamptz,
  expired_at timestamptz,
  message_id uuid references v3.messages(id),
  outcome v3.ppv_outcome not null default 'pending'
);
create index idx_attempts_conv_time
  on v3.ppv_attempts(conversation_id, pitched_at desc);
create index idx_attempts_pending
  on v3.ppv_attempts(pitched_at)
  where outcome = 'pending';

-- ─── transactions ────────────────────────────────────────────────────────────
create table v3.transactions (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references v3.subscribers(id) on delete cascade,
  kind v3.transaction_kind not null,
  amount_cents bigint not null,
  occurred_at timestamptz not null,
  external_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index uq_transactions_external
  on v3.transactions(subscriber_id, external_id)
  where external_id is not null;
create index idx_transactions_subscriber
  on v3.transactions(subscriber_id, occurred_at desc);

-- ─── state_transitions (audit log) ──────────────────────────────────────────
create table v3.state_transitions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references v3.conversations(id) on delete cascade,
  from_phase v3.phase,
  to_phase v3.phase not null,
  trigger text not null,
  meta jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index idx_transitions_conv on v3.state_transitions(conversation_id, at desc);

-- ─── llm_calls (full request/response log) ──────────────────────────────────
create table v3.llm_calls (
  id uuid primary key default gen_random_uuid(),
  task text not null,
  provider text not null,
  model text not null,
  prompt_tokens int,
  completion_tokens int,
  cost_cents numeric(12,4),
  latency_ms int,
  ok boolean not null,
  error text,
  request jsonb,
  response jsonb,
  created_at timestamptz not null default now()
);
create index idx_llm_calls_time on v3.llm_calls(created_at desc);
create index idx_llm_calls_task on v3.llm_calls(task, created_at desc);

-- ─── events (raw platform events for replay) ────────────────────────────────
create table v3.events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references v3.accounts(id) on delete cascade,
  kind text not null,
  external_id text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create unique index uq_events_external
  on v3.events(account_id, kind, external_id)
  where external_id is not null;
create index idx_events_unprocessed
  on v3.events(account_id, received_at)
  where processed_at is null;

-- ─── campaigns + campaign_sends (broadcasts) ────────────────────────────────
create table v3.campaigns (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references v3.accounts(id) on delete cascade,
  name text not null,
  segment_query jsonb not null,
  template jsonb not null,
  send_window jsonb not null,
  rate_cap jsonb not null default '{"perMinute": 10, "perHour": 300}'::jsonb,
  status v3.campaign_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_campaigns_updated before update on v3.campaigns
  for each row execute function v3.touch_updated_at();

create table v3.campaign_sends (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references v3.campaigns(id) on delete cascade,
  subscriber_id uuid not null references v3.subscribers(id) on delete cascade,
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  status v3.campaign_send_status not null default 'scheduled',
  reply_received_at timestamptz,
  error text,
  unique(campaign_id, subscriber_id)
);
create index idx_campaign_sends_due
  on v3.campaign_sends(scheduled_at)
  where status = 'scheduled';
