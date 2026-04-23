-- Seed the single v3.accounts row this worker deployment runs against.
-- The UUID must match ACCOUNT_ID in backend/.env.local.
-- Idempotent: safe to re-run.

insert into v3.accounts (id, name, persona_version, status, config)
values (
  '9e7e0c73-04fb-42d6-8958-8c3d58d50cb1',
  'PeachBot — default',
  '1',
  'active',
  '{}'::jsonb
)
on conflict (id) do nothing;
