-- Add SEXTING to v3.phase enum.
--
-- The SEXTING phase was added to the TypeScript type system + state machine
-- on 2026-04-28 (commit 863d980), but the corresponding Postgres enum value
-- was never added. Production observed (2026-04-29) every turn that tried
-- to transition into SEXTING phase failing with:
--   error: invalid input value for enum v3.phase: "SEXTING"
-- BullMQ retried the failing job 3x then gave up; conversations went silent.
--
-- ALTER TYPE ... ADD VALUE is non-transactional in Postgres < 12 and can't
-- run in a transaction block, but Supabase migrations on PG14+ handle this
-- correctly. Running this migration unblocks all stuck convs immediately.

alter type v3.phase add value if not exists 'SEXTING' after 'RAPPORT';
