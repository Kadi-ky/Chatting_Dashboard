import { logger } from "../observability/logger.js";
import type { Phase } from "../state/types.js";
import type { LatestArchetypeRow } from "../db/repos/archetypes.js";
import type { PpvCatalogRow } from "../db/repos/ppv_catalog.js";
import {
  countUnboughtRecentPitches,
  listRecentAttempts,
} from "../db/repos/ppv_attempts.js";
import { pickNextForFan } from "./scriptPicker.js";
import { getFunnelStep, clearFunnel } from "./funnel.js";
import { analyzePitchReadiness } from "./pitchReadiness.js";
import type { IntentFlags } from "../classify/intent.js";
import { sql, type SqlBool } from "kysely";
import { db } from "../db/client.js";

// Asset cooldown was REMOVED 2026-04-29. Old behavior: don't pitch the same
// asset_id (per-rung paywalled bubble) to a fan within 14 days. Reasoning at
// the time: anti-fatigue. Reality on production:
//   - Fans never see the asset's contents (it's locked) — they only see the
//     LLM-generated caption, which varies every turn.
//   - The cooldown directly contradicted support-drip: drip says "re-pitch
//     in 10 turns after 2 unbought" but cooldown said "no, wait 14 days."
//     Drip lost every time. Documented "Lost sale" symptom 2026-04-29.
// Funnel state (per (conversation, asset) Redis flag with 24h TTL) still
// gates same-asset re-pitch within a single chat session, except in drip
// mode where re-pitching with new caption + support framing is the whole
// point. That gives us the sane spacing without freezing chat-only fans.

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
   * Set when the discount was triggered by a cant_afford signal (fan said
   * "i'm broke / next paycheck"), not a haggle. Caption framing is warmer:
   * "i got u babe, knockin some off just for u tonight" rather than the
   * cooler "ok ok lemme knock a lil off." The actual price math is the same
   * (CANT_AFFORD_DISCOUNT_RATE applied to the prior pending asset's price).
   */
  cantAffordDiscount?: boolean;
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
  /** Fan signaled cant_afford this turn ("im broke", "no money", "only got $15 left"). When true the orchestrator re-pitches the most recent pending asset at CANT_AFFORD_DISCOUNT_RATE off and bypasses funnel/cooldown — turning a "lost sale" objection into a closed sale at lower price. */
  cantAfford?: boolean;
  /**
   * Full intent classification this turn — passed to the pitch-readiness
   * analyzer as a cheap-signal hint (NOT used as the override gate). Optional
   * for callers that don't have it (broadcasts, tests).
   */
  intent?: IntentFlags;
}

/** Fixed discount fans get when they ask. Configurable; bot frames as one-time gift. */
const DISCOUNT_RATE = 0.10;

/**
 * Bigger discount when fan explicitly says they CAN'T AFFORD the pitch.
 * Distinct from discount_request (haggling). cant_afford is "i'm broke / next
 * paycheck / only got $X left" — operator directive 2026-04-30: don't lose
 * the sale to a "can't pay today" objection; meet them where they are with
 * a meaningful drop and close at the lower price tonight rather than promise
 * to hold something for next month.
 */
const CANT_AFFORD_DISCOUNT_RATE = 0.30;

/**
 * After this many of the most recent pitches in a conversation are still
 * unbought (and the fan has engaged further past them), suppress the next
 * pitch and force the bot into rapport-recovery mode for a few turns. Without
 * this, the bot would keep auto-pitching every 2-3 messages even when the
 * fan is silently ignoring everything she sends — burning through the script
 * ladder while the fan goes cold.
 */
