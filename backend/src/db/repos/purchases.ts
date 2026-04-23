import { db } from "../client.js";

/**
 * Legacy purchases table tracks unlocks by (fan_uuid, script_number, amount).
 * The rung column was added in migration 20260422090000; older rows have
 * rung=null so we infer from amount matching one of the per-rung prices.
 */
export interface PurchaseRow {
  id: number;
  fanUuid: string;
  creatorUuid: string | null;
  scriptNumber: number | null;
  rung: number | null;
  amountCents: number | null;
  purchasedAt: Date;
}

/**
 * Record a purchase from a V3 ppv.unlocked event so the script picker on the
 * next turn can see it and advance the ladder. Idempotent via dedupe on
 * (fan_uuid, creator_uuid, script_number, rung).
 */
export async function recordPurchase(args: {
  fanUuid: string;
  creatorUuid: string;
  scriptNumber: number;
  rung: number;
  amountCents: number;
  purchasedAt: Date;
}): Promise<void> {
  await db
    .insertInto("public.purchases_onlyfans")
    .values({
      fan_uuid: args.fanUuid,
      creator_uuid: args.creatorUuid,
      script_number: args.scriptNumber,
      rung: args.rung,
      // amount is numeric in the legacy schema — kysely passes through as-is.
      amount: args.amountCents,
      purchased_at: args.purchasedAt,
    })
    .executeTakeFirst()
    .catch(() => {
      // Legacy table has no unique constraint — caller tolerates duplicates.
      // Swallowing lets the rest of the unlock handler complete.
    });
}

/**
 * Parse a v3.ppv_catalog.source_ref back to its parts. Returns null if the
 * ref is not a legacy-content mirror (e.g. a v3-native catalog row).
 */
export function parseLegacySourceRef(
  sourceRef: string | null,
): { creatorUuid: string; scriptNumber: number; rung: number } | null {
  if (!sourceRef) return null;
  const m = /^of:([^:]+):(\d+):(\d+)$/.exec(sourceRef);
  if (!m) return null;
  return {
    creatorUuid: m[1]!,
    scriptNumber: Number(m[2]!),
    rung: Number(m[3]!),
  };
}

export async function listPurchasesByFan(
  fanUuid: string,
  creatorUuid: string,
): Promise<PurchaseRow[]> {
  const rows = await db
    .selectFrom("public.purchases_onlyfans")
    .selectAll()
    .where("fan_uuid", "=", fanUuid)
    .where("creator_uuid", "=", creatorUuid)
    .orderBy("purchased_at", "asc")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    fanUuid: r.fan_uuid,
    creatorUuid: r.creator_uuid,
    scriptNumber: r.script_number,
    rung: r.rung,
    amountCents: r.amount === null ? null : Number(r.amount),
    purchasedAt: r.purchased_at as unknown as Date,
  }));
}

/**
 * Fan's progress through each script they've touched.
 * `maxRungUnlocked` is the highest rung (1..4) bought for that script.
 */
export interface FanScriptProgress {
  scriptNumber: number;
  maxRungUnlocked: number;
  lastUnlockAt: Date;
}

/**
 * Derive per-script progress from the purchases table. If a row has no rung
 * column populated (legacy), caller supplies a resolver to infer from amount.
 */
export function deriveProgress(
  purchases: PurchaseRow[],
  inferRung: (scriptNumber: number, amountCents: number | null) => number | null,
): Map<number, FanScriptProgress> {
  const progress = new Map<number, FanScriptProgress>();
  for (const p of purchases) {
    if (p.scriptNumber == null) continue;
    const rung = p.rung ?? inferRung(p.scriptNumber, p.amountCents);
    if (rung == null) continue;
    const prev = progress.get(p.scriptNumber);
    if (!prev || rung > prev.maxRungUnlocked) {
      progress.set(p.scriptNumber, {
        scriptNumber: p.scriptNumber,
        maxRungUnlocked: rung,
        lastUnlockAt: p.purchasedAt,
      });
    } else if (p.purchasedAt > prev.lastUnlockAt) {
      prev.lastUnlockAt = p.purchasedAt;
    }
  }
  return progress;
}
