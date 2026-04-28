import type { Rng } from "./rng.js";

/**
 * Deterministic post-cleanup that enforces the humanness rules the model is
 * most likely to violate (trailing "lol"/"haha", emoji sprinkle, 3-bubble
 * reflex). Prompt rules catch most cases; this is the safety net for the rest.
 */

// Trailing filler tokens the model loves to sign off with. Case-insensitive,
// with optional trailing punctuation. We keep them mid-sentence — only the
// *final* instance on a bubble is stripped, and only probabilistically so a
// rare genuine "lol" at the end survives.
const TRAILING_FILLER_RE =
  /(?:[\s,.!?-]+)?\b(?:lol+|ha(?:ha)+h?|lmao+|lmfao+|rofl|xd|hehe+)\s*[.!?]*\s*$/i;

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}️‍]+/gu;

/**
 * Strip a trailing filler token with high probability. Keeps the "lol" when
 * it's the entire bubble (that's a valid one-word reply) and when the bubble
 * already ends on strong punctuation like a question mark (reaction-as-retort).
 */
export function stripTrailingFiller(text: string, rng: Rng, probability = 0.85): string {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return text;
  // Don't touch bubbles that ARE a filler (e.g. whole-bubble "lol" as a one-word reply).
  if (/^(?:lol+|ha(?:ha)+h?|lmao+|lmfao+|hehe+|xd)[.!?\s]*$/i.test(trimmed)) return text;
  if (!TRAILING_FILLER_RE.test(trimmed)) return text;
  if (!rng.chance(probability)) return text;
  const stripped = trimmed.replace(TRAILING_FILLER_RE, "");
  return stripped.trimEnd();
}

/** Extract all emoji tokens from a bubble in order of appearance. */
function extractEmojis(text: string): string[] {
  const out: string[] = [];
  const matches = text.match(EMOJI_RE);
  if (!matches) return out;
  for (const m of matches) {
    // A single match might contain several consecutive emoji grapheme
    // clusters. Split naively per code point; good enough for cap logic.
    for (const codepoint of Array.from(m)) {
      if (/\p{Extended_Pictographic}/u.test(codepoint)) out.push(codepoint);
    }
  }
  return out;
}

/**
 * Keep at most one emoji in the bubble. When multiple are present the first
 * wins (usually the most intentional) and others are removed in-place.
 */
export function capEmojisPerBubble(text: string, max = 1): string {
  const emojis = extractEmojis(text);
  if (emojis.length <= max) return text;
  let kept = 0;
  return text.replace(EMOJI_RE, (match) => {
    let out = "";
    for (const ch of Array.from(match)) {
      if (/\p{Extended_Pictographic}/u.test(ch)) {
        if (kept < max) {
          out += ch;
          kept++;
        }
      } else {
        // zero-width joiners / variation selectors travel with preceding emoji
        if (out.length > 0) out += ch;
      }
    }
    return out;
  });
}

/**
 * Drop emoji from a bubble if the same emoji appeared in the previous bubble
 * of this turn OR if `recentEmojis` (from past turns) contains it. Encourages
 * variety and prevents the "every message has 🖤" tic.
 */
export function dedupeEmojiAcrossBubbles(bubbles: string[], recentEmojis: string[] = []): string[] {
  const seen = new Set(recentEmojis);
  return bubbles.map((b) => {
    const emojis = extractEmojis(b);
    if (emojis.length === 0) return b;
    const first = emojis[0]!;
    if (seen.has(first)) {
      // strip all emojis from this bubble
      return b.replace(EMOJI_RE, "").replace(/\s+([.!?,])/g, "$1").replace(/\s+$/, "").replace(/\s{2,}/g, " ");
    }
    seen.add(first);
    return b;
  });
}

/**
 * When the model emits 3 bubbles and they're short enough to join, collapse
 * to 1–2 with the given probability. Defense in depth against the
 * "three-bubble reflex" even when the humanness layer says default-to-one.
 * The model's intent is preserved because we concatenate in order.
 */
export function maybeCollapseBubbles(
  bubbles: string[],
  rng: Rng,
  opts: { probability?: number; maxCollapsedWords?: number } = {},
): string[] {
  const probability = opts.probability ?? 0.55;
  const maxWords = opts.maxCollapsedWords ?? 28;
  if (bubbles.length < 3) return bubbles;
  const total = bubbles.reduce((acc, b) => acc + b.split(/\s+/).filter(Boolean).length, 0);
  if (total > maxWords) return bubbles;
  if (!rng.chance(probability)) return bubbles;

  // Collapse to either 1 or 2 bubbles. 2 is more natural for longer content;
  // 1 for shorter.
  if (total <= 14 && rng.chance(0.6)) {
    return [joinBubbles(bubbles)];
  }
  // Two-bubble collapse: first bubble + remainder merged.
  const head = bubbles[0]!;
  const tail = joinBubbles(bubbles.slice(1));
  return [head, tail];
}

