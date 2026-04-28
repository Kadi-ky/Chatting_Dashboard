import { logger } from "../observability/logger.js";
import { evaluateTransitions } from "./transitions.js";
import { applyPhaseTransition, bumpTurnsInPhase } from "../db/repos/conversations.js";
import { logStateTransition } from "../db/repos/state_transitions.js";
import { loadBundle } from "./bundle.js";
import type { Phase } from "./types.js";

export interface TickResult {
  phase: Phase;
  transitioned: boolean;
  trigger: string | null;
}

/**
 * State-machine tick. Called once per inbound turn, BEFORE reply generation so
 * the new phase's directive drives the L4 prompt layer. Bumps turns_in_phase,
 * evaluates transitions, applies the first match (if any), writes audit row.
 *
 * If no transition fires, still returns the current phase so callers can pull
 * the right directive without a second DB round-trip.
 */
export async function tickStateMachine(args: {
  conversationId: string;
  subscriberId: string;
  phaseTransitionHint?: Phase | null;
  /** Sexual-readiness signal from THIS inbound — drives RAPPORT → SEXTING → QUALIFYING. */
  temperature?: "cold" | "warm" | "hot";
}): Promise<TickResult | null> {
  // Bump first so turnsInPhase reflects "this turn" in predicates below.
  await bumpTurnsInPhase(args.conversationId);

  const bundle = await loadBundle(args);
  if (!bundle) return null;

  const t = evaluateTransitions(bundle.signals);
  if (!t) return { phase: bundle.phase, transitioned: false, trigger: null };

  await applyPhaseTransition(args.conversationId, t.to);
  await logStateTransition({
    conversationId: args.conversationId,
    fromPhase: bundle.phase,
    toPhase: t.to,
    trigger: t.trigger,
    meta: { signals: bundle.signals },
  });

  logger.info(
    { conversationId: args.conversationId, from: bundle.phase, to: t.to, trigger: t.trigger },
    "phase transition",
  );

  return { phase: t.to, transitioned: true, trigger: t.trigger };
}
