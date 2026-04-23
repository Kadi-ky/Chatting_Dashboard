import { seededRng, type Rng } from "./rng.js";

/**
 * A per-conversation style profile. Derived deterministically from the
 * conversation id so the same fan sees the same "voice" across every turn —
 * the persona feels like a consistent person, not a dice roll. Per-turn
 * variation (which specific words get typo'd, exact casing on this bubble) is
 * still driven by the turn-indexed RNG in the pipeline; this profile pins the
 * *tendencies*.
 *
 * Keep the ranges tight. Wild swings between conversations make the whole
 * fleet feel like it's run by different people, which defeats the point of a
 * single persona bible.
 */
export interface StyleProfile {
  /** Typo rate 0.015..0.05 — some fans get a lightly-typo'd chat partner, some get heavier. */
  typoRate: number;
  /** Lowercase-opener rate 0.25..0.65 — some personas are naturally more capitalised. */
  lowercaseStartRate: number;
  /** Words-per-minute baseline 50..75. */
  wpm: number;
  /**
   * 1-3 emoji the persona tends to repeat with this fan. If the model emits
   * other emoji we leave them alone; this is a *bias* used when the model's
   * reply has no emoji and the profile's emojiInsertionRate wins a coin flip.
   */
  emojiPalette: string[];
  /**
   * 0..0.25 — probability that a trailing emoji gets auto-appended to a
   * bubble that already ends in letters (no terminal punctuation). Kept low:
   * emoji spam reads bot-ish.
   */
  emojiInsertionRate: number;
  /**
   * Per-word preferred typo index. When a word in the typos map has multiple
   * variants, this picks which one this conversation favors — so the same
   * fan always sees "u" vs "yu" consistently, not both alternately.
   */
  preferredVariantIndex: Map<string, number>;
}

const EMOJI_POOL = [
  "🖤", "😏", "🥺", "😈", "💋", "🔥", "😘", "🤍", "🙈", "😌",
  "🫶", "😚", "💕", "😉", "👀", "✨",
];

/**
 * Build a StyleProfile from a stable key (typically the conversation id).
 * Always returns the same profile for the same key.
 */
export function deriveStyleProfile(key: string): StyleProfile {
  const rng = seededRng(`style:${key}`);
  const typoRate = clamp(rng.gaussian(0.032, 0.008), 0.015, 0.05);
  const lowercaseStartRate = clamp(rng.gaussian(0.45, 0.1), 0.25, 0.65);
  const wpm = clamp(rng.gaussian(62, 7), 50, 75);
  const emojiInsertionRate = clamp(rng.gaussian(0.12, 0.05), 0.02, 0.22);

  // Pick 1-3 emoji, distinct.
  const paletteSize = rng.chance(0.5) ? 2 : rng.chance(0.5) ? 1 : 3;
  const emojiPalette = pickDistinct(EMOJI_POOL, paletteSize, rng);

  return {
    typoRate,
    lowercaseStartRate,
    wpm,
    emojiPalette,
    emojiInsertionRate,
    preferredVariantIndex: new Map(),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function pickDistinct<T>(arr: readonly T[], count: number, rng: Rng): T[] {
  if (count >= arr.length) return [...arr];
  const picked = new Set<number>();
  const out: T[] = [];
  while (out.length < count) {
    const idx = rng.int(0, arr.length - 1);
    if (picked.has(idx)) continue;
    picked.add(idx);
    out.push(arr[idx]!);
  }
  return out;
}

/**
 * Resolve which variant of a given word the style prefers. If the word hasn't
 * been seen before for this profile, lock in a choice (mutating the map) so
 * every subsequent turn in the same conversation sees the same variant.
 */
export function preferredVariant(
  profile: StyleProfile,
  word: string,
  variants: readonly string[],
  rng: Rng,
): string {
  if (variants.length === 1) return variants[0]!;
  const existing = profile.preferredVariantIndex.get(word);
  if (existing != null && existing < variants.length) return variants[existing]!;
  const idx = rng.int(0, variants.length - 1);
  profile.preferredVariantIndex.set(word, idx);
  return variants[idx]!;
}

/**
 * Optionally append a style-palette emoji to a bubble. Only fires when the
 * bubble has no existing emoji and ends on a letter (not punctuation) — we
 * don't want "sure.🖤" which reads awkward.
 */
export function maybeAppendEmoji(
  text: string,
  profile: StyleProfile,
  rng: Rng,
): string {
  if (profile.emojiPalette.length === 0) return text;
  if (!rng.chance(profile.emojiInsertionRate)) return text;
  if (/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(text)) return text;
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return text;
  const last = trimmed[trimmed.length - 1]!;
  if (/[a-zA-Z0-9]/.test(last)) {
    return `${trimmed} ${rng.pick(profile.emojiPalette)}`;
  }
  return text;
}
