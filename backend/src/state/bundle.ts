import type { Signals, Phase } from "./types.js";
import { loadConversationState } from "../db/repos/conversations.js";
import { loadSubscriberSignals } from "../db/repos/subscribers.js";
import { loadRecentMessages } from "../db/repos/messages.js";

export interface LoadedBundle {
  signals: Signals;
  phase: Phase;
}

/**
 * Build a Signals bundle for the state machine from the DB. Pure read — does
 * not mutate anything. Callers apply transitions and persist the result.
 */
export async function loadBundle(args: {
  conversationId: string;
  subscriberId: string;
  phaseTransitionHint?: Phase | null;
  /** Temperature classification of this turn's inbound. Drives RAPPORT → SEXTING → QUALIFYING transitions. */
  temperature?: "cold" | "warm" | "hot";
}): Promise<LoadedBundle | null> {
  const [conv, sub, recent] = await Promise.all([
    loadConversationState(args.conversationId),
    loadSubscriberSignals(args.subscriberId),
    loadRecentMessages(args.conversationId, 10),
  ]);
  if (!conv || !sub) return null;

  const inboundTexts = recent.filter((m) => m.direction === "inbound" && m.text);
  const avgInboundWords =
    inboundTexts.length === 0
      ? 0
      : inboundTexts.reduce((acc, m) => acc + (m.text ? m.text.trim().split(/\s+/).length : 0), 0) /
        inboundTexts.length;

  const hoursSinceLastInbound =
    sub.lastInboundAt == null
      ? null
      : (Date.now() - sub.lastInboundAt.getTime()) / 3_600_000;

  const signals: Signals = {
    phase: conv.phase,
    substate: conv.substate,
    turnsInPhase: conv.turnsInPhase,
    totalTurns: recent.length, // coarse; full count is countConversationTurns
    hoursSinceLastInbound,
    spendTotalCents: sub.totalSpendCents,
    spend30dCents: sub.spend30dCents,
    ppvOffersSinceUnlock: sub.ppvOffersSinceUnlock,
    avgInboundWords,
    hasEverUnlocked: sub.hasEverUnlocked,
    factCount: sub.factCount,
    preferenceCount: sub.preferenceCount,
    phaseTransitionHint: args.phaseTransitionHint ?? null,
    temperature: args.temperature ?? "cold",
  };

  return { signals, phase: conv.phase };
}
