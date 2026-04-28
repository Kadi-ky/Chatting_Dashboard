import { logger } from "../observability/logger.js";
import type { Phase } from "../state/types.js";
import type { LatestArchetypeRow } from "../db/repos/archetypes.js";
import type { PpvCatalogRow } from "../db/repos/ppv_catalog.js";
import {
  assetsPitchedWithin,
  countUnboughtRecentPitches,
  listRecentAttempts,
} from "../db/repos/ppv_attempts.js";
import { pickNextForFan } from "./scriptPicker.js";
import { getFunnelStep } from "./funnel.js";
import { sql, type SqlBool } from "kysely";
import { db } from "../db/client.js";

const COOLDOWN_DAYS = 14;

/**
 * How often a fan can see a new pitch, keyed by phase.
 *
 * WHALE was previously 2 (faster cadence than MONETIZING) — that was part of
 * the "whales get treated specially" pattern we removed 2026-04-27. WHALE now
 * paces identically to MONETIZING since the picker walks every fan through
 * the same script ladder regardless of spend. The phase still exists in the
 * state machine for analytics / observability but doesn't change pitch
 * behaviour anymore.
 */
const MIN_TURNS_BETWEEN_PITCHES: Record<Phase, number> = {
  WARMUP: Infinity,
  RAPPORT: Infinity,    // No pitching in rapport — bot is gathering signal.
  SEXTING: Infinity,    // No pitching in sexting either — bot is heating fan up.
  QUALIFYING: 1,        // First pitch lands here. After that, 1 msg between pitches
                        //   (preview turn → wait → ppv turn = naturally spaced).
  MONETIZING: 2,        // Repeat-buy cycle.
  WHALE: 2,
  REACTIVATION: Infinity,
  COLD: Infinity,
};

/**
 * REMOVED: PITCH_RAPPORT_GATE_TURNS turn-counter floor (was 8).
 *
 * Replaced with phase-based gating: pitches only fire in QUALIFYING+. The
 * state machine advances WARMUP → RAPPORT → SEXTING → QUALIFYING based on
 * temperature (intent classifier), so by the time a fan reaches QUALIFYING
 * they're demonstrably hot AND have spent meaningful turns warming up. This
 * makes the floor signal-driven instead of an arbitrary message count —
 * a fan who heats up fast can land a pitch by msg ~12, a slow fan never
 * gets force-pitched at all.
 */

export interface PitchDecision {
  shouldPitch: boolean;
  reason: string;
  /**
   * Which step of the two-turn funnel to send this turn:
   *   "preview" — free preview media + horny tease caption (no price)
   *   "ppv"     — priced PPV with caption
   * The funnel marks state in Redis: first time we pitch a rung we send
   * "preview", next turn (after fan replies) we send "ppv".
   */
  kind?: "preview" | "ppv";
  asset?: PpvCatalogRow;
  priceCents?: number;
  scriptNumber?: number;
  rung?: number;
  /**
   * Set when the fan asked for a SPECIFIC topic this turn (e.g. "feet") but
   * we have nothing in the catalog matching it. The persona should decline
   * gracefully — "sorry haven't recorded that yet but i have something" — and
   * NOT pitch the unrelated default content. Surfaced as turn guidance to
   * the LLM by the reply pipeline.
   */
  requestedTopicNotInVault?: string;
  /**
   * True when the fan asked for a discount this turn AND we honoured it by
   * knocking DISCOUNT_RATE off priceCents. Reply pipeline uses this to nudge
   * the LLM caption ("just for u i knocked a lil off"). The actual PPV bubble
   * already reflects the reduced price via priceCents.
   */
  discountApplied?: boolean;
  /**
   * Set when shouldPitch is false BECAUSE the bot's last UNBOUGHT_LOOKBACK
   * pitches were both ignored. Reply pipeline uses this to switch the persona
   * into rapport-recovery mode — share something personal, ask one real
   * question, stop dangling more content. Reset by the next unlock.
   */
  pitchRecoveryMode?: boolean;
  /**
   * Set when shouldPitch is TRUE under the support-drip cadence: fan has
   * been ignoring pitches but enough messages have passed since the last
   * one that we re-pitch with explicit "support me" framing. Reply pipeline
   * uses this to add task guidance about the support angle in the caption.
   */
  supportDripMode?: boolean;
  /**
   * Free preview media for the picked script. When set, the reply pipeline
   * sends this as a free media-attached bubble immediately before the priced
   * PPV — fan gets a tease for $0, then the close. Null when the picked
   * script has no preview configured.
   */
  previewMediaRef?: string;
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
  /** Total messages (inbound+outbound) in this conversation INCLUDING the just-arrived inbound. */
  turnIndex: number;
  /** Explicit ask from the fan this turn ("send me something"). Loosens gates. */
  explicitRequest?: boolean;
  /** Specific topic the fan asked for this turn (e.g. "feet"). Drives the picker's override path. */
  requestedTopic?: string | null;
  /** Fan asked for a discount this turn ("any discount?", "lower it"). When true and a pitch is otherwise approved, priceCents is reduced by DISCOUNT_RATE and discountApplied=true is set on the decision. */
  discountRequest?: boolean;
}

