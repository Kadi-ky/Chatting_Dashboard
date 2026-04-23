import { db } from "../client.js";
import type { TransactionKind } from "../types.js";

export interface RecordTransactionArgs {
  subscriberId: string;
  kind: TransactionKind;
  amountCents: number;
  occurredAt: Date;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Record a subscription/unlock/tip. Idempotent on (subscriber, external_id)
 * via the unique partial index in the schema — duplicate webhooks no-op.
 */
export async function recordTransaction(
  args: RecordTransactionArgs,
): Promise<{ id: string; inserted: boolean }> {
  const existing = args.externalId
    ? await db
        .selectFrom("v3.transactions")
        .select("id")
        .where("subscriber_id", "=", args.subscriberId)
        .where("external_id", "=", args.externalId)
        .executeTakeFirst()
    : null;
  if (existing) return { id: existing.id, inserted: false };

  const row = await db
    .insertInto("v3.transactions")
    .values({
      subscriber_id: args.subscriberId,
      kind: args.kind,
      amount_cents: args.amountCents,
      occurred_at: args.occurredAt,
      external_id: args.externalId ?? null,
      ...(args.metadata ? { metadata: JSON.stringify(args.metadata) } : {}),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id, inserted: true };
}