function joinBubbles(bubbles: string[]): string {
  // Join with a space; keep internal punctuation intact. Avoid double punctuation.
  return bubbles
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .join(" ")
    .replace(/\s+([.!?,])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface CleanupInput {
  bubbles: string[];
  rng: Rng;
  /** Emojis from the last N outbound bubbles, used to suppress repeats. */
  recentEmojis?: string[];
  /** Whether this turn should have any emoji at all. Supplied by style/rhythm. */
  allowEmoji?: boolean;
  /**
   * How many of the most-recent outbound bubbles started with a lazy "mmm" /
   * "aw" opener. When >= 1 we strip that opener from this turn's bubble(s)
   * to prevent the bot from defaulting to the same sound every reply. The
   * actual cap is enforced via prompt-level guidance; this is the safety net.
   */
  recentLazyOpenerCount?: number;
}

/**
 * Strip a lazy "mmm" / "aw" opener from the start of a bubble if the bot has
 * used one of those openers recently. Preserves the rest of the message — we
 * just remove the empty-calorie lead-in.
 *
 * "mmm thanks for noticin babe" → "thanks for noticin babe"
 * "Aw babe i havent shot that"  → "babe i havent shot that"
 */
const LAZY_OPENER_STRIP_RE =
  /^[ \t]*(?:m+m+|mmm+m*|a+w+|aww+w*|ohh*|oof+)[\s,!.\-—–]+(?=\S)/i;
export function stripLazyOpener(text: string): string {
  if (!LAZY_OPENER_STRIP_RE.test(text)) return text;
  let out = text.replace(LAZY_OPENER_STRIP_RE, "");
  // Preserve sentence-start: capitalize the first alpha if the rest of the
  // bubble is sentence-cased (rare for this persona, but safe).
  if (out.length > 0 && /^[a-z]/.test(out) && /[A-Z]/.test(text)) {
    out = out[0]!.toUpperCase() + out.slice(1);
  }
  return out;
}

/**
 * One-shot cleanup invoked from the humanizer pipeline. Order matters:
 *   1. collapse (change shape first so downstream ops act on the final count)
 *   2. stripTrailingFiller (before emoji dedup — a stripped "lol 🖤" leaves 🖤)
 *   3. capEmojisPerBubble
 *   4. dedupeEmojiAcrossBubbles (within turn + vs recent history)
 *   5. if !allowEmoji → strip all emoji
 */
export function applyCleanup(input: CleanupInput): string[] {
  const { rng, recentEmojis = [], allowEmoji = true, recentLazyOpenerCount = 0 } = input;

  let bubbles = maybeCollapseBubbles(input.bubbles, rng);
  bubbles = bubbles.map((b) => stripTrailingFiller(b, rng));
  bubbles = maybeStripTrailingQuestion(bubbles, rng);
  // Strip "Mmm" / "Aw" opener from the FIRST bubble only when the bot used
  // one of those openers recently — keeps the prompt's permission to use
  // them once-in-a-while while preventing a 5-in-a-row run.
  if (recentLazyOpenerCount >= 1 && bubbles.length > 0 && bubbles[0]) {
    bubbles[0] = stripLazyOpener(bubbles[0]);
  }
  bubbles = bubbles.map((b) => capEmojisPerBubble(b, 2));
  bubbles = dedupeEmojiAcrossBubbles(bubbles, recentEmojis);

  if (!allowEmoji) {
    bubbles = bubbles.map((b) =>
      b.replace(EMOJI_RE, "").replace(/\s+([.!?,])/g, "$1").replace(/\s{2,}/g, " ").trim(),
    );
  }

  return bubbles.map((b) => b.trim()).filter((b) => b.length > 0);
}

/**
 * Strip a trailing question when the reply recently ended in a question — the
 * model's biggest tic is "ping-pong interview mode". Looks at the LAST short
 * sentence of the LAST bubble; if it's a question AND the rng rolls under the
 * strip probability, drop it. Converts "that's cool, whats your favorite?" to
 * "that's cool". Statements beat questions as defaults.
 */
const TRAILING_QUESTION_RE = /(?:^|[.!?])\s*([^.!?]+\?)\s*$/;

export function maybeStripTrailingQuestion(
  bubbles: string[],
  rng: Rng,
  opts: { probability?: number; minStatementWords?: number } = {},
): string[] {
  if (bubbles.length === 0) return bubbles;
  const probability = opts.probability ?? 0.6;
  const minStatementWords = opts.minStatementWords ?? 3;
  if (!rng.chance(probability)) return bubbles;

  const out = [...bubbles];
  const lastIdx = out.length - 1;
  const last = out[lastIdx]!;
  const match = TRAILING_QUESTION_RE.exec(last);
  if (!match) return bubbles;

  const withoutQuestion = last.slice(0, last.length - match[1]!.length).trimEnd().replace(/[,.]$/, "").trim();
  // Only strip if what's left is a real statement, not just filler ("lol?", "hmm?")
  const remainingWords = withoutQuestion.split(/\s+/).filter(Boolean).length;
  if (remainingWords < minStatementWords) return bubbles;

  out[lastIdx] = withoutQuestion;
  return out.filter((b) => b.trim().length > 0);
}

/** Utility for other modules: pull the first emoji out of each bubble for the emoji-history log. */
export function emojisOf(bubbles: string[]): string[] {
  const out: string[] = [];
  for (const b of bubbles) {
    const e = extractEmojis(b);
    if (e.length > 0) out.push(e[0]!);
  }
  return out;
}
