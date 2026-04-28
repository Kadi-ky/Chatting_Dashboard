import { seededRng } from "./rng.js";
import { applyCasing } from "./casing.js";
import { applyTypos } from "./typos.js";
import { scrubForbidden } from "./forbidden.js";
import { normalizeBubbles } from "./split.js";
import { computeTimings, type BubbleTiming, type TimingOptions } from "./timing.js";
import { deriveStyleProfile, type StyleProfile } from "./style.js";
import { pickPacingVariant, timingOptionsFor, type PacingVariant } from "./pacing.js";
import { applyCleanup } from "./cleanup.js";

export interface HumanizeInput {
  bubbles: string[];
  /** Stable key — conversation id plus turn index keeps style consistent per conv but fresh per turn. */
  seedKey: string;
  /**
   * Stable identifier for the conversation used to derive the persistent
   * style profile (emoji palette, base WPM, lowercase rate, typo variant
   * preferences). Should be the conversation id without the turn index.
   */
  styleSeed: string;
  /** Optional overrides for the generator's own timing hints. Caller passes through from GeneratorOutput. */
  modelDelayHintMs?: number | null;
  modelGapHintMs?: number | null;
  /**
   * Optional pre-built style profile. When absent the pipeline derives one
   * from `styleSeed`. Callers can override for tests or A/B buckets.
   */
  style?: StyleProfile;
  /** Emojis used in the last ~N outbound bubbles. Used to suppress repeats. */
  recentEmojis?: string[];
  /**
   * When false, the cleanup pass strips all emoji from this turn — enforces
   * the "if you've emoji'd the last 3 replies, skip this one" rule.
   */
  allowEmoji?: boolean;
  /**
   * Count of recent outbound bubbles that started with a lazy "mmm"/"aw"
   * opener. When >= 1, this turn's first bubble has any such opener stripped
   * to break the bot's habit of leading every reply with the same sound.
   */
  recentLazyOpenerCount?: number;
}

export interface HumanizedTurn {
  bubbles: string[];
  timings: BubbleTiming[];
  /** Aggregate turn length so the rate governor can reserve capacity. */
  totalDurationMs: number;
  /** Pacing A/B bucket this turn was rendered under. Stable per conversation. */
  pacingVariant: PacingVariant;
}

/**
 * Run the full humanness pipeline on the model's bubbles. Order matters:
 *   1. scrubForbidden (before anything else — clean input)
 *   2. normalizeBubbles (split oversize bubbles, strip banned punctuation)
 *   3. applyTypos (per bubble, consistent RNG)
 *   4. applyCasing (opener lowercase)
 *   5. computeTimings (after final text so word counts are accurate)
 *
 * The RNG is seeded by conversation so the same fan sees a consistent *style*
 * across turns (same typo flavor, same rhythm). Adding turn index perturbs
 * just enough to avoid identical replies reading identically.
 */
export function humanizeTurn(input: HumanizeInput): HumanizedTurn {
  const rng = seededRng(input.seedKey);
  const style = input.style ?? deriveStyleProfile(input.styleSeed);
  const pacingVariant = pickPacingVariant(input.styleSeed);

  const scrubbed = input.bubbles.map(scrubForbidden).filter((b) => b.length > 0);
  const normalized = normalizeBubbles(scrubbed, rng);

  // Cleanup (shape + filler + emoji cap) runs BEFORE typography so trailing
  // fillers are removed cleanly and the bubble count is stable for timing.
  const cleaned = applyCleanup({
    bubbles: normalized,
    rng,
    recentEmojis: input.recentEmojis ?? [],
    allowEmoji: input.allowEmoji ?? true,
    recentLazyOpenerCount: input.recentLazyOpenerCount ?? 0,
  });

  const styled = cleaned.map((b) => {
    const withTypos = applyTypos(b, rng, { style });
    const cased = applyCasing(withTypos, rng, { style });
    return cased;
  });

  const finalBubbles = styled.filter((b) => b.trim().length > 0);

  const timingOpts: TimingOptions = { style, ...timingOptionsFor(pacingVariant) };
  const timings = computeTimings(finalBubbles, rng, timingOpts);

  // If the model suggested a specific lead-in and it's sane, honor it.
  if (
    input.modelDelayHintMs != null &&
    input.modelDelayHintMs >= 200 &&
    input.modelDelayHintMs <= 120_000 &&
    timings[0]
  ) {
    timings[0] = { delayMs: input.modelDelayHintMs };
  }
  if (input.modelGapHintMs != null && input.modelGapHintMs >= 100 && input.modelGapHintMs <= 30_000) {
    for (let i = 1; i < timings.length; i++) {
      timings[i] = { delayMs: input.modelGapHintMs };
    }
  }

  const totalDurationMs = timings.reduce((acc, t) => acc + t.delayMs, 0);

  return { bubbles: finalBubbles, timings, totalDurationMs, pacingVariant };
}
