import { sql, type SqlBool } from "kysely";
import { db } from "../client.js";
import type { PpvOutcome } from "../types.js";

export interface PpvAttemptRow {
  id: string;
  conversationId: string;
  assetId: string;
  priceCents: number;
  pitchedAt: Date;
  unlockedAt: Date | null;
  expiredAt: Date | null;
  messageId: string | null;
  outcome: PpvOutcome;
}

export async function insertPpvAttempt(args: {
  conversationId: string;
  assetId: string;
  priceCents: number;
  messageId?: string | null;
}): Promise<{ id: string }> {
  const row = await db
    .insertInto("v3.ppv_attempts")
    .values({
      conversation_id: args.conversationId,
      asset_id: args.assetId,
      price_cents: args.priceCents,
      message_id: args.messageId ?? null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

/**
 * Mark the most recent pending attempt in a conversation as unlocked. Returns
 * the attempt that was resolved (if any) so callers can update rollups.
 */
export async function markMostRecentAttemptUnlocked(args: {
  conversationId: string;
  assetId?: string | null;
  unlockedAt: Date;
}): Promise<PpvAttemptRow | null> {
  const pending = await db
    .selectFrom("v3.ppv_attempts")
    .selectAll()
    .where("conversation_id", "=", args.conversationId)
    .where("outcome", "=", "pending")
    .$if(args.assetId != null, (qb) => qb.where("asset_id", "=", args.assetId as string))
    .orderBy("pitched_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!pending) return null;

  await db
    .updateTable("v3.ppv_attempts")
    .set({ outcome: "unlocked", unlocked_at: args.unlockedAt })
    .where("id", "=", pending.id)
    .execute();

  return mapRow({
    ...pending,
    outcome: "unlocked",
    unlocked_at: args.unlockedAt,
  });
}

export async function listRecentAttempts(
  conversationId: string,
  limit = 10,
): Promise<PpvAttemptRow[]> {
  const rows = await db
    .selectFrom("v3.ppv_attempts")
    .selectAll()
    .where("conversation_id", "=", conversationId)
    .orderBy("pitched_at", "desc")
    .limit(limit)
    .execute();
  return rows.map(mapRow);
}

/** Asset ids pitched to a subscriber within `days` days. Used for cooldown. */
export async function assetsPitchedWithin(args: {
  subscriberId: string;
  days: number;
}): Promise<string[]> {
  const cutoff = new Date(Date.now() - args.days * 86_400_000);
  const rows = await db
    .selectFrom("v3.ppv_attempts")
    .innerJoin("v3.conversations", "v3.conversations.id", "v3.ppv_attempts.conversation_id")
    .select("v3.ppv_attempts.asset_id")
    .where("v3.conversations.subscriber_id", "=", args.subscriberId)
    .where(sql<SqlBool>`v3.ppv_attempts.pitched_at > ${cutoff}`)
    .execute();
  return Array.from(new Set(rows.map((r) => r.asset_id)));
}

/** Asset ids the subscriber has ever unlocked. */
export async function assetsUnlockedBy(subscriberId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("v3.ppv_attempts")
    .innerJoin("v3.conversations", "v3.conversations.id", "v3.ppv_attempts.conversation_id")
    .select("v3.ppv_attempts.asset_id")
    .where("v3.conversations.subscriber_id", "=", subscriberId)
    .where("v3.ppv_attempts.outcome", "=", "unlocked")
    .execute();
  return Array.from(new Set(rows.map((r) => r.asset_id)));
}

/** Mark attempts older than `hours` and still pending as expired. */
export async function expireStaleAttempts(hours = 72): Promise<number> {
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const result = await db
    .updateTable("v3.ppv_attempts")
    .set({ outcome: "expired", expired_at: sql`now()` })
    .where("outcome", "=", "pending")
    .where(sql<SqlBool>`pitched_at < ${cutoff}`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

function mapRow(row: {
  id: string;
  conversation_id: string;
  asset_id: string;
  price_cents: number;
  pitched_at: unknown;
  unlocked_at: unknown;
  expired_at: unknown;
  message_id: string | null;
  outcome: PpvOutcome;
}): PpvAttemptRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    assetId: row.asset_id,
    priceCents: row.price_cents,
    pitchedAt: row.pitched_at as Date,
    unlockedAt: (row.unlocked_at as Date | null) ?? null,
    expiredAt: (row.expired_at as Date | null) ?? null,
    messageId: row.message_id,
    outcome: row.outcome,
  };
}
