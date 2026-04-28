import type { Phase } from "../db/types.js";

export type { Phase };

/**
 * Bundle passed to every transition predicate. Built by bundleLoader. Keep
 * this narrow: if the state machine needs something new, add it here and
 * compute it once, so transitions stay pure functions of `Signals`.
 */
export interface Signals {
  phase: Phase;
  /** Null means no substate set. */
  substate: string | null;
  /** Monotonic clock of turns spent in the current phase. */
  turnsInPhase: number;
  /** Total messages in conversation (both directions). */
  totalTurns: number;
  /** Hours since last inbound, or null if no inbound ever. */
  hoursSinceLastInbound: number | null;

  /** Subscriber spend rollups. */
  spendTotalCents: number;
  spend30dCents: number;

  /** How many times we've pitched since this subscriber's last unlock. */
  ppvOffersSinceUnlock: number;
  /** Average inbound word count over the last ~10 replies. Used for COLD detection. */
  avgInboundWords: number;
  /** True if the user has ever unlocked anything. */
  hasEverUnlocked: boolean;

  /** Subscriber facts count (for RAPPORT qualification). */
  factCount: number;
  preferenceCount: number;

  /** Optional LLM-suggested hint from the previous turn's output. */
  phaseTransitionHint: Phase | null;

  /**
   * Sexual-readiness signal classified from the fan's most recent inbound.
   *   "cold" → chatty / neutral / asking factual questions, no flirt
   *   "warm" → flirting back, complimenting body, light innuendo
   *   "hot"  → openly sexual / aroused / asking for content / "fuck", "horny", graphic language
   * Drives RAPPORT → SEXTING and SEXTING → QUALIFYING transitions so the
   * funnel advances on the FAN'S energy, not a turn counter.
   */
  temperature: "cold" | "warm" | "hot";
}

export interface Transition {
  /** Source phase or "*" to match anywhere. */
  from: Phase | "*";
  to: Phase;
  /** Pure predicate — MUST NOT have side effects or IO. */
  when: (s: Signals) => boolean;
  /** Free-form trigger label written to state_transitions.trigger. */
  trigger: string;
}

/** Per-phase directive injected into the L4 STATE layer. */
export interface PhaseDirective {
  /** Short imperative rendered into the prompt. */
  directive: string;
  /** Things the generator must not do in this phase. */
  forbiddens: string[];
  /** If true, the reply pipeline skips the LLM entirely and sends a canned reply. */
  canned?: boolean;
  /** Context window override for this phase (WHALE widens, COLD narrows). */
  contextWindow?: number;
}
