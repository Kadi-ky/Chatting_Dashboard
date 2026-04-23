import type { TimingOptions } from "./timing.js";

/**
 * Pacing A/B rig. Deterministically buckets conversations into a small set
 * of timing variants so we can measure which cadence lifts unlock rate. The
 * bucket id is emitted on pitch/unlock metrics, letting the analytics side
 * slice conversion by variant without us needing a separate experiment table.
 *
 * Keep the variant set small (≤4) — every new variant splits traffic and
 * hurts statistical power. Retire losers; promote winners to control.
 */
export interface PacingVariant {
  id: string;
  wpm: number;
  wpmStd: number;
  readTimeMs: number;
  readTimeStdMs: number;
  interBubbleGapMs: number;
}

const CONTROL: PacingVariant = {
  id: "control",
  wpm: 62,
  wpmStd: 10,
  readTimeMs: 800,
  readTimeStdMs: 600,
  interBubbleGapMs: 400,
};

/**
 * Ordered list with `control` first so assignment distribution is explicit.
 * Hash slot 0 → control, 1 → fast, 2 → slow.
 */
const VARIANTS: PacingVariant[] = [
  CONTROL,
  {
    id: "fast",
    wpm: 75,
    wpmStd: 8,
    readTimeMs: 400,
    readTimeStdMs: 300,
    interBubbleGapMs: 250,
  },
  {
    id: "slow",
    wpm: 50,
    wpmStd: 12,
    readTimeMs: 1600,
    readTimeStdMs: 800,
    interBubbleGapMs: 800,
  },
];

export const PACING_VARIANTS: readonly PacingVariant[] = VARIANTS;

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pick a variant for the given conversation id. Deterministic — same
 * conversation always lands in the same bucket, so a fan's experience is
 * consistent across turns and restarts.
 */
export function pickPacingVariant(conversationId: string): PacingVariant {
  const hash = fnv1a32(`pacing:${conversationId}`);
  const idx = hash % VARIANTS.length;
  return VARIANTS[idx] ?? CONTROL;
}

export function timingOptionsFor(variant: PacingVariant): TimingOptions {
  return {
    wpm: variant.wpm,
    wpmStd: variant.wpmStd,
    readTimeMs: variant.readTimeMs,
    readTimeStdMs: variant.readTimeStdMs,
    interBubbleGapMs: variant.interBubbleGapMs,
  };
}
