import type { Rng } from "./rng.js";
import type { StyleProfile } from "./style.js";

export interface CasingOptions {
  /** Probability a bubble opens with a lowercase first letter. Default 0.5 (50/50 mix). */
  lowercaseStartRate?: number;
  /** Per-conversation style — supplies the default lowercaseStartRate. */
  style?: StyleProfile;
}

/**
 * Force the opener into lowercase OR uppercase mode to hit a target ratio,
 * regardless of what the LLM produced. The LLM tends to output lowercase 95%+
 * of the time (Peach's voice rules anchor it strongly) — a one-directional
 * "lowercase this one sometimes" post-processor can't fix that because it
 * never UPPERCASES anything. This version pushes both directions so the
 * resulting distribution hits the target rate.
 */
export function applyCasing(text: string, rng: Rng, opts: CasingOptions = {}): string {
  const lowercaseRate = opts.lowercaseStartRate ?? opts.style?.lowercaseStartRate ?? 0.5;
  if (text.length === 0) return text;

  // Skip if the first character isn't a letter (emoji, quote, ellipsis, etc).
  const first = text.charAt(0);
  if (!/[a-zA-Z]/.test(first)) return text;

  // "I" starting a sentence always stays capitalized ("I'm", "I was...").
  if (/^I(\b|[' ])/.test(text)) return text;

  // Decide the target for THIS bubble based on the rng + target rate.
  const wantLowercase = rng.chance(lowercaseRate);
  const isLowercase = first === first.toLowerCase();

  if (wantLowercase && !isLowercase) {
    return first.toLowerCase() + text.slice(1);
  }
  if (!wantLowercase && isLowercase) {
    return first.toUpperCase() + text.slice(1);
  }
  return text;
}
