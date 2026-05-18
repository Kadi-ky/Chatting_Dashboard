import { logger } from "../observability/logger.js";
import { listScriptsForCreator, type ContentScript, type ContentRung } from "../db/repos/content_inventory.js";
import { listPurchasesByFan } from "../db/repos/purchases.js";

/**
 * Voucher asset picker.
 *
 * Picks ONE asset (script + rung) the fan has NOT bought yet, so the voucher
 * is always relevant content the fan doesn't already own. Operator brief
 * 2026-05-14: "different PPV based on what they bought so we will not send
 * what they already bought before".
 *
 * Selection strategy:
 *   1. Load creator's full catalog.
 *   2. Load fan's purchase history.
 *   3. Compute the set of (script_number, rung) tuples they own.
 *   4. From the unowned set, prefer SCRIPTS the fan has never touched at
 *      all (variety over depth). If they own all scripts at rung 1, the
 *      next-rung pick of an already-touched script is fine.
 *   5. Random pick from the eligible set (so repeat sends don't always
 *      offer the same asset).
 *
 * Returns null when the fan has bought everything in the catalog (rare
 * but real for whales — caller should skip vouchering that fan).
 */

export interface VoucherPick {
  scriptId: string;
  scriptNumber: number;
  scriptName: string | null;
  rung: number;
  mediaId: string;
  basePriceCents: number;
  description: string | null;
}

export async function pickVoucherAsset(args: {
  fanExternalId: string;
  creatorUuid: string;
}): Promise<VoucherPick | null> {
  const [scripts, purchases] = await Promise.all([
    listScriptsForCreator(args.creatorUuid),
    listPurchasesByFan(args.fanExternalId, args.creatorUuid).catch(() => []),
  ]);

  if (scripts.length === 0) {
    logger.warn({ creatorUuid: args.creatorUuid }, "voucher picker: empty catalog");
    return null;
  }

  // Build set of owned (scriptNumber, rung) tuples
  const owned = new Set<string>();
  const ownedScripts = new Set<number>();
  for (const p of purchases) {
    if (p.scriptNumber == null) continue;
    owned.add(`${p.scriptNumber}:${p.rung ?? 0}`);
    ownedScripts.add(p.scriptNumber);
  }

  // Flatten catalog to (script, rung) pickables with media_id present.
  type Pickable = { script: ContentScript; rung: ContentRung };
  const all: Pickable[] = [];
  for (const s of scripts) {
    for (const r of s.rungs) {
      if (!r.mediaId) continue;
      if (owned.has(`${s.scriptNumber}:${r.rung}`)) continue;
      all.push({ script: s, rung: r });
    }
  }

  if (all.length === 0) {
    logger.info(
      { fanExternalId: args.fanExternalId, creatorUuid: args.creatorUuid },
      "voucher picker: fan owns entire catalog, skipping",
    );
    return null;
  }

  // Prefer pickables on scripts the fan has NEVER touched (variety).
  const untouched = all.filter((p) => !ownedScripts.has(p.script.scriptNumber));
  const candidates = untouched.length > 0 ? untouched : all;

  // Random pick across ALL unbought pickables — operator-observed 2026-05-17:
  // the prior "bottom third by rung" formula collapsed on small catalogs.
  // When a creator has only 1-2 scripts and fans have empty purchase history,
  // bottom-third floor(N/3) returned 1 pickable → every fan got the SAME
  // asset → identical caption descriptions → mass-send template lock at
  // the asset level. Random across all unbought maximizes diversity given
  // whatever catalog depth the creator has. Voucher pricing already
  // bumps to the $50-$99 tier regardless of base rung, so picking higher
  // rungs doesn't change the fan's voucher price — they all feel the same.
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;

  return {
    scriptId: pick.script.id,
    scriptNumber: pick.script.scriptNumber,
    scriptName: pick.script.scriptName,
    rung: pick.rung.rung,
    mediaId: pick.rung.mediaId!,
    basePriceCents: pick.rung.priceCents,
    description: pick.rung.description,
  };
}
