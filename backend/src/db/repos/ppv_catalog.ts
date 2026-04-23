import { sql } from "kysely";
import { db } from "../client.js";

export interface PpvCatalogRow {
  id: string;
  accountId: string;
  title: string;
  description: string | null;
  mediaRefs: unknown[];
  tags: string[];
  priceFloorCents: number;
  priceCeilingCents: number;
  attemptsCount: number;
  unlocksCount: number;
  revenueCents: number;
  createdAt: Date;
  sourceRef: string | null;
}

export interface CreateCatalogItem {
  accountId: string;
  title: string;
  description?: string | null;
  mediaRefs: unknown[];
  tags: string[];
  priceFloorCents: number;
  priceCeilingCents: number;
}

export async function createCatalogItem(args: CreateCatalogItem): Promise<{ id: string }> {
  const row = await db
    .insertInto("v3.ppv_catalog")
    .values({
      account_id: args.accountId,
      title: args.title,
      description: args.description ?? null,
      media_refs: JSON.stringify(args.mediaRefs),
      tags: args.tags,
      price_floor_cents: args.priceFloorCents,
      price_ceiling_cents: args.priceCeilingCents,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

/** Retire (soft-delete) a catalog entry so the ranker skips it. */
export async function retireCatalogItem(id: string): Promise<void> {
  await db
    .updateTable("v3.ppv_catalog")
    .set({ retired_at: sql`now()` })
    .where("id", "=", id)
    .where("retired_at", "is", null)
    .execute();
}

export async function listLiveCatalog(accountId: string): Promise<PpvCatalogRow[]> {
  const rows = await db
    .selectFrom("v3.ppv_catalog")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("retired_at", "is", null)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map(mapRow);
}

export async function loadCatalogItem(id: string): Promise<PpvCatalogRow | null> {
  const row = await db
    .selectFrom("v3.ppv_catalog")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
}

export interface UpsertMirrorArgs {
  sourceRef: string;
  accountId: string;
  title: string;
  description: string | null;
  mediaRefs: unknown[];
  tags: string[];
  priceFloorCents: number;
  priceCeilingCents: number;
}

/**
 * Idempotent mirror-upsert keyed by source_ref. Used by the script picker to
 * materialise a thin catalog shadow for a legacy (script, rung) pair — keeps
 * FKs on ppv_attempts + asset_performance intact without forcing a full
 * content migration.
 */
export async function upsertMirrorFromSource(args: UpsertMirrorArgs): Promise<PpvCatalogRow> {
  const row = await db
    .insertInto("v3.ppv_catalog")
    .values({
      account_id: args.accountId,
      title: args.title,
      description: args.description,
      media_refs: JSON.stringify(args.mediaRefs),
      tags: args.tags,
      price_floor_cents: args.priceFloorCents,
      price_ceiling_cents: args.priceCeilingCents,
      source_ref: args.sourceRef,
    })
    .onConflict((oc) =>
      oc
        .column("source_ref")
        .where("source_ref", "is not", null)
        .doUpdateSet({
          title: args.title,
          description: args.description,
          media_refs: JSON.stringify(args.mediaRefs),
          tags: args.tags,
          price_floor_cents: args.priceFloorCents,
          price_ceiling_cents: args.priceCeilingCents,
        }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return mapRow(row);
}

/** Increment rolling counters after a pitch or unlock. */
export async function incrementAttemptCounter(assetId: string): Promise<void> {
  await db
    .updateTable("v3.ppv_catalog")
    .set({ attempts_count: sql`attempts_count + 1` })
    .where("id", "=", assetId)
    .execute();
}

export async function incrementUnlockCounter(
  assetId: string,
  revenueCents: number,
): Promise<void> {
  await db
    .updateTable("v3.ppv_catalog")
    .set({
      unlocks_count: sql`unlocks_count + 1`,
      revenue_cents: sql`revenue_cents + ${revenueCents}`,
    })
    .where("id", "=", assetId)
    .execute();
}

function mapRow(row: {
  id: string;
  account_id: string;
  title: string;
  description: string | null;
  media_refs: unknown;
  tags: string[];
  price_floor_cents: number;
  price_ceiling_cents: number;
  attempts_count: number;
  unlocks_count: number;
  revenue_cents: number;
  created_at: unknown;
  source_ref?: string | null;
}): PpvCatalogRow {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    description: row.description,
    mediaRefs: Array.isArray(row.media_refs) ? (row.media_refs as unknown[]) : [],
    tags: row.tags,
    priceFloorCents: row.price_floor_cents,
    priceCeilingCents: row.price_ceiling_cents,
    attemptsCount: row.attempts_count,
    unlocksCount: row.unlocks_count,
    revenueCents: row.revenue_cents,
    createdAt: row.created_at as Date,
    sourceRef: row.source_ref ?? null,
  };
}