// Operator decision (2026-04-29): drip should fire after a SINGLE ignored
// pitch, not 2. The previous 2-pitch threshold was leaving fans with one
// pending PPV in indefinite limbo because the funnel `ppv_sent` block
// applied but drip never engaged to clear it. With 1, any fan whose last
// pitch went unbought + has chatted past it qualifies for the 10-turn
// drip re-pitch.
const UNBOUGHT_LOOKBACK = 1;
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
  // Hard guards (not phase-based — these always block):
  //   - COLD / REACTIVATION never pitch
  //   - Cooldown when not asked
  //
  // The heuristic bypasses (`explicitRequest`, `specificAskOverride`,
  // `previewOnly`) used to live here. They were retired in favor of the
  // pitch-readiness LLM analyzer below, which reads the full conversation
  // context and decides whether it's actually time to pitch — instead of
  // firing on word-list matches like "what kinda photoshoot? sounds hot"
  // that the regex/LLM classifier flagged as buying signals.
  if (args.phase === "COLD" || args.phase === "REACTIVATION") {
    return { shouldPitch: false, reason: `phase ${args.phase} does not pitch` };
  }
  const minTurns = MIN_TURNS_BETWEEN_PITCHES[args.phase];
  if (
    Number.isFinite(minTurns) &&
    !args.explicitRequest &&
    args.turnsSinceLastPitch < (minTurns as number)
  ) {
    return { shouldPitch: false, reason: "pitch cooldown active" };
  }

  if (!args.creatorUuid) {
    return { shouldPitch: false, reason: "account missing creator_uuid" };
  }

  // CANT_AFFORD discount path — operator directive 2026-04-30. Fan said
  // they can't pay right now ("im broke", "next paycheck", "only $X left").
  // Don't lose the sale to a price objection. Find the most recent pending
  // pitch in this conversation; if it exists, re-fire that exact asset at
  // 30% off + bypass funnel/cooldown blocks. Caption framing is "i got u
  // babe, knockin some off just for u tonight" via task-layer hint. This
  // is the single highest-leverage objection-handling path in the funnel.
  if (args.cantAfford) {
    const recent = await listRecentAttempts(args.conversationId, 5);
    const lastPending = recent.find((a) => a.outcome === "pending");
    if (lastPending) {
      const { loadCatalogItem } = await import("../db/repos/ppv_catalog.js");
      const asset = await loadCatalogItem(lastPending.assetId);
      if (asset) {
        const discountedPrice = Math.max(
          1,
          Math.round(lastPending.priceCents * (1 - CANT_AFFORD_DISCOUNT_RATE)),
        );
        await clearFunnel(args.conversationId, lastPending.assetId);
        logger.info(
          {
            conversationId: args.conversationId,
            assetId: lastPending.assetId,
            originalPrice: lastPending.priceCents,
            discountedPrice,
          },
          "cant_afford detected — re-pitching last pending asset at 30% off",
        );
        return {
          shouldPitch: true,
          reason: `cant_afford (re-pitching last pending asset @ ${Math.round((1 - CANT_AFFORD_DISCOUNT_RATE) * 100)}% of original)`,
          kind: "ppv",
          asset,
          priceCents: discountedPrice,
          discountApplied: true,
          cantAffordDiscount: true,
        };
      }
    }
    // No pending pitch to discount — fall through to normal flow. The
    // task layer can still suggest a soft retention beat next turn if
    // nothing fires this turn.
    logger.debug(
      { conversationId: args.conversationId },
      "cant_afford detected but no recent pending pitch to discount; falling through",
    );
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
      // Still inside the silent rapport window between drips. Operator
      // dropped pitchRecoveryMode 2026-04-30: the "be a person, share a
      // life detail" guidance contradicted post-PPV close-focus. Now we
      // just return no-pitch for this turn; close-focus + post-unlock
      // push handle the messaging when there's a recent pending PPV.
      return {
        shouldPitch: false,
        reason: `drip_window (last ${UNBOUGHT_LOOKBACK} pitches unbought, ${args.turnsSinceLastPitch}/${SUPPORT_DRIP_INTERVAL_TURNS} until next drip)`,
      };
    }
  }

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

  // Asset cooldown removed (see file header). Funnel state below handles
  // intra-session spacing; drip mode handles cross-session re-engagement.

  // Apply fan-requested discount AFTER picker has committed to an asset. We
  // never re-pick based on discount — discount is purely a price cut on the
  // already-selected pitch, framed as a one-time goodwill gesture by the bot.
  // The reply pipeline reads discountApplied to add a "knocked a lil off"
  // caption hint; the actual PPV bubble price comes from priceCents directly.
  const finalPriceCents = args.discountRequest
    ? Math.max(1, Math.round(picked.priceCents * (1 - DISCOUNT_RATE)))
    : picked.priceCents;

  // Pitch-readiness analyzer — LLM reads the conversation in full and
  // decides whether this turn should pitch (and what kind), instead of the
  // old word-list bypass rules.
  const funnelStep = await getFunnelStep(args.conversationId, picked.asset.id);
  const readiness = await analyzePitchReadiness({
    conversationId: args.conversationId,
    phase: args.phase,
    turnIndex: args.turnIndex,
    funnelStep,
    ...(args.intent ? { intent: args.intent } : {}),
  });

  // Map decision to outcome.
  // EXCEPTION: drip mode forces a re-pitch every SUPPORT_DRIP_INTERVAL_TURNS
  // regardless of what the AI analyzer thinks. Operator directive
  // (2026-04-29): "AS LONG AS THE CONVERSATION REACHES THE 10th TURN AFTER
  // THE LAST ONE BEING IGNORED, IT SHOULD SEND IT AGAIN." If drip says fire,
  // we fire — the analyzer's rapport/sext_more/decline_softly veto is
  // bypassed. Below the drip path the analyzer still gates first-time
  // pitches and other normal-flow turns.
  if (!dripPitch && (readiness.decision === "rapport" || readiness.decision === "sext_more")) {
    return {
      shouldPitch: false,
      reason: `pitch_readiness=${readiness.decision} (${readiness.reasoning})`,
    };
  }
  if (!dripPitch && readiness.decision === "decline_softly") {
    return {
      shouldPitch: false,
      reason: `pitch_readiness=decline_softly (${readiness.reasoning})`,
    };
  }
  if (dripPitch && (readiness.decision === "rapport" || readiness.decision === "sext_more" || readiness.decision === "decline_softly")) {
    logger.info(
      { conversationId: args.conversationId, aiDecision: readiness.decision, turnsSinceLastPitch: args.turnsSinceLastPitch },
      "drip pitch overriding AI readiness analyzer — 10+ turns since last ignored pitch",
    );
  }

  // 2-turn funnel guards — the FUNNEL STATE is structural truth, the AI
  // decision is only consulted to choose between preview-now vs hold-back.
  // The AI cannot skip the teaser step for a new asset.
  //
  // EXCEPTION (added 2026-04-29): drip mode (`dripPitch=true`) is allowed
  // to re-fire the same priced PPV even when funnelStep="ppv_sent". The
  // whole point of drip is "fan ignored the last few pitches — try again
  // every 10 turns with new caption + support framing." Without this
  // bypass, drip silently lost every "ignored PPV1" sale because funnel
  // state still said the asset was pitched. Funnel state is cleared
  // afterwards so the next non-drip turn behaves normally.
  if (funnelStep === "ppv_sent" && !dripPitch) {
    return {
      shouldPitch: false,
      reason: `funnelStep=ppv_sent for asset ${picked.asset.id} — refusing duplicate priced PPV`,
    };
  }
  if (funnelStep === "ppv_sent" && dripPitch) {
    logger.info(
      { conversationId: args.conversationId, assetId: picked.asset.id },
      "drip pitch bypassing funnel ppv_sent — clearing funnel state for re-pitch",
    );
    await clearFunnel(args.conversationId, picked.asset.id);
  }

  let kind: "preview" | "ppv";
  if (picked.previewMediaRef && funnelStep === "none") {
    // New asset + preview is configured → ALWAYS start with the teaser,
    // regardless of what AI decided. The AI can still gate "rapport" /
    // "sext_more" above to defer pitching at all. But once we're pitching
    // a new asset, the structural rule is teaser → wait → priced PPV.
    kind = "preview";
  } else if (readiness.decision === "preview") {
    // AI wanted preview but either preview already sent (funnelStep) or
    // no preview asset configured. Step back to rapport.
    return {
      shouldPitch: false,
      reason: !picked.previewMediaRef
        ? `pitch_readiness=preview but asset has no preview_media_id; staying in rapport`
        : `pitch_readiness=preview but funnelStep=${funnelStep}; skipping double-preview`,
    };
  } else {
    // funnelStep === "preview_sent" → fan saw the teaser, now the priced PPV.
    // OR: asset has no preview configured → straight to priced.
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
