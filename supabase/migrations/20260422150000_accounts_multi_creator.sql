-- Multi-creator: v3.accounts gains columns that identify each account on the
-- upstream platform (e.g. OnlyFansAPI `acct_xxx`) and map to the legacy
-- content_inventory_onlyfans / purchases_onlyfans tables (creator_uuid).
--
-- With these in place, every webhook / poller event can be routed to the
-- correct internal account without relying on a single env var.

alter table v3.accounts
  add column if not exists platform text not null default 'onlyfans',
  add column if not exists platform_account_id text,
  add column if not exists creator_uuid text;

create unique index if not exists accounts_platform_account_unique
  on v3.accounts (platform, platform_account_id)
  where platform_account_id is not null;

create unique index if not exists accounts_creator_uuid_unique
  on v3.accounts (creator_uuid)
  where creator_uuid is not null;

create index if not exists accounts_active_idx
  on v3.accounts (platform)
  where status = 'active';
