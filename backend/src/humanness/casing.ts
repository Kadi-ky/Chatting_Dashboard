import type { Rng } from "./rng.js";
import type { StyleProfile } from "./style.js";

export interface CasingOptions {
  /** Probability a bubble opens with a lowercase first letter. Default 0.4. */
  lowercaseStartRate?: number;
  /** Per-conversation style — supplies the default lowercaseStartRate. */
  style?: StyleProfile;
}

/**
 * Occasionally lowercase the first letter of a bubble. Leaves mid-sentence
 * capitalization and proper nouns alone (the model may still capitalize them,
 * we just relax the opener).
 */
export function applyCasing(text: string, rng: Rng, opts: CasingOptions = {}): string {
  const rate = opts.lowercaseStartRate ?? opts.style?.lowercaseStartRate ?? 0.4;
  if (text.length === 0) return text;
  if (!rng.chance(rate)) return text;
  const first = text.charAt(0);
  if (first === first.toLowerCase()) return text; // already lowercase
  // Preserve things like "I'm" / "I " — those should stay capitalized
  if (/^I(\b|[' ])/.test(text)) return text;
  return first.toLowerCase() + text.slice(1);
}
