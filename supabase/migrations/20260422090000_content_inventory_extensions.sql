-- Extensions to the legacy content inventory and purchases tables so the
-- V3 script picker can drive archetype-aware selection without forcing a
-- full catalog migration.
--
-- 1. tags text[] on content_inventory_onlyfans: single tag_creator is too
--    coarse for archetype × fetish-tag matching. Keeping tag_creator alongside
--    for back-compat with any existing query.
-- 2. rung smallint on purchases_onlyfans: the ladder rung a purchase belongs
--    to (1..4). Currently inferred from amount matching one of the per-rung
--    prices, which is fragile across price changes.

alter table public.content_inventory_onlyfans
  add column if not exists tags text[] not null default '{}'::text[];

create index if not exists content_inventory_onlyfans_tags_idx
  on public.content_inventory_onlyfans
  using gin (tags);

alter table public.purchases_onlyfans
  add column if not exists rung smallint;

create index if not exists purchases_onlyfans_creator_fan_script_idx
  on public.purchases_onlyfans (creator_uuid, fan_uuid, script_number);

-- 3. source_ref on v3.ppv_catalog: opaque key used to upsert a catalog row
--    that mirrors a (script_number, rung) pair from the legacy inventory.
--    Format: "of:{script_id}:{rung}". Preserves the V3 FK model (attempts +
--    asset_performance still key off ppv_catalog.id) without duplicating
--    actual media — mirror rows are thin metadata shadows.

alter table v3.ppv_catalog
  add column if not exists source_ref text;

create unique index if not exists ppv_catalog_source_ref_unique
  on v3.ppv_catalog (source_ref)
  where source_ref is not null;