/** Fixed discount fans get when they ask. Configurable; bot frames as one-time gift. */
const DISCOUNT_RATE = 0.10;

/**
 * After this many of the most recent pitches in a conversation are still
 * unbought (and the fan has engaged further past them), suppress the next
 * pitch and force the bot into rapport-recovery mode for a few turns. Without
 * this, the bot would keep auto-pitching every 2-3 messages even when the
 * fan is silently ignoring everything she sends — burning through the script
 * ladder while the fan goes cold.
 */
const UNBOUGHT_LOOKBACK = 2;
/**
 * A pitch only counts as "unbought" if the fan has sent at least this many
 * inbound messages AFTER it without unlocking. Avoids false-positives in the
 * normal short window between "we just sent the PPV" and "they had a chance
 * to react."
 */
const UNBOUGHT_INBOUND_GATE = 2;

/**
 * SUPPORT-DRIP interval. After UNBOUGHT_LOOKBACK pitches go unopened, the bot
 * stops the regular cadence and only re-pitches every N messages with an
 * explicit "support me" framing. Prevents the bot from harassing a quiet
 * fan with constant pitches, while still keeping a sales option on the table
 * for fans who chat-only without ever buying.
 *
 * The "support" framing is added in the reply pipeline as turn guidance —
 * the bot asks the fan to "support me with this one" / "buy this to help me
 * out" rather than pitching purely as content delivery.
 */
const SUPPORT_DRIP_INTERVAL_TURNS = 10;

/**
 * Should we attach a PPV pitch to this outbound turn? Only phases QUALIFYING
 * and up are eligible. COLD, WARMUP, RAPPORT, REACTIVATION never pitch.
 *
 * Selection is delegated to the script picker, which consults the legacy
 * content_inventory_onlyfans table and the fan's purchase history. The picker
 * lazy-materialises a v3.ppv_catalog mirror row so downstream FKs resolve.
 */
