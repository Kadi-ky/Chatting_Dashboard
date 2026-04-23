import { db } from "../client.js";

export interface FactRow {
  id: string;
  key: string;
  value: string;
  confidence: number;
  createdAt: Date;
}

export interface UpsertFactArgs {
  subscriberId: string;
  key: string;
  value: string;
  confidence: number;
  sourceMessageId?: string | null;
}

/**
 * Insert a new fact row. If a prior row with the same (subscriber, key, value)
 * exists, skip. If a different value exists for the same key, the old row is
 * marked superseded by the new one (append-only history preserved).
 */
export async function upsertFact(args: UpsertFactArgs): Promise<{ id: string; inserted: boolean }> {
  const existing = await db
    .selectFrom("v3.subscriber_facts")
    .select(["id", "value"])
    .where("subscriber_id", "=", args.subscriberId)
    .where("key", "=", args.key)
    .where("superseded_by", "is", null)
    .executeTakeFirst();

  if (existing && existing.value === args.value) {
    return { id: existing.id, inserted: false };
  }

  const row = await db
    .insertInto("v3.subscriber_facts")
    .values({
      subscriber_id: args.subscriberId,
      key: args.key,
      value: args.value,
      confidence: String(args.confidence),
      source_message_id: args.sourceMessageId ?? null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  if (existing) {
    await db
      .updateTable("v3.subscriber_facts")
      .set({ superseded_by: row.id })
      .where("id", "=", existing.id)
      .execute();
  }

  return { id: row.id, inserted: true };
}

/** Load current (non-superseded) facts for a subscriber, most recent first. */
export async function loadCurrentFacts(
  subscriberId: string,
  limit = 20,
): Promise<FactRow[]> {
  const rows = await db
    .selectFrom("v3.subscriber_facts")
    .select(["id", "key", "value", "confidence", "created_at"])
    .where("subscriber_id", "=", subscriberId)
    .where("superseded_by", "is", null)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    value: r.value,
    confidence: Number(r.confidence),
    createdAt: r.created_at as unknown as Date,
  }));
}
