import { logger } from "../observability/logger.js";
import type { Phase } from "../state/types.js";
import type { LatestArchetypeRow } from "../db/repos/archetypes.js";
import type { PpvCatalogRow } from "../db/repos/ppv_catalog.js";
import {
  assetsPitchedWithin,
  listRecentAttempts,
} from "../db/repos/ppv_attempts.js";
import { pickNextForFan } from "./scriptPicker.js";

const COOLDOWN_DAYS = 14;

/** How often a fan can see a new pitch, keyed by phase. */
const MIN_TURNS_BETWEEN_PITCHES: Record<Phase, number> = {
  WARMUP: Infinity, // never in warmup
  RAPPORT: Infinity, // not yet — soft teasing only
  QUALIFYING: 5,
  MONETIZING: 3,
  WHALE: 2,
  REACTIVATION: Infinity, // never on a reactivation turn itself
  COLD: Infinity,
};

export interface PitchDecision {
  shouldPitch: boolean;
  reason: string;
  asset?: PpvCatalogRow;
  priceCents?: number;
  scriptNumber?: number;
  rung?: number;
}

export interface DecidePitchArgs {
  accountId: string;
  /** Legacy creator id — keys content_inventory_onlyfans + purchases_onlyfans. */
  creatorUuid: string | null;
  subscriberId: string;
  subscriberExternalId: string;
  conversationId: string;
  phase: Phase;
  archetype: LatestArchetypeRow | null;
  /** How many turns since the last pitch in this conversation. */
  turnsSinceLastPitch: number;
  /** Explicit ask from the fan this turn ("send me something"). Loosens gates. */
  explicitRequest?: boolean;
}

/**
 * Should we attach a PPV pitch to this outbound turn? Only phases QUALIFYING
 * and up are eligible. COLD, WARMUP, RAPPORT, REACTIVATION never pitch.
 *
 * Selection is delegated to the script picker, which consults the legacy
 * content_inventory_onlyfans table and the fan's purchase history. The picker
 * lazy-materialises a v3.ppv_catalog mirror row so downstream FKs resolve.
 */
export async function decidePitch(args: DecidePitchArgs): Promise<PitchDecision> {
  const minTurns = MIN_TURNS_BETWEEN_PITCHES[args.phase];
  if (!args.explicitRequest && !Number.isFinite(minTurns)) {
    return { shouldPitch: false, reason: `phase ${args.phase} does not pitch` };
  }
  if (!args.explicitRequest && args.turnsSinceLastPitch < (minTurns as number)) {
    return { shouldPitch: false, reason: "pitch cooldown active" };
  }

  if (!args.creatorUuid) {
    return { shouldPitch: false, reason: "account missing creator_uuid" };
  }

  const pitchedRecently = new Set(
    await assetsPitchedWithin({
      subscriberId: args.subscriberId,
      days: COOLDOWN_DAYS,
    }),
  );

  const picked = await pickNextForFan({
    accountId: args.accountId,
    creatorUuid: args.creatorUuid,
    fanUuid: args.subscriberExternalId,
    archetype: args.archetype,
    phase: args.phase,
  });
  if (!picked) {
    return { shouldPitch: false, reason: "no eligible scripts after filtering" };
  }

  // If this exact asset was pitched within the cooldown window, skip. Note
  // "continuing" an in-progress script is still a different asset_id from the
  // previous rung, so cooldowns apply per-rung, not per-script.
  if (pitchedRecently.has(picked.asset.id)) {
    return { shouldPitch: false, reason: "asset pitched recently" };
  }

  return {
    shouldPitch: true,
    reason: picked.reason === "continue" ? "continue_script" : "new_script",
    asset: picked.asset,
    priceCents: picked.priceCents,
    scriptNumber: picked.scriptNumber,
    rung: picked.rung,
  };
}

/**
 * Turns since the last pitch in this conversation — for cooldown checks.
 * Counts pitches as turns on their own, approximate but good enough.
 */
export async function turnsSinceLastPitch(conversationId: string): Promise<number> {
  const attempts = await listRecentAttempts(conversationId, 1);
  if (attempts.length === 0) return Infinity;
  const ageMs = Date.now() - attempts[0]!.pitchedAt.getTime();
  // Use a crude "1 turn per hour active" — replaced by actual turn counting if needed later.
  return Math.max(1, Math.floor(ageMs / 3_600_000));
}

export function logPitchDecision(conversationId: string, d: PitchDecision): void {
  logger.debug(
    {
      conversationId,
      shouldPitch: d.shouldPitch,
      reason: d.reason,
      assetId: d.asset?.id ?? null,
      priceCents: d.priceCents ?? null,
    },
    "pitch decision",
  );
}