export async function decidePitch(args: DecidePitchArgs): Promise<PitchDecision> {
  // Phase gate. Pitching only happens in QUALIFYING / MONETIZING / WHALE.
  // WARMUP / RAPPORT / SEXTING are heat-building phases — even an explicit
  // "send pic" buys nothing in those phases. The state machine advances on
  // temperature signal so a fan who's actually hot lands in QUALIFYING fast;
  // a chatty fan stays in RAPPORT and never gets force-pitched.
  const minTurns = MIN_TURNS_BETWEEN_PITCHES[args.phase];
  if (!Number.isFinite(minTurns)) {
    return { shouldPitch: false, reason: `phase ${args.phase} does not pitch` };
  }
  if (!args.explicitRequest && args.turnsSinceLastPitch < (minTurns as number)) {
    return { shouldPitch: false, reason: "pitch cooldown active" };
  }

  if (!args.creatorUuid) {
    return { shouldPitch: false, reason: "account missing creator_uuid" };
  }

  // Back-off + drip: if the fan has ignored the last N pitches (still pending
  // + they've sent inbound messages since), the bot is in "drip mode".
  //
  // BEFORE: full suppression — bot pivoted to rapport, never pitched again
  //         until fan unlocked or explicitly asked. Result: chat-only fans
  //         who never buy got infinite free attention.
  // NOW:    pitch ONCE every SUPPORT_DRIP_INTERVAL_TURNS messages with
  //         explicit "support me" framing. Fan gets quiet rapport between
  //         drips, but the bot still asks for the sale on a regular cadence
  //         instead of giving up.
  //
  // Explicit ask still overrides — fan says "send me" → immediate pitch.
  const unbought = await countUnboughtRecentPitches({
    conversationId: args.conversationId,
    lookback: UNBOUGHT_LOOKBACK,
    inboundSince: UNBOUGHT_INBOUND_GATE,
  });
  let dripPitch = false;
  if (unbought >= UNBOUGHT_LOOKBACK && !args.explicitRequest) {
    if (args.turnsSinceLastPitch >= SUPPORT_DRIP_INTERVAL_TURNS) {
      // Drip cadence reached — allow this pitch, flag it for support framing.
      dripPitch = true;
    } else {
      // Still inside the silent rapport window between drips.
      return {
        shouldPitch: false,
        reason: `pitch_recovery (last ${UNBOUGHT_LOOKBACK} pitches unbought, ${args.turnsSinceLastPitch}/${SUPPORT_DRIP_INTERVAL_TURNS} until next drip)`,
        pitchRecoveryMode: true,
      };
    }
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
    requestedTopic: args.requestedTopic ?? null,
  });
  if (!picked) {
    // If the fan asked for something specific and we have no match, signal
    // that to the caller so the persona can do a graceful "sorry haven't
    // recorded that yet" decline instead of silently saying nothing or
    // pitching unrelated content.
    if (args.requestedTopic) {
      return {
        shouldPitch: false,
        reason: `requested_topic_not_in_vault: ${args.requestedTopic}`,
        requestedTopicNotInVault: args.requestedTopic,
      };
    }
    return { shouldPitch: false, reason: "no eligible scripts after filtering" };
  }

  // If this exact asset was pitched within the cooldown window, skip. Note
  // "continuing" an in-progress script is still a different asset_id from the
  // previous rung, so cooldowns apply per-rung, not per-script.
  //
  // EXCEPTION: when the fan EXPLICITLY asks for content right now ("send me",
  // "how much", a buying signal), we bypass the cooldown. Otherwise on heavy
  // chat days the picker can run out of un-pitched assets and the bot stalls
  // forever — no pitches even when fans are explicitly buying. Better to
  // re-pitch a recently-shown asset than to never pitch and lose the sale.
  if (pitchedRecently.has(picked.asset.id)) {
    if (args.explicitRequest) {
      logger.info(
        { fanUuid: args.subscriberExternalId, assetId: picked.asset.id },
        "asset cooldown bypassed — fan explicitly asked for content",
      );
    } else {
      return { shouldPitch: false, reason: "asset pitched recently" };
    }
  }

  // Apply fan-requested discount AFTER picker has committed to an asset. We
  // never re-pick based on discount — discount is purely a price cut on the
  // already-selected pitch, framed as a one-time goodwill gesture by the bot.
  // The reply pipeline reads discountApplied to add a "knocked a lil off"
  // caption hint; the actual PPV bubble price comes from priceCents directly.
  const finalPriceCents = args.discountRequest
    ? Math.max(1, Math.round(picked.priceCents * (1 - DISCOUNT_RATE)))
    : picked.priceCents;

  // Two-turn funnel: first time we pitch a rung, send the FREE PREVIEW with
  // a tease caption. Next turn (after fan replies), send the priced PPV. If
  // the rung has no preview_media_id configured, skip straight to the PPV
  // step — preserves behavior for catalogs that haven't filled in previews.
  const funnelStep = await getFunnelStep(args.conversationId, picked.asset.id);
  let kind: "preview" | "ppv";
  if (funnelStep === "none" && picked.previewMediaRef) {
    kind = "preview";
  } else {
    // funnelStep === "preview_sent" → fan reacted, time for the priced PPV
    // funnelStep === "ppv_sent"     → fan didn't unlock yet; this code path
    //   shouldn't fire (drip / recovery handles it), but if it does we re-pitch
    //   the priced PPV (idempotent; new attempt row).
    // no preview configured                → straight to PPV
    kind = "ppv";
  }

  return {
    shouldPitch: true,
    reason: dripPitch
      ? `support_drip (every ${SUPPORT_DRIP_INTERVAL_TURNS} msgs after ${UNBOUGHT_LOOKBACK} unbought) [${kind}]`
      : picked.reason === "continue"
        ? `continue_script [${kind}]`
        : `new_script [${kind}]`,
    kind,
    asset: picked.asset,
    priceCents: finalPriceCents,
    scriptNumber: picked.scriptNumber,
    rung: picked.rung,
    ...(args.discountRequest ? { discountApplied: true } : {}),
    ...(dripPitch ? { supportDripMode: true } : {}),
    ...(picked.previewMediaRef ? { previewMediaRef: picked.previewMediaRef } : {}),
  };
}

