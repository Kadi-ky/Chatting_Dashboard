import type { Rng } from "./rng.js";
import { preferredVariant, type StyleProfile } from "./style.js";

/**
 * Controlled typo map. Each entry maps a clean word/pattern to a more casual
 * variant. Chosen to read as *typing fast*, not as *bad at English*. Bias
 * toward substitutions a phone keyboard would plausibly produce.
 */
const WORD_MAP: Record<string, string[]> = {
  you: ["u", "yu"],
  your: ["ur"],
  "you're": ["ur", "youre"],
  are: ["r"],
  "to": ["tooo", "to"],
  yeah: ["yea", "yeahh"],
  yes: ["yea"],
  please: ["pls", "plz"],
  because: ["bc", "cuz"],
  "kind of": ["kinda"],
  going: ["goin"],
  doing: ["doin"],
  nothing: ["nothin"],
  "something": ["smth", "somethin"],
  tonight: ["tn"],
  tomorrow: ["tmrw"],
  probably: ["prob", "probs"],
  honestly: ["ngl"],
  literally: ["lowkey"],
  definitely: ["def"],
  "i am": ["im"],
  "i'm": ["im"],
  "do not": ["dont"],
  "don't": ["dont"],
  "cannot": ["cant"],
  "can't": ["cant"],
  "isn't": ["isnt"],
  "it's": ["its"],
  "that's": ["thats"],
  "what is": ["whats"],
  "what's": ["whats"],
};

export interface TypoOptions {
  /** Probability any eligible token gets transformed. Default 0.035 (~3.5%). */
  rate?: number;
  /** Hard cap on transformations per bubble. Default 3. */
  maxPerBubble?: number;
  /**
   * Optional per-conversation style. When provided, the rate defaults to
   * `style.typoRate` and variant choices are locked per word for the
   * conversation (so the same fan always sees "u" vs "yu", not both).
   */
  style?: StyleProfile;
}

/**
 * Apply casual typos to a single bubble of text. Deterministic given rng.
 * Only transforms whole tokens (word-boundary), case-insensitive match but
 * preserves capitalization of the first letter if the original had one.
 */
export function applyTypos(text: string, rng: Rng, opts: TypoOptions = {}): string {
  const rate = opts.rate ?? opts.style?.typoRate ?? 0.035;
  const maxPerBubble = opts.maxPerBubble ?? 3;
  if (rate <= 0) return text;

  let changes = 0;
  let result = text;

  const pickVariant = (key: string, variants: readonly string[]): string =>
    opts.style ? preferredVariant(opts.style, key, variants, rng) : rng.pick(variants);

  // Multi-word phrases first so they don't get swallowed by single-word regex
  const phraseKeys = Object.keys(WORD_MAP)
    .filter((k) => k.includes(" "))
    .sort((a, b) => b.length - a.length);
  for (const phrase of phraseKeys) {
    if (changes >= maxPerBubble) break;
    const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, "gi");
    result = result.replace(re, (match) => {
      if (changes >= maxPerBubble) return match;
      if (!rng.chance(rate * 2)) return match; // phrases 2x more likely since they're rarer
      changes++;
      const key = phrase.toLowerCase();
      const variants = WORD_MAP[key]!;
      return matchCase(match, pickVariant(key, variants));
    });
  }

  // Single-word replacements
  result = result.replace(/\b[\w']+\b/g, (match) => {
    if (changes >= maxPerBubble) return match;
    const key = match.toLowerCase();
    const variants = WORD_MAP[key];
    if (!variants) return match;
    if (!rng.chance(rate)) return match;
    changes++;
    return matchCase(match, pickVariant(key, variants));
  });

  return result;
}

function matchCase(original: string, replacement: string): string {
  if (original.length === 0) return replacement;
  if (original[0] === original[0]?.toUpperCase() && original[0] !== original[0]?.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
