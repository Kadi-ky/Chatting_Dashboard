import { sql } from "kysely";
import { db } from "../client.js";
import type { PlatformEvent } from "../../platform/PlatformAdapter.js";

/**
 * Records a raw inbound event for audit/replay. Returns true if newly inserted,
 * false if a duplicate (same account/kind/external_id already recorded).
 */
export async function recordEvent(
  accountId: string,
  event: PlatformEvent,
): Promise<{ inserted: boolean; id: string }> {
  const row = await db
    .insertInto("v3.events")
    .values({
      account_id: accountId,
      kind: event.kind,
      external_id: event.externalId,
      payload: JSON.stringify(event.payload),
    })
    .onConflict((oc) =>
      oc.columns(["account_id", "kind", "external_id"]).where("external_id", "is not", null).doNothing(),
    )
    .returning(["id"])
    .executeTakeFirst();

  if (row) return { inserted: true, id: row.id };

  const existing = await db
    .selectFrom("v3.events")
    .select("id")
    .where("account_id", "=", accountId)
    .where("kind", "=", event.kind)
    .where("external_id", "=", event.externalId)
    .executeTakeFirst();
  return { inserted: false, id: existing?.id ?? "" };
}

export async function markEventProcessed(id: string): Promise<void> {
  if (!id) return;
  await db
    .updateTable("v3.events")
    .set({ processed_at: sql`now()` })
    .where("id", "=", id)
    .where("processed_at", "is", null)
    .execute();
}