/**
 * Messages since the last pitch in this conversation — for cooldown checks.
 *
 * NOW MESSAGE-BASED (was hour-based, which effectively never expired within
 * a single chat session — meaning auto-pitching in MONETIZING/WHALE rarely
 * fired in practice). Now counts actual messages (inbound + outbound) created
 * after the most recent pitch, so MIN_TURNS_BETWEEN_PITCHES values truly
 * mean "messages between pitches" — e.g. MONETIZING=3 → bot can re-pitch
 * after 3 messages, naturally landing within the same session.
 */
export async function turnsSinceLastPitch(conversationId: string): Promise<number> {
  const attempts = await listRecentAttempts(conversationId, 1);
  if (attempts.length === 0) return Infinity;
  const lastPitchAt = attempts[0]!.pitchedAt;
  const row = await db
    .selectFrom("v3.messages")
    .select(db.fn.count<string>("id").as("count"))
    .where("conversation_id", "=", conversationId)
    .where(sql<SqlBool>`created_at > ${lastPitchAt}`)
    .where("direction", "in", ["inbound", "outbound"])
    .executeTakeFirst();
  return Number(row?.count ?? 0);
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
  RECENT_PITCH_DECISIONS.unshift({
    at: new Date().toISOString(),
    conversationId,
    shouldPitch: d.shouldPitch,
    reason: d.reason,
    assetId: d.asset?.id ?? null,
    priceCents: d.priceCents ?? null,
    scriptNumber: d.scriptNumber ?? null,
    rung: d.rung ?? null,
  });
  if (RECENT_PITCH_DECISIONS.length > RECENT_PITCH_DECISIONS_MAX) {
    RECENT_PITCH_DECISIONS.length = RECENT_PITCH_DECISIONS_MAX;
  }
}

interface RecentPitchDecision {
  at: string;
  conversationId: string;
  shouldPitch: boolean;
  reason: string;
  assetId: string | null;
  priceCents: number | null;
  scriptNumber: number | null;
  rung: number | null;
}
const RECENT_PITCH_DECISIONS: RecentPitchDecision[] = [];
const RECENT_PITCH_DECISIONS_MAX = 50;
export function getRecentPitchDecisions(): RecentPitchDecision[] {
  return RECENT_PITCH_DECISIONS.slice();
}
