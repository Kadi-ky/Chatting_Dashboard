-- ============================================================
-- Add rapport / interaction-depth / takeover columns to subscribers
--
-- Written by chat-worker (rapport_score, interaction_depth, last_ai_reply_at).
-- Flipped by the dashboard (ai_paused) — Phase 2 UI.
-- ============================================================
alter table public.onlyfans_subscribers
  add column if not exists rapport_score      integer     not null default 0,
  add column if not exists interaction_depth  text        not null default 'cold',   -- 'cold'|'warming'|'engaged'|'intimate'
  add column if not exists ai_paused          boolean     not null default false,
  add column if not exists last_ai_reply_at   timestamptz;
