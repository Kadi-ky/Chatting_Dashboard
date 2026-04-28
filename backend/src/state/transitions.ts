import { env } from "../config/index.js";
import type { Signals, Transition } from "./types.js";

/**
 * Declarative transitions. Order matters: first match wins on each tick.
 * Every rule is a pure function of Signals — no DB, no network, no clocks
 * beyond what's precomputed into the bundle.
 *
 * Priority ordering:
 *   1. Dead-end detectors (COLD, REACTIVATION) — they should catch fast.
 *   2. Elevators (WHALE) — expensive users get special handling first.
 *   3. Forward progress (WARMUP → RAPPORT → QUALIFYING → MONETIZING).
 *   4. LLM-suggested hints (last-resort — only when the explicit rules don't fire).
 */
export const TRANSITIONS: Transition[] = [
  // ─── Dead-end detectors ───────────────────────────────────────────────
  {
    from: "*",
    to: "COLD",
    trigger: "excessive_pitches_no_spend",
    when: (s) =>
      s.phase !== "COLD" &&
      s.ppvOffersSinceUnlock >= 4 &&
      s.spendTotalCents === 0 &&
      s.avgInboundWords < 5,
  },
  {
    from: "*",
    to: "REACTIVATION",
    trigger: "dormant_7d",
    when: (s) =>
      s.phase !== "COLD" &&
      s.phase !== "REACTIVATION" &&
      s.hoursSinceLastInbound !== null &&
      s.hoursSinceLastInbound >= 168,
  },

  // ─── WHALE elevator — short-circuits everything once spend is large ──
  {
    from: "*",
    to: "WHALE",
    trigger: "whale_spend_threshold",
    when: (s) => s.phase !== "WHALE" && s.spend30dCents >= env.WHALE_SPEND_30D_CENTS,
  },

  // ─── Forward progression through the funnel ───────────────────────────
  // FUNNEL DESIGN (rewritten 2026-04-28):
  //   WARMUP   →  RAPPORT  →  SEXTING  →  QUALIFYING  →  MONETIZING  →  WHALE
  //
  // Transitions are temperature-gated, not turn-counter-gated:
  //   - WARMUP → RAPPORT: 2+ turns OR fan got flirty fast (temperature warm/hot)
  //   - RAPPORT → SEXTING: 6+ turns in rapport AND fan is at least warm.
  //                        Hot-fan shortcut: 3+ turns in rapport AND temp=hot.
  //   - SEXTING → QUALIFYING: 4+ turns in sexting AND temp=hot. (First pitch
  //                           lands in QUALIFYING — this is the floor.)
  //
  // SEXTING is a NEW phase: bot actively initiates sexual content (narrates,
  // describes body, escalates) but does NOT pitch yet. Goal is to get the
  // fan visibly aroused before any priced PPV. The orchestrator's
  // MIN_TURNS_BETWEEN_PITCHES enforces "no pitch in SEXTING" at the pitch-
  // decision layer, but the directive in directives.ts is the primary signal
  // to the LLM.
  //
  // Slow / cold fans naturally stall in RAPPORT — they never trip the
  // temperature gate, so they never get force-pitched. That's the whole point.
  {
    from: "WARMUP",
    to: "RAPPORT",
    trigger: "warmup_complete",
    when: (s) => s.turnsInPhase >= 2,
  },
  {
    from: "RAPPORT",
    to: "SEXTING",
    trigger: "rapport_warm",
    when: (s) =>
      (s.turnsInPhase >= 6 && (s.temperature === "warm" || s.temperature === "hot")) ||
      (s.turnsInPhase >= 3 && s.temperature === "hot"),
  },
  {
    from: "SEXTING",
    to: "QUALIFYING",
    trigger: "sexting_hot",
    when: (s) => s.turnsInPhase >= 4 && s.temperature === "hot",
  },
  {
    from: "QUALIFYING",
    to: "MONETIZING",
    trigger: "first_unlock",
    when: (s) => s.hasEverUnlocked,
  },
  {
    from: "REACTIVATION",
    to: "RAPPORT",
    trigger: "reactivation_reply",
    when: (s) =>
      s.hoursSinceLastInbound !== null &&
      s.hoursSinceLastInbound < 24 &&
      s.turnsInPhase >= 2,
  },

  // ─── LLM-suggested hints (lowest priority) ────────────────────────────
  {
    from: "*",
    to: "WARMUP",
    trigger: "llm_hint",
    when: (s) => s.phaseTransitionHint === "WARMUP" && s.phase !== "WARMUP",
  },
  {
    from: "*",
    to: "RAPPORT",
    trigger: "llm_hint",
    when: (s) => s.phaseTransitionHint === "RAPPORT" && s.phase !== "RAPPORT",
  },
  {
    from: "*",
    to: "SEXTING",
    trigger: "llm_hint",
    when: (s) => s.phaseTransitionHint === "SEXTING" && s.phase !== "SEXTING",
  },
  {
    from: "*",
    to: "QUALIFYING",
    trigger: "llm_hint",
    when: (s) => s.phaseTransitionHint === "QUALIFYING" && s.phase !== "QUALIFYING",
  },
  {
    from: "*",
    to: "MONETIZING",
    trigger: "llm_hint",
    when: (s) => s.phaseTransitionHint === "MONETIZING" && s.phase !== "MONETIZING",
  },
];

export interface EvaluatedTransition {
  to: Transition["to"];
  trigger: string;
}

/**
 * Evaluate all transitions against the current signals; return the first match
 * or null if no transition applies. Pure function — callers persist the result.
 */
export function evaluateTransitions(
  signals: Signals,
  all: Transition[] = TRANSITIONS,
): EvaluatedTransition | null {
  for (const t of all) {
    if (t.from !== "*" && t.from !== signals.phase) continue;
    if (t.to === signals.phase) continue; // no self-transitions
    if (t.when(signals)) return { to: t.to, trigger: t.trigger };
  }
  return null;
}
