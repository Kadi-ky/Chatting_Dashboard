import { sql, type SqlBool } from "kysely";
import { db } from "../client.js";

export async function upsertSubscriber(args: {
  accountId: string;
  externalId: string;
  displayName?: string | undefined;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const row = await db
    .insertInto("v3.subscribers")
    .values({
      account_id: args.accountId,
      external_id: args.externalId,
      display_name: args.displayName ?? null,
      ...(args.metadata ? { platform_metadata: JSON.stringify(args.metadata) } : {}),
    })
    .onConflict((oc) =>
      oc.columns(["account_id", "external_id"]).doUpdateSet({
        display_name: (eb) => eb.ref("excluded.display_name"),
        platform_metadata: (eb) => eb.ref("excluded.platform_metadata"),
        updated_at: sql`now()`,
      }),
    )
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export async function loadSubscriberExternalId(subscriberId: string): Promise<string | null> {
  const row = await db
    .selectFrom("v3.subscribers")
    .select("external_id")
    .where("id", "=", subscriberId)
    .executeTakeFirst();
  return row?.external_id ?? null;
}

export async function markLastInbound(subscriberId: string, at: Date): Promise<void> {
  await db
    .updateTable("v3.subscribers")
    .set({ last_inbound_at: at })
    .where("id", "=", subscriberId)
    .execute();
}

export async function markLastOutbound(subscriberId: string, at: Date): Promise<void> {
  await db
    .updateTable("v3.subscribers")
    .set({ last_outbound_at: at })
    .where("id", "=", subscriberId)
    .execute();
}

export interface SubscriberSnapshotRow {
  id: string;
  totalSpendCents: number;
  spend30dCents: number;
  lastInboundAt: Date | null;
  factCount: number;
  preferenceCount: number;
  hasEverUnlocked: boolean;
  ppvOffersSinceUnlock: number;
}

/**
 * Load the rollups the state machine needs. One extra query — keeps
 * transitions pure functions of signals by precomputing everything here.
 */
export async function loadSubscriberSignals(subscriberId: string): Promise<SubscriberSnapshotRow | null> {
  const sub = await db
    .selectFrom("v3.subscribers")
    .select(["id", "total_spend_cents", "spend_30d_cents", "last_inbound_at"])
    .where("id", "=", subscriberId)
    .executeTakeFirst();
  if (!sub) return null;

  const factsRow = await db
    .selectFrom("v3.subscriber_facts")
    .select(db.fn.count<string>("id").as("count"))
    .where("subscriber_id", "=", subscriberId)
    .where("superseded_by", "is", null)
    .executeTakeFirst();

  const prefsRow = await db
    .selectFrom("v3.subscriber_facts")
    .select(db.fn.count<string>("id").as("count"))
    .where("subscriber_id", "=", subscriberId)
    .where("key", "=", "preference")
    .where("superseded_by", "is", null)
    .executeTakeFirst();

  const unlocksRow = await db
    .selectFrom("v3.transactions")
    .select(db.fn.count<string>("id").as("count"))
    .where("subscriber_id", "=", subscriberId)
    .where("kind", "=", "ppv_unlock")
    .executeTakeFirst();

  const lastUnlockRow = await db
    .selectFrom("v3.transactions")
    .select("occurred_at")
    .where("subscriber_id", "=", subscriberId)
    .where("kind", "=", "ppv_unlock")
    .orderBy("occurred_at", "desc")
    .limit(1)
    .executeTakeFirst();

  const offersSinceUnlockRow = await db
    .selectFrom("v3.ppv_attempts")
    .innerJoin("v3.conversations", "v3.conversations.id", "v3.ppv_attempts.conversation_id")
    .select(db.fn.count<string>("v3.ppv_attempts.id").as("count"))
    .where("v3.conversations.subscriber_id", "=", subscriberId)
    .$if(lastUnlockRow != null, (qb) => {
      const cutoff = lastUnlockRow!.occurred_at as unknown as Date;
      return qb.where(sql<SqlBool>`v3.ppv_attempts.pitched_at > ${cutoff}`);
    })
    .executeTakeFirst();

  return {
    id: sub.id,
    totalSpendCents: sub.total_spend_cents,
    spend30dCents: sub.spend_30d_cents,
    lastInboundAt: (sub.last_inbound_at as unknown as Date | null) ?? null,
    factCount: Number(factsRow?.count ?? 0),
    preferenceCount: Number(prefsRow?.count ?? 0),
    hasEverUnlocked: Number(unlocksRow?.count ?? 0) > 0,
    ppvOffersSinceUnlock: Number(offersSinceUnlockRow?.count ?? 0),
  };
}
