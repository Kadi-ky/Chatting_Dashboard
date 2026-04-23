import { sql, type SqlBool } from "kysely";
import { db } from "../client.js";
import type { SpenderTier, PriceSensitivity } from "../types.js";

/**
 * Archetype slice key. We keep the cardinality small so per-archetype stats
 * converge — don't add high-cardinality dimensions like freeform fetish tags.
 */
export interface ArchetypeSlice {
  spenderTier: SpenderTier;
  priceSensitivity: PriceSensitivity;
}

export interface AssetPerformanceRow {
  assetId: string;
  slice: ArchetypeSlice;
  attempts: number;
  unlocks: number;
  revenueCents: number;
}

export function sliceKey(s: ArchetypeSlice): Record<string, string> {
  return { spenderTier: s.spenderTier, priceSensitivity: s.priceSensitivity };
}

export async function bumpAttempt(assetId: string, slice: ArchetypeSlice): Promise<void> {
  const key = JSON.stringify(sliceKey(slice));
  await db
    .insertInto("v3.asset_performance")
    .values({
      asset_id: assetId,
      archetype_slice: key,
      attempts: 1,
    })
    .onConflict((oc) =>
      oc.columns(["asset_id", "archetype_slice"]).doUpdateSet({
        attempts: sql`v3.asset_performance.attempts + 1`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

export async function bumpUnlock(
  assetId: string,
  slice: ArchetypeSlice,
  revenueCents: number,
): Promise<void> {
  const key = JSON.stringify(sliceKey(slice));
  await db
    .insertInto("v3.asset_performance")
    .values({
      asset_id: assetId,
      archetype_slice: key,
      unlocks: 1,
      revenue_cents: revenueCents,
    })
    .onConflict((oc) =>
      oc.columns(["asset_id", "archetype_slice"]).doUpdateSet({
        unlocks: sql`v3.asset_performance.unlocks + 1`,
        revenue_cents: sql`v3.asset_performance.revenue_cents + ${revenueCents}`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

/** Pull all perf rows for an account's assets for the ranker. */
export async function loadSliceStats(
  accountId: string,
  slice: ArchetypeSlice,
): Promise<Map<string, AssetPerformanceRow>> {
  const key = JSON.stringify(sliceKey(slice));
  const rows = await db
    .selectFrom("v3.asset_performance")
    .innerJoin("v3.ppv_catalog", "v3.ppv_catalog.id", "v3.asset_performance.asset_id")
    .select([
      "v3.asset_performance.asset_id as asset_id",
      "v3.asset_performance.attempts as attempts",
      "v3.asset_performance.unlocks as unlocks",
      "v3.asset_performance.revenue_cents as revenue_cents",
    ])
    .where("v3.ppv_catalog.account_id", "=", accountId)
    .where(sql<SqlBool>`v3.asset_performance.archetype_slice = ${key}::jsonb`)
    .execute();
  const map = new Map<string, AssetPerformanceRow>();
  for (const r of rows) {
    map.set(r.asset_id, {
      assetId: r.asset_id,
      slice,
      attempts: Number(r.attempts),
      unlocks: Number(r.unlocks),
      revenueCents: Number(r.revenue_cents),
    });
  }
  return map;
}
